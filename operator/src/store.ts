import type { WhisperEncryptedCapsule } from "@whisper-trade/sdk";

import type { BidSubmissionEvent } from "./types.ts";

export type SubmissionStatus = "received" | "accepting" | "retry" | "funded" | "rejected";
export type SettlementStatus = "pending" | "settling" | "retry" | "settled";

export interface SubmissionRecord extends BidSubmissionEvent {
  status: SubmissionStatus;
  noteId?: bigint;
  transactionHashResult?: string;
  error?: string;
}

export interface SettlementRecord {
  auctionId: bigint;
  status: SettlementStatus;
  transactionHash?: string;
  error?: string;
}

export interface OperatorStore {
  putCapsule(envelope: WhisperEncryptedCapsule): Promise<"created" | "exists" | "conflict">;
  getCapsule(revealCommitment: bigint): Promise<WhisperEncryptedCapsule | undefined>;

  recordSubmission(event: BidSubmissionEvent): Promise<SubmissionRecord>;
  getSubmission(auctionId: bigint, bidHandle: bigint): Promise<SubmissionRecord | undefined>;
  claimSubmission(auctionId: bigint, bidHandle: bigint): Promise<boolean>;
  markSubmissionRetry(auctionId: bigint, bidHandle: bigint, error: string): Promise<void>;
  markSubmissionRejected(auctionId: bigint, bidHandle: bigint, error: string): Promise<void>;
  markSubmissionFunded(
    auctionId: bigint,
    bidHandle: bigint,
    noteId: bigint,
    transactionHash: string,
  ): Promise<void>;

  getSettlement(auctionId: bigint): Promise<SettlementRecord | undefined>;
  claimSettlement(auctionId: bigint): Promise<boolean>;
  markSettlementRetry(auctionId: bigint, error: string): Promise<void>;
  markSettlementComplete(auctionId: bigint, transactionHash: string): Promise<void>;
}

function submissionKey(auctionId: bigint, bidHandle: bigint): string {
  return `${auctionId}:${bidHandle}`;
}

export class InMemoryOperatorStore implements OperatorStore {
  private readonly capsules = new Map<string, WhisperEncryptedCapsule>();
  private readonly submissions = new Map<string, SubmissionRecord>();
  private readonly settlements = new Map<string, SettlementRecord>();

  async putCapsule(
    envelope: WhisperEncryptedCapsule,
  ): Promise<"created" | "exists" | "conflict"> {
    const key = BigInt(envelope.revealCommitment).toString();
    const current = this.capsules.get(key);
    if (current === undefined) {
      this.capsules.set(key, structuredClone(envelope));
      return "created";
    }
    return JSON.stringify(current) === JSON.stringify(envelope) ? "exists" : "conflict";
  }

  async getCapsule(revealCommitment: bigint): Promise<WhisperEncryptedCapsule | undefined> {
    const value = this.capsules.get(revealCommitment.toString());
    return value === undefined ? undefined : structuredClone(value);
  }

  async recordSubmission(event: BidSubmissionEvent): Promise<SubmissionRecord> {
    const key = submissionKey(event.auctionId, event.bidHandle);
    const current = this.submissions.get(key);
    if (current !== undefined) return structuredClone(current);
    const created: SubmissionRecord = { ...event, status: "received" };
    this.submissions.set(key, created);
    return structuredClone(created);
  }

  async getSubmission(
    auctionId: bigint,
    bidHandle: bigint,
  ): Promise<SubmissionRecord | undefined> {
    const value = this.submissions.get(submissionKey(auctionId, bidHandle));
    return value === undefined ? undefined : structuredClone(value);
  }

  async claimSubmission(auctionId: bigint, bidHandle: bigint): Promise<boolean> {
    const key = submissionKey(auctionId, bidHandle);
    const value = this.submissions.get(key);
    if (value === undefined || !["received", "retry"].includes(value.status)) return false;
    value.status = "accepting";
    delete value.error;
    return true;
  }

  async markSubmissionRetry(auctionId: bigint, bidHandle: bigint, error: string): Promise<void> {
    this.updateSubmission(auctionId, bidHandle, { status: "retry", error });
  }

  async markSubmissionRejected(auctionId: bigint, bidHandle: bigint, error: string): Promise<void> {
    this.updateSubmission(auctionId, bidHandle, { status: "rejected", error });
  }

  async markSubmissionFunded(
    auctionId: bigint,
    bidHandle: bigint,
    noteId: bigint,
    transactionHash: string,
  ): Promise<void> {
    this.updateSubmission(auctionId, bidHandle, {
      status: "funded",
      noteId,
      transactionHashResult: transactionHash,
    });
    const value = this.submissions.get(submissionKey(auctionId, bidHandle));
    if (value !== undefined) delete value.error;
  }

  async getSettlement(auctionId: bigint): Promise<SettlementRecord | undefined> {
    const value = this.settlements.get(auctionId.toString());
    return value === undefined ? undefined : structuredClone(value);
  }

  async claimSettlement(auctionId: bigint): Promise<boolean> {
    const key = auctionId.toString();
    const current = this.settlements.get(key);
    if (current?.status === "settled" || current?.status === "settling") return false;
    this.settlements.set(key, { auctionId, status: "settling" });
    return true;
  }

  async markSettlementRetry(auctionId: bigint, error: string): Promise<void> {
    this.settlements.set(auctionId.toString(), { auctionId, status: "retry", error });
  }

  async markSettlementComplete(auctionId: bigint, transactionHash: string): Promise<void> {
    this.settlements.set(auctionId.toString(), {
      auctionId,
      status: "settled",
      transactionHash,
    });
  }

  private updateSubmission(
    auctionId: bigint,
    bidHandle: bigint,
    patch: Partial<SubmissionRecord>,
  ): void {
    const key = submissionKey(auctionId, bidHandle);
    const value = this.submissions.get(key);
    if (value === undefined) throw new Error("submission is not recorded");
    Object.assign(value, patch);
  }
}
