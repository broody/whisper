import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWhisperBidActions,
  buildWhisperBidTopUpActions,
  encodeWhisperBidIntent,
} from "./bid-action.ts";
import {
  computeProceedsRecipientCommitment,
  computeRefundCommitment,
  computeBidGroupHandle,
  computeBidHandle,
  computeOperatorIdentityCommitment,
  computeRevealCommitment,
} from "./hashes.ts";
import {
  decryptWhisperBidCapsule,
  deriveWhisperRevealPublicKey,
  encryptWhisperBidCapsule,
} from "./capsule.ts";
import {
  buildWhisperAbortAction,
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
} from "./operator-actions.ts";

const intent = {
  whisperAddress: "0x123",
  paymentToken: "0x456",
  vaultAddress: "0x789",
  auctionId: 7n,
  bidNonce: 11n,
  bidAmount: 100n,
  revealCommitment: 12n,
  refundCommitment: 13n,
  winnerCommitment: 14n,
};

test("encodes the SubmitBid request in Cairo enum and field order", () => {
  assert.deepEqual(encodeWhisperBidIntent(intent), [0n, 7n, 11n, 12n, 13n, 14n]);
});

test("builds an atomic Wallet API transfer and standard invoke", () => {
  const composition = buildWhisperBidActions(intent);
  assert.deepEqual(composition.actions, [
    { type: "transfer", token: "0x456", amount: "0x64", recipient: "0x789" },
    {
      type: "invoke",
      contract: "0x123",
      calldata: ["0x0", "0x7", "0xb", "0xc", "0xd", "0xe"],
    },
  ]);
  assert.equal(
    composition.groupHandle,
    computeBidGroupHandle(7n, 11n, 13n, 14n),
  );
  assert.equal(
    composition.bidHandle,
    computeBidHandle(7n, composition.groupHandle, 0n, 12n),
  );
});

test("builds an additive bid tranche through the same wallet flow", () => {
  assert.deepEqual(
    buildWhisperBidTopUpActions({
      whisperAddress: "0x123",
      paymentToken: "0x456",
      vaultAddress: "0x789",
      auctionId: 7n,
      groupHandle: 15n,
      bidAmount: 30n,
      revealCommitment: 16n,
    }),
    [
      { type: "transfer", token: "0x456", amount: "0x1e", recipient: "0x789" },
      { type: "invoke", contract: "0x123", calldata: ["0x1", "0x7", "0xf", "0x10"] },
    ],
  );
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
  const groupHandle = computeBidGroupHandle(1n, 0xabcn, 0x702n, 0x703n);
  const bidHandle = computeBidHandle(1n, groupHandle, 0n, 0x701n);

  assert.equal(
    groupHandle,
    0xe8fdc2a31cc7c303e4a77bd5656145cd299cfeef0dbb110ef69b2f4daf123fn,
  );
  assert.equal(
    bidHandle,
    0x56fe80448dce869e7b460dd35c343d5018dd0b0a085bc5ff8aaa2bc6abd64fn,
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
    [0n, 7n, 8n, 11n],
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
    [1n, 7n, 20n, 2n, 8n, 100n, 30n, 9n, 70n, 31n, 8n, 21n, 22n, 23n],
  );

  assert.deepEqual(
    buildWhisperAbortAction({ whisperAddress: "0x123", auctionId: 7n, recoveryHash: 44n })({})
      .computeAdditionalData,
    [2n, 7n, 44n],
  );
});

test("supports no-sale settlement while rejecting a winner for an empty set", () => {
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
  assert.deepEqual(
    buildWhisperSettlementAction({
      ...base,
      revealedBids: [{ bidHandle: 8n, amount: 20n, salt: 30n }],
      winnerBidHandle: 0n,
    })({}).computeAdditionalData,
    [1n, 7n, 20n, 1n, 8n, 20n, 30n, 0n, 21n, 22n, 23n],
  );
});

test("encrypts, authenticates, and decrypts a bid capsule", async () => {
  const revealPrivateKey = 0x12345n;
  const revealPublicKey = deriveWhisperRevealPublicKey(revealPrivateKey);
  const refundRecipient = 0x987n;
  const refundCommitment = computeRefundCommitment(refundRecipient);
  const winnerCommitment = 0x456n;
  const opening = {
    auctionId: 7n,
    amount: 100n,
    salt: 0x777n,
    refundRecipient,
    refundCommitment,
    winnerCommitment,
  };
  const revealCommitment = computeRevealCommitment(
    opening.auctionId,
    opening.amount,
    opening.salt,
    opening.refundCommitment,
    opening.winnerCommitment,
  );
  const context = {
    chainId: 0x534e5f4d41494en,
    poolAddress: 0x111n,
    whisperAddress: 0x222n,
    auctionId: opening.auctionId,
    revealCommitment,
  };

  const envelope = await encryptWhisperBidCapsule(opening, revealPublicKey, context);
  const decrypted = await decryptWhisperBidCapsule(envelope, revealPrivateKey, context);

  assert.deepEqual(decrypted, opening);
  await assert.rejects(
    decryptWhisperBidCapsule(envelope, revealPrivateKey, { ...context, whisperAddress: 0x223n }),
  );
});

test("derives domain-separated routing commitments", () => {
  assert.notEqual(computeRefundCommitment(0x123n), computeProceedsRecipientCommitment(0x123n));
});
