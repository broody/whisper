use starknet::ContractAddress;

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
    pub winner_payload_domain: felt252,
    pub reserve_price: u128,
    pub max_bid: u128,
    pub max_bids: u32,
    pub bidding_deadline: u64,
    pub force_reveal_after: u64,
    pub abort_after: u64,
    pub vault_address: ContractAddress,
    pub vault_public_key: felt252,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct Auction {
    pub id: u64,
    pub creator: ContractAddress,
    pub payment_token: ContractAddress,
    pub proceeds_recipient_commitment: felt252,
    pub metadata_hash: felt252,
    pub winner_payload_domain: felt252,
    pub reserve_price: u128,
    pub max_bid: u128,
    pub max_bids: u32,
    pub bidding_deadline: u64,
    pub force_reveal_after: u64,
    pub abort_after: u64,
    pub vault_address: ContractAddress,
    pub vault_public_key: felt252,
    pub accepted_bids_hash: felt252,
    pub bid_count: u32,
    pub status: AuctionStatus,
    pub settlement_hash: felt252,
    pub recovery_hash: felt252,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct BidSubmission {
    pub auction_id: u64,
    pub bid_handle: felt252,
    pub identity_commitment: felt252,
    pub note_id: felt252,
    pub capsule_hash: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
}

/// Private input supplied to Whisper's STRK20 `privacy_compute` entrypoint.
///
/// These values are commitments or opaque identifiers; the bid amount is not
/// included and must remain inside the encrypted note/proof witness.
#[derive(Copy, Drop, Serde, Debug, PartialEq)]
pub struct BidIntent {
    pub auction_id: u64,
    pub note_id: felt252,
    pub capsule_hash: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct SealedBid {
    pub auction_id: u64,
    pub bid_handle: felt252,
    pub identity_commitment: felt252,
    pub note_id: felt252,
    pub capsule_hash: felt252,
    pub refund_commitment: felt252,
    pub winner_commitment: felt252,
    pub submitted_at: u64,
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
