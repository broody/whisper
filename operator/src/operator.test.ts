import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeProceedsRecipientCommitment,
  computeRefundCommitment,
  computeRevealCommitment,
  deriveWhisperRevealPublicKey,
  encryptWhisperBidCapsule,
  WHISPER_CAPSULE_ALGORITHM,
  type WhisperBidOpening,
  type WhisperEncryptedCapsule,
} from "@whisper-trade/sdk";
import {
  Account,
  constants,
  hash,
  type EventFilter,
  type ProviderInterface,
  type SignerInterface,
} from "starknet";

import { createOperatorApi } from "./api.ts";
import { AuctionCoordinator } from "./auction-coordinator.ts";
import { WhisperSdkCapsuleCipher } from "./capsule-cipher.ts";
import { loadOperatorRuntimeConfig } from "./config.ts";
import { OperatorCircuitBreakerError, WhisperOperator } from "./engine.ts";
import { SEPOLIA_OPERATOR_NETWORK } from "./networks.ts";
import { createOfficialVaultRuntime, type OfficialPrivacySdkModule } from "./official-sdk.ts";
import { AuctionRecovery } from "./recovery.ts";
import { loadOperatorSecretMaterial } from "./runtime-secrets.ts";
import { createOperatorService } from "./service.ts";
import { StarknetWhisperChain } from "./starknet-chain.ts";
import { SqliteOperatorStore } from "./sqlite-store.ts";
import { InMemoryOperatorStore, type OperatorStore } from "./store.ts";
import { Strk20VaultClient, type PrivateTransfersLike } from "./strk20-vault.ts";
import type {
  AuctionResultView,
  AuctionView,
  BidSubmissionEvent,
  BidView,
  RecoveryPlan,
  SettlementPlan,
  VaultNote,
  VaultPort,
  WhisperChainPort,
  WhisperEventSource,
} from "./types.ts";
import { OperatorWorker } from "./worker.ts";

const chainId = 0x534e5f4d41494en;
const poolAddress = 0x111n;
const whisperAddress = 0x222n;
const vaultAddress = 0x333n;
const revealPrivateKey = 0x12345n;
const revealPublicKey = deriveWhisperRevealPublicKey(revealPrivateKey);

class MemoryChain implements WhisperChainPort {
  readonly bids = new Map<string, BidView>();
  readonly candidates = new Map<string, bigint[]>();
  auction!: AuctionView;
  result?: AuctionResultView;

  async getAuction(): Promise<AuctionView> {
    return { ...this.auction };
  }

  async getResult(): Promise<AuctionResultView> {
    if (this.result === undefined) throw new Error("missing result");
    return { ...this.result };
  }

  async getBid(auctionId: bigint, bidHandle: bigint): Promise<BidView> {
    const bid = this.bids.get(`${auctionId}:${bidHandle}`);
    if (bid === undefined) throw new Error("missing bid");
    return { ...bid };
  }

  async getAcceptedBids(): Promise<BidView[]> {
    return [...this.bids.values()].filter((bid) => bid.funded).map((bid) => ({ ...bid }));
  }

  async candidateVaultNoteIds(transactionHash: string): Promise<bigint[]> {
    return [...(this.candidates.get(transactionHash) ?? [])];
  }
}

class MemoryVault implements VaultPort {
  readonly accepted: { auctionId: bigint; bidHandle: bigint; noteId: bigint }[] = [];
  notes: VaultNote[] = [];
  settledPlan?: SettlementPlan;

  constructor(private readonly chain: MemoryChain) {}

  async discoverNotes(paymentToken: bigint): Promise<VaultNote[]> {
    return this.notes.filter((note) => note.token === paymentToken);
  }

  async acceptBid(auctionId: bigint, bidHandle: bigint, noteId: bigint) {
    this.accepted.push({ auctionId, bidHandle, noteId });
    const bid = this.chain.bids.get(`${auctionId}:${bidHandle}`)!;
    bid.funded = true;
    bid.noteId = noteId;
    return { transactionHash: `0xaccept${bidHandle}` };
  }

  async settle(plan: SettlementPlan) {
    this.settledPlan = plan;
    this.chain.auction.status = "settled";
    return { transactionHash: "0xsettled" };
  }
}

interface BidFixture {
  bid: BidView;
  event: BidSubmissionEvent;
  envelope: WhisperEncryptedCapsule;
  note: VaultNote;
  opening: WhisperBidOpening;
}

async function bidFixture(input: {
  auctionId: bigint;
  bidHandle: bigint;
  groupHandle?: bigint;
  trancheIndex?: number;
  amount: bigint;
  noteId: bigint;
  refundRecipient: bigint;
}): Promise<BidFixture> {
  const refundCommitment = computeRefundCommitment(input.refundRecipient);
  const opening = {
    auctionId: input.auctionId,
    amount: input.amount,
    salt: input.bidHandle + 1_000n,
    refundRecipient: input.refundRecipient,
    refundCommitment,
    winnerCommitment: input.bidHandle + 2_000n,
  };
  const revealCommitment = computeRevealCommitment(
    opening.auctionId,
    opening.amount,
    opening.salt,
    opening.refundCommitment,
    opening.winnerCommitment,
  );
  const envelope = await encryptWhisperBidCapsule(opening, revealPublicKey, {
    chainId,
    poolAddress,
    whisperAddress,
    auctionId: input.auctionId,
    revealCommitment,
  });
  return {
    opening,
    envelope,
    bid: {
      auctionId: input.auctionId,
      bidHandle: input.bidHandle,
      groupHandle: input.groupHandle ?? input.bidHandle,
      trancheIndex: input.trancheIndex ?? 0,
      noteId: 0n,
      revealCommitment,
      refundCommitment,
      winnerCommitment: opening.winnerCommitment,
      funded: false,
      settled: false,
    },
    event: {
      auctionId: input.auctionId,
      bidHandle: input.bidHandle,
      transactionHash: `0xsource${input.bidHandle}`,
      blockNumber: 50,
    },
    note: {
      id: input.noteId,
      token: 0x444n,
      amount: input.amount,
      createdBlock: 50,
      sender: 0x555n,
      opaque: { id: input.noteId },
    },
  };
}

function setup(store: OperatorStore = new InMemoryOperatorStore()) {
  let nowSeconds = 75;
  const chain = new MemoryChain();
  const proceedsRecipient = 0x999n;
  chain.auction = {
    id: 7n,
    paymentToken: 0x444n,
    proceedsRecipientCommitment: computeProceedsRecipientCommitment(proceedsRecipient),
    fulfillmentKind: "offchain",
    assetToken: 0n,
    assetTokenId: 0n,
    assetAmount: 0n,
    fulfillmentStatus: "offchain",
    reservePrice: 50n,
    schedule: {
      kind: "absolute",
      biddingDeadline: 90,
      forceRevealAfter: 100,
      abortAfter: 300,
    },
    startedAt: 75,
    biddingDeadline: 90,
    forceRevealAfter: 100,
    abortAfter: 300,
    vaultAddress,
    acceptedBidsHash: 0xabcn,
    bidCount: 0,
    status: "bidding",
    settlementHash: 0n,
  };
  const vault = new MemoryVault(chain);
  const operator = new WhisperOperator({
    chain,
    vault,
    store,
    capsules: new WhisperSdkCapsuleCipher(
      { chainId, poolAddress, whisperAddress },
      { getRevealPrivateKey: async () => revealPrivateKey },
    ),
    proceedsRecipients: { getProceedsRecipient: async () => proceedsRecipient },
    clock: { nowSeconds: () => nowSeconds },
  });
  return {
    chain,
    vault,
    store,
    operator,
    setNowSeconds(value: number) {
      nowSeconds = value;
    },
  };
}

