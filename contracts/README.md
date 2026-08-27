# Whisper contracts

The `whisper` Scarb package exports:

- `WhisperAuction`, the deployable reference contract.
- `IWhisperAuction`, `IWhisperBidAction`, `IWhisperPrivacyAction`, `IWhisperOwnable`, `IWhisperUpgradeable`, and ABI dispatchers.
- Standard token/receiver interfaces and fulfillment types.
- Generic auction, bid, settlement, result, and status types.
- Canonical bid-group, tranche, operator, and reveal hashes.
- `compute_vickrey_price`, the deterministic pricing helper.

Consumers may use a local path dependency:

```toml
[dependencies]
whisper = { path = "../whisper/contracts" }
```

One `payment_token` is snapshotted per auction. It may be any ERC-20 supported by the configured STRK20 pool.

`WhisperAuction` embeds OpenZeppelin's `UpgradeableComponent` and two-step `OwnableComponent`. Its constructor requires both the canonical pool address and an explicit nonzero owner; only that owner may replace the class hash. Ownership transfers require the proposed owner to accept before upgrade authority changes.

## Scheduling

`AuctionConfig.schedule` is a tagged choice between:

- `AuctionSchedule::Absolute`, which opens the auction at creation and carries `bidding_deadline`, `force_reveal_after`, and `abort_after`; and
- `AuctionSchedule::StartOnBid`, which creates a `Pending` auction and carries `bidding_duration`, `acceptance_duration`, and `settlement_duration`.

The first successful bid starts a pending auction atomically. Its block timestamp becomes `started_at`; the contract derives the three resolved deadlines by adding the durations in order, changes the status to `Bidding`, and emits `AuctionStarted`. The stored `Auction` always exposes `schedule`, `started_at`, and the resolved deadline fields. For a pending auction, `started_at` and all resolved deadlines are zero.

Pending auctions cannot settle, abort, or release an escrowed asset. Because there is no creator-cancel entrypoint yet, a start-on-bid token lot remains escrowed until a first bid starts the auction and it later reaches a terminal path.

## Indexable event history

Every transaction-driven lifecycle transition emits a standard Starknet event, so a raw contract indexer can rebuild auction history without reading mutable storage. `auction_id`, `bid_handle`, and `group_handle` are event keys where applicable, which allows indexers to filter auction, tranche, and logical-bid histories directly. The stream distinguishes:

- submitted tranches through `BidSubmitted.submission_index` and `auction_submission_count`;
- funded tranches through `BidFunded.bid_index`, `auction_funded_tranche_count`, and `group_funded_tranche_count`;
- tranche amounts revealed at settlement through `BidRevealed`; and
- final logical-bid counts, eligibility counts, winner, price, accepted-set hash, and transcript roots through `AuctionSettled`.

An initial bid and its top-ups share a `group_handle`, so logical bid counts are not wallet counts. Bidder wallet identity remains private. `AuctionCreated` contains the full immutable auction configuration, while `AuctionStarted`, `AuctionAborted`, `AssetClaimed`, and `AssetReclaimed` cover the remaining lifecycle paths. Deadline passage itself emits no event because it does not execute a transaction; consumers derive time-based availability from the indexed deadlines and current chain time.

## Fulfillment

`AuctionConfig.fulfillment` is required and has four kinds: `Offchain`, `Erc20`, `Erc721`, and `Erc1155`. Offchain auctions require zero token fields and let applications such as Stake Wars interpret the generic `winner_commitment`. Token auctions require the seller to approve `WhisperAuction` before calling `create_auction`; the same transaction pulls and verifies the lot before the auction opens, so a failure rolls everything back.

ERC-20 uses an amount and token ID zero, ERC-721 uses a token ID and amount one, and ERC-1155 uses both fields. Onchain variants require `winner_payload_domain = WHISPER_ASSET_WINNER_V1`. After settlement, anyone may relay `claim_asset(auction_id, recipient, secret)`, but the lot is sent only when `(recipient, secret)` opens the winning commitment bound to the Whisper address and auction ID. Lots return to the recorded creator after an abort, a settled no-winner result, or an unfinalized auction whose `abort_after` deadline has passed. Winning lots have no seller clawback and remain claimable indefinitely.

Integrated escrow prevents seller non-delivery for a deposited token, but the current private payment vault and settlement outputs remain under the 1-of-1 operator trust model. Obtain an independent review before using meaningful assets.

## Canonical-pool flow

The contract uses the pool's standard invoke boundary for bidder actions and `ComputeAndInvoke` for operator-authenticated actions. It does not require a Whisper-specific pool deployment or prover extension.

1. A bidder gives a compatible wallet an exact-value private `transfer` plus an `invoke` of `WalletBidRequest::SubmitBid`. The wallet proves and relays both actions atomically; the callback does not need the newly created note ID.
2. The bidder may increase the same logical bid with another transfer and `WalletBidRequest::AddBidTranche`.
3. The operator correlates each note with its submission, decrypts the separate application-layer reveal capsule, verifies its token and amount, then submits `PrivacyRequest::AcceptBid` with the discovered note ID.
4. After the deadline, the contract sums accepted tranches by group before pricing while the operator spends all accepted notes into grouped refunds, winner change, and proceeds through `PrivacyRequest::Settle`.

Only calls forwarded by the configured pool can mutate private-action state. Operator requests additionally require the contract-scoped STRK20 identity committed in the auction configuration.

The contract verifies every tranche opening, the complete accepted-tranche order, group aggregation, winner, and Vickrey price. The unmodified pool does not prove that a submitted note funded the auction or that settlement outputs match `outputs_root`; those are operator attestations in this custodial version.

## Verify

```sh
scarb fmt --check
scarb build
snforge test
```
