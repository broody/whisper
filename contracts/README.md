# Whisper contracts

The `whisper` Scarb package exports:

- `WhisperAuction`, the deployable reference contract.
- `IWhisperAuction`, `IWhisperPrivacyAction`, and generated ABI dispatchers.
- Auction configuration, bid, result, and status types.
- Canonical auction-scoped identity and bid transcript hashes.
- `compute_vickrey_price`, the reusable deterministic pricing helper.

Consumers may use a local path dependency:

```toml
[dependencies]
whisper = { path = "../whisper/contracts" }
```

The application selects one `payment_token` per auction. It may be any ERC-20 supported by the configured STRK20 pool; the contract contains no hard-coded token or application semantics.

## Verify

```sh
scarb fmt --check
scarb build
snforge test
```

The live pool can call `privacy_compute` and `privacy_invoke_with_computation` to authenticate an auction-scoped identity and record opaque bid metadata. Encryption, proof-bound note locking and amount constraints, force decryption, and private refund/proceeds construction remain companion pool/prover responsibilities.
