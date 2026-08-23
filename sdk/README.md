# Whisper SDK

Headless request builders for composing Whisper callbacks with the official STRK20 Privacy SDK.

This is plumbing for wallet implementations and team-controlled SDK accounts. A normal dapp must never obtain a user's viewing key; it should request the combined transfer/callback through a compatible wallet API once that composition is exposed by the target wallet.

## Submit a bid

```ts
import { buildWhisperBidAction, computeRevealCommitment } from "@whisper-trade/sdk";

const revealCommitment = computeRevealCommitment(
  auctionId,
  amount,
  salt,
  refundCommitment,
  winnerCommitment,
);

const action = buildWhisperBidAction({
  whisperAddress,
  auctionId,
  revealCommitment,
  refundCommitment,
  winnerCommitment,
});

const result = await transfers.build().computeAndInvoke(action).execute();
```

The application must compose that callback with exactly one exact-value private transfer to the auction's configured vault account in the same pool batch. The helper does not move funds itself, and it intentionally does not require the newly created encrypted-note ID; the operator derives that from the batch events before accepting the bid.

It must also use hybrid authenticated encryption for the amount opening and refund/winner routing material under the auction's separate `revealPublicKey`, then upload that capsule for the operator. Capsule encryption is intentionally not implemented until the wire format and audited crypto dependency are selected.

It never accepts an identity key or viewing key. STRK20 derives the Whisper-scoped identity inside the proven computation and prepends it to `privacy_compute`.

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

These builders serialize the four Cairo `PrivacyRequest` variants exactly: submit `0`, accept `1`, settle `2`, and abort `3`.

## Security boundary

The canonical pool proves that the vault controls consumed notes and that its private batch conserves value. Whisper verifies the public bid openings and Vickrey result. The current protocol does not cryptographically bind a submitted note's hidden token/amount to its bid or enforce the recipients and values represented by `outputsRoot`; the operator remains a custodian.

`computeIdentityCommitment`, `computeOperatorIdentityCommitment`, `computeRevealCommitment`, and `computeBidHandle` mirror the Cairo Poseidon transcripts.
