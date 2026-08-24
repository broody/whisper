# Whisper Private Vickrey Auction Protocol

**Status:** Sepolia registration, private bid, discovery, and funding acceptance verified; settlement pending; custodial and unaudited
**Updated:** 2026-08-23

## Decision

Whisper uses an existing STRK20 privacy pool as a private, operator-controlled auction vault. Every bidder transfers an encrypted note worth exactly their maximum bid. After bidding closes, a 1-of-1 operator decrypts the accepted bids and privately returns every losing bid, returns the winner's change, and sends the clearing price to the seller.

The highest bid wins and pays `max(reserve_price, second_highest_bid)`. No bidder must escrow the auction's maximum possible price, and no custom privacy pool or prover action is required.

There is no configured maximum bid: each bidder chooses and escrows their actual maximum willingness to pay. Amounts use Cairo `u128` and must meet the public reserve.

This is deliberately a custodial first version. The vault is a STRK20 privacy account controlled by the operator backend, not an autonomous Cairo contract. The operator can see bids early, can spend vault notes, and is responsible for refunds. Whisper's contract verifies the committed bid openings and exact Vickrey result, but the existing pool does not enforce auction-specific payout recipients or values.

## What the canonical pool provides

The existing pool already supports the pieces Whisper needs:

- encrypted notes and private note-to-note transfers;
- proof of ownership for consumed notes;
- nullifiers preventing the same note from being spent twice;
- value conservation across a private operation batch; and
- `ComputeAndInvoke`, which derives a contract-scoped private identity and invokes Whisper through fixed selectors.

Whisper therefore does not deploy a separate pool and does not add an auction action to the pool's prover. The auction callback is one action inside the same batch as the relevant private transfers. See [STRK20 actions and proofs](https://strk20-by-example.org/actions-and-proofs) and [multi-operation batches](https://strk20-by-example.org/sdk/multi-op-batch).

The callback ABI must match the canonical pool exactly. `privacy_invoke_with_computation` returns one serialized `Span<OpenNoteDeposit>` and no trailing metadata. Whisper currently returns an empty span because its callbacks update auction state but do not settle open notes directly. The pool rejects additional return values as `INVALID_INVOKE_RETURN_DATA`.

The pool does **not** know Vickrey rules, associate an incoming note with a Whisper bid, restrict the operator's viewing key, or validate Whisper's `outputs_root`.

## Roles

- **Auction creator:** publishes immutable auction parameters.
- **Bidder:** controls a normal privacy account, creates an exact-value encrypted note for the vault, and submits committed bid metadata.
- **Vault/operator:** one backend-controlled privacy account and viewing key. It discovers and validates notes as they arrive, force-reveals them after the deadline, and constructs settlement outputs.
- **Configured pool:** verifies the standard private operations and is the only caller allowed to mutate Whisper's private-action interface.
- **Consumer:** a game, NFT adapter, or other application that interprets the winning `winner_commitment`.

## Library boundary

The Cairo package contains no NFT, game, marketplace, or application callback. An auction snapshots:

```text
payment_token
proceeds_recipient_commitment
metadata_hash
winner_payload_domain
reserve_price
max_bids
bidding_deadline
force_reveal_after
abort_after
vault_address
vault_public_key
reveal_public_key
operator_identity_commitment
```

`payment_token` may be any ERC-20 supported by the configured pool. `metadata_hash` identifies the lot. `winner_payload_domain` defines how a consumer interprets `winner_commitment`.

The operator commitment is:

```text
operator_identity_commitment = Poseidon("WHISPER_OP_V1", operator_identity_key)
```

The identity key is derived by STRK20 for the Whisper contract and is never supplied by browser application code.

`vault_public_key` is the registered STRK20 recipient key. `reveal_public_key` is a separate application-layer encryption key for bid capsules; production deployments must not reuse the pool viewing key for that purpose.

## Bid transcript

The bidder privately chooses:

```text
amount
salt
refund commitment
winner commitment
```

It also uses authenticated hybrid encryption to seal a reveal capsule to `reveal_public_key`. The v1 SDK format uses Stark-curve ECDH, HKDF-SHA256, and AES-256-GCM. The capsule contains `auction_id`, `amount`, `salt`, refund output routing, and the winner commitment. It is uploaded to the operator service under `reveal_commitment` and is never placed in public settlement calldata before the deadline. Authenticated context includes the chain ID, pool address, Whisper address, auction ID, and reveal commitment to prevent replay across deployments.

The shared transcripts are:

```text
identity_commitment = Poseidon(
  "WHISPER_ID_V1", identity_key, auction_id
)

reveal_commitment = Poseidon(
  "WHISPER_REVEAL_V1", auction_id, amount, salt,
  refund_commitment, winner_commitment
)

bid_handle = Poseidon(
  "WHISPER_BID_V1", auction_id, identity_commitment,
  reveal_commitment, refund_commitment, winner_commitment
)
```

The amount and salt remain absent from public bid calldata until force reveal. STRK20 automatically scopes the identity commitment to the auction; refund commitments, winner commitments, and salts must also be fresh per auction.

## Bid flow

1. The bidder already has private funds in the configured pool. A public shield immediately beside the bid would leak the funding account and amount through timing correlation.
2. The client creates an encrypted note of exactly `amount` for the auction's `vault_public_key`, returning any input excess as private change.
3. It uploads the encrypted reveal capsule to the operator service and, in the same private-operation batch as the transfer, submits `PrivacyRequest::SubmitBid` through `ComputeAndInvoke` with `auction_id`, `reveal_commitment`, `refund_commitment`, and `winner_commitment`.
4. Whisper derives the bidder pseudonym, rejects a duplicate identity for that auction, records the submission as `funded = false`, and emits `BidSubmitted`.
5. The operator correlates the encrypted note created for the vault in that same pool transaction with `BidSubmitted`, decrypts the matching capsule, and checks auction, token, amount, commitment opening, and refund/winner routing commitments.
6. During the acceptance grace period, before `force_reveal_after`, the operator submits `PrivacyRequest::AcceptBid` with the discovered `note_id`. The same batch must also consume and reissue a separate vault-owned replay-protection note: the canonical pool rejects a callback-only proof with `NO_REPLAY_PROTECTION`. Whisper authenticates the committed private identity, rejects reuse of the bid note ID, marks the bid funded, appends it to the ordered accepted set, and emits `BidFunded`.

Only funded bids participate in settlement. `force_reveal_after` must be later than `bidding_deadline` so notes submitted near the deadline can be indexed and accepted. If a note is invalid, late, unmatched, or exceeds `max_bids`, the operator should privately return it immediately; the contract cannot force that refund.

The submit and transfer must be one batch so the operator can correlate their events without asking the bidder or upstream SDK for the new encrypted-note ID. This transaction-level correlation does not create an auction-specific proof binding; the operator's acceptance is the binding attestation. The operator decrypts the authenticated capsule first and requires exactly one transaction-scoped vault note whose token and amount match it. Other vault-owned outputs, such as private change, are permitted.

The replay-protection note is operational state, not auction escrow. It must never be an accepted bid note. After every acceptance, its replacement note ID must be recorded and allowed to mature before reuse; multiple concurrent acceptances require a pool of independent replay notes or batched acceptance support.

## Force reveal and Vickrey settlement

After `force_reveal_after` and before `abort_after`, the operator:

1. Freezes the contract's ordered accepted-bid set and verifies its rolling `accepted_bids_hash`.
2. Opens every accepted `reveal_commitment` with `(amount, salt)` in that exact order.
3. Computes the winner using amount descending, then `bid_handle` ascending.
4. Sets `clearing_price = max(reserve_price, second_highest_bid)`.
5. Constructs private outputs:
   - each loser receives its entire bid at its refund commitment;
   - the winner receives `winning_bid - clearing_price`, omitting a zero output;
   - the seller receives `clearing_price` at `proceeds_recipient_commitment`.
6. Consumes the accepted vault notes, creates those encrypted outputs, and includes `PrivacyRequest::Settle` in the same standard pool batch.
7. Whisper verifies the accepted set, every reveal commitment, deterministic winner, and clearing price, then records the result once.

With one valid bid, the bidder pays the reserve. With no accepted bids, the auction settles without a winner. For tied highest bids, the smallest handle wins and the clearing price equals the tied amount.

Amounts are public in settlement calldata in this version. Wallet identities and private output recipients remain hidden, subject to normal timing and amount-correlation risks.

## Why this is escrow, and why it is custodial

Economically, the vault holds all exact bid amounts until settlement. Cryptographically, those funds are ordinary encrypted notes owned by the operator's privacy account. A Cairo contract cannot independently decrypt or sign spends for them under the current pool design.

Consequences:

- losers receive automatic refunds in the normal flow and need no reveal transaction;
- the pool prevents inflation and double spending;
- Whisper prevents the operator from recording a false Vickrey winner for the submitted openings;
- the operator can still redirect or withhold actual note outputs, submit a dishonest `outputs_root`, inspect bids early, or disappear;
- bidders have no permissionless reclaim path from the operator-owned vault.