test("matches one transaction-scoped note and accepts a funded bid", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  context.vault.notes.push(fixture.note);
  await context.store.putCapsule(fixture.envelope);

  const result = await context.operator.ingestSubmission(fixture.event);

  assert.equal(result.status, "funded");
  assert.equal(result.noteId, 101n);
  assert.deepEqual(context.vault.accepted, [{ auctionId: 7n, bidHandle: 10n, noteId: 101n }]);
});

test("retries while the transaction-scoped note is waiting for discovery", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  await context.store.putCapsule(fixture.envelope);

  const waiting = await context.operator.ingestSubmission(fixture.event);
  assert.equal(waiting.status, "retry");
  assert.equal(waiting.failedAttempts, 0);
  assert.match(waiting.error ?? "", /not discoverable yet/);

  context.vault.notes.push(fixture.note);
  const funded = await context.operator.processSubmission(7n, 10n);
  assert.equal(funded.status, "funded");
  assert.equal(funded.noteId, 101n);
});

test("opens the circuit breaker after three private acceptance failures", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  context.vault.notes.push(fixture.note);
  context.vault.acceptBid = async () => {
    const error = new Error("RPC request details");
    Object.assign(error, { baseError: { code: 41, message: "fee estimation failed" } });
    throw error;
  };
  await context.store.putCapsule(fixture.envelope);

  const first = await context.operator.ingestSubmission(fixture.event);
  assert.equal(first.status, "retry");
  assert.equal(first.failedAttempts, 1);
  assert.equal(first.error, "41: fee estimation failed");

  const second = await context.operator.processSubmission(7n, 10n);
  assert.equal(second.status, "retry");
  assert.equal(second.failedAttempts, 2);

  await assert.rejects(
    context.operator.processSubmission(7n, 10n),
    OperatorCircuitBreakerError,
  );
  const stopped = await context.store.getSubmission(7n, 10n);
  assert.equal(stopped?.status, "retry");
  assert.equal(stopped?.failedAttempts, 3);
  assert.equal(stopped?.error, "41: fee estimation failed");
});

test("rejects a discovered vault note whose amount does not match the capsule", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  context.vault.notes.push({ ...fixture.note, amount: 99n });
  await context.store.putCapsule(fixture.envelope);

  const result = await context.operator.ingestSubmission(fixture.event);

  assert.equal(result.status, "rejected");
  assert.match(result.error ?? "", /matches capsule amount/);
  assert.equal(context.vault.accepted.length, 0);
});

test("matches the committed bid amount when the transaction also creates change", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [101n, 102n]);
  context.vault.notes.push(fixture.note, { ...fixture.note, id: 102n, amount: 900n });
  await context.store.putCapsule(fixture.envelope);

  const result = await context.operator.ingestSubmission(fixture.event);

  assert.equal(result.status, "funded");
  assert.equal(result.noteId, 101n);
  assert.deepEqual(context.vault.accepted, [{ auctionId: 7n, bidHandle: 10n, noteId: 101n }]);
});

test("fails closed when a submission creates multiple matching candidate notes", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [101n, 102n]);
  context.vault.notes.push(fixture.note, { ...fixture.note, id: 102n });
  await context.store.putCapsule(fixture.envelope);

  const result = await context.operator.ingestSubmission(fixture.event);

  assert.equal(result.status, "rejected");
  assert.match(result.error ?? "", /exactly one/);
  assert.equal(context.vault.accepted.length, 0);
});

test("rejects a bid that was not accepted before force reveal", async () => {
  const context = setup();
  context.setNowSeconds(100);
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  context.vault.notes.push(fixture.note);
  await context.store.putCapsule(fixture.envelope);

  const result = await context.operator.ingestSubmission(fixture.event);

  assert.equal(result.status, "rejected");
  assert.match(result.error ?? "", /acceptance window is closed/);
  assert.equal(context.vault.accepted.length, 0);
});

test("recovers exact unaccepted bid notes to their committed refund recipients", async () => {
  const context = setup();
  context.setNowSeconds(100);
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id, 102n]);
  await context.store.putCapsule(fixture.envelope);
  await context.store.recordSubmission(fixture.event);
  await context.store.markSubmissionRejected(7n, 10n, "acceptance window closed");
  let submittedPlan: RecoveryPlan | undefined;
  const recovery = new AuctionRecovery({
    chain: context.chain,
    capsules: new WhisperSdkCapsuleCipher(
      { chainId, poolAddress, whisperAddress },
      { getRevealPrivateKey: async () => revealPrivateKey },
    ),
    store: context.store,
    vault: {
      discoverNotes: async () => [fixture.note],
      refundUnacceptedBids: async (plan) => {
        submittedPlan = plan;
        return { transactionHash: "0xrecovered" };
      },
    },
    clock: { nowSeconds: () => 100 },
  });

  const plan = await recovery.plan(7n);
  assert.deepEqual(
    plan.refunds.map((refund) => ({ noteId: refund.note.id, recipient: refund.recipient })),
    [{ noteId: 101n, recipient: 0xa01n }],
  );
  const first = await recovery.recoverPlan(plan);
  const second = await recovery.recoverPlan(plan);

  assert.equal(submittedPlan, plan);
  assert.deepEqual(first, {
    transactionHash: "0xrecovered",
    recoveredBidCount: 1,
    alreadyCompleted: false,
  });
  assert.deepEqual(second, {
    transactionHash: "0xrecovered",
    recoveredBidCount: 0,
    alreadyCompleted: true,
  });
});

test("constructs a complete Vickrey settlement with private refunds and change", async () => {
  const context = setup();
  const fixtures = await Promise.all([
    bidFixture({ auctionId: 7n, bidHandle: 10n, amount: 100n, noteId: 101n, refundRecipient: 0xa01n }),
    bidFixture({ auctionId: 7n, bidHandle: 20n, amount: 80n, noteId: 102n, refundRecipient: 0xa02n }),
    bidFixture({ auctionId: 7n, bidHandle: 30n, amount: 70n, noteId: 103n, refundRecipient: 0xa03n }),
  ]);
  context.chain.auction.bidCount = fixtures.length;
  for (const fixture of fixtures) {
    context.chain.bids.set(`7:${fixture.bid.bidHandle}`, fixture.bid);
    context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
    context.vault.notes.push(fixture.note);
    await context.store.putCapsule(fixture.envelope);
    assert.equal((await context.operator.ingestSubmission(fixture.event)).status, "funded");
  }

  context.setNowSeconds(200);
  const plan = await context.operator.settleAuction(7n);

  assert.ok(plan);
  assert.equal(plan.winnerBidHandle, 10n);
  assert.equal(plan.winningBid, 100n);
  assert.equal(plan.secondHighestBid, 80n);
  assert.equal(plan.clearingPrice, 80n);
  assert.deepEqual(
    plan.outputs.map(({ kind, recipient, amount }) => ({ kind, recipient, amount })),
    [
      { kind: "winner-change", recipient: 0xa01n, amount: 20n },
      { kind: "refund", recipient: 0xa02n, amount: 80n },
      { kind: "refund", recipient: 0xa03n, amount: 70n },
      { kind: "proceeds", recipient: 0x999n, amount: 80n },
    ],
  );
  assert.equal(
    plan.outputs.reduce((sum, output) => sum + output.amount, 0n),
    plan.notes.reduce((sum, note) => sum + note.amount, 0n),
  );
  assert.equal((await context.store.getSettlement(7n))?.status, "settled");
});

