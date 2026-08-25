# STRK20 Privacy Integration Plan — Whisper Operator

Generated 2026-08-23 by the strk20-privacy-integration skill. Upstream versions and mainnet configuration must be re-verified before deployment.

## 1. Project snapshot

- Stack: Cairo 2.13.1 auction contract in `contracts/`; TypeScript 7 and starknet.js 10.7.1 action SDK in `sdk/`; Node 24 operator package in `operator/`.
- Relevant code: `sdk/src/bid-action.ts` composes bidder callbacks, `sdk/src/operator-actions.ts` composes operator callbacks, and `contracts/src/auction.cairo` verifies bid acceptance and Vickrey settlement.
- Privacy goal: keep bids and private output destinations off the public chain until settlement while a 1-of-1 backend vault discovers escrow notes, force-reveals every accepted tranche, aggregates logical bid groups, and returns losers' funds without bidder action.
- Environment: Sepolia integration first, followed by the canonical STRK20 mainnet pool for the hackathon; the service controls its own Starknet account, viewing key, reveal key, and relay account.

## 2. Chosen routes: Wallet API bidder + Privacy SDK operator

Browser bidders use the standard STRK20 Wallet API. Their compatible wallet selects notes, generates proofs, and relays the atomic transfer + invoke; the dapp never receives a viewing key or proof. Whisper's backend-managed vault separately uses the official TypeScript Privacy SDK for acceptance, settlement, abort, and vault maintenance, handling only its own viewing key and application reveal key.

## 3. What this delivers — hidden vs visible

| Private | Public |
|---|---|
| Bid and tranche amounts before settlement, refund recipient, private note ownership, private settlement recipients | Auction configuration, group/tranche handles and commitments, accepted note IDs, transaction timing, submission and funded-tranche counts |
| Bidder-to-vault transfer details inside the pool | Any separate public shield or unshield amount and address |
| Vault output recipients after settlement | Accepted tranche amounts, aggregate winner, clearing price, and settlement transcript roots |

The 1-of-1 operator can decrypt bid capsules and vault notes as soon as they are discovered; this is confidentiality from the public and other bidders, not from the operator. During Sepolia testing, the hosted discovery and proving service operators are also inside the trust boundary; mainnet restores the intended operator-only service boundary by self-hosting both components.

## 4. Prerequisites and versions

- Node.js 24 or later.
- `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5`, confirmed in the upstream monorepo on 2026-08-23; it is distributed through GitHub Packages.
- `starknet@10.7.1`.
- Wallet API specification v0.10.3 through a compatible privacy wallet. If a consuming dapp uses get-starknet v6 directly, re-check the current `next` pins; discovery was 6.0.4 and wallet-standard was 6.0.5 on 2026-08-24.
- Sepolia privacy pool v2.0 at `0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91`.
- Canonical pool, proving service, discovery indexer, Starknet RPC, relayer, and deployed Whisper addresses for the selected chain.
- Secret-manager providers for the vault account signing key, vault viewing key, reveal private key, and relayer signing key.

## 5. Phase 1 — operator core and application-layer capsule ✅ done 2026-08-23

1. Add authenticated Stark-curve ECDH + HKDF-SHA256 + AES-256-GCM bid capsules to `sdk/src/capsule.ts`.
2. Add domain-separated refund and proceeds routing commitments to `sdk/src/hashes.ts`.
3. Add `operator/` with key-provider boundaries, durable SQLite idempotency storage, a capsule upload/config API, note matching, acceptance, Vickrey settlement planning, and a structural adapter for the official Privacy SDK.
4. Add a relayed outside-execution submitter that carries proof facts and proof data into the pool call.
5. Verify capsule authentication, ambiguous-note rejection, exact note/commitment matching, Vickrey outputs, SQLite state, and HTTP idempotency in automated tests.

## 6. Phase 2 — canonical pool and Whisper chain adapters ✅ done 2026-08-23

