# Whisper contracts

The `whisper` Scarb package exports:

- `WhisperAuction`, the deployable reference contract.
- `IWhisperAuction`, `IWhisperPrivacyAction`, and ABI dispatchers.
- Generic auction, bid, settlement, result, and status types.
- Canonical bidder, operator, reveal, and bid-handle hashes.
- `compute_vickrey_price`, the deterministic pricing helper.

Consumers may use a local path dependency:

```toml
[dependencies]
whisper = { path = "../whisper/contracts" }
```

One `payment_token` is snapshotted per auction. It may be any ERC-20 supported by the configured STRK20 pool.

## Canonical-pool flow

The contract uses the pool's standard `ComputeAndInvoke` boundary. It does not require a Whisper-specific pool deployment or prover extension.

1. In one pool batch, a bidder privately transfers an exact-value note to the operator's vault privacy account and submits `PrivacyRequest::SubmitBid`. The callback does not need the newly created note ID.
2. The operator correlates the note created in that transaction with the submission, decrypts the separate application-layer reveal capsule, verifies its token and amount, then submits `PrivacyRequest::AcceptBid` with the discovered note ID.
3. After the deadline, the operator spends all accepted notes into refunds, change, and proceeds while submitting `PrivacyRequest::Settle` in the same pool batch.

Only calls forwarded by the configured pool can mutate private-action state. Operator requests additionally require the contract-scoped STRK20 identity committed in the auction configuration.

The contract verifies the submitted amount openings, complete accepted-bid order, winner, and Vickrey price. The unmodified pool does not prove that a submitted note funded the auction or that settlement outputs match `outputs_root`; those are operator attestations in this custodial version.

## Verify

```sh
scarb fmt --check
scarb build
snforge test
```
