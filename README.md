# Whisper

Whisper is a reusable Cairo and TypeScript library for private, token-agnostic Vickrey auctions on Starknet. Bidders escrow encrypted STRK20 notes, the highest bid wins, and the winner pays the greater of the reserve price and the second-highest bid.

The auction result exposes a generic winner commitment, allowing games, NFT marketplaces, allocation systems, and other applications to define what the winner receives without adding application-specific behavior to the auction contract.

## Auction model

Each auction defines:

- an ERC-20 payment token supported by the configured STRK20 privacy pool;
- a reserve price and maximum number of accepted bids;
- bidding, force-reveal, and abort deadlines;
- an operator-controlled private vault;
- a private proceeds recipient; and
- application metadata and a winner-payload domain.

Bids contain an amount commitment, a private refund destination, and an application-defined winner commitment. One auction-scoped private identity may submit one bid. Ties are resolved deterministically by bid handle.

## How it works

1. The bidder privately transfers an encrypted note worth their bid to the auction vault and submits the bid commitments in the same STRK20 operation batch.
2. The operator matches the incoming note with the authenticated reveal capsule and marks the bid as funded in a proof-backed batch. That batch rotates a separate vault note to provide STRK20 replay protection without spending the escrowed bid.
3. After bidding closes, the operator opens every accepted bid and constructs a settlement batch.
4. The contract verifies the complete bid set, commitment openings, winner, and Vickrey clearing price.
5. The settlement returns each losing bid, returns the winner's excess, and sends the clearing price to the proceeds recipient as private notes.

Whisper uses the privacy pool's encrypted-note and `ComputeAndInvoke` operations. The operator associates each accepted bid with the encrypted note created for the vault.

## Packages

```text
contracts/       Cairo auction contract, interfaces, pricing, hashes, and tests
sdk/             ComputeAndInvoke builders, transcript hashes, and encrypted bid capsules
operator/        Vault note matching, persistence, HTTP plumbing, and settlement engine
vectors/         Shared Cairo and TypeScript transcript fixtures
docs/            Vocs guide plus the protocol and security reference
```

The Cairo package can be consumed as a Scarb dependency:

```toml
[dependencies]
whisper = { path = "../whisper/contracts" }
```

The headless SDK exports builders for bid submission, funded-bid acceptance, settlement, and abort:

```ts
import {
  buildWhisperBidAction,
  buildWhisperAcceptBidAction,
  buildWhisperSettlementAction,
  buildWhisperAbortAction,
} from "@whisper-trade/sdk";
```

## Privacy and custody

Before settlement, bid amounts, bidder wallets, refund destinations, and winner payloads remain hidden from the public and other bidders. The 1-of-1 operator can decrypt bid amounts as soon as it discovers their notes and capsules. Auction configuration, bid handles, commitments, note IDs, timing, and bid counts are public. Settlement publishes the accepted bid amounts, winning bid, clearing price, and winning commitment; private-note recipients remain hidden.

The vault is a privacy account controlled by the auction operator. The STRK20 pool proves note ownership, prevents double spending, and conserves value, while the Whisper contract verifies the Vickrey result. The operator is responsible for matching notes to bids and constructing the promised refund and proceeds outputs. Bidders therefore trust the operator to settle or return escrowed funds.

A normal dapp must never handle a user's viewing key, notes, or proofs. User actions belong behind a compatible wallet interface; only the backend-controlled vault service holds its own viewing key. Start with the [Vocs walkthrough](docs/src/pages/how-whisper-works.mdx), then use [the protocol specification](docs/PROTOCOL.md) and the [STRK20 actions and proofs guide](https://strk20-by-example.org/actions-and-proofs) for details.

## Sepolia deployment

The experimental Sepolia instance is deployed at [`0x01a0…2083`](https://sepolia.voyager.online/contract/0x01a0027cf3cee829e991691543ea455d1fdcf2fc7296837243ff0cf35d742083) against the canonical Sepolia STRK20 pool. Its class hash, transactions, deployment blocks, disposable service-account addresses, and public operator keys are recorded in [`deployments/sepolia.json`](deployments/sepolia.json); signing, viewing, and reveal secrets are stored outside the repository.

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
