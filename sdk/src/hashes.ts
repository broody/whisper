import { ec, shortString } from "starknet";

const IDENTITY_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_ID_V1"));
const BID_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_BID_V1"));
const OPERATOR_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_OP_V1"));
const REVEAL_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_REVEAL_V1"));

export function computeIdentityCommitment(identityKey: bigint, auctionId: bigint): bigint {
  return ec.starkCurve.poseidonHashMany([IDENTITY_DOMAIN, identityKey, auctionId]);
}

export function computeOperatorIdentityCommitment(identityKey: bigint): bigint {
  return ec.starkCurve.poseidonHashMany([OPERATOR_DOMAIN, identityKey]);
}

export function computeRevealCommitment(
  auctionId: bigint,
  amount: bigint,
  salt: bigint,
  refundCommitment: bigint,
  winnerCommitment: bigint,
): bigint {
  return ec.starkCurve.poseidonHashMany([
    REVEAL_DOMAIN,
    auctionId,
    amount,
    salt,
    refundCommitment,
    winnerCommitment,
  ]);
}

export function computeBidHandle(
  auctionId: bigint,
  identityCommitment: bigint,
  revealCommitment: bigint,
  refundCommitment: bigint,
  winnerCommitment: bigint,
): bigint {
  return ec.starkCurve.poseidonHashMany([
    BID_DOMAIN,
    auctionId,
    identityCommitment,
    revealCommitment,
    refundCommitment,
    winnerCommitment,
  ]);
}
