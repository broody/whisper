# STRK20 Privacy Integration Plan — Whisper Operator

Generated 2026-08-23 by the strk20-privacy-integration skill. Upstream versions and mainnet configuration must be re-verified before deployment.

## 1. Project snapshot

- Stack: Cairo 2.13.1 auction contract in `contracts/`; TypeScript 7 and starknet.js 10.7.1 action SDK in `sdk/`; Node 24 operator package in `operator/`.
- Relevant code: `sdk/src/bid-action.ts` composes bidder callbacks, `sdk/src/operator-actions.ts` composes operator callbacks, and `contracts/src/auction.cairo` verifies bid acceptance and Vickrey settlement.
- Privacy goal: keep bids and private output destinations off the public chain until settlement while a 1-of-1 backend vault discovers escrow notes, force-reveals every accepted bid, and returns losers' funds without bidder action.
- Environment: canonical STRK20 mainnet pool for the hackathon; the service controls its own Starknet account, viewing key, reveal key, and relay account.

## 2. Chosen route: Privacy SDK direct

Whisper is a backend-managed privacy account, so it can use the official TypeScript Privacy SDK directly. Browser applications never receive a user's viewing key; the operator handles only the vault's own viewing key and the separate application reveal key.

## 3. What this delivers — hidden vs visible

| Private | Public |
|---|---|
| Bid amount before settlement, refund recipient, private note ownership, private settlement recipients | Auction configuration, bid handles and commitments, accepted note IDs, transaction timing, submission and funded-bid counts |
| Bidder-to-vault transfer details inside the pool | Any separate public shield or unshield amount and address |
| Vault output recipients after settlement | Accepted bid amounts, winner, clearing price, and settlement transcript roots |

The 1-of-1 operator can decrypt bid capsules and vault notes as soon as they are discovered; this is confidentiality from the public and other bidders, not from the operator.

## 4. Prerequisites and versions

- Node.js 24 or later.
- `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5`, confirmed in the upstream monorepo on 2026-08-23; it is distributed through GitHub Packages.
- `starknet@10.7.1`.
- Canonical pool, proving service, discovery indexer, Starknet RPC, relayer, and deployed Whisper addresses for the selected chain.
- Secret-manager providers for the vault account signing key, vault viewing key, reveal private key, and relayer signing key.

## 5. Phase 1 — operator core and application-layer capsule ✅ done 2026-08-23

1. Add authenticated Stark-curve ECDH + HKDF-SHA256 + AES-256-GCM bid capsules to `sdk/src/capsule.ts`.
2. Add domain-separated refund and proceeds routing commitments to `sdk/src/hashes.ts`.
3. Add `operator/` with key-provider boundaries, durable SQLite idempotency storage, a capsule upload/config API, note matching, acceptance, Vickrey settlement planning, and a structural adapter for the official Privacy SDK.
4. Add a relayed outside-execution submitter that carries proof facts and proof data into the pool call.
5. Verify capsule authentication, ambiguous-note rejection, exact note/commitment matching, Vickrey outputs, SQLite state, and HTTP idempotency in automated tests.

## 6. Phase 2 — canonical pool and Whisper chain adapters

1. Install the official Privacy SDK from GitHub Packages and construct `createPrivateTransfers` with the vault's account signer, viewing-key provider, proving provider, discovery provider, and canonical pool address.
2. Generate a typed Whisper contract client from the built ABI for auction and accepted-bid reads.
3. Decode `BidSubmitted` events and inspect the matching pool transaction receipt for output note IDs, rejecting transactions with zero or multiple candidate notes for the configured vault and token.
4. Add a durable event cursor and worker leases, then drive `WhisperOperator.ingestSubmission` and `settleAuction` from an event/scheduler loop.
5. Register the vault, set up its required recipient channels, and verify the public configuration endpoint against the registered keys.

## 7. Phase 3 — mainnet integration and operational hardening

1. Exercise register → private bid transfer/callback → discovery → accept → settlement against the canonical pool with disposable low-value accounts.
2. Move all four keys into the deployment secret manager; keep them out of SQLite, logs, images, and repository files.
3. Deploy the operator separately from Stake Wars' Go API/Torii machine, with one durable database, health checks, request-size limits, capsule upload rate limiting, job alerts, and backups.
4. Add recovery-manifest/refund automation and alert before `abort_after`.
5. Obtain independent Cairo, capsule-cryptography, and operational security review before meaningful funds are accepted.

Mainnet registration, deployment, and transactions require explicit approval when this phase begins.

## 8. Testing

- Headless: SDK and operator typecheck/build/tests; Cairo format/build/tests.
- Integration: official SDK against the selected canonical pool and discovery/proving services.
- Manual: register the service-owned vault, shield a small test amount in a separate transaction, privately transfer an exact bid note, verify discovery and acceptance, then settle and discover all private outputs.
- Pure local tests verify orchestration but do not prove compatibility with hosted proving, discovery, screening, or the deployed pool ABI.

## 9. Compliance and security notes

- Deposit screening is enforced onchain by the protocol and applies regardless of proving provider.
- Selective disclosure can support legitimate requests but is not automatic compliance or regulator endorsement; the application owns its legal and compliance decisions.
- A normal dapp never handles a user's viewing key, notes, or proofs. The backend stores only its own vault credentials through injected secret providers.
- The application-layer capsule format is experimental and unaudited.

## 10. Open items to re-verify at build time

- Canonical mainnet pool ABI and the exact pool event fields needed to derive output note IDs from a transaction.
- Current Privacy SDK release, package-registry authentication, proving URL, discovery URL, and relayer submission requirements.
- Whether a hosted prover and indexer are available to this deployment and what screening configuration they require.
- Exact sequencing/maturity requirements for vault registration, channel setup, acceptance, and settlement transactions.
- Capsule cryptographic review and key-rotation policy.

## 11. Links

- [Official Privacy SDK](https://github.com/starkware-libs/starknet-privacy/blob/main/sdk/README.md)
- [SDK getting started](https://strk20-by-example.org/sdk/getting-started)
- [SDK setup requirements](https://strk20-by-example.org/sdk/setup-requirements)
- [Note discovery](https://strk20-by-example.org/sdk/note-discovery)
- [Multi-operation batches](https://strk20-by-example.org/sdk/multi-op-batch)
- [Actions and proofs](https://strk20-by-example.org/actions-and-proofs)