1. Install the official Privacy SDK from GitHub Packages and construct `createPrivateTransfers` with the vault's account signer, viewing-key provider, proving provider, discovery provider, and canonical pool address.
2. Generate a typed Whisper contract client from the built ABI for auction and accepted-bid reads.
3. Decode `BidSubmitted` events and inspect the matching pool transaction receipt for output note IDs, retrying zero matches during discovery lag and requiring exactly one vault note whose decrypted amount matches the authenticated capsule. Other outputs, such as private change, are allowed.
4. Add a durable event cursor and worker leases, then drive `WhisperOperator.ingestSubmission` and `settleAuction` from an event/scheduler loop.
5. Register the vault, set up its required recipient channels, and verify the public configuration endpoint against the registered keys.

Implemented locally: official SDK composition boundary, Whisper state/event decoder, canonical-pool `EncNoteCreated` receipt inspection, durable event cursor, stale worker leases, settlement scheduler, service assembly, and startup validation. The official `@starkware-libs/starknet-privacy-sdk@0.14.3-rc.5` package is installed through ephemeral GitHub Packages authentication, and its real `createPrivateTransfers` export loads successfully.

Sepolia validation completed so far: the official pool address and an RPC 0.10.2 endpoint were confirmed. The published transaction-prover container exits with signal 132 (`Illegal instruction`) on this Apple Silicon Docker host in both its amd64-emulated and arm64 variants, so Sepolia uses StarkWare's public prover for now. Dedicated disposable vault and relayer accounts were deployed without reusing Stake Wars credentials, `WhisperAuction` was declared and deployed against the canonical Sepolia pool, and the vault viewing key was registered successfully through a proof-backed pool transaction. The hosted alpha-Sepolia discovery endpoint currently returns 404 for the registered vault, while direct contract discovery succeeds, so the Sepolia preset uses the SDK's direct discovery provider until a compatible indexer is available. Public deployment metadata is recorded in `deployments/sepolia.json`; all private account, viewing, and reveal material remains outside the repository in owner-only files.

The first live bid smoke test found that the initial Whisper callback returned a legacy two-value tuple. The canonical pool decodes exactly one `Span<OpenNoteDeposit>` and rejected the trailing value with `INVALID_INVOKE_RETURN_DATA`. The corrected class was declared and deployed at `0x01a0027cf3cee829e991691543ea455d1fdcf2fc7296837243ff0cf35d742083`.

Auction 2 then completed the live path through funding acceptance: a mature encrypted STRK note was discovered, a private self-transfer created an exact bid note and change while submitting `BidSubmitted` in the same proven transaction, and the operator matched the authenticated capsule amount to the correct output. A callback-only acceptance proof was rejected by the canonical pool with `NO_REPLAY_PROTECTION`; consuming and reissuing a separate vault change note in the same batch supplied the required nullifier without spending the bid note. `BidFunded` is confirmed onchain. Public transaction and deployment metadata is recorded in `deployments/sepolia.json`; the opening, capsule, and all keys remain in owner-only files outside the repository.

After the force-reveal deadline, the operator decrypted the authenticated capsule, consumed the accepted bid note, and completed proof-backed settlement through the canonical pool. The single 0.2 STRK bid won and paid the 0.1 STRK reserve under Vickrey pricing; the 0.1 STRK winner change and 0.1 STRK seller proceeds were reissued as private notes. Auction 2 is `Settled` onchain.

The operator now has an explicit `sepolia` preset for the deployed pool, PublicNode RPC, and the publicly reachable StarkWare alpha-Sepolia discovery and transaction-prover endpoints. The prover responded with RPC spec `0.10.3-rc.2`, and the official SDK reported discovery status `OK`, on 2026-08-23. These endpoints have no published availability commitment, so they remain replaceable environment configuration rather than mainnet dependencies.

## 7. Phase 3 — Wallet API bidder ingress and additive tranches ✅ done locally 2026-08-24

