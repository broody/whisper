import {
  felt,
  positiveFelt,
  u128,
  u64,
  type ComputeAndInvokeBuilder,
  type FeltLike,
} from "./bid-action.ts";

export interface WhisperActionTarget {
  whisperAddress: string;
}

export interface WhisperAcceptBid extends WhisperActionTarget {
  auctionId: FeltLike;
  bidHandle: FeltLike;
  noteId: FeltLike;
}

export interface WhisperRevealedBid {
  bidHandle: FeltLike;
  amount: FeltLike;
  salt: FeltLike;
}

export interface WhisperSettlement extends WhisperActionTarget {
  auctionId: FeltLike;
  acceptedBidsHash: FeltLike;
  revealedBids: readonly WhisperRevealedBid[];
  /** Zero only when the accepted bid set is empty. */
  winnerBidHandle: FeltLike;
  revealsRoot: FeltLike;
  outputsRoot: FeltLike;
  settlementHash: FeltLike;
}

export interface WhisperAbort extends WhisperActionTarget {
  auctionId: FeltLike;
  recoveryHash: FeltLike;
}

const MAX_SUPPORTED_BIDS = 256;

function buildAction(
  whisperAddress: string,
  computeAdditionalData: bigint[],
): ComputeAndInvokeBuilder {
  positiveFelt("whisperAddress", whisperAddress);
  return () => ({
    contractAddress: whisperAddress,
    computeAdditionalData: [...computeAdditionalData],
    invokeAdditionalData: [],
  });
}

/** Operator-only acknowledgement that the vault received and decrypted a matching note. */
export function buildWhisperAcceptBidAction(input: WhisperAcceptBid): ComputeAndInvokeBuilder {
  return buildAction(input.whisperAddress, [
    1n, // PrivacyRequest::AcceptBid
    u64("auctionId", input.auctionId),
    positiveFelt("bidHandle", input.bidHandle),
    positiveFelt("noteId", input.noteId),
  ]);
}

/**
 * Encodes the auction callback leg of an atomic settlement.
 *
 * Compose this callback with the vault's loser refunds, winner change, and
 * seller proceeds in the same STRK20 private-operation batch.
 */
export function buildWhisperSettlementAction(input: WhisperSettlement): ComputeAndInvokeBuilder {
  if (input.revealedBids.length > MAX_SUPPORTED_BIDS) {
    throw new RangeError(`revealedBids exceeds ${MAX_SUPPORTED_BIDS}`);
  }
  const winnerBidHandle = felt("winnerBidHandle", input.winnerBidHandle);
  if (input.revealedBids.length === 0 && winnerBidHandle !== 0n) {
    throw new RangeError("winnerBidHandle must be zero for an empty bid set");
  }
  if (input.revealedBids.length > 0 && winnerBidHandle === 0n) {
    throw new RangeError("winnerBidHandle must be non-zero for a non-empty bid set");
  }
  const revealedBids = input.revealedBids.flatMap((bid, index) => [
    positiveFelt(`revealedBids[${index}].bidHandle`, bid.bidHandle),
    u128(`revealedBids[${index}].amount`, bid.amount),
    felt(`revealedBids[${index}].salt`, bid.salt),
  ]);

  return buildAction(input.whisperAddress, [
    2n, // PrivacyRequest::Settle
    u64("auctionId", input.auctionId),
    positiveFelt("acceptedBidsHash", input.acceptedBidsHash),
    BigInt(input.revealedBids.length),
    ...revealedBids,
    winnerBidHandle,
    positiveFelt("revealsRoot", input.revealsRoot),
    positiveFelt("outputsRoot", input.outputsRoot),
    positiveFelt("settlementHash", input.settlementHash),
  ]);
}

/** Operator-only terminal recovery record after the auction's abort deadline. */
export function buildWhisperAbortAction(input: WhisperAbort): ComputeAndInvokeBuilder {
  return buildAction(input.whisperAddress, [
    3n, // PrivacyRequest::Abort
    u64("auctionId", input.auctionId),
    positiveFelt("recoveryHash", input.recoveryHash),
  ]);
}