This is close to a conventional Web2 auction experience, but users trust the auction operator with custody during the auction. The UI and integration must say so plainly.

## Recovery

`PrivacyRequest::Abort` becomes available after `abort_after` and requires the same committed operator identity. It records a non-zero `recovery_hash`, intended to commit to an operator-produced refund manifest.

Abort is not a bidder reclaim mechanism. The operator must still create private refunds. If the operator is unavailable or malicious, the current protocol cannot recover the notes. A trust-minimized version would require one of:

- a supported threshold/recovery ownership mode for vault notes;
- an upstream auction-specific lock and reclaim proof;
- bidder-enforceable timelocked note ownership; or
- a separately reviewed multi-party custody scheme.

## State transitions

```text
create auction
    -> Bidding
       -> submit (unfunded)
       -> operator accept (funded and added to accepted set)
    -> Settled, after force_reveal_after
    -> Aborted, after abort_after
```

Settlement and abort are terminal and mutually exclusive.

## Public and private data

| Hidden before settlement | Public before settlement |
|---|---|
| Bid amount and salt | Auction configuration and selected token |
| Bidder wallet and identity key | Bid handle, note ID, commitments, timing |
| Refund destination and winner payload | Submission count, funded count, accepted-set hash |

| Hidden after settlement | Public after settlement |
|---|---|
| Wallet ownership of bids and outputs | All accepted bid amounts and handles |
| Refund/proceeds recipient plaintext | Winner commitment, winning bid, clearing price |
| Vault viewing key and note plaintext | Reveal, output, and settlement roots |

Private transfers can still be correlated through unique amounts, timing, or separate public shield/unshield operations.

## Contract checks versus operator checks

| Property | Enforced by |
|---|---|
| Only the configured pool invokes state changes | Whisper contract |
| Bidder/operator pseudonym derives inside proven computation | Canonical pool + Whisper |
| Duplicate identity and note ID rejection | Whisper contract |
| Incoming note exists, belongs to vault, uses the selected token, and matches amount | Operator attestation |
| Complete funded-bid ordering | Whisper contract |
| Amount was committed at submission | Whisper reveal commitment |
| Winner and second price are correct for revealed inputs | Whisper contract |
| Consumed notes are owned and not double-spent | Canonical pool |
| Private batch conserves token value | Canonical pool |
| Refunds/proceeds match the advertised output root | Operator attestation |

## Implementation status

Implemented in `v0.2.0`:

- generic Cairo auction state and exact Vickrey pricing;
- standard `ComputeAndInvoke` submit, accept, settle, and abort variants;
- committed STRK20 operator authentication;
- two-phase submitted/funded bid state;
- ordered accepted-set commitment and reveal verification;
- TypeScript encoders and Cairo-compatible Poseidon helpers;
- cross-language vectors and negative-path tests.

Implemented in the operator and SDK application layer:

- authenticated encrypted reveal capsules and domain-separated routing commitments;
- SQLite-backed capsule and idempotency state without key persistence;
- exact note/commitment/amount validation while permitting unrelated private change;
- private refund, winner-change, and proceeds settlement planning;
- structural official-SDK and relayed outside-execution adapters; and
- public configuration and idempotent capsule upload HTTP endpoints;
- finalized Whisper event scanning with a durable block cursor;
- canonical-pool `EncNoteCreated` receipt extraction and vault-note intersection; and
- stale worker lease recovery and deadline settlement scheduling.

Still required before a production auction:

- backend vault account lifecycle and production secret-manager bindings;
- key rotation and independent review of the capsule format;
- authenticated installation of the official SDK package;
- durable replay-protection note inventory and rotation for operator callbacks;
- completion of the force-reveal settlement smoke test;
- durable event polling, scheduling, worker leases, alerting, and recovery automation;
- mainnet configuration and deployment verification;
- independent Cairo and operational security review.

## References

- [Sealed-bid auction RFP](https://strk20.starknet.io/rfp/sealed-bid-auctions)
- [STRK20 notes and nullifiers](https://strk20-by-example.org/notes-and-nullifiers)
- [STRK20 actions and proofs](https://strk20-by-example.org/actions-and-proofs)
- [STRK20 multi-operation batches](https://strk20-by-example.org/sdk/multi-op-batch)
- [Starknet privacy protocol repository](https://github.com/starkware-libs/starknet-privacy)
- [Wallet API STRK20 action schema](https://github.com/starkware-libs/starknet-specs/blob/main/wallet-api/openrpc.json)
