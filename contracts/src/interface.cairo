use starknet::ContractAddress;
use crate::types::{
    Auction, AuctionConfig, AuctionResult, OpenNoteDeposit, PrivacyCommand, PrivacyRequest,
    SealedBid,
};

#[starknet::interface]
pub trait IWhisperAuction<TContractState> {
    fn create_auction(ref self: TContractState, config: AuctionConfig) -> u64;

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
        self: @TContractState, identity_key: felt252, request: PrivacyRequest,
    ) -> PrivacyCommand;

    /// Called onchain by the configured STRK20 pool with the computation result.
    /// Bid registration creates no open-note deposits, so both returned spans
    /// are empty.
    /// The canonical pool decodes exactly one serialized `Span<OpenNoteDeposit>`.
    /// Returning any trailing value makes the pool reject the callback.
    fn privacy_invoke_with_computation(
        ref self: TContractState, command: PrivacyCommand,
    ) -> Span<OpenNoteDeposit>;
}
