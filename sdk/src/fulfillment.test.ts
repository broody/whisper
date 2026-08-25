import assert from "node:assert/strict";
import test from "node:test";

import {
  WHISPER_OFFCHAIN_FULFILLMENT,
  WhisperFulfillmentKind,
  computeAssetWinnerCommitment,
  encodeWhisperAuctionFulfillment,
} from "./fulfillment.ts";

test("encodes offchain and all supported token fulfillment shapes", () => {
  assert.deepEqual(
    encodeWhisperAuctionFulfillment(WHISPER_OFFCHAIN_FULFILLMENT),
    [0n, 0n, 0n, 0n, 0n, 0n],
  );
  assert.deepEqual(
    encodeWhisperAuctionFulfillment({
      kind: WhisperFulfillmentKind.Erc20,
      token: 0x444n,
      tokenId: 0n,
      amount: 25n,
    }),
    [1n, 0x444n, 0n, 0n, 25n, 0n],
  );
  assert.deepEqual(
    encodeWhisperAuctionFulfillment({
      kind: WhisperFulfillmentKind.Erc721,
      token: 0x444n,
      tokenId: (1n << 128n) + 5n,
      amount: 1n,
    }),
    [2n, 0x444n, 5n, 1n, 1n, 0n],
  );
  assert.deepEqual(
    encodeWhisperAuctionFulfillment({
      kind: WhisperFulfillmentKind.Erc1155,
      token: 0x444n,
      tokenId: (1n << 128n) + 5n,
      amount: (2n << 128n) + 7n,
    }),
    [3n, 0x444n, 5n, 1n, 7n, 2n],
  );
});

test("matches the canonical Cairo asset winner commitment vector", () => {
  assert.equal(
    computeAssetWinnerCommitment({
      whisperAddress: 0x111n,
      auctionId: 9n,
      recipient: 0x555n,
      secret: 0x666n,
    }),
    0x389f3d8b639107ceb0a260f4bbb07017e8f138fc002bc8016593d47751bb705n,
  );
});

test("rejects invalid fulfillment shapes", () => {
  assert.throws(
    () =>
      encodeWhisperAuctionFulfillment({
        kind: WhisperFulfillmentKind.Offchain,
        token: 1n,
        tokenId: 0n,
        amount: 0n,
      }),
    /offchain fulfillment token fields must be zero/,
  );
  assert.throws(
    () =>
      encodeWhisperAuctionFulfillment({
        kind: WhisperFulfillmentKind.Erc20,
        token: 1n,
        tokenId: 2n,
        amount: 3n,
      }),
    /ERC-20 tokenId must be zero/,
  );
  assert.throws(
    () =>
      encodeWhisperAuctionFulfillment({
        kind: WhisperFulfillmentKind.Erc721,
        token: 1n,
        tokenId: 2n,
        amount: 3n,
      }),
    /ERC-721 amount must equal one/,
  );
  assert.throws(
    () =>
      encodeWhisperAuctionFulfillment({
        kind: WhisperFulfillmentKind.Erc1155,
        token: 1n,
        tokenId: 2n,
        amount: 0n,
      }),
    /ERC-1155 amount must be non-zero/,
  );
});
