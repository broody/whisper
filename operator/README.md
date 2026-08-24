# Whisper operator

`@whisper-trade/operator` is the backend boundary for a 1-of-1 Whisper auction vault. It matches encrypted STRK20 notes with bid submissions, validates authenticated bid capsules, accepts funded bids, and builds one private settlement containing loser refunds, winner change, seller proceeds, and the Whisper callback.

The operator controls its own privacy account and can see bids as soon as it discovers them. It does not receive or manage a bidder's viewing key.

## Included

- `WhisperOperator`: idempotent bid acceptance and Vickrey settlement orchestration.
- `SqliteOperatorStore`: WAL-backed capsule, job, and transaction state without key storage.
- `WhisperSdkCapsuleCipher`: reveal-key access through an injected secret provider.
- `Strk20VaultClient`: structural adapter for the official Privacy SDK.
- `OutsideExecutionSubmitter`: proof-backed pool submission through a separate relayer account.
- `StarknetWhisperChain`: Whisper state/event reads plus transaction-scoped `EncNoteCreated` extraction from the canonical pool.
- `OperatorWorker`: finalized-block scanning, durable cursors, stale-lease recovery, bid processing, and deadline settlement scheduling.
- `createOfficialVaultRuntime`: exact `createPrivateTransfers(...)` composition for hosted proving and indexed discovery.
- `createOperatorService`: validates the chain, pool, vault address, viewing key, and reveal key before listening.
- `createOperatorApi`: `GET /healthz`, `GET /v1/config`, and idempotent `POST /v1/capsules` endpoints.

The pool receipt adapter reads every `EncNoteCreated` ID from the bid transaction, then the engine intersects those IDs with notes decryptable by the vault for the configured token. The encrypted capsule is authenticated before matching, zero amount-matching notes remain retryable while discovery catches up, and multiple matching notes are rejected. Unrelated private change is allowed.

The canonical pool rejects an operator-only `ComputeAndInvoke` proof with no private state transition as `NO_REPLAY_PROTECTION`. Acceptance must consume and reissue a separate vault-owned replay note in the same batch; it must not spend the escrowed bid note. Durable replay-note selection and rotation is the remaining operator integration layer.

## Build

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

Node 24 or later is required. Configure GitHub Packages without putting a token in the repository, then install the official SDK:

```sh
cp .npmrc.example .npmrc
export GITHUB_PACKAGES_TOKEN="..."
pnpm add @starkware-libs/starknet-privacy-sdk@0.14.3-rc.5
```

Do not send or commit the token; `.npmrc` is ignored. The runtime dynamically loads the package and uses its `createPrivateTransfers(...)` entrypoint; see the [official SDK quickstart](https://github.com/starkware-libs/starknet-privacy/blob/main/sdk/README.md), [setup requirements](https://strk20-by-example.org/sdk/setup-requirements), and [note discovery](https://strk20-by-example.org/sdk/note-discovery).

## Runtime boundaries

The public runtime configuration is loaded by `loadOperatorRuntimeConfig`. Signing and viewing secrets are not part of that object; supply them through secret-backed providers when composing:

- the vault Starknet signer;
- the vault viewing-key provider expected by the Privacy SDK;
- the capsule reveal-key provider; and
- the relayer account signer.

`WHISPER_DATABASE_PATH` contains encrypted capsules and idempotency state, not these keys. For production, place capsule rate limiting and request authentication policy at the gateway, run one scheduler leader per database, and deploy this process separately from latency-sensitive game APIs.

`createOperatorService(...)` returns the validated service components. Call `validate()`, then `listen()` and `worker.run(abortSignal)`; vault registration remains a separate explicit `registerVault()` action so process startup can never create an onchain transaction accidentally.

## Sepolia infrastructure

Set `WHISPER_NETWORK=sepolia` to use the deployed Sepolia privacy pool, PublicNode RPC, direct contract discovery, and StarkWare's publicly reachable alpha-Sepolia transaction-prover service. Direct discovery is slower but avoids depending on an indexer while validating the integration. Set `WHISPER_DISCOVERY_MODE=indexer` with `WHISPER_DISCOVERY_URL` when a compatible hosted or self-managed discovery service is available; every endpoint and address can be overridden explicitly.

`WHISPER_PROVING_BLOCK_LAG` defaults to 10. Each proof uses the current RPC head minus this lag so the resulting proof fact is old enough for the pool's acceptance window; do not replace it with `latest` unless the deployed pool explicitly accepts proofs from the head block.

The hosted alpha-Sepolia services have no published availability commitment. They are suitable for integration testing, while mainnet must use explicitly configured infrastructure; see the [SDK proving configuration](https://strk20-by-example.org/sdk/proving-config).

The hosted discovery service receives the vault viewing key needed to discover notes, and the hosted prover processes the vault's private proof request. Treat both service operators as part of the Sepolia test trust boundary, use disposable accounts and test funds only, and self-host both components for the intended mainnet operator-only custody model.

## Security status

The operator, contracts, and capsule format are experimental and unaudited. The capsule uses Stark-curve ECDH, HKDF-SHA256, and AES-256-GCM with chain ID, pool, Whisper contract, auction ID, and reveal commitment bound as authenticated context; obtain independent cryptographic review before accepting meaningful funds.
