import { u64, type FeltLike } from "./bid-action.ts";

export const WhisperAuctionScheduleKind = {
  Absolute: 0n,
  StartOnBid: 1n,
} as const;

export type WhisperAuctionSchedule =
  | {
      kind: typeof WhisperAuctionScheduleKind.Absolute;
      biddingDeadline: FeltLike;
      forceRevealAfter: FeltLike;
      abortAfter: FeltLike;
    }
  | {
      kind: typeof WhisperAuctionScheduleKind.StartOnBid;
      biddingDuration: FeltLike;
      acceptanceDuration: FeltLike;
      settlementDuration: FeltLike;
    };

/** Matches Cairo's `AuctionSchedule` discriminant and fixed-width variant payload. */
export function encodeWhisperAuctionSchedule(
  schedule: WhisperAuctionSchedule,
): [bigint, bigint, bigint, bigint] {
  if (schedule.kind === WhisperAuctionScheduleKind.Absolute) {
    const biddingDeadline = u64("schedule.biddingDeadline", schedule.biddingDeadline);
    const forceRevealAfter = u64("schedule.forceRevealAfter", schedule.forceRevealAfter);
    const abortAfter = u64("schedule.abortAfter", schedule.abortAfter);
    if (forceRevealAfter <= biddingDeadline) {
      throw new RangeError("schedule.forceRevealAfter must follow biddingDeadline");
    }
    if (abortAfter <= forceRevealAfter) {
      throw new RangeError("schedule.abortAfter must follow forceRevealAfter");
    }
    return [WhisperAuctionScheduleKind.Absolute, biddingDeadline, forceRevealAfter, abortAfter];
  }

  return [
    WhisperAuctionScheduleKind.StartOnBid,
    u64("schedule.biddingDuration", schedule.biddingDuration),
    u64("schedule.acceptanceDuration", schedule.acceptanceDuration),
    u64("schedule.settlementDuration", schedule.settlementDuration),
  ];
}
