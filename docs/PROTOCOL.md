# Whisper Private Vickrey Auction Protocol

**Status:** Standard transfer + invoke bidder flow and full settlement verified on Sepolia through the official Privacy SDK; interactive Ready Wallet handoff pending; custodial and unaudited
**Updated:** 2026-08-24

## Decision

Whisper uses an existing STRK20 privacy pool as a private, operator-controlled auction vault. A logical bid consists of one or more exact-value encrypted note tranches. After bidding closes, a 1-of-1 operator decrypts the accepted tranches, sums them by bid group, privately returns every losing group, returns the winner's change, and sends the clearing price to the seller.

The highest bid wins and pays `max(reserve_price, second_highest_bid)`. No bidder must escrow the auction's maximum possible price, and no custom privacy pool or prover action is required.

There is no configured maximum bid: each bidder chooses and escrows their actual maximum willingness to pay, either once or through additive increases. Amounts and group totals use Cairo `u128`; aggregate groups below the public reserve are ineligible and fully refunded.

This is deliberately a custodial first version. The vault is a STRK20 privacy account controlled by the operator backend, not an autonomous Cairo contract. The operator can see bids early, can spend vault notes, and is responsible for refunds. Whisper's contract verifies the committed bid openings and exact Vickrey result, but the existing pool does not enforce auction-specific payout recipients or values.

## What the canonical pool provides

The existing pool already supports the pieces Whisper needs:

- encrypted notes and private note-to-note transfers;
- proof of ownership for consumed notes;
- nullifiers preventing the same note from being spent twice;
- value conservation across a private operation batch;
- standard `invoke`, which lets a wallet call Whisper's pool-only `privacy_invoke` entrypoint in the same action list as a private transfer; and
- `ComputeAndInvoke`, which derives the vault's contract-scoped private identity for operator-only acceptance and settlement callbacks.

Whisper therefore does not deploy a separate pool or add an auction circuit to the prover. Bidder dapps submit the Wallet API's standard `transfer` + `invoke` actions, and the wallet handles note selection and proving. The backend uses `ComputeAndInvoke` only for its vault-owned actions. See the [Wallet API overview](https://strk20-by-example.org/starknet-wallet-api/overview), [private DeFi composition](https://strk20-by-example.org/starknet-wallet-api/private-defi), and [multi-operation batches](https://strk20-by-example.org/sdk/multi-op-batch).

Both callback ABIs must match the canonical pool exactly. Bidder actions call `privacy_invoke(WalletBidRequest)`; operator actions call `privacy_invoke_with_computation(PrivacyCommand)`. Each returns one serialized `Span<OpenNoteDeposit>` and no trailing metadata. Whisper returns an empty span because its callbacks update auction state but do not settle open notes directly.

The pool does **not** know Vickrey rules, associate an incoming note with a Whisper bid, restrict the operator's viewing key, or validate Whisper's `outputs_root`.

## Roles

- **Auction creator:** publishes immutable auction parameters.
- **Bidder:** asks a compatible privacy wallet to create an exact-value encrypted note for the vault and submit committed bid metadata; the dapp never receives private account material.
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

## Bid groups and tranche transcripts

For the initial tranche, the bidder privately chooses:

```text
amount
salt
bid nonce
refund commitment
winner commitment
```

It also uses authenticated hybrid encryption to seal a reveal capsule to `reveal_public_key`. The v1 SDK format uses Stark-curve ECDH, HKDF-SHA256, and AES-256-GCM. The capsule contains `auction_id`, `amount`, `salt`, refund output routing, and the winner commitment. It is uploaded to the operator service under `reveal_commitment` and is never placed in public settlement calldata before the deadline. Authenticated context includes the chain ID, pool address, Whisper address, auction ID, and reveal commitment to prevent replay across deployments.

The shared transcripts are:

```text
group_handle = Poseidon(
  "WHISPER_GROUP_V1", auction_id, bid_nonce,
  refund_commitment, winner_commitment
)

reveal_commitment = Poseidon(
  "WHISPER_REVEAL_V1", auction_id, amount, salt,
  refund_commitment, winner_commitment
)

bid_handle = Poseidon(
  "WHISPER_TRANCHE_V1", auction_id, group_handle,
  tranche_index, reveal_commitment
)
```

The amount, salt, and bid nonce remain absent from public calldata. The random nonce prevents deriving the group handle from a wallet address, while the group publicly links later increases to the original logical bid. Every tranche has a fresh salt and reveal commitment but inherits the group's refund and winner commitments.

## Bid flow

1. The bidder already has private funds in the configured pool. A public shield immediately beside the bid would leak the funding account and amount through timing correlation.
2. The client creates the reveal commitment and uploads its encrypted capsule to the operator service.
3. The dapp calls `buildWhisperBidActions(...)`, then passes the returned `[transfer, invoke]` actions to the connected wallet's `strk20InvokeTransaction(actions)` method.
4. The wallet privately transfers exactly `amount` to `vault_address`, returning any input excess as private change, and invokes `privacy_invoke(WalletBidRequest::SubmitBid)` atomically. It owns note selection, proving, and relay submission.
5. Whisper derives the group and first-tranche handles from the request, records the tranche as `funded = false`, and emits `BidSubmitted`.
6. The operator correlates the encrypted note created for the vault in that same pool transaction with `BidSubmitted`, decrypts the matching capsule, and checks auction, token, amount, commitment opening, and refund/winner routing commitments.
7. During the acceptance grace period, before `force_reveal_after`, the operator submits `PrivacyRequest::AcceptBid` with the discovered `note_id`. The same batch must also consume and reissue a separate vault-owned replay-protection note: the canonical pool rejects a callback-only proof with `NO_REPLAY_PROTECTION`. Whisper authenticates the committed private identity, rejects reuse of the bid note ID, marks the tranche funded, appends it to the ordered accepted set, and emits `BidFunded`.

