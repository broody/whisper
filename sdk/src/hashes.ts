import { ec, shortString } from "starknet";

const BID_GROUP_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_GROUP_V1"));
const BID_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_TRANCHE_V1"));
const OPERATOR_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_OP_V1"));
const REVEAL_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_REVEAL_V1"));
const REFUND_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_REFUND_V1"));
const PROCEEDS_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_PROCEEDS_V1"));

export function computeBidGroupHandle(
  auctionId: bigint,
  bidNonce: bigint,
  refundCommitment: bigint,
  winnerCommitment: bigint,
): bigint {
  return ec.starkCurve.poseidonHashMany([
    BID_GROUP_DOMAIN,
    auctionId,
    bidNonce,
    refundCommitment,
    winnerCommitment,
  ]);
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
  groupHandle: bigint,
  trancheIndex: bigint,
  revealCommitment: bigint,
): bigint {
  return ec.starkCurve.poseidonHashMany([
    BID_DOMAIN,
    auctionId,
    groupHandle,
    trancheIndex,
    revealCommitment,
  ]);
}

/** Default commitment for a private refund routing address. */
export function computeRefundCommitment(recipient: bigint): bigint {
  return ec.starkCurve.poseidonHashMany([REFUND_DOMAIN, recipient]);
}

/** Default commitment for an auction's private proceeds routing address. */
export function computeProceedsRecipientCommitment(recipient: bigint): bigint {
  return ec.starkCurve.poseidonHashMany([PROCEEDS_DOMAIN, recipient]);
}
