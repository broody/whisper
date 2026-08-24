import { computeBidGroupHandle, computeBidHandle } from "./hashes.ts";

export type FeltLike = bigint | number | string;

export interface WhisperBidIntent {
  whisperAddress: string;
  paymentToken: FeltLike;
  vaultAddress: FeltLike;
  auctionId: FeltLike;
  bidNonce: FeltLike;
  bidAmount: FeltLike;
  revealCommitment: FeltLike;
  refundCommitment: FeltLike;
  winnerCommitment: FeltLike;
}

export interface WhisperBidTopUpIntent {
  whisperAddress: string;
  paymentToken: FeltLike;
  vaultAddress: FeltLike;
  auctionId: FeltLike;
  groupHandle: FeltLike;
  bidAmount: FeltLike;
  revealCommitment: FeltLike;
}

/** Structural subset of the upstream STRK20 SDK's ComputeAndInvokeDetails. */
export interface ComputeAndInvokeDetails {
  contractAddress: string;
  computeAdditionalData: bigint[];
  invokeAdditionalData: bigint[];
}

/** Compatible with `PrivateTransfersBuilder.computeAndInvoke(...)`. */
export type ComputeAndInvokeBuilder = (_args: unknown) => ComputeAndInvokeDetails;

export interface Strk20TransferAction {
  type: "transfer";
  token: string;
  amount: string;
  recipient: string;
}

export interface Strk20InvokeAction {
  type: "invoke";
  contract: string;
  calldata: string[];
}

export type WhisperWalletBidActions = [Strk20TransferAction, Strk20InvokeAction];

export interface WhisperBidComposition {
  groupHandle: bigint;
  bidHandle: bigint;
  actions: WhisperWalletBidActions;
}

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
  if (parsed < 0n) throw new RangeError(`${name} must be non-negative`);
  if (parsed > MAX_FELT) throw new RangeError(`${name} exceeds felt252`);
  return parsed;
}

export function positiveFelt(name: string, value: FeltLike): bigint {
  const parsed = felt(name, value);
  if (parsed === 0n) throw new RangeError(`${name} must be non-zero`);
  return parsed;
}

export function u64(name: string, value: FeltLike): bigint {
  const parsed = positiveFelt(name, value);
  if (parsed > MAX_U64) throw new RangeError(`${name} exceeds u64`);
  return parsed;
}

export function u128(name: string, value: FeltLike): bigint {
  const parsed = felt(name, value);
  if (parsed > MAX_U128) throw new RangeError(`${name} exceeds u128`);
  return parsed;
}

function positiveU128(name: string, value: FeltLike): bigint {
  const parsed = u128(name, value);
  if (parsed === 0n) throw new RangeError(`${name} must be non-zero`);
  return parsed;
}

function hex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

/** Serializes `WalletBidRequest::SubmitBid` in exact Cairo enum and field order. */
export function encodeWhisperBidIntent(intent: WhisperBidIntent): bigint[] {
  return [
    0n,
    u64("auctionId", intent.auctionId),
    positiveFelt("bidNonce", intent.bidNonce),
    positiveFelt("revealCommitment", intent.revealCommitment),
    positiveFelt("refundCommitment", intent.refundCommitment),
    positiveFelt("winnerCommitment", intent.winnerCommitment),
  ];
}

/** Serializes `WalletBidRequest::AddBidTranche` in exact Cairo enum and field order. */
export function encodeWhisperBidTopUpIntent(intent: WhisperBidTopUpIntent): bigint[] {
  return [
    1n,
    u64("auctionId", intent.auctionId),
    positiveFelt("groupHandle", intent.groupHandle),
    positiveFelt("revealCommitment", intent.revealCommitment),
  ];
}

/**
 * Compose the Wallet API's atomic private transfer + standard invoke request.
 * The connected privacy wallet owns note selection, proving, and relaying.
 */
export function buildWhisperBidActions(intent: WhisperBidIntent): WhisperBidComposition {
  const auctionId = u64("auctionId", intent.auctionId);
  const bidNonce = positiveFelt("bidNonce", intent.bidNonce);
  const revealCommitment = positiveFelt("revealCommitment", intent.revealCommitment);
  const refundCommitment = positiveFelt("refundCommitment", intent.refundCommitment);
  const winnerCommitment = positiveFelt("winnerCommitment", intent.winnerCommitment);
  const groupHandle = computeBidGroupHandle(
    auctionId,
    bidNonce,
    refundCommitment,
    winnerCommitment,
  );
  const bidHandle = computeBidHandle(auctionId, groupHandle, 0n, revealCommitment);
  return {
    groupHandle,
    bidHandle,
    actions: walletActions(intent, encodeWhisperBidIntent(intent)),
  };
}

/** Compose an additive encrypted-note tranche for an existing logical bid. */
export function buildWhisperBidTopUpActions(
  intent: WhisperBidTopUpIntent,
): WhisperWalletBidActions {
  return walletActions(intent, encodeWhisperBidTopUpIntent(intent));
}

function walletActions(
  intent: {
    whisperAddress: string;
    paymentToken: FeltLike;
    vaultAddress: FeltLike;
    bidAmount: FeltLike;
  },
  invokeCalldata: readonly bigint[],
): WhisperWalletBidActions {
  const whisperAddress = positiveFelt("whisperAddress", intent.whisperAddress);
  const paymentToken = positiveFelt("paymentToken", intent.paymentToken);
  const vaultAddress = positiveFelt("vaultAddress", intent.vaultAddress);
  const bidAmount = positiveU128("bidAmount", intent.bidAmount);
  return [
    {
      type: "transfer",
      token: hex(paymentToken),
      amount: hex(bidAmount),
      recipient: hex(vaultAddress),
    },
    {
      type: "invoke",
      contract: hex(whisperAddress),
      calldata: invokeCalldata.map(hex),
    },
  ];
}
