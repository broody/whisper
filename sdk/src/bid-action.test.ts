import assert from "node:assert/strict";
import test from "node:test";

import { buildWhisperBidAction, encodeWhisperBidIntent } from "./bid-action.ts";
import {
  computeBidHandle,
  computeIdentityCommitment,
  computeOperatorIdentityCommitment,
  computeRevealCommitment,
} from "./hashes.ts";
import {
  buildWhisperAbortAction,
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
} from "./operator-actions.ts";

const intent = {
  whisperAddress: "0x123",
  auctionId: 7n,
  revealCommitment: 12n,
  refundCommitment: 13n,
  winnerCommitment: 14n,
};

test("encodes the SubmitBid request in Cairo enum and field order", () => {
  assert.deepEqual(encodeWhisperBidIntent(intent), [0n, 7n, 12n, 13n, 14n]);
});

test("builds a ComputeAndInvoke callback without identity-key material", () => {
  const details = buildWhisperBidAction(intent)({});

  assert.equal(details.contractAddress, "0x123");
  assert.deepEqual(details.computeAdditionalData, [0n, 7n, 12n, 13n, 14n]);
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
  assert.throws(
    () => encodeWhisperBidIntent({ ...intent, revealCommitment: 1n << 252n }),
    /revealCommitment exceeds felt252/,
  );
});

test("matches the canonical Cairo bid transcript vector", () => {
  const identityCommitment = computeIdentityCommitment(0xabcn, 1n);
  const bidHandle = computeBidHandle(
    1n,
    identityCommitment,
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
    0x11c9d1b216ef5e67b87296fe6d25da64c546d2d1a95af2de7a56e37a7abaf5bn,
  );
});

test("matches Cairo operator and reveal commitment hashes", () => {
  assert.equal(
    computeOperatorIdentityCommitment(0x123n),
    0x6e876d6c9ddb85e9971d01b7929af750cdb526e2682eeee41d9309dc5d0c63dn,
  );
  assert.equal(
    computeRevealCommitment(7n, 25n, 99n, 13n, 14n),
    0x3c680e2bf9d6ed1671676046be5b8e3ef5029ed40fb63e098c729cfc1d3de50n,
  );
});

test("encodes operator request variants", () => {
  assert.deepEqual(
    buildWhisperAcceptBidAction({
      whisperAddress: "0x123",
      auctionId: 7n,
      bidHandle: 8n,
      noteId: 11n,
    })({})
      .computeAdditionalData,
    [1n, 7n, 8n, 11n],
  );

  assert.deepEqual(
    buildWhisperSettlementAction({
      whisperAddress: "0x123",
      auctionId: 7n,
      acceptedBidsHash: 20n,
      revealedBids: [
        { bidHandle: 8n, amount: 100n, salt: 30n },
        { bidHandle: 9n, amount: 70n, salt: 31n },
      ],
      winnerBidHandle: 8n,
      revealsRoot: 21n,
      outputsRoot: 22n,
      settlementHash: 23n,
    })({}).computeAdditionalData,
    [2n, 7n, 20n, 2n, 8n, 100n, 30n, 9n, 70n, 31n, 8n, 21n, 22n, 23n],
  );

  assert.deepEqual(
    buildWhisperAbortAction({ whisperAddress: "0x123", auctionId: 7n, recoveryHash: 44n })({})
      .computeAdditionalData,
    [3n, 7n, 44n],
  );
});

test("rejects inconsistent settlement winners", () => {
  const base = {
    whisperAddress: "0x123",
    auctionId: 7n,
    acceptedBidsHash: 20n,
    revealsRoot: 21n,
    outputsRoot: 22n,
    settlementHash: 23n,
  };
  assert.throws(
    () =>
      buildWhisperSettlementAction({
        ...base,
        revealedBids: [],
        winnerBidHandle: 8n,
      }),
    /winnerBidHandle must be zero/,
  );
  assert.throws(
    () =>
      buildWhisperSettlementAction({
        ...base,
        revealedBids: [{ bidHandle: 8n, amount: 100n, salt: 30n }],
        winnerBidHandle: 0n,
      }),
    /winnerBidHandle must be non-zero/,
  );
});
