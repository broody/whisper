# Whisper SDK

Headless request builders for composing bidder actions through the STRK20 Wallet API and vault-operator callbacks through the official Privacy SDK.

The bidder path is ordinary dapp plumbing: the wallet owns note selection, viewing keys, proving, and relay submission. The operator path remains backend plumbing for the operator-controlled privacy vault.

## Submit a bid

```ts
import {
  buildWhisperBidActions,
  computeRevealCommitment,
} from "@whisper-trade/sdk";

const revealCommitment = computeRevealCommitment(
  auctionId,
  amount,
  salt,
  refundCommitment,
  winnerCommitment,
);

const { groupHandle, bidHandle, actions } = buildWhisperBidActions({
  whisperAddress,
  paymentToken,
  vaultAddress,
  auctionId,
  bidNonce,
  bidAmount: amount,
  revealCommitment,
  refundCommitment,
  winnerCommitment,
});

const result = await walletAccount.strk20InvokeTransaction(actions);
```

The returned tuple contains an exact-value private `transfer` followed by a standard `invoke` of Whisper's `privacy_invoke` entrypoint. The connected wallet executes them atomically and derives the newly created note ID internally; the operator correlates the note from pool events before accepting the tranche.

It also uses authenticated hybrid encryption for the amount opening and refund routing material under the auction's separate `revealPublicKey`, then uploads that capsule for the operator.

The SDK provides the experimental v1 capsule plumbing:

```ts
import {
  computeRefundCommitment,
  computeRevealCommitment,
  encryptWhisperBidCapsule,
} from "@whisper-trade/sdk";

const refundCommitment = computeRefundCommitment(refundRecipient);
const revealCommitment = computeRevealCommitment(
  auctionId,
  amount,
  salt,
  refundCommitment,
  winnerCommitment,
);

const capsule = await encryptWhisperBidCapsule(
  { auctionId, amount, salt, refundRecipient, refundCommitment, winnerCommitment },
  auction.revealPublicKey,
  { chainId, poolAddress, whisperAddress, auctionId, revealCommitment },
);
```

Upload the returned envelope to the operator before submitting the private bid batch. The format uses Stark-curve ECDH, HKDF-SHA256, and AES-256-GCM; it is experimental and requires independent cryptographic review.

The builder never accepts an identity key, viewing key, note, or proof.

## Increase a bid

An increase is a second encrypted note in the same logical bid group:

```ts
import { buildWhisperBidTopUpActions } from "@whisper-trade/sdk";

const actions = buildWhisperBidTopUpActions({
  whisperAddress,
  paymentToken,
  vaultAddress,
  auctionId,
  groupHandle,
  bidAmount: 30n,
  revealCommitment: topUpRevealCommitment,
});

await walletAccount.strk20InvokeTransaction(actions);
```

If the original tranche is 50 and this tranche is 30, settlement prices that group as an 80-token bid. The operator creates one combined refund for a losing group or one combined winner-change output. A top-up cannot reduce or replace a previously transferred tranche.

## Operator actions

The backend-controlled vault uses:

```ts
import {
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
  buildWhisperAbortAction,
} from "@whisper-trade/sdk";
```

- `buildWhisperAcceptBidAction` marks a submission funded after the operator verifies the incoming note.
- `buildWhisperSettlementAction` encodes the complete ordered reveal set and expected result. Compose it with loser refunds, winner change, and proceeds in one private-operation batch.
- `buildWhisperAbortAction` records the operator's recovery manifest after timeout.

These builders serialize the three operator-only Cairo `PrivacyRequest` variants exactly: accept `0`, settle `1`, and abort `2`. Bid submission has a separate Wallet API-compatible request enum: submit `0` and add tranche `1`.

## Auction scheduling

Auction creation chooses either absolute chain timestamps or durations anchored to the first successful bid:

```ts
import {
  WhisperAuctionScheduleKind,
  encodeWhisperAuctionSchedule,
} from "@whisper-trade/sdk";

const absolute = encodeWhisperAuctionSchedule({
  kind: WhisperAuctionScheduleKind.Absolute,
  biddingDeadline,
  forceRevealAfter,
  abortAfter,
});

const startOnBid = encodeWhisperAuctionSchedule({
  kind: WhisperAuctionScheduleKind.StartOnBid,
  biddingDuration: 300n,
  acceptanceDuration: 180n,
  settlementDuration: 1_320n,
});
```

Put the four encoded values into `AuctionConfig.schedule`. An absolute auction starts at creation. A start-on-bid auction is `Pending` with zero resolved deadlines until its first successful bid starts it atomically.

## Auction fulfillment

Every auction explicitly selects offchain or token fulfillment. Stake Wars uses the zeroed offchain descriptor; ERC-20, ERC-721, and ERC-1155 auctions approve and deposit their lot directly into `WhisperAuction` during creation:

```ts
import {
  WHISPER_ASSET_WINNER_DOMAIN,
  WHISPER_OFFCHAIN_FULFILLMENT,
  WhisperFulfillmentKind,
  computeAssetWinnerCommitment,
  encodeWhisperAuctionFulfillment,
} from "@whisper-trade/sdk";

const offchain = encodeWhisperAuctionFulfillment(WHISPER_OFFCHAIN_FULFILLMENT);

const erc721 = encodeWhisperAuctionFulfillment({
  kind: WhisperFulfillmentKind.Erc721,
  token: collectionAddress,
  tokenId,
  amount: 1n,
});

const winnerCommitment = computeAssetWinnerCommitment({
  whisperAddress,
  auctionId,
  recipient,
  secret,
});
```

Put the six encoded values into `AuctionConfig.fulfillment`. Token variants use `WHISPER_ASSET_WINNER_DOMAIN`; the winner keeps `secret` private until calling `claim_asset`. Offchain auctions retain their application-defined winner domain and do not use the asset-claim commitment.

## Security boundary

The canonical pool proves that the vault controls consumed notes and that its private batch conserves value. Whisper verifies the public bid openings and Vickrey result. The current protocol does not cryptographically bind a submitted note's hidden token/amount to its bid or enforce the recipients and values represented by `outputsRoot`; the operator remains a custodian.

`computeBidGroupHandle`, `computeBidHandle`, `computeOperatorIdentityCommitment`, and `computeRevealCommitment` mirror the Cairo Poseidon transcripts.
