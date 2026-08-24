import {
  computeProceedsRecipientCommitment,
  computeRevealCommitment,
  type WhisperBidOpening,
} from "@whisper-trade/sdk";

import {
  computeOutputsRoot,
  computeRevealsRoot,
  computeSettlementHash,
  computeVickreyPrice,
} from "./settlement.ts";
import type { OperatorStore, SubmissionRecord } from "./store.ts";
import {
  systemClock,
  type BidSubmissionEvent,
  type BidView,
  type CapsuleCipher,
  type Clock,
  type ProceedsRecipientProvider,
  type SettlementOutput,
  type SettlementPlan,
  type SettlementReveal,
  type VaultNote,
  type VaultPort,
  type WhisperChainPort,
} from "./types.ts";

export class RetryableOperatorError extends Error {}
export class RejectedBidError extends Error {}

export interface WhisperOperatorDependencies {
  chain: WhisperChainPort;
  vault: VaultPort;
  capsules: CapsuleCipher;
  store: OperatorStore;
  proceedsRecipients: ProceedsRecipientProvider;
  clock?: Clock;
}

export class WhisperOperator {
  private readonly clock: Clock;

  constructor(private readonly dependencies: WhisperOperatorDependencies) {
    this.clock = dependencies.clock ?? systemClock;
  }

  async ingestSubmission(event: BidSubmissionEvent): Promise<SubmissionRecord> {
    await this.dependencies.store.recordSubmission(event);
    return this.processSubmission(event.auctionId, event.bidHandle);
  }

  async processSubmission(auctionId: bigint, bidHandle: bigint): Promise<SubmissionRecord> {
    const { chain, store, vault } = this.dependencies;
    const record = await store.getSubmission(auctionId, bidHandle);
    if (record === undefined) throw new Error("submission is not recorded");
    if (record.status === "funded" || record.status === "rejected") return record;

    try {
      const [auction, bid] = await Promise.all([
        chain.getAuction(auctionId),
        chain.getBid(auctionId, bidHandle),
      ]);
      if (bid.funded) {
        await store.markSubmissionFunded(
          auctionId,
          bidHandle,
          bid.noteId,
          "reconciled-onchain",
        );
        return (await store.getSubmission(auctionId, bidHandle))!;
      }
      if (auction.status !== "bidding") throw new RejectedBidError("auction is not bidding");
      if (this.clock.nowSeconds() >= auction.forceRevealAfter) {
        throw new RejectedBidError("bid acceptance window is closed");
      }
      if (auction.vaultAddress <= 0n) throw new RejectedBidError("auction vault is invalid");

      const envelope = await store.getCapsule(bid.revealCommitment);
      if (envelope === undefined) throw new RetryableOperatorError("encrypted capsule not found");
      const candidateIds = unique(
        await chain.candidateVaultNoteIds(
          record.transactionHash,
          auction.vaultAddress,
          auction.paymentToken,
        ),
      );
      const discovered = await vault.discoverNotes(auction.paymentToken);
      const opening = await this.dependencies.capsules.decrypt(envelope, {
        auctionId,
        revealCommitment: bid.revealCommitment,
      });
      const candidateNotes = discovered.filter(
        (note) => note.token === auction.paymentToken && candidateIds.has(note.id.toString()),
      );
      if (candidateNotes.length === 0) {
        throw new RetryableOperatorError("vault note is not discoverable yet");
      }
      const matchingNotes = candidateNotes.filter(
        (note) => note.amount === BigInt(opening.amount),
      );
      if (matchingNotes.length === 0) {
        throw new RejectedBidError("no candidate vault note matches capsule amount");
      }
      if (matchingNotes.length !== 1) {
        throw new RejectedBidError(
          `submission must create exactly one matching vault note; found ${matchingNotes.length}`,
        );
      }
      const note = matchingNotes[0]!;
      validateOpening(bid, note, opening);

      const claimed = await store.claimSubmission(auctionId, bidHandle);
      if (!claimed) return (await store.getSubmission(auctionId, bidHandle))!;
      const result = await vault.acceptBid(auctionId, bidHandle, note.id);
      await store.markSubmissionFunded(auctionId, bidHandle, note.id, result.transactionHash);
      return (await store.getSubmission(auctionId, bidHandle))!;
    } catch (error) {
      const message = safeError(error);
      if (error instanceof RejectedBidError) {
        await store.markSubmissionRejected(auctionId, bidHandle, message);
      } else {
        await store.markSubmissionRetry(auctionId, bidHandle, message);
      }
      return (await store.getSubmission(auctionId, bidHandle))!;
    }
  }