test("opens the circuit breaker after three private settlement failures", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.auction.bidCount = 1;
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  context.vault.notes.push(fixture.note);
  await context.store.putCapsule(fixture.envelope);
  assert.equal((await context.operator.ingestSubmission(fixture.event)).status, "funded");

  context.vault.settle = async () => {
    const error = new Error("RPC request details");
    Object.assign(error, { baseError: { code: 41, message: "fee estimation failed" } });
    throw error;
  };
  context.setNowSeconds(200);

  await assert.rejects(context.operator.settleAuction(7n), /RPC request details/);
  assert.equal((await context.store.getSettlement(7n))?.failedAttempts, 1);
  await assert.rejects(context.operator.settleAuction(7n), /RPC request details/);
  assert.equal((await context.store.getSettlement(7n))?.failedAttempts, 2);
  await assert.rejects(context.operator.settleAuction(7n), OperatorCircuitBreakerError);
  const stopped = await context.store.getSettlement(7n);
  assert.equal(stopped?.status, "retry");
  assert.equal(stopped?.failedAttempts, 3);
  assert.equal(stopped?.error, "41: fee estimation failed");
});

test("discloses only the verified winner after settlement", async () => {
  const context = setup();
  const fixtures = await Promise.all([
    bidFixture({ auctionId: 7n, bidHandle: 10n, amount: 100n, noteId: 101n, refundRecipient: 0xa01n }),
    bidFixture({ auctionId: 7n, bidHandle: 20n, amount: 80n, noteId: 102n, refundRecipient: 0xa02n }),
  ]);
  context.chain.auction.bidCount = fixtures.length;
  for (const fixture of fixtures) {
    context.chain.bids.set(`7:${fixture.bid.bidHandle}`, fixture.bid);
    context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
    context.vault.notes.push(fixture.note);
    await context.store.putCapsule(fixture.envelope);
    assert.equal((await context.operator.ingestSubmission(fixture.event)).status, "funded");
  }

  assert.deepEqual(await context.operator.getWinnerDisclosure(7n), {
    status: "pending",
    auctionId: 7n,
  });
  context.setNowSeconds(200);
  const plan = await context.operator.settleAuction(7n);
  assert.ok(plan);
  context.chain.auction.settlementHash = plan.settlementHash;
  context.chain.result = {
    auctionId: 7n,
    hasWinner: true,
    winnerBidHandle: plan.winnerBidHandle,
    winnerCommitment: fixtures[0]!.bid.winnerCommitment,
    winningBid: plan.winningBid,
    secondHighestBid: plan.secondHighestBid,
    clearingPrice: plan.clearingPrice,
    revealsRoot: plan.revealsRoot,
    outputsRoot: plan.outputsRoot,
    settlementHash: plan.settlementHash,
    settledAt: 200,
  };

  assert.deepEqual(await context.operator.getWinnerDisclosure(7n), {
    status: "winner",
    auctionId: 7n,
    winnerGroupHandle: 10n,
    winnerCommitment: fixtures[0]!.bid.winnerCommitment,
    address: 0xa01n,
  });
});

test("aggregates additive bid tranches before Vickrey pricing", async () => {
  const context = setup();
  const fixtures = await Promise.all([
    bidFixture({
      auctionId: 7n,
      bidHandle: 10n,
      groupHandle: 100n,
      trancheIndex: 0,
      amount: 50n,
      noteId: 101n,
      refundRecipient: 0xa01n,
    }),
    bidFixture({
      auctionId: 7n,
      bidHandle: 11n,
      groupHandle: 100n,
      trancheIndex: 1,
      amount: 30n,
      noteId: 102n,
      refundRecipient: 0xa01n,
    }),
    bidFixture({
      auctionId: 7n,
      bidHandle: 20n,
      groupHandle: 200n,
      trancheIndex: 0,
      amount: 60n,
      noteId: 103n,
      refundRecipient: 0xa02n,
    }),
  ]);
  context.chain.auction.bidCount = fixtures.length;
  for (const fixture of fixtures) {
    context.chain.bids.set(`7:${fixture.bid.bidHandle}`, fixture.bid);
    context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
    context.vault.notes.push(fixture.note);
    await context.store.putCapsule(fixture.envelope);
    assert.equal((await context.operator.ingestSubmission(fixture.event)).status, "funded");
  }

  context.setNowSeconds(200);
  const plan = await context.operator.settleAuction(7n);

  assert.ok(plan);
  assert.equal(plan.winnerBidHandle, 100n);
  assert.equal(plan.winningBid, 80n);
  assert.equal(plan.secondHighestBid, 60n);
  assert.equal(plan.clearingPrice, 60n);
  assert.deepEqual(
    plan.outputs.map(({ kind, recipient, amount }) => ({ kind, recipient, amount })),
    [
      { kind: "winner-change", recipient: 0xa01n, amount: 20n },
      { kind: "refund", recipient: 0xa02n, amount: 60n },
      { kind: "proceeds", recipient: 0x999n, amount: 60n },
    ],
  );
  assert.equal(
    plan.outputs.reduce((sum, output) => sum + output.amount, 0n),
    plan.notes.reduce((sum, note) => sum + note.amount, 0n),
  );
});

test("refunds a funded group that finishes below reserve", async () => {
  const context = setup();
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    groupHandle: 100n,
    amount: 20n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  context.chain.auction.bidCount = 1;
  context.chain.bids.set("7:10", fixture.bid);
  context.chain.candidates.set(fixture.event.transactionHash, [fixture.note.id]);
  context.vault.notes.push(fixture.note);
  await context.store.putCapsule(fixture.envelope);
  assert.equal((await context.operator.ingestSubmission(fixture.event)).status, "funded");

  context.setNowSeconds(200);
  const plan = await context.operator.settleAuction(7n);

  assert.ok(plan);
  assert.equal(plan.winnerBidHandle, 0n);
  assert.equal(plan.winningBid, 0n);
  assert.equal(plan.clearingPrice, 0n);
  assert.deepEqual(
    plan.outputs.map(({ kind, recipient, amount }) => ({ kind, recipient, amount })),
    [{ kind: "refund", recipient: 0xa01n, amount: 20n }],
  );
});

