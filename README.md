# Whisper

Whisper is a reusable Cairo and TypeScript library for private, token-agnostic Vickrey auctions on Starknet. Bidders escrow encrypted STRK20 notes, the highest bid wins, and the winner pays the greater of the reserve price and the second-highest bid.

The auction result exposes a generic winner commitment, allowing games, NFT marketplaces, allocation systems, and other applications to define what the winner receives without adding application-specific behavior to the auction contract.

## Auction model

Each auction defines:

- an ERC-20 payment token supported by the configured STRK20 privacy pool;
- a reserve price and maximum number of accepted note tranches;
- bidding, force-reveal, and abort deadlines;
- an operator-controlled private vault;
- a private proceeds recipient; and
- application metadata and a winner-payload domain.

Bids contain one or more encrypted-note tranches, an amount commitment for each tranche, a private refund destination, and an application-defined winner commitment. A bidder may increase a logical bid by adding another tranche; settlement sums all funded tranches in the group before pricing. Groups below reserve are fully refunded, and ties are resolved deterministically by the public group handle.

## How it works

1. The dapp asks a compatible privacy wallet to atomically transfer an encrypted note to the auction vault and invoke Whisper with the bid commitments. The wallet selects notes, proves the private transaction, and relays it.
2. The operator matches the incoming note with the authenticated reveal capsule and marks the bid as funded in a proof-backed batch. That batch rotates a separate vault note to provide STRK20 replay protection without spending the escrowed bid.
3. After bidding closes, the operator opens every accepted bid and constructs a settlement batch.
4. The contract verifies the complete bid set, commitment openings, winner, and Vickrey clearing price.
5. The settlement returns each losing group's aggregate escrow, returns the winner's excess, and sends the clearing price to the proceeds recipient as private notes.

Bid submission uses the standard Wallet API `transfer` and `invoke` actions, so browser dapps do not handle viewing keys, notes, or proving infrastructure. Operator acceptance, force reveal, and settlement still use the privacy SDK's `ComputeAndInvoke` path because they authenticate the vault's contract-scoped private identity.

## Packages

```text
contracts/       Cairo auction contract, interfaces, pricing, hashes, and tests
sdk/             Wallet API bid builders, operator action builders, hashes, and encrypted capsules
operator/        Vault note matching, persistence, HTTP plumbing, and settlement engine
vectors/         Shared Cairo and TypeScript transcript fixtures
docs/            Vocs guide plus the protocol and security reference
```

The Cairo package can be consumed as a Scarb dependency:

```toml
[dependencies]
whisper = { path = "../whisper/contracts" }
```

The headless SDK exports Wallet API builders for initial bids and additive tranches, plus operator builders for acceptance, settlement, and abort:

```ts
import {
  buildWhisperBidActions,
  buildWhisperBidTopUpActions,
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
  buildWhisperAbortAction,
} from "@whisper-trade/sdk";
```

## Privacy and custody

Before settlement, bid amounts, bidder wallets, refund destinations, and winner payloads remain hidden from the public and other bidders. The current implementation uses a 1-of-1 operator that controls the vault's viewing and reveal keys, so that operator can decrypt bid amounts as soon as it discovers their notes and capsules. This is an intentional early-stage compromise, not the intended final trust model: Whisper can evolve toward threshold-controlled decryption and vault spending so no single operator can unilaterally decrypt bids or move escrow, followed by stronger deadline-decryption and non-custodial settlement mechanisms as the underlying privacy infrastructure supports them.

Until those changes are implemented, bidders must trust the operator not to inspect bids for an unfair advantage and to settle or return escrowed funds correctly. Auction configuration, group and tranche handles, commitments, accepted note IDs, timing, and funded-tranche counts are public. Settlement publishes each accepted tranche amount, aggregate winning bid, clearing price, and winning commitment; private-note recipients remain hidden.

The vault is a privacy account controlled by the auction operator. The STRK20 pool proves note ownership, prevents double spending, and conserves value, while the Whisper contract verifies the Vickrey result. The operator still performs note matching and constructs the promised refund and proceeds outputs, so these onchain checks do not yet make custody trustless.

A normal dapp must never handle a user's viewing key, notes, or proofs. It passes the SDK's action array to a compatible wallet's `strk20InvokeTransaction(actions)` method; only the backend-controlled vault service holds its own viewing key. Start with the [Vocs walkthrough](docs/src/pages/how-whisper-works.mdx), then use [the protocol specification](docs/PROTOCOL.md) and the [Wallet API private DeFi guide](https://strk20-by-example.org/starknet-wallet-api/private-defi) for details.

## Sepolia deployment

The current experimental Sepolia instance is deployed at [`0x05fc…ee5c`](https://sepolia.voyager.online/contract/0x05fc7856d6f64428e001fdf126a17d3b303695d04342195aa9e0c3500de3ee5c) against the canonical Sepolia STRK20 pool. A standard transfer + invoke bid completed the full private-note discovery, acceptance, force-reveal, and proof-backed settlement lifecycle using the official Privacy SDK. An interactive Ready Wallet handoff and additive top-up remain to be tested. Public deployment metadata is recorded in [`deployments/sepolia.json`](deployments/sepolia.json); signing, viewing, and reveal secrets remain outside the repository.

## Develop

```sh
cd contracts
scarb fmt --check
scarb build
snforge test

cd ../sdk
pnpm install
pnpm typecheck
pnpm build
pnpm test

cd ../operator
pnpm install
pnpm typecheck
pnpm build
pnpm test

cd ../docs
pnpm install
pnpm typecheck
pnpm build
```

Whisper is experimental and unaudited. Do not use it with real funds until the Cairo contracts, cryptographic transcript, capsule format, and operator infrastructure have received independent review.
