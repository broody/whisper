import type { WhisperBidOpening, WhisperEncryptedCapsule } from "@whisper-trade/sdk";

export type AuctionStatus = "bidding" | "settled" | "aborted";

export interface AuctionView {
  id: bigint;
  paymentToken: bigint;
  proceedsRecipientCommitment: bigint;
  reservePrice: bigint;
  forceRevealAfter: number;
  abortAfter: number;
  vaultAddress: bigint;
  acceptedBidsHash: bigint;
  bidCount: number;
  status: AuctionStatus;
}

export interface BidView {
  auctionId: bigint;
  bidHandle: bigint;
  noteId: bigint;
  revealCommitment: bigint;
  refundCommitment: bigint;
  winnerCommitment: bigint;
  funded: boolean;
  settled: boolean;
}

export interface BidSubmissionEvent {
  auctionId: bigint;
  bidHandle: bigint;
  transactionHash: string;
  blockNumber: number;
}

export interface AuctionCreatedEvent {
  auctionId: bigint;
  transactionHash: string;
  blockNumber: number;
}

export interface WhisperEventBatch {
  auctions: AuctionCreatedEvent[];
  submissions: BidSubmissionEvent[];
}

export interface VaultNote {
  id: bigint;
  token: bigint;
  amount: bigint;
  createdBlock?: number;
  sender: bigint;
  /** Upstream SDK note object, retained only in memory for a later spend. */
  opaque: unknown;
}

export interface SettlementOutput {
  kind: "refund" | "winner-change" | "proceeds";
  recipient: bigint;
  amount: bigint;
  bidHandle: bigint;
}

export interface SettlementReveal {
  bidHandle: bigint;
  amount: bigint;
  salt: bigint;
}

export interface SettlementPlan {
  auction: AuctionView;
  notes: VaultNote[];
  reveals: SettlementReveal[];
  outputs: SettlementOutput[];
  winnerBidHandle: bigint;
  winningBid: bigint;
  secondHighestBid: bigint;
  clearingPrice: bigint;
  revealsRoot: bigint;
  outputsRoot: bigint;
  settlementHash: bigint;
}

export interface TransactionResult {
  transactionHash: string;
}

export interface WhisperChainPort {
  getAuction(auctionId: bigint): Promise<AuctionView>;
  getBid(auctionId: bigint, bidHandle: bigint): Promise<BidView>;
  getAcceptedBids(auctionId: bigint): Promise<BidView[]>;
  candidateVaultNoteIds(
    transactionHash: string,
    vaultAddress: bigint,
    paymentToken: bigint,
  ): Promise<bigint[]>;
}

export interface WhisperEventSource {
  getFinalizedBlockNumber(): Promise<number>;
  scanEvents(fromBlock: number, toBlock: number): Promise<WhisperEventBatch>;
}

export interface VaultPort {
  discoverNotes(paymentToken: bigint): Promise<VaultNote[]>;
  acceptBid(auctionId: bigint, bidHandle: bigint, noteId: bigint): Promise<TransactionResult>;
  settle(plan: SettlementPlan): Promise<TransactionResult>;
}

export interface CapsuleCipher {
  decrypt(
    envelope: WhisperEncryptedCapsule,
    context: {
      auctionId: bigint;
      revealCommitment: bigint;
    },
  ): Promise<WhisperBidOpening>;
}

export interface ProceedsRecipientProvider {
  getProceedsRecipient(auctionId: bigint): Promise<bigint>;
}

export interface Clock {
  nowSeconds(): number;
}

export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1_000),
};
