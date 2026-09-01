# Whisper operator

`@whisper-trade/operator` is the backend boundary for a 1-of-1 Whisper auction vault. It matches encrypted STRK20 note tranches with bid submissions, validates authenticated bid capsules, accepts funded tranches, aggregates them by logical bid group, and builds one private settlement containing group refunds, winner change, seller proceeds, and the Whisper callback.

The operator controls its own privacy account and can see bids as soon as it discovers them. It does not receive or manage a bidder's viewing key.

Bidder proving is not an operator responsibility. A compatible privacy wallet executes the dapp's standard `transfer` + `invoke` action array; this service needs proving infrastructure only for vault-owned acceptance, settlement, abort, and account-maintenance transactions.

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
- `createOperatorApi`: `GET /healthz`, replay-aware `GET /readyz`, `GET /v1/config`, idempotent `POST /v1/capsules`, plus optional authenticated coordinator and settled-winner disclosure endpoints.

The pool receipt adapter reads every `EncNoteCreated` ID from the bid transaction, then the engine intersects those IDs with notes decryptable by the vault for the configured token. The encrypted capsule is authenticated before matching, zero amount-matching notes remain retryable while discovery catches up, and multiple matching notes are rejected. Unrelated private change is allowed. At settlement, accepted tranches sharing a group handle are summed before Vickrey pricing and use one committed refund/winner route.

The canonical pool rejects an operator-only `ComputeAndInvoke` proof with no private state transition as `NO_REPLAY_PROTECTION`. Acceptance consumes and reissues a separate, mature, vault-originated replay note in the same proof batch. Selection excludes the current escrow note and notes sent by other accounts, then rotates the oldest eligible note back to the vault. The process serializes acceptance proofs so one local worker cannot select the same note twice.

Every Privacy SDK `transfer` recipient is a registered Starknet account address, not a viewing public key. Replay notes rotate to `WHISPER_VAULT_ADDRESS`, and auction proceeds default to that same address. `WHISPER_PROCEEDS_RECIPIENT` may override the default only with another registered account address.

Keep an inventory of small replay notes for bid bursts: a newly reissued baton cannot be reused until discovery and proof-block maturity catch up. Run one scheduler for a vault/database. Coordinating replay-note leases across multiple processes remains a production-hardening task.

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

When `WHISPER_COORDINATOR_TOKEN` is configured, the operator also exposes
`POST /v1/coordinator/auctions` and
`GET /v1/auctions/<auction-id>/winner`. The bearer-authenticated creation endpoint accepts only
the public per-round fields, fixes the vault, reveal, proceeds, and operator
identity fields from validated runtime configuration, submits `create_auction`
through the relayer, and persists its request ID for idempotent retries. The
winner endpoint returns no address before settlement; afterward it matches the
onchain winning group, decrypts and revalidates that group's capsules, and
returns only their committed refund recipient. Consumers may publish that
address when their prize convention defines the refund recipient as the
winner. Keep the token server-only and terminate these endpoints at a private
gateway or loopback listener; capsule uploads remain unauthenticated so the
bidder wallet is not linked to its sealed bid.

`createOperatorService(...)` returns the validated service components. Call `ready()`, then `listen()` and `worker.run(abortSignal)`; readiness verifies the chain configuration, key identities, and presence of a mature replay note. Vault registration remains a separate explicit `registerVault()` action so process startup can never create an onchain transaction accidentally.

### Rejected-bid recovery

Stop the operator before recovering rejected, unfunded bids so only one process uses the vault account. The recovery command defaults to a dry run: it requires the acceptance window to be closed, decrypts the recorded capsules, verifies the committed refund account for each bid, and resolves exactly one unspent transaction-scoped vault note per bid without printing private amounts or recipients.

```sh
pnpm build
pnpm recover -- --auction-id 2
pnpm recover -- --auction-id 2 --execute
```

Execution batches the exact input notes into one private transfer, records the confirmed transaction in SQLite, and refuses to execute the same auction twice. Restart the operator after the receipt is confirmed. See the [private transfer guide](https://strk20-by-example.org/sdk/transfer).

After `abort_after`, link the completed refund transaction to Whisper's terminal auction record. The abort command also defaults to a dry run, requires a completed recovery for the auction, and uses that confirmed transaction hash as the non-zero `recovery_hash`:

```sh
pnpm abort -- --auction-id 2
pnpm abort -- --auction-id 2 --execute
```

Execution rotates a mature vault replay note in the same private proof as `PrivacyRequest::Abort`, waits for the Starknet receipt, and verifies that the auction is `Aborted`. Keep the worker stopped until this command exits.

The included runner reads public values from the environment and credentials directly from owner-only JSON files. Copy `.env.example` to the ignored `.env`, point `WHISPER_ACCOUNT_FILE` and `WHISPER_OPERATOR_SECRETS_FILE` at files with mode `0600`, and use the active deployment's public contract address and block. The manifest's public addresses and keys must match the runtime configuration.

```sh
pnpm build
node --env-file=.env dist/run.js
```

For local Stake Wars integration, use `WHISPER_API_PORT=8082` because the local Torii gateway uses 8081. A successful startup performs reads and opens the HTTP server; it does not register a vault or submit a transaction. `GET /healthz` reports process health, while `GET /readyz` is `503` until the operator can safely accept a bid.

## Sepolia infrastructure

Set `WHISPER_NETWORK=sepolia` to use the deployed Sepolia privacy pool, PublicNode RPC, direct contract discovery, and StarkWare's publicly reachable alpha-Sepolia transaction-prover service. Direct discovery is slower but avoids depending on an indexer while validating the integration. Set `WHISPER_DISCOVERY_MODE=indexer` with `WHISPER_DISCOVERY_URL` when a compatible hosted or self-managed discovery service is available; every endpoint and address can be overridden explicitly.

`WHISPER_PROVING_BLOCK_LAG` defaults to 10. Each proof uses the current RPC head minus this lag so the resulting proof fact is old enough for the pool's acceptance window; do not replace it with `latest` unless the deployed pool explicitly accepts proofs from the head block.

`WHISPER_PROVING_TIMEOUT_MS` defaults to the official SDK's 30-second request timeout. A slower self-hosted prover must set this above its worst-case proof duration. Otherwise the client disconnects while the server-side blocking proof can continue, and the worker's next retry can overlap it and exhaust the host's memory.

The hosted alpha-Sepolia services have no published availability commitment. They are suitable for integration testing, while mainnet must use explicitly configured infrastructure; see the [SDK proving configuration](https://strk20-by-example.org/sdk/proving-config).

The hosted discovery service receives the vault viewing key needed to discover notes, and the hosted prover processes the vault's private proof request. Treat both service operators as part of the Sepolia test trust boundary, use disposable accounts and test funds only, and self-host both components for the intended mainnet operator-only custody model.

## Security status

The operator, contracts, and capsule format are experimental and unaudited. The capsule uses Stark-curve ECDH, HKDF-SHA256, and AES-256-GCM with chain ID, pool, Whisper contract, auction ID, and reveal commitment bound as authenticated context; obtain independent cryptographic review before accepting meaningful funds.
