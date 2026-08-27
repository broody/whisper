import { computeRefundCommitment } from "@whisper-trade/sdk";

import type { OperatorStore, RecoveryRecord, SubmissionRecord } from "./store.ts";
import type {
  CapsuleCipher,
  Clock,
  RecoveryPlan,
  RecoveryVaultPort,
  WhisperChainPort,
} from "./types.ts";
import { systemClock } from "./types.ts";

export interface AuctionRecoveryDependencies {
  chain: WhisperChainPort;
  vault: RecoveryVaultPort;
  capsules: CapsuleCipher;
  store: OperatorStore;
  clock?: Clock;
}

export interface AuctionRecoveryResult {
  transactionHash: string;
  recoveredBidCount: number;
  alreadyCompleted: boolean;
}

/** Builds and executes an exact-note refund for bids rejected before funding. */
export class AuctionRecovery {
  private readonly clock: Clock;

  constructor(private readonly dependencies: AuctionRecoveryDependencies) {
    this.clock = dependencies.clock ?? systemClock;
  }

  async plan(auctionId: bigint): Promise<RecoveryPlan> {
    const { chain, store, vault } = this.dependencies;
    const auction = await chain.getAuction(auctionId);
    if (auction.status === "pending") throw new Error("pending auction cannot be recovered");
    if (auction.status === "bidding" && this.clock.nowSeconds() < auction.forceRevealAfter) {
      throw new Error("bid acceptance window is still open");
    }

    const submissions = await store.listSubmissions(auctionId);
    if (submissions.length === 0) throw new Error("auction has no recorded bid submissions");
    const notes = await vault.discoverNotes(auction.paymentToken);
    const usedNoteIds = new Set<string>();
    const refunds: RecoveryPlan["refunds"] = [];

    for (const submission of submissions) {
      const bid = await chain.getBid(auctionId, submission.bidHandle);
      if (bid.funded || bid.noteId !== 0n) continue;
      assertRecoverableSubmission(submission);
      const capsule = await store.getCapsule(bid.revealCommitment);
      if (capsule === undefined) throw new Error("encrypted capsule is missing for rejected bid");
      const opening = await this.dependencies.capsules.decrypt(capsule, {
        auctionId,
        revealCommitment: bid.revealCommitment,
      });
      const amount = BigInt(opening.amount);
      const recipient = BigInt(opening.refundRecipient);
      if (
        BigInt(opening.refundCommitment) !== bid.refundCommitment ||
        computeRefundCommitment(recipient) !== bid.refundCommitment
      ) {
        throw new Error("recovery refund recipient does not match the bid commitment");
      }
      if (BigInt(opening.winnerCommitment) !== bid.winnerCommitment) {
        throw new Error("recovery capsule winner commitment does not match the bid");
      }
      const candidates = new Set(
        (
          await chain.candidateVaultNoteIds(
            submission.transactionHash,
            auction.vaultAddress,
            auction.paymentToken,
          )
        ).map(String),
      );
      const matching = notes.filter(
        (note) =>
          note.token === auction.paymentToken &&
          note.amount === amount &&
          candidates.has(note.id.toString()),
      );
      if (matching.length !== 1) {
        throw new Error(
          `rejected bid must resolve to exactly one unspent vault note; found ${matching.length}`,
        );
      }
      const note = matching[0]!;
      if (usedNoteIds.has(note.id.toString())) {
        throw new Error("multiple rejected bids resolve to the same vault note");
      }
      usedNoteIds.add(note.id.toString());
      refunds.push({ note, recipient });
    }

    if (refunds.length === 0) throw new Error("auction has no recoverable rejected bids");
    return { auctionId, paymentToken: auction.paymentToken, refunds };
  }

  async recover(auctionId: bigint): Promise<AuctionRecoveryResult> {
    return this.recoverPlan(await this.plan(auctionId));
  }

  async recoverPlan(plan: RecoveryPlan): Promise<AuctionRecoveryResult> {
    const { store, vault } = this.dependencies;
    const existing = await store.getRecovery(plan.auctionId);
    if (existing?.status === "completed") return completed(existing);
    if (existing?.status === "recovering") {
      throw new Error("auction recovery is already in progress; reconcile it before retrying");
    }
    if (!(await store.claimRecovery(plan.auctionId))) {
      throw new Error("auction recovery could not be claimed");
    }
    try {
      const result = await vault.refundUnacceptedBids(plan);
      await store.completeRecovery(plan.auctionId, result.transactionHash);
      return {
        transactionHash: result.transactionHash,
        recoveredBidCount: plan.refunds.length,
        alreadyCompleted: false,
      };
    } catch (error) {
      await store.failRecovery(plan.auctionId, safeError(error));
      throw error;
    }
  }
}

function assertRecoverableSubmission(submission: SubmissionRecord): void {
  if (submission.status !== "rejected") {
    throw new Error("unfunded bid must be rejected before recovery");
  }
}

function completed(record: RecoveryRecord): AuctionRecoveryResult {
  if (record.transactionHash === undefined) {
    throw new Error("completed auction recovery is missing its transaction hash");
  }
  return {
    transactionHash: record.transactionHash,
    recoveredBidCount: 0,
    alreadyCompleted: true,
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown recovery error";
}
