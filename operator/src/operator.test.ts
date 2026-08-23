import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
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

import { createOperatorApi } from "./api.ts";
import { WhisperSdkCapsuleCipher } from "./capsule-cipher.ts";
import { WhisperOperator } from "./engine.ts";
import { SqliteOperatorStore } from "./sqlite-store.ts";
import { InMemoryOperatorStore, type OperatorStore } from "./store.ts";
import type {
  AuctionView,
  BidSubmissionEvent,
  BidView,
  SettlementPlan,
  VaultNote,
  VaultPort,
  WhisperChainPort,
} from "./types.ts";

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

  async getAuction(): Promise<AuctionView> {
    return { ...this.auction };
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
  const chain = new MemoryChain();
  const proceedsRecipient = 0x999n;
  chain.auction = {
    id: 7n,
    paymentToken: 0x444n,
    proceedsRecipientCommitment: computeProceedsRecipientCommitment(proceedsRecipient),
    reservePrice: 50n,
    forceRevealAfter: 100,
    abortAfter: 300,
    vaultAddress,
    acceptedBidsHash: 0xabcn,
    bidCount: 0,
    status: "bidding",
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
    clock: { nowSeconds: () => 200 },
  });
  return { chain, vault, store, operator };
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

test("fails closed when a submission transaction creates multiple candidate notes", async () => {
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
  } finally {
    store.close();
  }
});

test("serves public vault configuration and accepts idempotent capsule uploads", async () => {
  const store = new InMemoryOperatorStore();
  const server = createOperatorApi({
    store,
    publicConfig: {
      chainId,
      poolAddress,
      whisperAddress,
      vaultAddress,
      vaultPublicKey: 0x777n,
      revealPublicKey,
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
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
