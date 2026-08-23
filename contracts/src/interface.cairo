use starknet::ContractAddress;
use crate::types::{
    Auction, AuctionConfig, AuctionResult, BidIntent, BidSubmission, OpenNoteDeposit, RevealedBid,
    SealedBid,
};

#[starknet::interface]
pub trait IWhisperAuction<TContractState> {
    fn create_auction(ref self: TContractState, config: AuctionConfig) -> u64;

    /// Pool-authenticated result of the custom encrypted-note bid action.
    fn record_bid(ref self: TContractState, bid: BidSubmission);

    /// Pool-authenticated result of the batch force-reveal and settlement proof.
    fn force_reveal_and_settle(
        ref self: TContractState,
        auction_id: u64,
        accepted_bids_hash: felt252,
        revealed_bids: Span<RevealedBid>,
        winner_bid_handle: felt252,
        reveals_root: felt252,
        outputs_root: felt252,
        settlement_hash: felt252,
    );

    /// Pool-authenticated recovery after the settlement grace period.
    fn abort_auction(ref self: TContractState, auction_id: u64, recovery_hash: felt252);

    fn get_pool_address(self: @TContractState) -> ContractAddress;
    fn get_auction(self: @TContractState, auction_id: u64) -> Auction;
    fn get_bid(self: @TContractState, auction_id: u64, bid_handle: felt252) -> SealedBid;
    fn get_bid_handle(self: @TContractState, auction_id: u64, index: u32) -> felt252;
    fn get_result(self: @TContractState, auction_id: u64) -> AuctionResult;
}

/// STRK20 `ComputeAndInvoke` target implemented by `WhisperAuction`.
#[starknet::interface]
pub trait IWhisperPrivacyAction<TContractState> {
    /// Runs inside the proven client computation. STRK20 prepends an identity
    /// key derived for this contract; Whisper never receives the wallet key.
    fn privacy_compute(
        self: @TContractState, identity_key: felt252, intent: BidIntent,
    ) -> BidSubmission;

    /// Called onchain by the configured STRK20 pool with the computation result.
    /// Bid registration creates no open-note deposits, so both returned spans
    /// are empty.
    fn privacy_invoke_with_computation(
        ref self: TContractState, bid: BidSubmission,
    ) -> (Span<OpenNoteDeposit>, Span<ContractAddress>);
}
