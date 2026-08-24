import { ec, shortString } from "starknet";

import type { SettlementOutput, SettlementReveal } from "./types.ts";

const REVEALS_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_REVEALS_V1"));
const OUTPUTS_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_OUTPUTS_V1"));
const SETTLEMENT_DOMAIN = BigInt(shortString.encodeShortString("WHISPER_SETTLEMENT_V1"));
const MAX_U128 = (1n << 128n) - 1n;

export interface VickreyPrice {
  winnerBidHandle: bigint;
  winningBid: bigint;
  secondHighestBid: bigint;
  clearingPrice: bigint;
}

export function computeVickreyPrice(
  reveals: readonly SettlementReveal[],
  reservePrice: bigint,
): VickreyPrice {
  assertU128("reservePrice", reservePrice);
  if (reveals.length === 0) {
    return {
      winnerBidHandle: 0n,
      winningBid: 0n,
      secondHighestBid: 0n,
      clearingPrice: 0n,
    };
  }
  const ranked = reveals.filter((reveal) => reveal.amount >= reservePrice).sort((left, right) => {
    if (left.amount !== right.amount) return left.amount > right.amount ? -1 : 1;
    if (left.bidHandle === right.bidHandle) return 0;
    return left.bidHandle < right.bidHandle ? -1 : 1;
  });
  for (const [index, reveal] of ranked.entries()) {
    assertPositive(`reveals[${index}].bidHandle`, reveal.bidHandle);
    assertU128(`reveals[${index}].amount`, reveal.amount);
  }
  if (ranked.length === 0) {
    return {
      winnerBidHandle: 0n,
      winningBid: 0n,
      secondHighestBid: 0n,
      clearingPrice: 0n,
    };
  }
  const winner = ranked[0]!;
  const secondHighestBid = ranked[1]?.amount ?? 0n;
  return {
    winnerBidHandle: winner.bidHandle,
    winningBid: winner.amount,
    secondHighestBid,
    clearingPrice: secondHighestBid > reservePrice ? secondHighestBid : reservePrice,
  };
}

export function computeRevealsRoot(
  auctionId: bigint,
  reveals: readonly SettlementReveal[],
): bigint {
  return ec.starkCurve.poseidonHashMany([
    REVEALS_DOMAIN,
    auctionId,
    BigInt(reveals.length),
    ...reveals.flatMap((reveal) => [reveal.bidHandle, reveal.amount, reveal.salt]),
  ]);
}

export function computeOutputsRoot(
  auctionId: bigint,
  outputs: readonly SettlementOutput[],
): bigint {
  return ec.starkCurve.poseidonHashMany([
    OUTPUTS_DOMAIN,
    auctionId,
    BigInt(outputs.length),
    ...outputs.flatMap((output) => [
      outputKind(output.kind),
      output.recipient,
      output.amount,
      output.bidHandle,
    ]),
  ]);
}

export function computeSettlementHash(input: {
  auctionId: bigint;
  acceptedBidsHash: bigint;
  winnerBidHandle: bigint;
  revealsRoot: bigint;
  outputsRoot: bigint;
}): bigint {
  return ec.starkCurve.poseidonHashMany([
    SETTLEMENT_DOMAIN,
    input.auctionId,
    input.acceptedBidsHash,
    input.winnerBidHandle,
    input.revealsRoot,
    input.outputsRoot,
  ]);
}

function outputKind(kind: SettlementOutput["kind"]): bigint {
  switch (kind) {
    case "refund":
      return 0n;
    case "winner-change":
      return 1n;
    case "proceeds":
      return 2n;
  }
}

function assertPositive(name: string, value: bigint): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function assertU128(name: string, value: bigint): void {
  if (value < 0n || value > MAX_U128) throw new RangeError(`${name} exceeds u128`);
}
