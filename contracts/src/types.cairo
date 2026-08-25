use starknet::ContractAddress;
use crate::asset_types::{AuctionFulfillment, FulfillmentStatus};

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub enum AuctionStatus {
    #[default]
    Unset,
    Bidding,
    Settled,
    Aborted,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct AuctionConfig {
    pub payment_token: ContractAddress,
    pub proceeds_recipient_commitment: felt252,
    pub metadata_hash: felt252,
    pub fulfillment: AuctionFulfillment,
    pub winner_payload_domain: felt252,
    pub reserve_price: u128,
    pub max_bids: u32,
    pub bidding_deadline: u64,
    pub force_reveal_after: u64,
    pub abort_after: u64,
    pub vault_address: ContractAddress,
    pub vault_public_key: felt252,
    /// Application-layer encryption key for the bid reveal capsule. This must
    /// be distinct from the STRK20 viewing/registration key in production.
    pub reveal_public_key: felt252,
    /// Commitment to the STRK20 contract-scoped identity used by the
    /// backend-controlled vault operator.
    pub operator_identity_commitment: felt252,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct Auction {
    pub id: u64,
    pub creator: ContractAddress,
    pub payment_token: ContractAddress,
    pub proceeds_recipient_commitment: felt252,
    pub metadata_hash: felt252,
    pub fulfillment: AuctionFulfillment,
    pub fulfillment_status: FulfillmentStatus,
    pub winner_payload_domain: felt252,
    pub reserve_price: u128,
    pub max_bids: u32,
    pub bidding_deadline: u64,
    pub force_reveal_after: u64,
    pub abort_after: u64,
    pub vault_address: ContractAddress,
    pub vault_public_key: felt252,
    pub reveal_public_key: felt252,
    pub operator_identity_commitment: felt252,
    pub accepted_bids_hash: felt252,
    pub submission_count: u32,
    pub bid_count: u32,
    pub status: AuctionStatus,
    pub settlement_hash: felt252,
    pub recovery_hash: felt252,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct BidSubmission {
    pub auction_id: u64,
    pub bid_handle: felt252,
    pub group_handle: felt252,
    pub tranche_index: u32,
    pub reveal_commitment: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
}

/// Initial bid submitted through the Wallet API's standard `privacy_invoke`
/// boundary. The random nonce makes the bid group unlinkable to the wallet.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct BidIntent {
    pub auction_id: u64,
    pub bid_nonce: felt252,
    pub reveal_commitment: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
}

/// Additive funding tranche for an existing logical bid group.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct BidTopUpIntent {
    pub auction_id: u64,
    pub group_handle: felt252,
    pub reveal_commitment: felt252,
}

/// Requests accepted through the Wallet API-compatible plain invoke boundary.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub enum WalletBidRequest {
    SubmitBid: BidIntent,
    AddBidTranche: BidTopUpIntent,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct BidGroup {
    pub auction_id: u64,
    pub group_handle: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
    pub tranche_count: u32,
    pub funded_tranche_count: u32,
    pub settled: bool,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct SealedBid {
    pub auction_id: u64,
    pub bid_handle: felt252,
    pub group_handle: felt252,
    pub tranche_index: u32,
    pub note_id: felt252,
    pub reveal_commitment: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
    pub submitted_at: u64,
    pub funded: bool,
    pub settled: bool,
}

/// ABI-compatible with `privacy::objects::OpenNoteDeposit`.
///
/// Whisper's bid registration action returns an empty span today, but the
/// canonical return type is required by the STRK20 invoke boundary.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct RevealedBid {
    pub bid_handle: felt252,
    pub amount: u128,
    /// One-time opening used to verify the bid-time reveal commitment.
    pub salt: felt252,
}

/// Vault-operator attestation that an incoming encrypted note was discovered,
/// decrypted, and matched to the submitted bid transcript.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct AcceptBidInput {
    pub auction_id: u64,
    pub bid_handle: felt252,
    /// Encrypted note created for the vault in the same pool transaction as
    /// the bid submission, correlated and attested by the operator.
    pub note_id: felt252,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct AbortInput {
    pub auction_id: u64,
    pub recovery_hash: felt252,
}

#[derive(Drop, Serde, Debug, PartialEq)]
pub struct SettlementInput {
    pub auction_id: u64,
    pub accepted_bids_hash: felt252,
    pub revealed_bids: Span<RevealedBid>,
    pub winner_bid_handle: felt252,
    pub reveals_root: felt252,
    pub outputs_root: felt252,
    pub settlement_hash: felt252,
}

/// Operator-only requests accepted by the canonical STRK20
/// `ComputeAndInvoke` boundary.
#[derive(Drop, Serde, Debug, PartialEq)]
pub enum PrivacyRequest {
    AcceptBid: AcceptBidInput,
    Settle: SettlementInput,
    Abort: AbortInput,
}

/// Result returned by `privacy_compute` and forwarded by the pool to
/// `privacy_invoke_with_computation`. Operator-only variants are emitted only
/// after the private operator identity has been authenticated.
#[derive(Drop, Serde, Debug, PartialEq)]
pub enum PrivacyCommand {
    AcceptBid: AcceptBidInput,
    Settle: SettlementInput,
    Abort: AbortInput,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct PricingResult {
    pub winner_bid_handle: felt252,
    pub winning_bid: u128,
    pub second_highest_bid: u128,
    pub clearing_price: u128,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct AuctionResult {
    pub auction_id: u64,
    pub has_winner: bool,
    pub winner_bid_handle: felt252,
    pub winner_commitment: felt252,
    pub winning_bid: u128,
    pub second_highest_bid: u128,
    pub clearing_price: u128,
    pub reveals_root: felt252,
    pub outputs_root: felt252,
    pub settlement_hash: felt252,
    pub settled_at: u64,
}