1. Replace bidder `ComputeAndInvoke` with the Wallet API's atomic standard `transfer` + `invoke` action array.
2. Add a pool-only `privacy_invoke(WalletBidRequest)` Cairo boundary while retaining `ComputeAndInvoke` only for operator-authenticated actions.
3. Model bid increases as additive encrypted-note tranches grouped by a random-nonce-derived public handle.
4. Aggregate funded tranches by group before Vickrey pricing and combine each group's refund or winner change.
5. Verify exact Wallet API encoding, cross-language hashes, group pricing, output conservation, and operator ABI decoding in local Cairo and TypeScript tests.

The standard-invoke class is deployed on Sepolia and a direct official-SDK transfer + invoke bid completed discovery, acceptance, force reveal, and settlement against the canonical pool. A manual Ready Wallet bid and additive top-up test are still required before marking the external integration complete.

## 8. Phase 4 — mainnet integration and operational hardening

1. After the new wallet flow succeeds on Sepolia, repeat register → wallet bid/top-up → discovery → accept → settlement against the canonical mainnet pool with disposable low-value accounts.
2. Move all four keys into the deployment secret manager; keep them out of SQLite, logs, images, and repository files.
3. Deploy the operator separately from Stake Wars' Go API/Torii machine, with one durable database, health checks, request-size limits, capsule upload rate limiting, job alerts, and backups.
4. Add recovery-manifest/refund automation and alert before `abort_after`.
5. Obtain independent Cairo, capsule-cryptography, and operational security review before meaningful funds are accepted.

Mainnet registration, deployment, and transactions require explicit approval when this phase begins.

## 9. Phase 5 — unified auction fulfillment ✅ done 2026-08-24

1. Make fulfillment an explicit, required part of `AuctionConfig`: `Offchain`, `Erc20`, `Erc721`, or `Erc1155` with a fixed-width token descriptor.
2. Integrate token custody into `WhisperAuction.create_auction`, atomically pulling and verifying an ERC-20, ERC-721, or ERC-1155 lot before bidding opens. Keep the seller as the auction creator and leave `metadata_hash` application-defined.
3. Add a domain-separated winner claim commitment binding the Whisper contract, auction ID, recipient, and secret. Anyone may relay a valid claim, but the asset can only be delivered to the committed recipient.
4. Return the lot to the creator after an operator abort, a settled no-winner result, or an expired unfinalized auction. Keep winning lots claimable indefinitely rather than adding a seller-controlled post-settlement clawback.
5. Update the operator decoder and Stake Wars arbiter reader for the breaking `Auction` ABI. Stake Wars requires the explicit `Offchain` kind and rejects token auctions as canonical game rounds.
6. Add Cairo contract tests, TypeScript fulfillment helpers and cross-language vectors, protocol documentation, and an explicit audit requirement before mainnet use.

This phase changes no STRK20 note, Wallet API, capsule, or operator-key behavior. It intentionally breaks the auction creation/state ABI to replace the separate adapter with one coherent interface.

Implemented locally: integrated escrow, standard ERC-721/1155 receiver and SRC5 boundaries, exact token receipt checks, reentrancy protection, committed winner claims, no-sale/abort/timeout recovery, unified TypeScript encoders and hashes, updated Whisper operator decoding, strict Stake Wars offchain validation, cross-language vectors, and fulfillment documentation. Cairo (30), SDK (13), and operator (19) tests pass; all builds, typechecks, Cairo formatting, and the documentation production build pass.

Sepolia validation completed 2026-08-24: v0.3 was declared and deployed at `0x03db9a75d8f90384e300b32bc4f08e3ac273325fbd18d0ef037a31795cfbb586`. Explicit offchain auction 1 completed the full private bid, replay-protected acceptance, and settlement path and was decoded successfully through the Stake Wars Go reader. ERC-20 auction 2 atomically escrowed exactly 0.01 STRK and returned it to the seller through the timeout reclaim path. ERC-721, ERC-1155, and winning ERC-20 claim paths remain covered locally and need dedicated live test tokens before equivalent Sepolia coverage.

