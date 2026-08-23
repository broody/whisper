# Whisper SDK

Headless builders for composing Whisper actions with the official STRK20 Privacy SDK.

```ts
import { buildWhisperBidAction } from "@whisper-trade/sdk";

const action = buildWhisperBidAction({
  whisperAddress,
  auctionId,
  noteId,
  capsuleHash,
  refundCommitment,
  winnerCommitment,
});

const result = await transfers.build().computeAndInvoke(action).execute();
```

The helper intentionally never accepts an identity key, viewing key, note plaintext, or bid amount. STRK20 derives the contract-scoped identity key inside the proven computation and prepends it to `privacy_compute`.

`computeIdentityCommitment` and `computeBidHandle` mirror the Cairo Poseidon transcript. The shared fixture lives at `../vectors/bid-transcript-v1.json`.

## Current boundary

This package serializes and authenticates the bid metadata leg. It does **not** yet prove that `noteId` is a newly created encrypted note for the auction vault, that its token matches the auction, or that its hidden amount is within bounds. Do not treat a successful `privacy_invoke_with_computation` as escrow until the custom pool/prover action enforces those constraints.
