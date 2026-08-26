import assert from "node:assert/strict";
import test from "node:test";

import {
  WhisperAuctionScheduleKind,
  encodeWhisperAuctionSchedule,
} from "./schedule.ts";

test("encodes absolute and start-on-bid auction schedules", () => {
  assert.deepEqual(
    encodeWhisperAuctionSchedule({
      kind: WhisperAuctionScheduleKind.Absolute,
      biddingDeadline: 200n,
      forceRevealAfter: 220n,
      abortAfter: 300n,
    }),
    [0n, 200n, 220n, 300n],
  );
  assert.deepEqual(
    encodeWhisperAuctionSchedule({
      kind: WhisperAuctionScheduleKind.StartOnBid,
      biddingDuration: 300n,
      acceptanceDuration: 180n,
      settlementDuration: 1_320n,
    }),
    [1n, 300n, 180n, 1_320n],
  );
});

test("rejects invalid auction schedule timing", () => {
  assert.throws(
    () =>
      encodeWhisperAuctionSchedule({
        kind: WhisperAuctionScheduleKind.Absolute,
        biddingDeadline: 200n,
        forceRevealAfter: 200n,
        abortAfter: 300n,
      }),
    /forceRevealAfter must follow biddingDeadline/,
  );
  assert.throws(
    () =>
      encodeWhisperAuctionSchedule({
        kind: WhisperAuctionScheduleKind.StartOnBid,
        biddingDuration: 300n,
        acceptanceDuration: 0n,
        settlementDuration: 1_320n,
      }),
    /acceptanceDuration must be non-zero/,
  );
});
