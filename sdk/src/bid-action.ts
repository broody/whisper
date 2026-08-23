export type FeltLike = bigint | number | string;

export interface WhisperBidIntent {
  whisperAddress: string;
  auctionId: FeltLike;
  revealCommitment: FeltLike;
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

export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;
export const MAX_FELT = (1n << 251n) + 17n * (1n << 192n);

export function felt(name: string, value: FeltLike): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be bigint-compatible`);
  }
  if (parsed < 0n) {
    throw new RangeError(`${name} must be non-negative`);
  }
  if (parsed > MAX_FELT) {
    throw new RangeError(`${name} exceeds felt252`);
  }
  return parsed;
}

export function positiveFelt(name: string, value: FeltLike): bigint {
  const parsed = felt(name, value);
  if (parsed === 0n) {
    throw new RangeError(`${name} must be non-zero`);
  }
  return parsed;
}

export function u64(name: string, value: FeltLike): bigint {
  const parsed = positiveFelt(name, value);
  if (parsed > MAX_U64) {
    throw new RangeError(`${name} exceeds u64`);
  }
  return parsed;
}

export function u128(name: string, value: FeltLike): bigint {
  const parsed = felt(name, value);
  if (parsed > MAX_U128) {
    throw new RangeError(`${name} exceeds u128`);
  }
  return parsed;
}

/** Serializes `BidIntent` in the exact Cairo field order. */
export function encodeWhisperBidIntent(intent: WhisperBidIntent): bigint[] {
  return [
    0n, // PrivacyRequest::SubmitBid
    u64("auctionId", intent.auctionId),
    positiveFelt("revealCommitment", intent.revealCommitment),
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
