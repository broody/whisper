# Whisper operator

`@whisper-trade/operator` is the backend boundary for a 1-of-1 Whisper auction vault. It matches encrypted STRK20 notes with bid submissions, validates authenticated bid capsules, accepts funded bids, and builds one private settlement containing loser refunds, winner change, seller proceeds, and the Whisper callback.

The operator controls its own privacy account and can see bids as soon as it discovers them. It does not receive or manage a bidder's viewing key.

## Included

- `WhisperOperator`: idempotent bid acceptance and Vickrey settlement orchestration.
- `SqliteOperatorStore`: WAL-backed capsule, job, and transaction state without key storage.
- `WhisperSdkCapsuleCipher`: reveal-key access through an injected secret provider.
- `Strk20VaultClient`: structural adapter for the official Privacy SDK.
- `OutsideExecutionSubmitter`: proof-backed pool submission through a separate relayer account.
- `createOperatorApi`: `GET /healthz`, `GET /v1/config`, and idempotent `POST /v1/capsules` endpoints.

Live chain event decoding and canonical-pool receipt inspection remain deployment adapters because their exact ABI and endpoints must match the selected pool deployment. The engine deliberately rejects a submission unless the transaction yields exactly one candidate note that the vault can discover and decrypt.

## Build

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Node 24 or later is required. The production composition root must install `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5` from GitHub Packages and pass its `createPrivateTransfers(...)` result to `Strk20VaultClient`; see the [official SDK quickstart](https://github.com/starkware-libs/starknet-privacy/blob/main/sdk/README.md), [setup requirements](https://strk20-by-example.org/sdk/setup-requirements), and [note discovery](https://strk20-by-example.org/sdk/note-discovery).

## Runtime boundaries

The public runtime configuration is loaded by `loadOperatorRuntimeConfig`. Signing and viewing secrets are not part of that object; supply them through secret-backed providers when composing:

- the vault Starknet signer;
- the vault viewing-key provider expected by the Privacy SDK;
- the capsule reveal-key provider; and
- the relayer account signer.

`WHISPER_DATABASE_PATH` contains encrypted capsules and idempotency state, not these keys. For production, place capsule rate limiting and request authentication policy at the gateway, run one scheduler leader per database, and deploy this process separately from latency-sensitive game APIs.

## Security status

The operator, contracts, and capsule format are experimental and unaudited. The capsule uses Stark-curve ECDH, HKDF-SHA256, and AES-256-GCM with chain ID, pool, Whisper contract, auction ID, and reveal commitment bound as authenticated context; obtain independent cryptographic review before accepting meaningful funds.
