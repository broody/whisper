import { ec, shortString } from "starknet";

import { felt, positiveFelt, u64, type FeltLike } from "./bid-action.ts";

export const WHISPER_ASSET_WINNER_DOMAIN = BigInt(
  shortString.encodeShortString("WHISPER_ASSET_WINNER_V1"),
);

export const WhisperFulfillmentKind = {
  Offchain: 0n,
  Erc20: 1n,
  Erc721: 2n,
  Erc1155: 3n,
} as const;

export type WhisperFulfillmentKindValue =
  (typeof WhisperFulfillmentKind)[keyof typeof WhisperFulfillmentKind];

export interface WhisperAuctionFulfillment {
  kind: WhisperFulfillmentKindValue;
  token: FeltLike;
  tokenId: FeltLike;
  amount: FeltLike;
}

export interface WhisperAssetWinnerOpening {
  whisperAddress: FeltLike;
  auctionId: FeltLike;
  recipient: FeltLike;
  secret: FeltLike;
}

export const WHISPER_OFFCHAIN_FULFILLMENT = {
  kind: WhisperFulfillmentKind.Offchain,
  token: 0n,
  tokenId: 0n,
  amount: 0n,
} as const satisfies WhisperAuctionFulfillment;

const MAX_U256 = (1n << 256n) - 1n;
const LOW_MASK = (1n << 128n) - 1n;

/** Matches Cairo's fixed-width `AuctionFulfillment` field order. */
export function encodeWhisperAuctionFulfillment(
  fulfillment: WhisperAuctionFulfillment,
): [bigint, bigint, bigint, bigint, bigint, bigint] {
  const kind = fulfillmentKind(fulfillment.kind);
  const token = felt("fulfillment.token", fulfillment.token);
  const tokenId = u256("fulfillment.tokenId", fulfillment.tokenId);
  const amount = u256("fulfillment.amount", fulfillment.amount);
  validateFulfillmentShape(kind, token, tokenId, amount);
  return [kind, token, ...u256Parts(tokenId), ...u256Parts(amount)];
}

/** Opening used by the winner to claim an onchain asset from Whisper. */
export function computeAssetWinnerCommitment(input: WhisperAssetWinnerOpening): bigint {
  return ec.starkCurve.poseidonHashMany([
    WHISPER_ASSET_WINNER_DOMAIN,
    positiveFelt("whisperAddress", input.whisperAddress),
    u64("auctionId", input.auctionId),
    positiveFelt("recipient", input.recipient),
    positiveFelt("secret", input.secret),
  ]);
}

function fulfillmentKind(value: WhisperFulfillmentKindValue): bigint {
  const parsed = felt("fulfillment.kind", value);
  if (parsed < 0n || parsed > 3n) {
    throw new RangeError("fulfillment.kind is unsupported");
  }
  return parsed;
}

function u256(name: string, value: FeltLike): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be bigint-compatible`);
  }
  if (parsed < 0n) throw new RangeError(`${name} must be non-negative`);
  if (parsed > MAX_U256) throw new RangeError(`${name} exceeds u256`);
  return parsed;
}

function u256Parts(value: bigint): [bigint, bigint] {
  return [value & LOW_MASK, value >> 128n];
}

function validateFulfillmentShape(
  kind: bigint,
  token: bigint,
  tokenId: bigint,
  amount: bigint,
): void {
  if (kind === WhisperFulfillmentKind.Offchain) {
    if (token !== 0n || tokenId !== 0n || amount !== 0n) {
      throw new RangeError("offchain fulfillment token fields must be zero");
    }
    return;
  }
  if (token === 0n) throw new RangeError("onchain fulfillment token must be non-zero");
  if (kind === WhisperFulfillmentKind.Erc20) {
    if (tokenId !== 0n) throw new RangeError("ERC-20 tokenId must be zero");
    if (amount === 0n) throw new RangeError("ERC-20 amount must be non-zero");
  } else if (kind === WhisperFulfillmentKind.Erc721) {
    if (amount !== 1n) throw new RangeError("ERC-721 amount must equal one");
  } else if (amount === 0n) {
    throw new RangeError("ERC-1155 amount must be non-zero");
  }
}
