export type FeltLike = bigint | number | string;

export interface WhisperBidIntent {
  whisperAddress: string;
  auctionId: FeltLike;
  noteId: FeltLike;
  capsuleHash: FeltLike;
  refundCommitment: FeltLike;
  winnerCommitment: FeltLike;
}

/** Structural subset of the upstream STRK20 SDK's ComputeAndInvokeDetails. */
export interface ComputeAndInvokeDetails {
  contractAddress: string;
  computeAdditionalData: bigint[];
  invokeAdditionalData: bigint[];
}

/** Compatible with `PrivateTransfersBuilder.computeAndInvoke(...)`. */
export type ComputeAndInvokeBuilder = (_args: unknown) => ComputeAndInvokeDetails;

const MAX_U64 = (1n << 64n) - 1n;

function positiveFelt(name: string, value: FeltLike): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be bigint-compatible`);
  }
  if (parsed <= 0n) {
    throw new RangeError(`${name} must be non-zero`);
  }
  return parsed;
}

/** Serializes `BidIntent` in the exact Cairo field order. */
export function encodeWhisperBidIntent(intent: WhisperBidIntent): bigint[] {
  const auctionId = positiveFelt("auctionId", intent.auctionId);
  if (auctionId > MAX_U64) {
    throw new RangeError("auctionId exceeds u64");
  }

  return [
    auctionId,
    positiveFelt("noteId", intent.noteId),
    positiveFelt("capsuleHash", intent.capsuleHash),
    positiveFelt("refundCommitment", intent.refundCommitment),
    positiveFelt("winnerCommitment", intent.winnerCommitment),
  ];
}

/**
 * Builds the callback consumed by STRK20's `.computeAndInvoke(...)` builder.
 *
 * The pool privately prepends its derived identity key when calling Whisper's
 * `privacy_compute`; callers must never include or handle that key here.
 */
export function buildWhisperBidAction(intent: WhisperBidIntent): ComputeAndInvokeBuilder {
  positiveFelt("whisperAddress", intent.whisperAddress);
  const computeAdditionalData = encodeWhisperBidIntent(intent);

  return () => ({
    contractAddress: intent.whisperAddress,
    computeAdditionalData: [...computeAdditionalData],
    invokeAdditionalData: [],
  });
}
