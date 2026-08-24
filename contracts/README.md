# Whisper contracts

The `whisper` Scarb package exports:

- `WhisperAuction`, the deployable reference contract.
- `IWhisperAuction`, `IWhisperBidAction`, `IWhisperPrivacyAction`, and ABI dispatchers.
- Generic auction, bid, settlement, result, and status types.
- Canonical bid-group, tranche, operator, and reveal hashes.
- `compute_vickrey_price`, the deterministic pricing helper.

Consumers may use a local path dependency:

```toml
[dependencies]
whisper = { path = "../whisper/contracts" }
```

One `payment_token` is snapshotted per auction. It may be any ERC-20 supported by the configured STRK20 pool.

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
