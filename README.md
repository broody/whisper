# Whisper

Private sealed-bid auctions on Starknet, built around real encrypted STRK20 notes.

Whisper starts with a reusable, token-agnostic Vickrey auction contract; NFT listing, custody, marketplace, indexer, and frontend layers remain adapters around the generic settlement result.

## Repository layout

```text
contracts/       Standalone Cairo/Scarb package and Starknet Foundry tests
sdk/             Headless STRK20 ComputeAndInvoke action builder
vectors/         Canonical Cairo/TypeScript transcript fixtures
docs/PROTOCOL.md Privacy, force-reveal, settlement, and integration specification
```

Future application code can live under `apps/` without adding web or marketplace assumptions to the contract package.

## Contract status

Implemented:

- Any ERC-20 supported by the configured STRK20 privacy pool.
- Multiple concurrent single-winner Vickrey auctions.
- Public auction configuration and opaque encrypted-note bid records.
- STRK20-compatible `privacy_compute` and pool-only `privacy_invoke_with_computation` bid metadata path.
- Auction-scoped proven identity and canonical bid transcript hashes.
- Pool-only bid, batch force-reveal settlement, and recovery entrypoints.
- Complete ordered bid-set commitment and deterministic tie-breaking.
- Generic `winner_commitment` for NFT, game, allocation, or other adapters.
- Winner commitments bound at bid time rather than accepted from reveal calldata.
- Eighteen Cairo tests and four SDK tests, including a shared Poseidon transcript vector.

Still required for an end-to-end private auction:

- STRK20 pool/prover actions for encrypted note locking and proof-backed settlement.
- Restricted auction vault and 1-of-1 force-reveal operator.
- Encrypted-note ID exposure/derivation in the SDK bid composition flow.
- Independent Cairo and cryptographic review.

The current unmodified pool can authenticate Whisper's private identity and bid-metadata leg, but it cannot prove that the referenced note is newly escrowed to the vault or bind its hidden amount to the auction rules. A successful metadata action is therefore not yet a valid escrowed bid.

## Develop

```sh
cd contracts
scarb build
snforge test

cd ../sdk
pnpm install
pnpm typecheck
pnpm test
```

Experimental and unaudited. Do not deploy to mainnet in its current form.