## 10. Testing

- Headless: SDK and operator typecheck/build/tests; Cairo format/build/tests.
- Integration: official SDK against the selected canonical pool and discovery/proving services.
- Manual bidder: connect Ready, submit the SDK's `[transfer, invoke]` actions through `strk20InvokeTransaction(actions)`, then add a tranche to the same group.
- Manual operator: verify discovery and acceptance of each tranche, settle the aggregate groups, and discover all private outputs.
- Pure local tests verify orchestration but do not prove compatibility with hosted proving, discovery, screening, or the deployed pool ABI.

## 11. Compliance and security notes

- Deposit screening is enforced onchain by the protocol and applies regardless of proving provider.
- Selective disclosure can support legitimate requests but is not automatic compliance or regulator endorsement; the application owns its legal and compliance decisions.
- A normal dapp never handles a user's viewing key, notes, or proofs. The backend stores only its own vault credentials through injected secret providers.
- The application-layer capsule format is experimental and unaudited.
- The integrated asset escrow must receive independent Cairo review before mainnet deployment. It prevents seller non-delivery but does not remove the current 1-of-1 operator's custody over private bid notes and settlement outputs.

## 12. Open items to re-verify at build time

- Canonical mainnet pool ABI and the exact pool event fields needed to derive output note IDs from a transaction.
- Current Privacy SDK release, package-registry authentication, proving URL, discovery URL, and relayer submission requirements.
- Current Wallet API version, Ready support for atomic `transfer` + standard `invoke`, and exact Starknet.js/get-starknet pins in the consuming dapp.
- Deploy the new Wallet API callback ABI to Sepolia and complete initial-bid plus additive-tranche testing with Ready.
- Register the verified v0.3 offchain auction as a canonical Stake Wars round when the API's explicit admin procedure is implemented; no production API database or Fly deployment was changed during the contract smoke test.
- Exercise ERC-721, ERC-1155, and winning token-claim flows on Sepolia with dedicated reviewed test tokens; the live v0.3 smoke currently covers offchain settlement plus ERC-20 escrow and timeout reclaim.
- Confirm whether the alpha-Sepolia proving and discovery services are formally supported for sprint teams; until then, treat them as replaceable test infrastructure.
- Run a self-hosted transaction prover for mainnet operator settlement; bidders should shield through a privacy-enabled wallet so the operator prover does not need to originate screened deposits.
- Design and automate a durable inventory of vault-owned replay-protection notes for operator-only acceptance transactions; a bare `ComputeAndInvoke` callback is rejected as `NO_REPLAY_PROTECTION`.
- Re-verify the exact sequencing and maturity requirements for settlement and consecutive replay-baton rotations.
- Capsule cryptographic review and key-rotation policy.
- Committee-ready custody remains deferred in [GitHub issue #1](https://github.com/broody/whisper/issues/1) until the Sepolia end-to-end path works.
- OpenZeppelin Cairo token-interface compatibility and receiver behavior for the exact ERC-20, ERC-721, and ERC-1155 contracts accepted by Whisper.

## 13. Links

- [Official Privacy SDK](https://github.com/starkware-libs/starknet-privacy/blob/main/sdk/README.md)
- [SDK getting started](https://strk20-by-example.org/sdk/getting-started)
- [SDK setup requirements](https://strk20-by-example.org/sdk/setup-requirements)
- [Note discovery](https://strk20-by-example.org/sdk/note-discovery)
- [Multi-operation batches](https://strk20-by-example.org/sdk/multi-op-batch)
- [Actions and proofs](https://strk20-by-example.org/actions-and-proofs)
- [Wallet API overview](https://strk20-by-example.org/starknet-wallet-api/overview)
- [Wallet API private DeFi](https://strk20-by-example.org/starknet-wallet-api/private-defi)
