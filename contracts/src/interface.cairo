use starknet::{ClassHash, ContractAddress};
use crate::types::{
    Auction, AuctionConfig, AuctionResult, BidGroup, OpenNoteDeposit, PrivacyCommand,
    PrivacyRequest, SealedBid, WalletBidRequest,
};

#[starknet::interface]
pub trait IWhisperAuction<TContractState> {
    fn create_auction(ref self: TContractState, config: AuctionConfig) -> u64;
    fn claim_asset(
        ref self: TContractState, auction_id: u64, recipient: ContractAddress, secret: felt252,
    );
    fn reclaim_asset(ref self: TContractState, auction_id: u64);

    fn get_pool_address(self: @TContractState) -> ContractAddress;
    fn get_asset_winner_payload_domain(self: @TContractState) -> felt252;
    fn compute_asset_winner_commitment(
        self: @TContractState, auction_id: u64, recipient: ContractAddress, secret: felt252,
    ) -> felt252;
    fn get_auction(self: @TContractState, auction_id: u64) -> Auction;
    fn get_bid_group(self: @TContractState, auction_id: u64, group_handle: felt252) -> BidGroup;
    fn get_bid(self: @TContractState, auction_id: u64, bid_handle: felt252) -> SealedBid;
    fn get_bid_handle(self: @TContractState, auction_id: u64, index: u32) -> felt252;
    fn get_result(self: @TContractState, auction_id: u64) -> AuctionResult;
}

/// Administrative surface implemented with OpenZeppelin's Ownable component.
#[starknet::interface]
pub trait IWhisperOwnable<TContractState> {
    fn owner(self: @TContractState) -> ContractAddress;
    fn pending_owner(self: @TContractState) -> ContractAddress;
    fn accept_ownership(ref self: TContractState);
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
    fn renounce_ownership(ref self: TContractState);
}

/// Class replacement guarded by the OpenZeppelin Ownable component.
#[starknet::interface]
pub trait IWhisperUpgradeable<TContractState> {
    fn upgrade(ref self: TContractState, new_class_hash: ClassHash);
}

/// Wallet API-compatible STRK20 `Invoke` target implemented by Whisper.
#[starknet::interface]
pub trait IWhisperBidAction<TContractState> {
    fn privacy_invoke(ref self: TContractState, request: WalletBidRequest) -> Span<OpenNoteDeposit>;
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