  async settleAuction(auctionId: bigint): Promise<SettlementPlan | undefined> {
    const { chain, store, vault } = this.dependencies;
    const auction = await chain.getAuction(auctionId);
    if (auction.status === "settled") {
      await store.markSettlementComplete(auctionId, "reconciled-onchain");
      return undefined;
    }
    if (auction.status !== "bidding") throw new Error("auction is not settleable");
    const now = this.clock.nowSeconds();
    if (now < auction.forceRevealAfter) throw new RetryableOperatorError("force reveal has not opened");
    if (now >= auction.abortAfter) throw new Error("settlement deadline has passed");

    const claimed = await store.claimSettlement(auctionId);
    if (!claimed) return undefined;

    try {
      const bids = await chain.getAcceptedBids(auctionId);
      if (bids.length !== auction.bidCount) {
        throw new RetryableOperatorError("accepted tranche set is incomplete");
      }
      const notes = await vault.discoverNotes(auction.paymentToken);
      const noteById = new Map(notes.map((note) => [note.id.toString(), note]));
      const openings: WhisperBidOpening[] = [];
      const consumedNotes: VaultNote[] = [];

      for (const bid of bids) {
        if (!bid.funded || bid.noteId === 0n) throw new Error("accepted bid is not funded");
        const record = await store.getSubmission(auctionId, bid.bidHandle);
        if (record?.status !== "funded" || record.noteId !== bid.noteId) {
          throw new RetryableOperatorError("local funded-bid record is incomplete");
        }
        const envelope = await store.getCapsule(bid.revealCommitment);
        if (envelope === undefined) throw new RetryableOperatorError("encrypted capsule not found");
        const note = noteById.get(bid.noteId.toString());
        if (note === undefined) throw new RetryableOperatorError("accepted vault note is unavailable");
        const opening = await this.dependencies.capsules.decrypt(envelope, {
          auctionId,
          revealCommitment: bid.revealCommitment,
        });
        validateOpening(bid, note, opening);
        openings.push(opening);
        consumedNotes.push(note);
      }

      const reveals: SettlementReveal[] = bids.map((bid, index) => ({
        bidHandle: bid.bidHandle,
        groupHandle: bid.groupHandle,
        amount: BigInt(openings[index]!.amount),
        salt: BigInt(openings[index]!.salt),
      }));
      const price = computeVickreyPrice(aggregateReveals(reveals), auction.reservePrice);
      const proceedsRecipient = await this.dependencies.proceedsRecipients.getProceedsRecipient(
        auctionId,
      );
      if (computeProceedsRecipientCommitment(proceedsRecipient) !== auction.proceedsRecipientCommitment) {
        throw new Error("proceeds recipient does not match auction commitment");
      }
      const outputs = buildOutputs(bids, openings, price.winnerBidHandle, price.clearingPrice, proceedsRecipient);
      const revealsRoot = computeRevealsRoot(auctionId, reveals);
      const outputsRoot = computeOutputsRoot(auctionId, outputs);
      const settlementHash = computeSettlementHash({
        auctionId,
        acceptedBidsHash: auction.acceptedBidsHash,
        winnerBidHandle: price.winnerBidHandle,
        revealsRoot,
        outputsRoot,
      });
      const plan: SettlementPlan = {
        auction,
        notes: consumedNotes,
        reveals,
        outputs,
        ...price,
        revealsRoot,
        outputsRoot,
        settlementHash,
      };
      const result = await vault.settle(plan);
      await store.markSettlementComplete(auctionId, result.transactionHash);
      return plan;
    } catch (error) {
      await store.markSettlementRetry(auctionId, safeError(error));
      throw error;
    }
  }
}