test("rejects an invalid proceeds commitment before private note discovery", async () => {
  const context = setup();
  context.setNowSeconds(200);
  context.chain.auction.proceedsRecipientCommitment = 0xdeadn;
  let discovered = false;
  context.vault.discoverNotes = async () => {
    discovered = true;
    return [];
  };

  await assert.rejects(
    context.operator.settleAuction(7n),
    /proceeds recipient does not match auction commitment/,
  );
  assert.equal(discovered, false);
});

test("persists encrypted capsules and idempotency state in SQLite", async () => {
  const store = new SqliteOperatorStore(":memory:");
  const fixture = await bidFixture({
    auctionId: 7n,
    bidHandle: 10n,
    amount: 100n,
    noteId: 101n,
    refundRecipient: 0xa01n,
  });
  try {
    assert.equal(await store.putCapsule(fixture.envelope), "created");
    assert.equal(await store.putCapsule(fixture.envelope), "exists");
    await store.recordSubmission(fixture.event);
    assert.equal(await store.claimSubmission(7n, 10n), true);
    await store.markSubmissionFunded(7n, 10n, 101n, "0xaccepted");
    assert.equal((await store.getSubmission(7n, 10n))?.status, "funded");
    assert.equal(await store.claimSettlement(7n), true);
    await store.markSettlementComplete(7n, "0xsettled");
    assert.equal((await store.getSettlement(7n))?.transactionHash, "0xsettled");
    assert.equal(await store.claimRecovery(7n), true);
    assert.equal(await store.claimRecovery(7n), false);
    await store.completeRecovery(7n, "0xrecovered");
    assert.deepEqual(await store.getRecovery(7n), {
      auctionId: 7n,
      status: "completed",
      transactionHash: "0xrecovered",
      updatedAt: (await store.getRecovery(7n))?.updatedAt,
    });
  } finally {
    store.close();
  }
});

