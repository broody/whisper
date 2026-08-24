# Whisper Agent Guide

These instructions apply to the entire repository.

## Repository layout and checks

- `contracts` contains the Cairo auction contract.
- `sdk` contains bidder Wallet API builders and operator action builders.
- `operator` contains the service-owned privacy vault and proof submission code.
- `docs` is the Vocs documentation site.
- `deployments/sepolia.json` is the source of truth for public Sepolia addresses, class hashes, transactions, blocks, and smoke-test results.

There is no root package manifest. Run checks in their package directories:

```sh
cd contracts
snforge test
scarb fmt --check
scarb build

cd ../sdk
pnpm test
pnpm build

cd ../operator
pnpm test
pnpm build

cd ../docs
pnpm build
```

Also run `jq empty deployments/sepolia.json` and `git diff --check` from the repository root.

Do not commit, push, deploy, create accounts, fund accounts, approve tokens, or send transactions unless the user explicitly requests that action. Sepolia authorization does not imply mainnet authorization.

## Secret and account handling

Disposable Sepolia account and operator material is stored outside the repository:

- `~/.starknet_accounts/whisper/sepolia_accounts.json`
- `~/.starknet_accounts/whisper/operator_secrets.json`

Keep these files owner-only (`0600`). Never print, echo, log, copy, or commit private keys, viewing keys, reveal keys, decrypted notes, capsules, proofs, or complete SDK error objects. Read secrets only inside the process that needs them. Public account addresses and public keys belong in `deployments/sepolia.json`.

Use separate disposable vault and relayer accounts. The vault owns private notes and the viewing key. The relayer submits outside-execution transactions and needs public STRK for gas and privacy-pool fees.

## Sepolia deployment preparation

Before declaring or deploying:

1. Inspect the worktree and verify the intended contract diff.
2. Run every check above.
3. Read the current pool, token, account, and compiler values from `deployments/sepolia.json`; do not recover active addresses from old prose or superseded deployment records.
4. Query balances and the pool's current fee rather than assuming the recorded fee is unchanged.
5. Confirm the vault is registered with the pool and has at least one mature private replay-protection note that is not auction escrow.
6. Confirm the relayer has enough public STRK for declaration/deployment gas when it performs those actions, plus every planned proof submission.

The account that submits the outer pool transaction pays the public pool fee. For `OutsideExecutionSubmitter`, this is the **relayer**, not the private vault. Before a bid, acceptance, or settlement smoke run, approve the configured pool to spend enough of the selected public fee token from that relayer. Confirm the allowance onchain. Approving from the vault does not satisfy this requirement and produces `Insufficient ERC20 allowance` during fee estimation.

Pool fees are charged per private transaction. Budget for the bid, each acceptance, settlement or abort, registration or maintenance, and retries. Do not treat a successful ERC-20 approval receipt as proof that it came from the correct owner.

## Declare and deploy

Run declaration and deployment from `contracts` with the disposable Sepolia deployer. Never paste a private key into a command or export it into a long-lived shell. Pass it to only the relevant process from the owner-only account file.

After each transaction:

- wait for a successful receipt;
- record its canonical transaction hash and block;
- query the deployed address with `starknet_getClassHashAt` and require it to equal the declared class hash; and
- leave the previous deployment metadata intact until the new smoke test succeeds.

The operator identity is deployment-scoped. Recompute its identity key and commitment with the **new Whisper contract address** before creating an auction. Reusing the commitment from an older deployment will make operator-authenticated callbacks fail.

The canonical pool requires both callback entrypoints to return exactly one serialized `Span<OpenNoteDeposit>` with no trailing values. A trailing status or metadata value causes `INVALID_INVOKE_RETURN_DATA`.

## Short Sepolia smoke test

For a fast end-to-end auction, use chain time rather than local time. A known-good schedule is:

- `bidding_deadline = latest block timestamp + 300`;
- `force_reveal_after = latest block timestamp + 480`; and
- `abort_after = latest block timestamp + 1800`.

The extra three minutes between bidding and force reveal is the operator's discovery and acceptance grace period. Do not reduce it without accounting for block inclusion, the proving lag, discovery, and proof generation.

Follow this sequence:

1. Create the auction and obtain the actual auction ID from the receipt/event or contract state. Never hardcode `1`; failed smoke attempts still consume auction IDs.
2. Submit the bidder action as one atomic standard `transfer + invoke` operation calling `privacy_invoke`. Do not restore bidder `ComputeAndInvoke`; compatible wallets use the standard action array.
3. When testing without an interactive wallet, the official Privacy SDK may build the same standard operation using a disposable service-controlled account. Describe this accurately as a Wallet API-compatible action-semantic test, not a Ready Wallet test.
4. Wait for the bid receipt and then for the configured proving depth. The Sepolia default is `head - 10`; do not prove against `latest`.
5. Discover the transaction-scoped vault output, decrypt and authenticate the capsule, and require exactly one note matching the auction token and committed amount.
6. Accept the bid with operator `ComputeAndInvoke`. The batch must consume and reissue a separate vault-owned replay note; a callback-only proof fails with `NO_REPLAY_PROTECTION`. Never consume the escrowed bid note during acceptance.
7. Wait until `force_reveal_after`, again respect proving depth, consume the accepted escrow notes, create the exact refund/change/proceeds outputs, and settle.
8. Independently query every receipt and the auction view. Completion requires successful receipts, the expected deployed class hash, and auction status `settled`.

Persist enough non-secret run state to resume safely after a failure: deployment address, auction ID, public transaction hashes, handles, deadlines, and current stage. Keep salts, openings, capsules, notes, and keys only in an owner-only file outside the repository. Do not blindly rerun a script that creates an auction at startup.

After success, update `deployments/sepolia.json` with the active deployment and smoke metadata, preserve prior deployments under history fields, update the Vocs status page, rebuild docs, and remove temporary smoke scripts that contain run-specific state.

## Live failure guide

- `Insufficient ERC20 allowance` during `starknet_estimateFee`: identify the actual outer transaction submitter and approve the pool from that account. For `OutsideExecutionSubmitter`, approve from the relayer.
- `INVALID_INVOKE_RETURN_DATA`: make the callback return only the canonical `Span<OpenNoteDeposit>`.
- `NO_REPLAY_PROTECTION`: consume and reissue a non-escrow vault baton note in the operator callback batch.
- Proof rejected as too recent or not yet available: wait for at least the configured block lag and use that finalized proving block.
- No discovered bid note: wait for depth/indexing, then intersect notes decryptable by the vault with every `EncNoteCreated` ID in the bid transaction. Do not guess the note ID.
- SDK warning about too few recent V3 transactions with tips: this is fee-estimation sampling guidance, not automatically a transaction failure. Inspect the underlying RPC error before changing the auction flow.

Starknet.js `RpcError.message` embeds the full request and may include an enormous proof. Log only `error.baseError.code`, `error.baseError.message`, and the minimal nested execution error needed for diagnosis. Never persist the request, proof, decrypted notes, or key material.

## Mainnet boundary

The public alpha-Sepolia prover and direct pool discovery are test infrastructure without a published availability commitment. Do not copy Sepolia assumptions to mainnet. Mainnet requires explicit user approval, current pool and fee verification, configured/self-hosted proving and discovery, secret-manager-backed keys, independent contract and cryptographic review, durable replay-note inventory, monitoring, and a low-value rehearsal.
