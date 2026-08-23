import assert from "node:assert/strict";
import test from "node:test";

import { buildWhisperBidAction, encodeWhisperBidIntent } from "./bid-action.ts";
import { computeBidHandle, computeIdentityCommitment } from "./hashes.ts";

const intent = {
  whisperAddress: "0x123",
  auctionId: 7n,
  noteId: 11n,
  capsuleHash: 12n,
  refundCommitment: 13n,
  winnerCommitment: 14n,
};

test("encodes BidIntent in Cairo field order", () => {
  assert.deepEqual(encodeWhisperBidIntent(intent), [7n, 11n, 12n, 13n, 14n]);
});

test("builds a ComputeAndInvoke callback without identity-key material", () => {
  const details = buildWhisperBidAction(intent)({});

  assert.equal(details.contractAddress, "0x123");
  assert.deepEqual(details.computeAdditionalData, [7n, 11n, 12n, 13n, 14n]);
  assert.deepEqual(details.invokeAdditionalData, []);
  assert.equal(Object.hasOwn(details, "identityKey"), false);
});

test("rejects zero commitments and out-of-range auction ids", () => {
  assert.throws(
    () => encodeWhisperBidIntent({ ...intent, winnerCommitment: 0n }),
    /winnerCommitment must be non-zero/,
  );
  assert.throws(
    () => encodeWhisperBidIntent({ ...intent, auctionId: 1n << 64n }),
    /auctionId exceeds u64/,
  );
});

test("matches the canonical Cairo bid transcript vector", () => {
  const identityCommitment = computeIdentityCommitment(0xabcn, 1n);
  const bidHandle = computeBidHandle(
    1n,
    identityCommitment,
    0x704n,
    0x701n,
    0x702n,
    0x703n,
  );

  assert.equal(
    identityCommitment,
    0x388934032e394e858e5fd474159ead3a6dd48d0419c2a4b9ffa38c353b72ef1n,
  );
  assert.equal(
    bidHandle,
    0x3d1d493a715d646b29f80a915b17c9b9248c8f35b1289aef7be88888a6453c5n,
  );
});