function validateOpening(
  bid: BidView,
  note: VaultNote,
  openingInput: WhisperBidOpening,
): void {
  const opening = {
    auctionId: BigInt(openingInput.auctionId),
    amount: BigInt(openingInput.amount),
    salt: BigInt(openingInput.salt),
    refundCommitment: BigInt(openingInput.refundCommitment),
    winnerCommitment: BigInt(openingInput.winnerCommitment),
  };
  if (opening.auctionId !== bid.auctionId) throw new RejectedBidError("capsule auction mismatch");
  if (opening.refundCommitment !== bid.refundCommitment) {
    throw new RejectedBidError("capsule refund commitment mismatch");
  }
  if (opening.winnerCommitment !== bid.winnerCommitment) {
    throw new RejectedBidError("capsule winner commitment mismatch");
  }
  if (
    computeRevealCommitment(
      opening.auctionId,
      opening.amount,
      opening.salt,
      opening.refundCommitment,
      opening.winnerCommitment,
    ) !== bid.revealCommitment
  ) {
    throw new RejectedBidError("capsule reveal commitment mismatch");
  }
  if (note.amount !== opening.amount) throw new RejectedBidError("vault note amount mismatch");
}

function buildOutputs(
  bids: readonly BidView[],
  openings: readonly WhisperBidOpening[],
  winnerBidHandle: bigint,
  clearingPrice: bigint,
  proceedsRecipient: bigint,
): SettlementOutput[] {
  const groups = new Map<string, { groupHandle: bigint; recipient: bigint; amount: bigint }>();
  bids.forEach((bid, index) => {
    const amount = BigInt(openings[index]!.amount);
    const recipient = BigInt(openings[index]!.refundRecipient);
    const key = bid.groupHandle.toString();
    const current = groups.get(key);
    if (current !== undefined && current.recipient !== recipient) {
      throw new Error("bid group has inconsistent refund recipients");
    }
    groups.set(key, {
      groupHandle: bid.groupHandle,
      recipient,
      amount: (current?.amount ?? 0n) + amount,
    });
  });
  const outputs: SettlementOutput[] = [];
  for (const group of groups.values()) {
    if (group.groupHandle === winnerBidHandle) {
      const change = group.amount - clearingPrice;
      if (change > 0n) {
        outputs.push({
          kind: "winner-change",
          recipient: group.recipient,
          amount: change,
          bidHandle: group.groupHandle,
        });
      }
    } else {
      outputs.push({
        kind: "refund",
        recipient: group.recipient,
        amount: group.amount,
        bidHandle: group.groupHandle,
      });
    }
  }
  if (clearingPrice > 0n) {
    outputs.push({
      kind: "proceeds",
      recipient: proceedsRecipient,
      amount: clearingPrice,
      bidHandle: winnerBidHandle,
    });
  }
  return outputs;
}

function aggregateReveals(reveals: readonly SettlementReveal[]): SettlementReveal[] {
  const groups = new Map<string, SettlementReveal>();
  for (const reveal of reveals) {
    const key = reveal.groupHandle.toString();
    const current = groups.get(key);
    groups.set(key, {
      bidHandle: reveal.groupHandle,
      groupHandle: reveal.groupHandle,
      amount: (current?.amount ?? 0n) + reveal.amount,
      salt: 0n,
    });
  }
  return [...groups.values()];
}

function unique(values: readonly bigint[]): Set<string> {
  return new Set(values.map((value) => value.toString()));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown operator error";
  return message.slice(0, 500);
}