Only funded tranches participate in settlement. `force_reveal_after` must be later than `bidding_deadline` so notes submitted near the deadline can be indexed and accepted. `max_bids` currently caps accepted tranches, not unique groups. If a note is invalid, late, unmatched, or exceeds that capacity, the operator should privately return it immediately; the contract cannot force that refund.

The submit and transfer must be one batch so the operator can correlate their events without asking the bidder or upstream SDK for the new encrypted-note ID. This transaction-level correlation does not create an auction-specific proof binding; the operator's acceptance is the binding attestation. The operator decrypts the authenticated capsule first and requires exactly one transaction-scoped vault note whose token and amount match it. Other vault-owned outputs, such as private change, are permitted.

The replay-protection note is operational state, not auction escrow. It must never be an accepted bid note. After every acceptance, its replacement note ID must be recorded and allowed to mature before reuse; multiple concurrent acceptances require a pool of independent replay notes or batched acceptance support.

### Additive increases

Before `bidding_deadline`, a bidder may call `buildWhisperBidTopUpActions(...)` with the existing `group_handle`, a new amount, and a fresh reveal commitment. The same Wallet API transfer + invoke flow creates a new tranche and `BidSubmitted` event. The group handle, tranche index, commitments, and timing are public; the amount and wallet remain hidden.

Top-ups are additive: a 50-token tranche plus a 30-token tranche becomes one 80-token bid at settlement. A tranche cannot replace, reduce, or cancel an earlier transfer. The operator validates that every capsule opens to the group's original refund and winner commitments, and settlement creates one combined refund or change output per group.

## Force reveal and Vickrey settlement

After `force_reveal_after` and before `abort_after`, the operator:

1. Freezes the contract's ordered accepted-bid set and verifies its rolling `accepted_bids_hash`.
2. Opens every accepted tranche `reveal_commitment` with `(amount, salt)` in that exact order.
3. Sums tranche amounts by `group_handle`, removes groups below the reserve from winner selection, then computes the winner using eligible aggregate amount descending and group handle ascending.
4. Sets `clearing_price = max(reserve_price, second_highest_bid)`.
5. Constructs private outputs:
   - each losing group receives its aggregate bid at its refund commitment;
   - the winner receives `winning_bid - clearing_price`, omitting a zero output;
   - the seller receives `clearing_price` at `proceeds_recipient_commitment`.
6. Consumes the accepted vault notes, creates those encrypted outputs, and includes `PrivacyRequest::Settle` in the same standard pool batch.
7. Whisper verifies the accepted set, every reveal commitment, deterministic winner, and clearing price, then records the result once.

With one eligible funded group, the bidder pays the reserve. With no accepted tranches—or only groups below reserve—the auction settles without a winner and refunds all funded groups. For tied aggregate bids, the smallest group handle wins and the clearing price equals the tied amount.

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
| Bidder wallet, bid nonce, and private account data | Group handle, tranche handle, note ID, commitments, timing |
| Refund destination and winner payload | Submission count, funded-tranche count, accepted-set hash |

| Hidden after settlement | Public after settlement |
|---|---|
| Wallet ownership of bids and outputs | Every accepted tranche amount and aggregate result |
| Refund/proceeds recipient plaintext | Winner commitment, winning bid, clearing price |
| Vault viewing key and note plaintext | Reveal, output, and settlement roots |

Private transfers can still be correlated through unique amounts, timing, or separate public shield/unshield operations.

## Contract checks versus operator checks

| Property | Enforced by |
|---|---|
| Only the configured pool invokes state changes | Whisper contract |
| Bid callback is atomic with its private transfer | Wallet action batch + canonical pool |
| Duplicate group/tranche handle and note ID rejection | Whisper contract |
| Incoming note exists, belongs to vault, uses the selected token, and matches amount | Operator attestation |
| Complete funded-bid ordering | Whisper contract |
| Every tranche amount was committed at submission | Whisper reveal commitment |
| Winner and second price are correct for revealed inputs | Whisper contract |
| Consumed notes are owned and not double-spent | Canonical pool |
| Private batch conserves token value | Canonical pool |
| Refunds/proceeds match the advertised output root | Operator attestation |

## Implementation status

Implemented in the current source:

- generic Cairo auction state and exact Vickrey pricing;
- Wallet API-compatible standard invoke for initial bids and additive tranches;
- operator-only `ComputeAndInvoke` accept, settle, and abort variants;
- committed STRK20 operator authentication;
- two-phase submitted/funded bid state;
- ordered accepted-set commitment and reveal verification;
- TypeScript encoders and Cairo-compatible Poseidon helpers;
- group aggregation before Vickrey pricing, combined group refunds/change, and deterministic tie-breaking;
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
- interactive Ready Wallet bid and additive top-up smoke tests for the standard-invoke ABI;
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
