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
import {
  Account,
  constants,
  hash,
  type EventFilter,
  type ProviderInterface,
  type SignerInterface,
} from "starknet";

import { createOperatorApi } from "./api.ts";
import { WhisperSdkCapsuleCipher } from "./capsule-cipher.ts";
import { loadOperatorRuntimeConfig } from "./config.ts";
import { WhisperOperator } from "./engine.ts";
import { SEPOLIA_OPERATOR_NETWORK } from "./networks.ts";
import { createOfficialVaultRuntime, type OfficialPrivacySdkModule } from "./official-sdk.ts";
import { createOperatorService } from "./service.ts";
import { StarknetWhisperChain } from "./starknet-chain.ts";
import { SqliteOperatorStore } from "./sqlite-store.ts";
import { InMemoryOperatorStore, type OperatorStore } from "./store.ts";
import { Strk20VaultClient, type PrivateTransfersLike } from "./strk20-vault.ts";
import type {
  AuctionView,
  BidSubmissionEvent,
  BidView,
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
  assert.match(waiting.error ?? "", /not discoverable yet/);

  context.vault.notes.push(fixture.note);
  const funded = await context.operator.processSubmission(7n, 10n);
  assert.equal(funded.status, "funded");
  assert.equal(funded.noteId, 101n);
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
  const bid = (handle: bigint, noteId: bigint) =>
    [7n, handle, handle + 100n, 0n, noteId, handle + 2n, handle + 3n, handle + 4n, 80n, 1n, 0n]
      .map(hex);
  const provider = {
    async callContract(call: { entrypoint: string; calldata?: readonly string[] }) {
      if (call.entrypoint === "get_pool_address") return [hex(pool)];
      if (call.entrypoint === "get_auction") return auctionValues;
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
    submitter: { submit: async () => ({ transactionHash: "0x1" }) },
    sdkModule,
  });

  assert.equal(runtime.transfers, transfers);
  assert.equal(captured?.viewingKeyProvider, viewingKeyProvider);
  assert.equal(captured?.poolContractAddress, poolAddress);
  assert.equal(captured?.provingProvider.chainId, constants.StarknetChainId.SN_MAIN);
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
    async () => 123,
  );

  await vault.register();

  assert.deepEqual(executeOptions, { provingBlockId: 123 });
  assert.deepEqual(submitted, [callAndProof]);
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
  assert.equal(config.provingBlockLag, 10);
});

test("allows explicit endpoint overrides on the Sepolia preset", () => {
  const config = loadOperatorRuntimeConfig({
    WHISPER_NETWORK: "sepolia",
    WHISPER_PROVING_URL: "https://self-hosted-prover.example",
    WHISPER_CONTRACT_ADDRESS: "0x111",
    WHISPER_VAULT_ADDRESS: "0x222",
    WHISPER_VAULT_PUBLIC_KEY: "0x333",
    WHISPER_REVEAL_PUBLIC_KEY: "0x444",
    WHISPER_DEPLOYMENT_BLOCK: "123",
  });

  assert.equal(config.provingUrl, "https://self-hosted-prover.example/");
  assert.equal(config.discoveryUrl, `${SEPOLIA_OPERATOR_NETWORK.discoveryUrl}/`);
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
      databasePath: ":memory:",
      allowedOrigins: [],
      deploymentBlock: 1,
      provingBlockLag: 10,
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