test("serves public vault configuration and accepts idempotent capsule uploads", async () => {
  const store = new InMemoryOperatorStore();
  let ready = false;
  const server = createOperatorApi({
    store,
    coordinatorToken: "a".repeat(32),
    publicConfig: {
      chainId,
      poolAddress,
      whisperAddress,
      vaultAddress,
      vaultPublicKey: 0x777n,
      revealPublicKey,
    },
    readiness: async () => {
      if (!ready) throw new Error("replay note is not ready");
    },
    winnerReader: {
      getWinnerDisclosure: async (auctionId) => ({
        status: "winner",
        auctionId,
        winnerGroupHandle: 0x123n,
        winnerCommitment: 0x456n,
        address: 0xa01n,
      }),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const envelope: WhisperEncryptedCapsule = {
    version: 1,
    algorithm: WHISPER_CAPSULE_ALGORITHM,
    auctionId: "0x7",
    revealCommitment: "0x123",
    ephemeralPublicKey: "0x456",
    hkdfSalt: `0x${"11".repeat(32)}`,
    nonce: `0x${"22".repeat(12)}`,
    ciphertext: "0x3344",
  };
  try {
    const notReadyResponse = await fetch(`${baseUrl}/readyz`);
    assert.equal(notReadyResponse.status, 503);
    assert.deepEqual(await notReadyResponse.json(), { status: "not_ready" });
    ready = true;
    const readyResponse = await fetch(`${baseUrl}/readyz`);
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(await readyResponse.json(), { status: "ready" });

    const configResponse = await fetch(`${baseUrl}/v1/config`);
    assert.equal(configResponse.status, 200);
    assert.equal((await configResponse.json() as { vaultAddress: string }).vaultAddress, "0x333");

    const first = await fetch(`${baseUrl}/v1/capsules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const second = await fetch(`${baseUrl}/v1/capsules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);

    const privateWinnerResponse = await fetch(`${baseUrl}/v1/auctions/7/winner`);
    assert.equal(privateWinnerResponse.status, 401);
    const winnerResponse = await fetch(`${baseUrl}/v1/auctions/7/winner`, {
      headers: { Authorization: `Bearer ${"a".repeat(32)}` },
    });
    assert.equal(winnerResponse.status, 200);
    assert.deepEqual(await winnerResponse.json(), {
      status: "winner",
      auctionId: "0x7",
      winnerGroupHandle: "0x123",
      winnerCommitment: "0x456",
      address: "0xa01",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("authenticates and idempotently creates coordinator auctions", async () => {
  const store = new InMemoryOperatorStore();
  let executions = 0;
  const account = {
    address: "0xabc",
    execute: async (call: { entrypoint: string; calldata: string[] }) => {
      executions += 1;
      assert.equal(call.entrypoint, "create_auction");
      assert.equal(call.calldata.length, 20);
      return { transaction_hash: "0xdef" };
    },
  } as unknown as Account;
  const provider = {
    waitForTransaction: async () => ({
      isSuccess: () => true,
      events: [{
        from_address: hex(whisperAddress),
        keys: [hash.getSelectorFromName("AuctionCreated"), "0x9", account.address],
      }],
    }),
  } as unknown as ProviderInterface;
  const coordinator = new AuctionCoordinator({
    provider,
    relayerAccount: account,
    store,
    whisperAddress,
    vaultAddress,
    vaultPublicKey: 0x777n,
    revealPublicKey,
    proceedsRecipient: 0x888n,
    getViewingKey: async () => 0x999n,
  });
  const server = createOperatorApi({
    store,
    coordinator,
    coordinatorToken: "a".repeat(32),
    publicConfig: {
      chainId, poolAddress, whisperAddress, vaultAddress,
      vaultPublicKey: 0x777n, revealPublicKey,
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/v1/coordinator/auctions`;
  const body = JSON.stringify({
    requestId: "stakewars:SN_SEPOLIA:round:1",
    paymentToken: "0x444",
    metadataHash: "0x555",
    winnerPayloadDomain: "0x666",
    reservePrice: "100",
    maxBids: 32,
    biddingDuration: 300,
    acceptanceDuration: 180,
    settlementDuration: 1320,
  });
  try {
    const unauthorized = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    assert.equal(unauthorized.status, 401);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${"a".repeat(32)}` },
        body,
      });
      assert.equal(response.status, 201);
      assert.equal((await response.json() as { auctionId: string }).auctionId, "0x9");
    }
    assert.equal(executions, 1);
    assert.deepEqual(await store.listTrackedAuctions(), [9n]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("decodes Whisper state/events and pool note IDs from Starknet RPC", async () => {
  const pool = 0x111n;
  const whisper = 0x222n;
  const bidSubmittedSelector = hash.getSelectorFromName("BidSubmitted");
  const auctionCreatedSelector = hash.getSelectorFromName("AuctionCreated");
  const encNoteCreatedSelector = hash.getSelectorFromName("EncNoteCreated");
  const auctionValues = [
    7n, 0x1n, 0x444n, 0x555n, 0x6n,
    0n, 0n, 0n, 0n, 0n, 0n, 0n,
    0x7n, 50n, 2n, 0n, 90n, 100n, 300n,
    80n, 90n, 100n, 300n,
    0x333n, 0x8n, 0x9n, 0xan, 0xabcn, 2n, 2n, 2n, 0n, 0n,
  ].map(hex);
  const resultValues = [
    7n, 1n, 0x6en, 0x77n, 100n, 80n, 80n, 0x88n, 0x99n, 0xaan, 200n,
  ].map(hex);
  const bid = (handle: bigint, noteId: bigint) =>
    [7n, handle, handle + 100n, 0n, noteId, handle + 2n, handle + 3n, handle + 4n, 80n, 1n, 0n]
      .map(hex);
  const provider = {
    async callContract(call: { entrypoint: string; calldata?: readonly string[] }) {
      if (call.entrypoint === "get_pool_address") return [hex(pool)];
      if (call.entrypoint === "get_auction") return auctionValues;
      if (call.entrypoint === "get_result") return resultValues;
      if (call.entrypoint === "get_bid_handle") {
        return [BigInt(call.calldata?.[1] ?? 0) === 0n ? "0xa" : "0x14"];
      }
      if (call.entrypoint === "get_bid") {
        const handle = BigInt(call.calldata?.[1] ?? 0);
        return bid(handle, handle === 10n ? 101n : 102n);
      }
      throw new Error(`unexpected call: ${call.entrypoint}`);
    },
    async getBlockNumber() {
      return 123;
    },
    async getEvents(filter: EventFilter) {
      const selector = (filter as unknown as { keys: string[][] }).keys[0]![0];
      if (BigInt(selector!) === BigInt(auctionCreatedSelector)) {
        return {
          events: [{
            from_address: hex(whisper),
            keys: [auctionCreatedSelector, "0x7", "0x1"],
            data: [],
            transaction_hash: "0xaaa",
            block_number: 120,
          }],
        };
      }
      if (BigInt(selector!) === BigInt(bidSubmittedSelector)) {
        return {
          events: [{
            from_address: hex(whisper),
            keys: [bidSubmittedSelector, "0x7", "0xa", "0x6e"],
            data: ["0x0", "0x0", "0x1"],
            transaction_hash: "0xbbb",
            block_number: 121,
          }],
        };
      }
      throw new Error("unexpected event selector");
    },
    async getTransactionReceipt() {
      return {
        events: [
          { from_address: hex(pool), keys: [encNoteCreatedSelector, "0x65"], data: ["0x1"] },
          { from_address: hex(pool), keys: [encNoteCreatedSelector, "0x66"], data: ["0x2"] },
          {
            from_address: hex(whisper),
            keys: [bidSubmittedSelector, "0x7", "0xa", "0x6e"],
            data: [],
          },
        ],
      };
    },
  } as unknown as ProviderInterface;
  const chain = new StarknetWhisperChain(provider, whisper, pool);

  await chain.assertConfiguredPool();
  const auction = await chain.getAuction(7n);
  const bids = await chain.getAcceptedBids(7n);
  const events = await chain.scanEvents(120, 123);
  const candidates = await chain.candidateVaultNoteIds("0xbbb", 0x333n, 0x444n);

  assert.equal(auction.status, "bidding");
  assert.equal(auction.settlementHash, 0n);
  assert.deepEqual(await chain.getResult(7n), {
    auctionId: 7n,
    hasWinner: true,
    winnerBidHandle: 0x6en,
    winnerCommitment: 0x77n,
    winningBid: 100n,
    secondHighestBid: 80n,
    clearingPrice: 80n,
    revealsRoot: 0x88n,
    outputsRoot: 0x99n,
    settlementHash: 0xaan,
    settledAt: 200,
  });
  assert.deepEqual(auction.schedule, {
    kind: "absolute",
    biddingDeadline: 90,
    forceRevealAfter: 100,
    abortAfter: 300,
  });
  assert.equal(auction.startedAt, 80);
  assert.equal(auction.fulfillmentKind, "offchain");
  assert.equal(auction.bidCount, 2);
  assert.deepEqual(bids.map((value) => value.bidHandle), [10n, 20n]);
  assert.deepEqual(bids.map((value) => value.groupHandle), [110n, 120n]);
  assert.deepEqual(events.auctions.map((value) => value.auctionId), [7n]);
  assert.deepEqual(events.submissions.map((value) => value.bidHandle), [10n]);
  assert.deepEqual(candidates, [101n, 102n]);
});

test("decodes a pending start-on-bid auction", async () => {
  const values = [
    8n, 0x1n, 0x444n, 0x555n, 0x6n,
    0n, 0n, 0n, 0n, 0n, 0n, 0n,
    0x7n, 50n, 2n, 1n, 100n, 20n, 80n,
    0n, 0n, 0n, 0n,
    0x333n, 0x8n, 0x9n, 0xan, 0xabcn, 0n, 0n, 1n, 0n, 0n,
  ].map(hex);
  const provider = {
    callContract: async () => values,
  } as unknown as ProviderInterface;
  const chain = new StarknetWhisperChain(provider, 0x222n, 0x111n);

  const auction = await chain.getAuction(8n);

  assert.equal(auction.status, "pending");
  assert.equal(auction.startedAt, 0);
  assert.equal(auction.biddingDeadline, 0);
  assert.deepEqual(auction.schedule, {
    kind: "start-on-bid",
    biddingDuration: 100,
    acceptanceDuration: 20,
    settlementDuration: 80,
  });
});

test("scans finalized events into durable worker state and schedules ready auctions", async () => {
  const store = new InMemoryOperatorStore();
  const processed: string[] = [];
  const settled: bigint[] = [];
  const fakeOperator = {
    async processSubmission(auctionId: bigint, bidHandle: bigint) {
      processed.push(`${auctionId}:${bidHandle}`);
    },
    async settleAuction(auctionId: bigint) {
      settled.push(auctionId);
    },
  } as unknown as WhisperOperator;
  const eventSource: WhisperEventSource = {
    getFinalizedBlockNumber: async () => 12,
    scanEvents: async () => ({
      auctions: [{ auctionId: 7n, transactionHash: "0xaaa", blockNumber: 11 }],
      submissions: [{
        auctionId: 7n,
        bidHandle: 10n,
        transactionHash: "0xbbb",
        blockNumber: 12,
      }],
    }),
  };
  const chain = {
    getAuction: async () => ({
      id: 7n,
      paymentToken: 0x444n,
      proceedsRecipientCommitment: 0x555n,
      fulfillmentKind: "offchain" as const,
      assetToken: 0n,
      assetTokenId: 0n,
      assetAmount: 0n,
      fulfillmentStatus: "offchain" as const,
      reservePrice: 50n,
      schedule: {
        kind: "absolute" as const,
        biddingDeadline: 90,
        forceRevealAfter: 100,
        abortAfter: 300,
      },
      startedAt: 75,
      biddingDeadline: 90,
      forceRevealAfter: 100,
      abortAfter: 300,
      vaultAddress,
      acceptedBidsHash: 0xabcn,
      bidCount: 1,
      status: "bidding" as const,
    }),
  } as unknown as WhisperChainPort;
  const worker = new OperatorWorker(fakeOperator, chain, eventSource, store, {
    deploymentBlock: 10,
    clock: { nowSeconds: () => 200 },
  });

  const result = await worker.runOnce();

  assert.equal(result.scannedToBlock, 12);
  assert.equal(result.eventsRecorded, 2);
  assert.deepEqual(processed, ["7:10"]);
  assert.deepEqual(settled, [7n]);
  assert.equal(await store.getLastScannedBlock(), 12);
  assert.deepEqual(await store.listTrackedAuctions(), [7n]);
});

test("propagates an open circuit breaker out of the worker", async () => {
  const store = new InMemoryOperatorStore();
  await store.recordSubmission({
    auctionId: 7n,
    bidHandle: 10n,
    transactionHash: "0xbbb",
    blockNumber: 1,
  });
  const operator = {
    processSubmission: async () => {
      throw new OperatorCircuitBreakerError("open");
    },
  } as unknown as WhisperOperator;
  const worker = new OperatorWorker(
    operator,
    {} as WhisperChainPort,
    {
      getFinalizedBlockNumber: async () => 0,
      scanEvents: async () => ({ auctions: [], submissions: [] }),
    },
    store,
    { deploymentBlock: 1 },
  );

  await assert.rejects(worker.runOnce(), OperatorCircuitBreakerError);
});

test("composes the official SDK with injected key and provider boundaries", async () => {
  let captured: Parameters<OfficialPrivacySdkModule["createPrivateTransfers"]>[0] | undefined;
  const transfers = {
    discoverNotes: async () => ({ notes: new Map() }),
    build: () => {
      throw new Error("not used");
    },
  } as unknown as PrivateTransfersLike;
  const sdkModule: OfficialPrivacySdkModule = {
    createPrivateTransfers(input) {
      captured = input;
      return transfers;
    },
  };
  const viewingKeyProvider = { getViewingKey: async () => 0x123n };
  const runtime = await createOfficialVaultRuntime({
    account: { address: vaultAddress, signer: {} as SignerInterface },
    viewingKeyProvider,
    provingUrl: "https://prover.example.com",
    discoveryUrl: "https://discovery.example.com",
    rpcUrl: "https://rpc.example.com",
    chainId: constants.StarknetChainId.SN_MAIN,
    poolAddress,
    whisperAddress,
    vaultAddress,
    replayTokenAddress: 0x444n,
    submitter: { submit: async () => ({ transactionHash: "0x1" }) },
    provingTimeoutMilliseconds: 900_000,
    sdkModule,
  });

  assert.equal(runtime.transfers, transfers);
  assert.equal(captured?.viewingKeyProvider, viewingKeyProvider);
  assert.equal(captured?.poolContractAddress, poolAddress);
  assert.equal(captured?.provingProvider.chainId, constants.StarknetChainId.SN_MAIN);
  assert.equal(captured?.provingProvider.requestTimeoutMs, 900_000);
  assert.deepEqual(captured?.discoveryProvider, { url: "https://discovery.example.com/" });
});

test("composes direct pool discovery for Sepolia testing", async () => {
  let captured: Parameters<OfficialPrivacySdkModule["createPrivateTransfers"]>[0] | undefined;
  const transfers = {
    discoverNotes: async () => ({ notes: new Map() }),
    build: () => {
      throw new Error("not used");
    },
  } as unknown as PrivateTransfersLike;
  await createOfficialVaultRuntime({
    account: { address: vaultAddress, signer: {} as SignerInterface },
    viewingKeyProvider: { getViewingKey: async () => 0x123n },
    provingUrl: "https://prover.example.com",
    discoveryUrl: "https://unused-indexer.example.com",
    discoveryMode: "contract",
    rpcUrl: "https://rpc.example.com",
    chainId: constants.StarknetChainId.SN_MAIN,
    poolAddress,
    whisperAddress,
    vaultAddress,
    replayTokenAddress: 0x444n,
    submitter: { submit: async () => ({ transactionHash: "0x1" }) },
    sdkModule: {
      createPrivateTransfers(input) {
        captured = input;
        return transfers;
      },
    },
  });

  assert.ok(captured !== undefined);
  assert.ok("discoverNotes" in captured.discoveryProvider);
  assert.equal(typeof captured.discoveryProvider.discoverNotes, "function");
  assert.equal(typeof captured.discoveryProvider.discoverChannels, "function");
});

test("proves vault actions against the configured finalized block", async () => {
  let executeOptions: { provingBlockId?: number } | undefined;
  const callAndProof = {
    call: { contractAddress: "0x1", entrypoint: "apply_actions", calldata: [] },
    proof: { data: "proof", proofFacts: [] },
  };
  const builder = {
    register() {
      return this;
    },
    with() {
      return this;
    },
    computeAndInvoke() {
      return this;
    },
    async execute(options?: { provingBlockId?: number }) {
      executeOptions = options;
      return { callAndProof };
    },
  };
  const transfers = {
    discoverNotes: async () => ({ notes: new Map() }),
    build: () => builder,
  } as unknown as PrivateTransfersLike;
  const submitted: unknown[] = [];
  const vault = new Strk20VaultClient(
    transfers,
    {
      submit: async (input) => {
        submitted.push(input);
        return { transactionHash: "0x1" };
      },
    },
    "0x222",
    vaultAddress,
    0x444n,
    async () => 123,
  );

  await vault.register();

  assert.deepEqual(executeOptions, { provingBlockId: 123 });
  assert.deepEqual(submitted, [callAndProof]);
});

test("accepts a bid while atomically rotating a mature vault replay note", async () => {
  const replayToken = 0x444n;
  const replayNote = { id: 77n, amount: 5n, created: 10, sender: vaultAddress };
  let discoveryInput: unknown;
  let buildOptions: unknown;
  let selectedInput: unknown;
  let transferOutput: unknown;
  let action: ((args: unknown) => {
    contractAddress: string;
    computeAdditionalData: bigint[];
    invokeAdditionalData: bigint[];
  }) | undefined;
  let executeOptions: unknown;
  const callAndProof = {
    call: { contractAddress: "0x1", entrypoint: "apply_actions", calldata: [] },
    proof: { data: "proof", proofFacts: [] },
  };
  const builder = {
    register() {
      return this;
    },
    with(token: bigint, operations: (tokenBuilder: unknown) => void) {
      assert.equal(token, replayToken);
      operations({
        inputs(note: unknown) {
          selectedInput = note;
          return this;
        },
        transfer(output: unknown) {
          transferOutput = output;
          return this;
        },
      });
      return this;
    },
    computeAndInvoke(input: typeof action) {
      action = input;
      return this;
    },
    async execute(options?: unknown) {
      executeOptions = options;
      return { callAndProof };
    },
  };
  const transfers = {
    discoverNotes: async (input: unknown) => {
      discoveryInput = input;
      return {
        notes: new Map([
          [
            replayToken,
            [
              { id: 101n, amount: 50n, created: 1, sender: vaultAddress },
              { id: 66n, amount: 5n, created: 2, sender: 0x999n },
              replayNote,
            ],
          ],
        ]),
      };
    },
    build: (options: unknown) => {
      buildOptions = options;
      return builder;
    },
  } as unknown as PrivateTransfersLike;
  const submitted: unknown[] = [];
  const vault = new Strk20VaultClient(
    transfers,
    {
      submit: async (input) => {
        submitted.push(input);
        return { transactionHash: "0x1" };
      },
    },
    "0x222",
    vaultAddress,
    replayToken,
    async () => 123,
  );

  await vault.acceptBid(7n, 10n, 101n);

  assert.deepEqual(discoveryInput, { tokens: [replayToken], blockIdentifier: 123 });
  assert.deepEqual(buildOptions, {
    autoDiscover: { channels: "refresh" },
    autoSetup: true,
  });
  assert.equal(selectedInput, replayNote);
  assert.deepEqual(transferOutput, { recipient: vaultAddress, amount: 5n });
  assert.deepEqual(action?.({}), {
    contractAddress: "0x222",
    computeAdditionalData: [0n, 7n, 10n, 101n],
    invokeAdditionalData: [],
  });
  assert.deepEqual(executeOptions, { provingBlockId: 123 });
  assert.deepEqual(submitted, [callAndProof]);
});

test("refunds unaccepted bid notes to registered account addresses", async () => {
  const paymentToken = 0x444n;
  const notes = [
    { id: 101n, amount: 100n, created: 10, sender: 0xa01n },
    { id: 102n, amount: 200n, created: 11, sender: 0xa02n },
  ];
  let discoveryInput: unknown;
  let selectedInputs: unknown[] = [];
  let transferOutputs: unknown[] = [];
  let buildOptions: unknown;
  let executeOptions: unknown;
  const callAndProof = {
    call: { contractAddress: "0x1", entrypoint: "apply_actions", calldata: [] },
    proof: { data: "proof", proofFacts: [] },
  };
  const builder = {
    register() {
      return this;
    },
    with(token: bigint, operations: (tokenBuilder: unknown) => void) {
      assert.equal(token, paymentToken);
      operations({
        inputs(...inputs: unknown[]) {
          selectedInputs = inputs;
          return this;
        },
        transfer(...outputs: unknown[]) {
          transferOutputs = outputs;
          return this;
        },
      });
      return this;
    },
    computeAndInvoke() {
      return this;
    },
    async execute(options?: unknown) {
      executeOptions = options;
      return { callAndProof };
    },
  };
  const transfers = {
    discoverNotes: async (input: unknown) => {
      discoveryInput = input;
      return { notes: new Map([[paymentToken, notes]]) };
    },
    build: (options: unknown) => {
      buildOptions = options;
      return builder;
    },
  } as unknown as PrivateTransfersLike;
  const vault = new Strk20VaultClient(
    transfers,
    { submit: async () => ({ transactionHash: "0xrefund" }) },
    "0x222",
    vaultAddress,
    0x999n,
    async () => 123,
  );

  const result = await vault.refundUnacceptedBids({
    auctionId: 7n,
    paymentToken,
    refunds: [
      {
        note: { id: 101n, token: paymentToken, amount: 100n, sender: 0xa01n, opaque: notes[0] },
        recipient: 0xa01n,
      },
      {
        note: { id: 102n, token: paymentToken, amount: 200n, sender: 0xa02n, opaque: notes[1] },
        recipient: 0xa02n,
      },
    ],
  });

  assert.deepEqual(discoveryInput, { tokens: [paymentToken], blockIdentifier: 123 });
  assert.deepEqual(buildOptions, {
    autoDiscover: { channels: "refresh" },
    autoSetup: true,
  });
  assert.deepEqual(selectedInputs, notes);
  assert.deepEqual(transferOutputs, [
    { recipient: 0xa01n, amount: 100n },
    { recipient: 0xa02n, amount: 200n },
  ]);
  assert.deepEqual(executeOptions, { provingBlockId: 123 });
  assert.deepEqual(result, { transactionHash: "0xrefund" });
});

test("aborts an expired auction while rotating a vault replay note", async () => {
  const replayToken = 0x444n;
  const replayNote = { id: 77n, amount: 5n, created: 10, sender: vaultAddress };
  let selectedInput: unknown;
  let transferOutput: unknown;
  let action: ((args: unknown) => {
    contractAddress: string;
    computeAdditionalData: bigint[];
    invokeAdditionalData: bigint[];
  }) | undefined;
  const builder = {
    register() {
      return this;
    },
    with(_token: bigint, operations: (tokenBuilder: unknown) => void) {
      operations({
        inputs(note: unknown) {
          selectedInput = note;
          return this;
        },
        transfer(output: unknown) {
          transferOutput = output;
          return this;
        },
      });
      return this;
    },
    computeAndInvoke(input: typeof action) {
      action = input;
      return this;
    },
    async execute() {
      return {
        callAndProof: {
          call: { contractAddress: "0x1", entrypoint: "apply_actions", calldata: [] },
          proof: { data: "proof", proofFacts: [] },
        },
      };
    },
  };
  const vault = new Strk20VaultClient(
    {
      discoverNotes: async () => ({ notes: new Map([[replayToken, [replayNote]]]) }),
      build: () => builder,
    } as unknown as PrivateTransfersLike,
    { submit: async () => ({ transactionHash: "0xaborted" }) },
    "0x222",
    vaultAddress,
    replayToken,
    async () => 123,
  );

  const result = await vault.abortAuction(7n, 0x555n);

  assert.equal(selectedInput, replayNote);
  assert.deepEqual(transferOutput, { recipient: vaultAddress, amount: 5n });
  assert.deepEqual(action?.({}), {
    contractAddress: "0x222",
    computeAdditionalData: [2n, 7n, 0x555n],
    invokeAdditionalData: [],
  });
  assert.deepEqual(result, { transactionHash: "0xaborted" });
});

test("refuses bid acceptance when no mature vault replay note is available", async () => {
  const replayToken = 0x444n;
  let built = false;
  const transfers = {
    discoverNotes: async () => ({
      notes: new Map([
        [
          replayToken,
          [
            { id: 101n, amount: 50n, sender: vaultAddress },
            { id: 77n, amount: 5n, sender: 0x999n },
          ],
        ],
      ]),
    }),
    build: () => {
      built = true;
      throw new Error("must not build without a replay note");
    },
  } as unknown as PrivateTransfersLike;
  const vault = new Strk20VaultClient(
    transfers,
    { submit: async () => ({ transactionHash: "0x1" }) },
    "0x222",
    vaultAddress,
    replayToken,
    async () => 123,
  );

  await assert.rejects(
    vault.acceptBid(7n, 10n, 101n),
    /no mature vault-owned replay note is available/,
  );
  assert.equal(built, false);
});

test("loads the Sepolia prover, discovery, RPC, and pool preset", () => {
  const config = loadOperatorRuntimeConfig({
    WHISPER_NETWORK: "sepolia",
    WHISPER_CONTRACT_ADDRESS: "0x111",
    WHISPER_VAULT_ADDRESS: "0x222",
    WHISPER_VAULT_PUBLIC_KEY: "0x333",
    WHISPER_REVEAL_PUBLIC_KEY: "0x444",
    WHISPER_DEPLOYMENT_BLOCK: "123",
  });

  assert.equal(config.chainId, SEPOLIA_OPERATOR_NETWORK.chainId);
  assert.equal(config.rpcUrl, `${SEPOLIA_OPERATOR_NETWORK.rpcUrl}/`);
  assert.equal(config.discoveryMode, "contract");
  assert.equal(config.discoveryUrl, `${SEPOLIA_OPERATOR_NETWORK.discoveryUrl}/`);
  assert.equal(config.provingUrl, `${SEPOLIA_OPERATOR_NETWORK.provingUrl}/`);
  assert.equal(config.poolAddress, SEPOLIA_OPERATOR_NETWORK.poolAddress);
  assert.equal(config.replayTokenAddress, SEPOLIA_OPERATOR_NETWORK.replayTokenAddress);
  assert.equal(config.proceedsRecipient, 0x222n);
  assert.equal(config.provingBlockLag, 10);
  assert.equal(config.provingTimeoutMilliseconds, 30_000);
});

test("allows explicit endpoint overrides on the Sepolia preset", () => {
  const config = loadOperatorRuntimeConfig({
    WHISPER_NETWORK: "sepolia",
    WHISPER_PROVING_URL: "https://self-hosted-prover.example",
    WHISPER_PROVING_TIMEOUT_MS: "3600000",
    WHISPER_CONTRACT_ADDRESS: "0x111",
    WHISPER_VAULT_ADDRESS: "0x222",
    WHISPER_VAULT_PUBLIC_KEY: "0x333",
    WHISPER_REVEAL_PUBLIC_KEY: "0x444",
    WHISPER_PROCEEDS_RECIPIENT: "0x555",
    WHISPER_DEPLOYMENT_BLOCK: "123",
  });

  assert.equal(config.provingUrl, "https://self-hosted-prover.example/");
  assert.equal(config.provingTimeoutMilliseconds, 3_600_000);
  assert.equal(config.discoveryUrl, `${SEPOLIA_OPERATOR_NETWORK.discoveryUrl}/`);
  assert.equal(config.proceedsRecipient, 0x555n);
});

test("rejects a viewing public key as the configured proceeds recipient", () => {
  assert.throws(
    () =>
      loadOperatorRuntimeConfig({
        WHISPER_NETWORK: "sepolia",
        WHISPER_CONTRACT_ADDRESS: "0x111",
        WHISPER_VAULT_ADDRESS: "0x222",
        WHISPER_VAULT_PUBLIC_KEY: "0x333",
        WHISPER_REVEAL_PUBLIC_KEY: "0x444",
        WHISPER_PROCEEDS_RECIPIENT: "0x333",
        WHISPER_DEPLOYMENT_BLOCK: "123",
      }),
    /must be a Starknet account address, not WHISPER_VAULT_PUBLIC_KEY/,
  );
});

test("loads owner-only operator secret files and validates their public identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "whisper-operator-secrets-"));
  const accountPath = join(directory, "accounts.json");
  const operatorPath = join(directory, "operator.json");
  const config = loadOperatorRuntimeConfig({
    WHISPER_NETWORK: "sepolia",
    WHISPER_CONTRACT_ADDRESS: "0x111",
    WHISPER_VAULT_ADDRESS: "0x222",
    WHISPER_VAULT_PUBLIC_KEY: "0x333",
    WHISPER_REVEAL_PUBLIC_KEY: "0x444",
    WHISPER_DEPLOYMENT_BLOCK: "123",
  });
  writeFileSync(
    accountPath,
    JSON.stringify({
      "alpha-sepolia": {
        whisper_sepolia_vault: { address: "0x222", private_key: "vault-private" },
        whisper_sepolia_relayer: { address: "0x555", private_key: "relayer-private" },
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    operatorPath,
    JSON.stringify({
      vault_address: "0x222",
      relayer_address: "0x555",
      vault_viewing_private_key: "viewing-private",
      vault_viewing_public_key: "0x333",
      capsule_reveal_private_key: "reveal-private",
      capsule_reveal_public_key: "0x444",
      whisper_address: "0x111",
    }),
    { mode: 0o600 },
  );
  try {
    const secrets = loadOperatorSecretMaterial(
      {
        WHISPER_NETWORK: "sepolia",
        WHISPER_ACCOUNT_FILE: accountPath,
        WHISPER_OPERATOR_SECRETS_FILE: operatorPath,
      },
      config,
    );
    assert.deepEqual(secrets, {
      vaultPrivateKey: "vault-private",
      relayerAddress: "0x555",
      relayerPrivateKey: "relayer-private",
      vaultViewingPrivateKey: "viewing-private",
      capsuleRevealPrivateKey: "reveal-private",
    });

    chmodSync(operatorPath, 0o644);
    assert.throws(
      () =>
        loadOperatorSecretMaterial(
          {
            WHISPER_NETWORK: "sepolia",
            WHISPER_ACCOUNT_FILE: accountPath,
            WHISPER_OPERATOR_SECRETS_FILE: operatorPath,
          },
          config,
        ),
      /owner-only/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("assembles and validates the service without persisting its key material", async () => {
  const viewingKey = 0x456n;
  const capsuleKey = 0x789n;
  const signer = {} as SignerInterface;
  const transfers = {
    discoverNotes: async () => ({ notes: new Map() }),
    build: () => {
      throw new Error("not used");
    },
  } as unknown as PrivateTransfersLike;
  const provider = {
    getChainId: async () => constants.StarknetChainId.SN_MAIN,
    callContract: async (call: { entrypoint: string }) => {
      if (call.entrypoint === "get_pool_address") return [hex(poolAddress)];
      throw new Error("unexpected call");
    },
  } as unknown as ProviderInterface;
  const vaultAccount = { address: hex(vaultAddress), signer } as unknown as Account;
  const service = await createOperatorService({
    config: {
      chainId,
      rpcUrl: "https://rpc.example.com/",
      discoveryMode: "indexer",
      discoveryUrl: "https://discovery.example.com/",
      provingUrl: "https://prover.example.com/",
      poolAddress,
      whisperAddress,
      vaultAddress,
      vaultPublicKey: deriveWhisperRevealPublicKey(viewingKey),
      revealPublicKey: deriveWhisperRevealPublicKey(capsuleKey),
      replayTokenAddress: 0x444n,
      proceedsRecipient: 0x999n,
      databasePath: ":memory:",
      allowedOrigins: [],
      deploymentBlock: 1,
      provingBlockLag: 10,
      provingTimeoutMilliseconds: 30_000,
      apiHost: "127.0.0.1",
      apiPort: 8081,
      pollIntervalMilliseconds: 10_000,
    },
    provider,
    vaultAccount,
    relayerAccount: { address: "0xabc" } as unknown as Account,
    viewingKeyProvider: { getViewingKey: async () => viewingKey },
    revealKeyProvider: { getRevealPrivateKey: async () => capsuleKey },
    proceedsRecipients: { getProceedsRecipient: async () => 0x999n },
    sdkModule: { createPrivateTransfers: () => transfers },
  });
  try {
    await service.validate();
    assert.deepEqual(await service.store.listTrackedAuctions(), []);
  } finally {
    await service.close();
  }
});

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}
