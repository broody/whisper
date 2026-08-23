import { ec, shortString } from "starknet";

const IDENTITY_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_ID_V1"));
const BID_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_BID_V1"));

export function computeIdentityCommitment(identityKey: bigint, auctionId: bigint): bigint {
  return ec.starkCurve.poseidonHashMany([IDENTITY_DOMAIN, identityKey, auctionId]);
}

export function computeBidHandle(
  auctionId: bigint,
  identityCommitment: bigint,
  noteId: bigint,
  capsuleHash: bigint,
  refundCommitment: bigint,
  winnerCommitment: bigint,
): bigint {
  return ec.starkCurve.poseidonHashMany([
    BID_DOMAIN,
    auctionId,
    identityCommitment,
    noteId,
    capsuleHash,
    refundCommitment,
    winnerCommitment,
  ]);
}
