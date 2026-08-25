use snforge_std::{
    CheatSpan, ContractClassTrait, DeclareResultTrait, cheat_caller_address, declare,
    start_cheat_block_timestamp, start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::{ClassHash, ContractAddress, SyscallResultTrait};
use crate::asset_hashes::{ASSET_WINNER_DOMAIN, compute_asset_winner_commitment};
use crate::asset_interface::{
    IERC1155AssetDispatcher, IERC1155AssetDispatcherTrait, IERC20AssetDispatcher,
    IERC20AssetDispatcherTrait, IERC721AssetDispatcher, IERC721AssetDispatcherTrait,
};
use crate::asset_types::{AuctionFulfillment, FulfillmentKind, FulfillmentStatus};
use crate::hashes::{
    compute_bid_group_handle, compute_bid_handle, compute_operator_identity_commitment,
    compute_reveal_commitment,
};
use crate::interface::{
    IWhisperAuctionDispatcher, IWhisperAuctionDispatcherTrait, IWhisperBidActionDispatcher,
    IWhisperBidActionDispatcherTrait, IWhisperOwnableDispatcher, IWhisperOwnableDispatcherTrait,
    IWhisperPrivacyActionDispatcher, IWhisperPrivacyActionDispatcherTrait,
    IWhisperUpgradeableDispatcher, IWhisperUpgradeableDispatcherTrait,
};
use crate::pricing::compute_vickrey_price;
use crate::test_tokens::{
    IMockERC1155ControlDispatcher, IMockERC1155ControlDispatcherTrait, IMockERC20ControlDispatcher,
    IMockERC20ControlDispatcherTrait, IMockERC721ControlDispatcher,
    IMockERC721ControlDispatcherTrait, IMockWhisperUpgradeV2Dispatcher,
    IMockWhisperUpgradeV2DispatcherTrait,
};
use crate::types::{
    AbortInput, AcceptBidInput, AuctionConfig, AuctionStatus, BidIntent, BidTopUpIntent,
    PrivacyRequest, RevealedBid, SettlementInput, WalletBidRequest,
};

const RESERVE_PRICE: u128 = 10;
const BID_DEADLINE: u64 = 200;
const REVEAL_AFTER: u64 = 220;
const ABORT_AFTER: u64 = 300;
const OPERATOR_IDENTITY_KEY: felt252 = 0x444;
const MAX_U128: u128 = 0xffffffffffffffffffffffffffffffff;

fn address(value: felt252) -> ContractAddress {
    value.try_into().unwrap()
}

fn pool_address() -> ContractAddress {
    address(0x100)
}

fn creator_address() -> ContractAddress {
    address(0x200)
}

fn owner_address() -> ContractAddress {
    address(0x900)
}

fn config(token: ContractAddress) -> AuctionConfig {
    AuctionConfig {
        payment_token: token,
        proceeds_recipient_commitment: 0x301,
        metadata_hash: 0x302,
        fulfillment: AuctionFulfillment {
            kind: FulfillmentKind::Offchain, token: address(0), token_id: 0, amount: 0,
        },
        winner_payload_domain: 0x303,
        reserve_price: RESERVE_PRICE,
        max_bids: 16,
        bidding_deadline: BID_DEADLINE,
        force_reveal_after: REVEAL_AFTER,
        abort_after: ABORT_AFTER,
        vault_address: address(0x400),
        vault_public_key: 0x401,
        reveal_public_key: 0x402,
        operator_identity_commitment: compute_operator_identity_commitment(OPERATOR_IDENTITY_KEY),
    }
}

fn deploy_with_owner(owner: ContractAddress) -> IWhisperAuctionDispatcher {
    let pool = pool_address();
    let mut calldata = array![];
    pool.serialize(ref calldata);
    owner.serialize(ref calldata);
    let contract_class = declare("WhisperAuction").unwrap();
    let (contract_address, _) = contract_class.contract_class().deploy(@calldata).unwrap_syscall();
    IWhisperAuctionDispatcher { contract_address }
}

fn deploy() -> IWhisperAuctionDispatcher {
    deploy_with_owner(owner_address())
}

fn ownable(auction: IWhisperAuctionDispatcher) -> IWhisperOwnableDispatcher {
    IWhisperOwnableDispatcher { contract_address: auction.contract_address }
}

fn upgradeable(auction: IWhisperAuctionDispatcher) -> IWhisperUpgradeableDispatcher {
    IWhisperUpgradeableDispatcher { contract_address: auction.contract_address }
}

fn privacy(auction: IWhisperAuctionDispatcher) -> IWhisperPrivacyActionDispatcher {
    IWhisperPrivacyActionDispatcher { contract_address: auction.contract_address }
}

fn wallet_bid(auction: IWhisperAuctionDispatcher) -> IWhisperBidActionDispatcher {
    IWhisperBidActionDispatcher { contract_address: auction.contract_address }
}

fn create_auction(auction: IWhisperAuctionDispatcher, token: ContractAddress) -> u64 {
    set_context(auction, 100, creator_address());
    auction.create_auction(config(token))
}

fn set_context(auction: IWhisperAuctionDispatcher, timestamp: u64, caller: ContractAddress) {
    start_cheat_block_timestamp(auction.contract_address, timestamp);
    start_cheat_caller_address(auction.contract_address, caller);
}

fn bid_intent(
    auction_id: u64, bid_nonce: felt252, note_id: felt252, amount: u128, salt: felt252,
) -> BidIntent {
    let refund_commitment = note_id + 0x1000;
    let winner_commitment = note_id + 0x2000;
    BidIntent {
        auction_id,
        bid_nonce,
        reveal_commitment: compute_reveal_commitment(
            auction_id, amount, salt, refund_commitment, winner_commitment,
        ),
        refund_commitment,
        winner_commitment,
    }
}

fn submit_bid(
    auction: IWhisperAuctionDispatcher,
    auction_id: u64,
    bid_nonce: felt252,
    note_id: felt252,
    amount: u128,
    salt: felt252,
) -> felt252 {
    let intent = bid_intent(auction_id, bid_nonce, note_id, amount, salt);
    let group_handle = compute_bid_group_handle(
        auction_id, bid_nonce, intent.refund_commitment, intent.winner_commitment,
    );
    let bid_handle = compute_bid_handle(auction_id, group_handle, 0, intent.reveal_commitment);
    set_context(auction, 150, pool_address());
    wallet_bid(auction).privacy_invoke(WalletBidRequest::SubmitBid(intent));
    bid_handle
}

fn add_bid_tranche(
    auction: IWhisperAuctionDispatcher,
    auction_id: u64,
    group_handle: felt252,
    note_id: felt252,
    amount: u128,
    salt: felt252,
) -> felt252 {
    let group = auction.get_bid_group(auction_id, group_handle);
    let reveal_commitment = compute_reveal_commitment(
        auction_id, amount, salt, group.refund_commitment, group.winner_commitment,
    );
    let bid_handle = compute_bid_handle(
        auction_id, group_handle, group.tranche_count, reveal_commitment,
    );
    set_context(auction, 150, pool_address());
    wallet_bid(auction)
        .privacy_invoke(
            WalletBidRequest::AddBidTranche(
                BidTopUpIntent { auction_id, group_handle, reveal_commitment },
            ),
        );
    bid_handle
}

fn accept_bid(
    auction: IWhisperAuctionDispatcher, auction_id: u64, bid_handle: felt252, note_id: felt252,
) {
    accept_bid_at(auction, auction_id, bid_handle, note_id, 150);
}

fn accept_bid_at(
    auction: IWhisperAuctionDispatcher,
    auction_id: u64,
    bid_handle: felt252,
    note_id: felt252,
    timestamp: u64,
) {
    set_context(auction, timestamp, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::AcceptBid(AcceptBidInput { auction_id, bid_handle, note_id }),
        );
    set_context(auction, timestamp, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

fn submit_and_accept_bid(
    auction: IWhisperAuctionDispatcher,
    auction_id: u64,
    identity_key: felt252,
    note_id: felt252,
    amount: u128,
    salt: felt252,
) -> felt252 {
    let bid_handle = submit_bid(auction, auction_id, identity_key, note_id, amount, salt);
    accept_bid(auction, auction_id, bid_handle, note_id);
    bid_handle
}

fn settle(
    auction: IWhisperAuctionDispatcher,
    auction_id: u64,
    revealed_bids: Span<RevealedBid>,
    winner_bid_handle: felt252,
) {
    let state = auction.get_auction(auction_id);
    set_context(auction, REVEAL_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Settle(
                SettlementInput {
                    auction_id,
                    accepted_bids_hash: state.accepted_bids_hash,
                    revealed_bids,
                    winner_bid_handle,
                    reveals_root: 0x901,
                    outputs_root: 0x902,
                    settlement_hash: 0x903,
                },
            ),
        );
    set_context(auction, REVEAL_AFTER, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
// Baseline: ~37,910 L2 gas on Scarb 2.13.1 / snforge 0.60.0.
#[available_gas(l2_gas: 50_000)]
fn computes_second_price_and_private_change_amount() {
    let bids = array![
        RevealedBid { bid_handle: 11, amount: 14, salt: 1 },
        RevealedBid { bid_handle: 22, amount: 30, salt: 2 },
        RevealedBid { bid_handle: 33, amount: 22, salt: 3 },
    ];
    let result = compute_vickrey_price(bids.span(), RESERVE_PRICE);
    assert_eq!(result.winner_bid_handle, 22);
    assert_eq!(result.winning_bid, 30);
    assert_eq!(result.second_highest_bid, 22);
    assert_eq!(result.clearing_price, 22);
    assert_eq!(result.winning_bid - result.clearing_price, 8);
}

#[test]
fn one_bid_pays_reserve() {
    let bids = array![RevealedBid { bid_handle: 44, amount: 90, salt: 1 }];
    let result = compute_vickrey_price(bids.span(), RESERVE_PRICE);
    assert_eq!(result.winner_bid_handle, 44);
    assert_eq!(result.second_highest_bid, 0);
    assert_eq!(result.clearing_price, RESERVE_PRICE);
}

#[test]
fn tied_bid_uses_smallest_handle_and_pays_tied_amount() {
    let bids = array![
        RevealedBid { bid_handle: 20, amount: 50, salt: 1 },
        RevealedBid { bid_handle: 10, amount: 50, salt: 2 },
        RevealedBid { bid_handle: 30, amount: 40, salt: 3 },
    ];
    let result = compute_vickrey_price(bids.span(), RESERVE_PRICE);
    assert_eq!(result.winner_bid_handle, 10);
    assert_eq!(result.winning_bid, 50);
    assert_eq!(result.second_highest_bid, 50);
    assert_eq!(result.clearing_price, 50);
}

#[test]
fn derives_wallet_bid_group_and_tranche_transcript() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let intent = bid_intent(auction_id, 0xabc, 0x704, 30, 0x705);
    let expected_group = compute_bid_group_handle(
        auction_id, intent.bid_nonce, intent.refund_commitment, intent.winner_commitment,
    );
    let expected_bid = compute_bid_handle(auction_id, expected_group, 0, intent.reveal_commitment);
    set_context(auction, 150, pool_address());
    wallet_bid(auction).privacy_invoke(WalletBidRequest::SubmitBid(intent));
    assert_eq!(auction.get_bid(auction_id, expected_bid).group_handle, expected_group);
}

#[test]
fn matches_canonical_typescript_bid_transcript_vector() {
    let group_handle = compute_bid_group_handle(1, 0xabc, 0x702, 0x703);
    let bid_handle = compute_bid_handle(1, group_handle, 0, 0x701);
    assert_eq!(group_handle, 0xe8fdc2a31cc7c303e4a77bd5656145cd299cfeef0dbb110ef69b2f4daf123f);
    assert_eq!(bid_handle, 0x56fe80448dce869e7b460dd35c343d5018dd0b0a085bc5ff8aaa2bc6abd64f);
}

#[test]
fn matches_typescript_operator_and_reveal_vectors() {
    assert_eq!(
        compute_operator_identity_commitment(0x123),
        0x6e876d6c9ddb85e9971d01b7929af750cdb526e2682eeee41d9309dc5d0c63d,
    );
    assert_eq!(
        compute_reveal_commitment(7, 25, 99, 13, 14),
        0x3c680e2bf9d6ed1671676046be5b8e3ef5029ed40fb63e098c729cfc1d3de50,
    );
}

#[test]
// Baseline: ~1,779,910 L2 gas and ~384 L1 data gas.
#[available_gas(l1_data_gas: 500, l2_gas: 2_200_000)]
fn constructor_sets_explicit_upgrade_owner() {
    let auction = deploy();
    assert_eq!(ownable(auction).owner(), owner_address());
}

#[test]
#[should_panic(expected: 'New owner is the zero address')]
fn rejects_zero_upgrade_owner() {
    deploy_with_owner(address(0));
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn rejects_upgrade_from_non_owner() {
    let auction = deploy();
    let replacement = declare("MockWhisperUpgradeV2").unwrap().contract_class();
    start_cheat_caller_address(auction.contract_address, address(0x901));
    upgradeable(auction).upgrade(*replacement.class_hash);
}

#[test]
#[should_panic(expected: 'Class hash cannot be zero')]
fn rejects_zero_upgrade_class_hash() {
    let auction = deploy();
    let zero_class_hash: ClassHash = 0.try_into().unwrap();
    start_cheat_caller_address(auction.contract_address, owner_address());
    upgradeable(auction).upgrade(zero_class_hash);
}

#[test]
// Baseline: ~2,140,220 L2 gas and ~384 L1 data gas.
#[available_gas(l1_data_gas: 500, l2_gas: 2_600_000)]
fn owner_can_upgrade_and_preserve_existing_storage() {
    let auction = deploy();
    let replacement = declare("MockWhisperUpgradeV2").unwrap().contract_class();
    start_cheat_caller_address(auction.contract_address, owner_address());
    upgradeable(auction).upgrade(*replacement.class_hash);

    let upgraded = IMockWhisperUpgradeV2Dispatcher { contract_address: auction.contract_address };
    assert_eq!(upgraded.get_pool_address(), pool_address());
    assert_eq!(upgraded.version(), 2);
}

#[test]
// Baseline: ~3,104,230 L2 gas and ~384 L1 data gas.
#[available_gas(l1_data_gas: 500, l2_gas: 3_800_000)]
fn transferred_owner_controls_future_upgrades() {
    let auction = deploy();
    let new_owner = address(0x902);
    start_cheat_caller_address(auction.contract_address, owner_address());
    ownable(auction).transfer_ownership(new_owner);
    assert_eq!(ownable(auction).owner(), owner_address());
    assert_eq!(ownable(auction).pending_owner(), new_owner);

    start_cheat_caller_address(auction.contract_address, new_owner);
    ownable(auction).accept_ownership();
    assert_eq!(ownable(auction).owner(), new_owner);
    assert_eq!(ownable(auction).pending_owner(), address(0));

    let replacement = declare("MockWhisperUpgradeV2").unwrap().contract_class();
    upgradeable(auction).upgrade(*replacement.class_hash);
    assert_eq!(
        IMockWhisperUpgradeV2Dispatcher { contract_address: auction.contract_address }.version(), 2,
    );
}

#[test]
#[should_panic(expected: 'Caller is not the owner')]
fn pending_owner_cannot_upgrade_before_acceptance() {
    let auction = deploy();
    let pending_owner = address(0x902);
    start_cheat_caller_address(auction.contract_address, owner_address());
    ownable(auction).transfer_ownership(pending_owner);

    let replacement = declare("MockWhisperUpgradeV2").unwrap().contract_class();
    start_cheat_caller_address(auction.contract_address, pending_owner);
    upgradeable(auction).upgrade(*replacement.class_hash);
}

#[test]
#[should_panic(expected: 'Caller is not the pending owner')]
fn third_party_cannot_accept_ownership() {
    let auction = deploy();
    start_cheat_caller_address(auction.contract_address, owner_address());
    ownable(auction).transfer_ownership(address(0x902));

    start_cheat_caller_address(auction.contract_address, address(0x903));
    ownable(auction).accept_ownership();
}

#[test]
// Baseline: ~21,037,630 L2 gas and ~3,264 L1 data gas.
#[available_gas(l1_data_gas: 4_000, l2_gas: 25_000_000)]
fn wallet_invoke_submits_unfunded_bid() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let bid_handle = submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    let stored = auction.get_bid(auction_id, bid_handle);
    let state = auction.get_auction(auction_id);
    assert!(!stored.funded);
    assert_eq!(state.submission_count, 1);
    assert_eq!(state.bid_count, 0);
}

#[test]
// Baseline: ~28,594,414 L2 gas and ~3,840 L1 data gas.
#[available_gas(l1_data_gas: 4_500, l2_gas: 34_000_000)]
fn operator_accepts_discovered_vault_note() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let bid_handle = submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    accept_bid(auction, auction_id, bid_handle, 0x704);
    let stored = auction.get_bid(auction_id, bid_handle);
    assert!(stored.funded);
    assert_eq!(stored.note_id, 0x704);
    assert_eq!(auction.get_auction(auction_id).bid_count, 1);
    assert_eq!(auction.get_bid_handle(auction_id, 0), bid_handle);
}

#[test]
fn operator_accepts_during_post_bid_grace_period() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let bid_handle = submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    accept_bid_at(auction, auction_id, bid_handle, 0x704, BID_DEADLINE);
    assert!(auction.get_bid(auction_id, bid_handle).funded);
}

#[test]
#[should_panic(expected: "ACCEPTANCE_CLOSED")]
fn rejects_acceptance_when_force_reveal_window_opens() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let bid_handle = submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    accept_bid_at(auction, auction_id, bid_handle, 0x704, REVEAL_AFTER);
}

#[test]
fn supports_different_payment_tokens_per_auction() {
    let auction = deploy();
    let first_id = create_auction(auction, address(0x501));
    let second_id = create_auction(auction, address(0x502));
    assert_eq!(auction.get_auction(first_id).payment_token, address(0x501));
    assert_eq!(auction.get_auction(second_id).payment_token, address(0x502));
}

#[test]
#[should_panic(expected: "MAX_BIDS_TOO_HIGH")]
fn rejects_auction_capacity_above_supported_limit() {
    let auction = deploy();
    let mut invalid = config(address(0x501));
    invalid.max_bids = 257;
    set_context(auction, 100, creator_address());
    auction.create_auction(invalid);
}

#[test]
#[should_panic(expected: "INVALID_REVEAL_TIME")]
fn rejects_auction_without_post_bid_grace_period() {
    let auction = deploy();
    let mut invalid = config(address(0x501));
    invalid.force_reveal_after = invalid.bidding_deadline;
    set_context(auction, 100, creator_address());
    auction.create_auction(invalid);
}

#[test]
#[should_panic(expected: "BIDDING_CLOSED")]
fn rejects_bid_at_bidding_deadline() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, BID_DEADLINE, pool_address());
    wallet_bid(auction)
        .privacy_invoke(
            WalletBidRequest::SubmitBid(bid_intent(auction_id, 0xabc, 0x704, 30, 0x705)),
        );
}

#[test]
#[should_panic(expected: "DUPLICATE_BID_GROUP")]
fn rejects_duplicate_bid_group() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let intent = bid_intent(auction_id, 0xabc, 0x704, 30, 0x705);
    set_context(auction, 150, pool_address());
    wallet_bid(auction).privacy_invoke(WalletBidRequest::SubmitBid(intent));
    wallet_bid(auction).privacy_invoke(WalletBidRequest::SubmitBid(intent));
}

#[test]
#[should_panic(expected: "BID_ALREADY_FUNDED")]
fn rejects_funding_same_bid_twice() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let bid_handle = submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    accept_bid(auction, auction_id, bid_handle, 0x704);
    accept_bid(auction, auction_id, bid_handle, 0x706);
}

#[test]
#[should_panic(expected: "MAX_BIDS_REACHED")]
fn enforces_accepted_tranche_capacity() {
    let auction = deploy();
    let mut limited = config(address(0x501));
    limited.max_bids = 1;
    set_context(auction, 100, creator_address());
    let auction_id = auction.create_auction(limited);
    let first = submit_bid(auction, auction_id, 0xa1, 0x701, 20, 0x801);
    let second = submit_bid(auction, auction_id, 0xa2, 0x702, 30, 0x802);
    accept_bid(auction, auction_id, first, 0x701);
    accept_bid(auction, auction_id, second, 0x702);
}

#[test]
#[should_panic(expected: "DUPLICATE_NOTE_ID")]
fn rejects_note_reuse_across_auctions() {
    let auction = deploy();
    let first_auction = create_auction(auction, address(0x501));
    let second_auction = create_auction(auction, address(0x501));
    let first = submit_bid(auction, first_auction, 0xa1, 0x701, 20, 0x801);
    let second = submit_bid(auction, second_auction, 0xa2, 0x702, 30, 0x802);
    accept_bid(auction, first_auction, first, 0x900);
    accept_bid(auction, second_auction, second, 0x900);
}

#[test]
#[should_panic(expected: "ONLY_POOL")]
fn rejects_computed_command_not_forwarded_by_pool() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, ABORT_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Abort(AbortInput { auction_id, recovery_hash: 0xa01 }),
        );
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
// Baseline: ~76,911,588 L2 gas and ~8,832 L1 data gas.
#[available_gas(l1_data_gas: 10_500, l2_gas: 92_000_000)]
fn settles_operator_accepted_vickrey_result() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 14, 0x801);
    let second = submit_and_accept_bid(auction, auction_id, 0xa2, 0x702, 30, 0x802);
    let third = submit_and_accept_bid(auction, auction_id, 0xa3, 0x703, 22, 0x803);
    let revealed = array![
        RevealedBid { bid_handle: first, amount: 14, salt: 0x801 },
        RevealedBid { bid_handle: second, amount: 30, salt: 0x802 },
        RevealedBid { bid_handle: third, amount: 22, salt: 0x803 },
    ];
    let winner_group = auction.get_bid(auction_id, second).group_handle;
    settle(auction, auction_id, revealed.span(), winner_group);

    let state = auction.get_auction(auction_id);
    let result = auction.get_result(auction_id);
    assert_eq!(state.status, AuctionStatus::Settled);
    assert_eq!(result.winner_bid_handle, winner_group);
    assert_eq!(result.winning_bid, 30);
    assert_eq!(result.second_highest_bid, 22);
    assert_eq!(result.clearing_price, 22);
    assert!(auction.get_bid(auction_id, first).settled);
    assert!(auction.get_bid(auction_id, second).settled);
    assert!(auction.get_bid(auction_id, third).settled);
}

#[test]
fn accepts_bid_without_configured_ceiling() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let amount: u128 = 1_000_000_000_000_000_000_000_000;
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, amount, 0x801);
    let revealed = array![RevealedBid { bid_handle: handle, amount, salt: 0x801 }];
    settle(auction, auction_id, revealed.span(), auction.get_bid(auction_id, handle).group_handle);
    let result = auction.get_result(auction_id);
    assert_eq!(result.winning_bid, amount);
    assert_eq!(result.clearing_price, RESERVE_PRICE);
}

#[test]
fn settles_empty_auction_without_winner() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    settle(auction, auction_id, array![].span(), 0);
    assert!(!auction.get_result(auction_id).has_winner);
}

#[test]
fn operator_aborts_after_timeout() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, ABORT_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Abort(AbortInput { auction_id, recovery_hash: 0xa01 }),
        );
    set_context(auction, ABORT_AFTER, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
    let state = auction.get_auction(auction_id);
    assert_eq!(state.status, AuctionStatus::Aborted);
    assert_eq!(state.recovery_hash, 0xa01);
}

#[test]
#[should_panic(expected: "ONLY_POOL")]
fn rejects_privacy_invoke_not_authenticated_by_pool() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, 150, address(0x999));
    wallet_bid(auction)
        .privacy_invoke(
            WalletBidRequest::SubmitBid(bid_intent(auction_id, 0xabc, 0x704, 30, 0x705)),
        );
}

#[test]
fn accepts_additive_bid_tranche() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_bid(auction, auction_id, 0xabc, 0x704, 50, 0x705);
    let group_handle = auction.get_bid(auction_id, first).group_handle;
    let second = add_bid_tranche(auction, auction_id, group_handle, 0x706, 30, 0x707);
    accept_bid(auction, auction_id, first, 0x704);
    accept_bid(auction, auction_id, second, 0x706);
    assert_eq!(auction.get_bid_group(auction_id, group_handle).funded_tranche_count, 2);
}

#[test]
// Baseline: ~72,666,832 L2 gas and ~8,256 L1 data gas.
#[available_gas(l1_data_gas: 9_800, l2_gas: 87_000_000)]
fn aggregates_tranches_before_vickrey_pricing() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_bid(auction, auction_id, 0xabc, 0x704, 50, 0x705);
    let group_handle = auction.get_bid(auction_id, first).group_handle;
    let top_up = add_bid_tranche(auction, auction_id, group_handle, 0x706, 30, 0x707);
    let competitor = submit_bid(auction, auction_id, 0xdef, 0x708, 60, 0x709);
    accept_bid(auction, auction_id, first, 0x704);
    accept_bid(auction, auction_id, top_up, 0x706);
    accept_bid(auction, auction_id, competitor, 0x708);
    let revealed = array![
        RevealedBid { bid_handle: first, amount: 50, salt: 0x705 },
        RevealedBid { bid_handle: top_up, amount: 30, salt: 0x707 },
        RevealedBid { bid_handle: competitor, amount: 60, salt: 0x709 },
    ];
    settle(auction, auction_id, revealed.span(), group_handle);
    let result = auction.get_result(auction_id);
    assert_eq!(result.winning_bid, 80);
    assert_eq!(result.second_highest_bid, 60);
    assert_eq!(result.clearing_price, 60);
}

#[test]
#[should_panic(expected: "DUPLICATE_NOTE_ID")]
fn rejects_operator_reusing_vault_note() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_bid(auction, auction_id, 0xa1, 0x704, 30, 0x705);
    let second = submit_bid(auction, auction_id, 0xa2, 0x706, 31, 0x707);
    accept_bid(auction, auction_id, first, 0x900);
    accept_bid(auction, auction_id, second, 0x900);
}

#[test]
#[should_panic(expected: "ONLY_OPERATOR")]
fn rejects_wrong_operator_identity() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let bid_handle = submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    privacy(auction)
        .privacy_compute(
            0xbad,
            PrivacyRequest::AcceptBid(AcceptBidInput { auction_id, bid_handle, note_id: 0x704 }),
        );
}

#[test]
#[should_panic(expected: "REVEAL_TOO_EARLY")]
fn rejects_settlement_before_force_reveal_window() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, REVEAL_AFTER - 1, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Settle(
                SettlementInput {
                    auction_id,
                    accepted_bids_hash: auction.get_auction(auction_id).accepted_bids_hash,
                    revealed_bids: array![].span(),
                    winner_bid_handle: 0,
                    reveals_root: 0x901,
                    outputs_root: 0x902,
                    settlement_hash: 0x903,
                },
            ),
        );
    set_context(auction, REVEAL_AFTER - 1, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic(expected: "INCOMPLETE_BID_SET")]
fn rejects_incomplete_force_reveal_batch() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 20, 0x801);
    submit_and_accept_bid(auction, auction_id, 0xa2, 0x702, 30, 0x802);
    let revealed = array![RevealedBid { bid_handle: first, amount: 20, salt: 0x801 }];
    settle(auction, auction_id, revealed.span(), first);
}

#[test]
#[should_panic(expected: "WRONG_WINNER")]
fn rejects_wrong_vickrey_winner() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 70, 0x801);
    let second = submit_and_accept_bid(auction, auction_id, 0xa2, 0x702, 80, 0x802);
    let revealed = array![
        RevealedBid { bid_handle: first, amount: 70, salt: 0x801 },
        RevealedBid { bid_handle: second, amount: 80, salt: 0x802 },
    ];
    settle(auction, auction_id, revealed.span(), first);
}

#[test]
fn refunds_group_below_reserve_without_a_winner() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, RESERVE_PRICE - 1, 0x801);
    let revealed = array![
        RevealedBid { bid_handle: handle, amount: RESERVE_PRICE - 1, salt: 0x801 },
    ];
    settle(auction, auction_id, revealed.span(), 0);
    let result = auction.get_result(auction_id);
    assert!(!result.has_winner);
    assert_eq!(result.winner_bid_handle, 0);
    assert_eq!(result.clearing_price, 0);
}

#[test]
#[should_panic(expected: "INVALID_REVEAL")]
fn rejects_reveal_that_does_not_open_bid_commitment() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 30, 0x801);
    let revealed = array![RevealedBid { bid_handle: handle, amount: 31, salt: 0x801 }];
    settle(auction, auction_id, revealed.span(), handle);
}

#[test]
#[should_panic(expected: "SETTLEMENT_EXPIRED")]
fn rejects_settlement_at_abort_deadline() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let state = auction.get_auction(auction_id);
    set_context(auction, ABORT_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Settle(
                SettlementInput {
                    auction_id,
                    accepted_bids_hash: state.accepted_bids_hash,
                    revealed_bids: array![].span(),
                    winner_bid_handle: 0,
                    reveals_root: 0x901,
                    outputs_root: 0x902,
                    settlement_hash: 0x903,
                },
            ),
        );
    set_context(auction, ABORT_AFTER, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic(expected: "BID_SET_MISMATCH")]
fn rejects_settlement_with_wrong_accepted_bid_hash() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, REVEAL_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Settle(
                SettlementInput {
                    auction_id,
                    accepted_bids_hash: 0xbad,
                    revealed_bids: array![].span(),
                    winner_bid_handle: 0,
                    reveals_root: 0x901,
                    outputs_root: 0x902,
                    settlement_hash: 0x903,
                },
            ),
        );
    set_context(auction, REVEAL_AFTER, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic(expected: "ZERO_REVEALS_ROOT")]
fn rejects_settlement_without_transcript_roots() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let state = auction.get_auction(auction_id);
    set_context(auction, REVEAL_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Settle(
                SettlementInput {
                    auction_id,
                    accepted_bids_hash: state.accepted_bids_hash,
                    revealed_bids: array![].span(),
                    winner_bid_handle: 0,
                    reveals_root: 0,
                    outputs_root: 0x902,
                    settlement_hash: 0x903,
                },
            ),
        );
    set_context(auction, REVEAL_AFTER, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic(expected: "BID_ORDER_MISMATCH")]
fn rejects_reordered_settlement_bid_set() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 20, 0x801);
    let second = submit_and_accept_bid(auction, auction_id, 0xa2, 0x702, 30, 0x802);
    let revealed = array![
        RevealedBid { bid_handle: second, amount: 30, salt: 0x802 },
        RevealedBid { bid_handle: first, amount: 20, salt: 0x801 },
    ];
    settle(auction, auction_id, revealed.span(), auction.get_bid(auction_id, second).group_handle);
}

#[test]
#[should_panic(expected: "ZERO_BID_TRANCHE")]
fn rejects_zero_value_reveal() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 0, 0x801);
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle: handle, amount: 0, salt: 0x801 }].span(),
        0,
    );
}

#[test]
#[should_panic(expected: ('BID_TOTAL_OVERFLOW',))]
fn rejects_overflowing_bid_group_total() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_bid(auction, auction_id, 0xa1, 0x701, MAX_U128, 0x801);
    let group_handle = auction.get_bid(auction_id, first).group_handle;
    let second = add_bid_tranche(auction, auction_id, group_handle, 0x702, 1, 0x802);
    accept_bid(auction, auction_id, first, 0x701);
    accept_bid(auction, auction_id, second, 0x702);
    settle(
        auction,
        auction_id,
        array![
            RevealedBid { bid_handle: first, amount: MAX_U128, salt: 0x801 },
            RevealedBid { bid_handle: second, amount: 1, salt: 0x802 },
        ]
            .span(),
        group_handle,
    );
}

#[test]
#[should_panic(expected: "ABORT_TOO_EARLY")]
fn rejects_abort_before_deadline() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, ABORT_AFTER - 1, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Abort(AbortInput { auction_id, recovery_hash: 0xa01 }),
        );
    set_context(auction, ABORT_AFTER - 1, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic(expected: "ZERO_RECOVERY_HASH")]
fn rejects_abort_without_recovery_commitment() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    set_context(auction, ABORT_AFTER, address(0x999));
    let command = privacy(auction)
        .privacy_compute(
            OPERATOR_IDENTITY_KEY,
            PrivacyRequest::Abort(AbortInput { auction_id, recovery_hash: 0 }),
        );
    set_context(auction, ABORT_AFTER, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic(expected: "NOT_SETTLEABLE")]
fn rejects_second_settlement() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    settle(auction, auction_id, array![].span(), 0);
    settle(auction, auction_id, array![].span(), 0);
}

#[test]
fn bid_equal_to_reserve_wins_and_pays_reserve() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, RESERVE_PRICE, 0x801);
    let group_handle = auction.get_bid(auction_id, handle).group_handle;
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle: handle, amount: RESERVE_PRICE, salt: 0x801 }].span(),
        group_handle,
    );
    let result = auction.get_result(auction_id);
    assert!(result.has_winner);
    assert_eq!(result.winning_bid, RESERVE_PRICE);
    assert_eq!(result.clearing_price, RESERVE_PRICE);
}

#[test]
// Baseline: ~4,633,408,560 L2 gas and ~470,304 L1 data gas for the full
// lifecycle; the 256-reveal settlement callback itself is ~406,466,644 L2 gas.
#[available_gas(l1_data_gas: 565_000, l2_gas: 5_560_000_000)]
fn settles_maximum_supported_bid_set() {
    let auction = deploy();
    let mut maximum = config(address(0x501));
    maximum.max_bids = 256;
    maximum.reserve_price = 1;
    set_context(auction, 100, creator_address());
    let auction_id = auction.create_auction(maximum);
    let mut revealed_bids: Array<RevealedBid> = array![];
    let mut winner_group = 0;
    let mut index: u32 = 0;
    while index < 256 {
        let offset: felt252 = index.into();
        let amount: u128 = index.into() + 1;
        let note_id = 0x1000 + offset;
        let salt = 0x2000 + offset;
        let bid_handle = submit_and_accept_bid(
            auction, auction_id, 0x3000 + offset, note_id, amount, salt,
        );
        revealed_bids.append(RevealedBid { bid_handle, amount, salt });
        winner_group = auction.get_bid(auction_id, bid_handle).group_handle;
        index += 1;
    }

    settle(auction, auction_id, revealed_bids.span(), winner_group);
    let result = auction.get_result(auction_id);
    assert_eq!(auction.get_auction(auction_id).bid_count, 256);
    assert_eq!(result.winner_bid_handle, winner_group);
    assert_eq!(result.winning_bid, 256);
    assert_eq!(result.second_highest_bid, 255);
    assert_eq!(result.clearing_price, 255);
}

fn deploy_mock_erc20(owner: ContractAddress, supply: u256) -> IERC20AssetDispatcher {
    let mut calldata = array![];
    owner.serialize(ref calldata);
    supply.serialize(ref calldata);
    let contract_class = declare("MockERC20").unwrap();
    let (contract_address, _) = contract_class.contract_class().deploy(@calldata).unwrap_syscall();
    IERC20AssetDispatcher { contract_address }
}

fn deploy_mock_erc721(owner: ContractAddress, token_id: u256) -> IERC721AssetDispatcher {
    let mut calldata = array![];
    owner.serialize(ref calldata);
    token_id.serialize(ref calldata);
    let contract_class = declare("MockERC721").unwrap();
    let (contract_address, _) = contract_class.contract_class().deploy(@calldata).unwrap_syscall();
    IERC721AssetDispatcher { contract_address }
}

fn deploy_mock_erc1155(
    owner: ContractAddress, token_id: u256, amount: u256,
) -> IERC1155AssetDispatcher {
    let mut calldata = array![];
    owner.serialize(ref calldata);
    token_id.serialize(ref calldata);
    amount.serialize(ref calldata);
    let contract_class = declare("MockERC1155").unwrap();
    let (contract_address, _) = contract_class.contract_class().deploy(@calldata).unwrap_syscall();
    IERC1155AssetDispatcher { contract_address }
}

fn asset_config(asset: AuctionFulfillment) -> AuctionConfig {
    let mut result = config(address(0x501));
    result.fulfillment = asset;
    result.winner_payload_domain = ASSET_WINNER_DOMAIN;
    result
}

fn create_asset_auction(
    auction: IWhisperAuctionDispatcher, seller: ContractAddress, asset: AuctionFulfillment,
) -> u64 {
    start_cheat_block_timestamp(auction.contract_address, 100);
    cheat_caller_address(auction.contract_address, seller, CheatSpan::TargetCalls(1));
    auction.create_auction(asset_config(asset))
}

fn submit_and_accept_asset_bid(
    auction: IWhisperAuctionDispatcher,
    auction_id: u64,
    bid_nonce: felt252,
    note_id: felt252,
    amount: u128,
    salt: felt252,
    winner_commitment: felt252,
) -> (felt252, felt252) {
    let refund_commitment = note_id + 0x1000;
    let reveal_commitment = compute_reveal_commitment(
        auction_id, amount, salt, refund_commitment, winner_commitment,
    );
    let group_handle = compute_bid_group_handle(
        auction_id, bid_nonce, refund_commitment, winner_commitment,
    );
    let bid_handle = compute_bid_handle(auction_id, group_handle, 0, reveal_commitment);
    set_context(auction, 150, pool_address());
    wallet_bid(auction)
        .privacy_invoke(
            WalletBidRequest::SubmitBid(
                BidIntent {
                    auction_id, bid_nonce, reveal_commitment, refund_commitment, winner_commitment,
                },
            ),
        );
    accept_bid(auction, auction_id, bid_handle, note_id);
    (bid_handle, group_handle)
}

#[test]
// Baseline: ~48,412,746 L2 gas and ~5,760 L1 data gas.
#[available_gas(l1_data_gas: 6_800, l2_gas: 58_000_000)]
fn escrows_erc20_and_delivers_it_to_committed_winner() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let recipient = address(0xb0b);
    let token = deploy_mock_erc20(seller, 100);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc20, token: token.contract_address, token_id: 0, amount: 40,
    };

    start_cheat_caller_address(token.contract_address, seller);
    IMockERC20ControlDispatcher { contract_address: token.contract_address }
        .approve(auction.contract_address, asset.amount);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);

    assert_eq!(token.balance_of(seller), 60);
    assert_eq!(token.balance_of(auction.contract_address), 40);
    assert_eq!(auction.get_auction(auction_id).creator, seller);
    assert_eq!(auction.get_auction(auction_id).fulfillment_status, FulfillmentStatus::Escrowed);
    let secret = 0xc1a1;
    let winner_commitment = auction.compute_asset_winner_commitment(auction_id, recipient, secret);
    let (bid_handle, group_handle) = submit_and_accept_asset_bid(
        auction, auction_id, 0xa1, 0x701, 30, 0x801, winner_commitment,
    );
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle, amount: 30, salt: 0x801 }].span(),
        group_handle,
    );

    auction.claim_asset(auction_id, recipient, secret);
    assert_eq!(token.balance_of(recipient), 40);
    assert_eq!(token.balance_of(auction.contract_address), 0);
    assert_eq!(auction.get_auction(auction_id).fulfillment_status, FulfillmentStatus::Claimed);
}

#[test]
// Baseline: ~26,126,656 L2 gas and ~3,264 L1 data gas.
#[available_gas(l1_data_gas: 3_800, l2_gas: 31_000_000)]
fn returns_erc721_to_seller_when_auction_has_no_winner() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let token_id = 77;
    let token = deploy_mock_erc721(seller, token_id);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc721, token: token.contract_address, token_id, amount: 1,
    };

    start_cheat_caller_address(token.contract_address, seller);
    IMockERC721ControlDispatcher { contract_address: token.contract_address }
        .approve(auction.contract_address, token_id);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    assert_eq!(token.owner_of(token_id), auction.contract_address);

    settle(auction, auction_id, array![].span(), 0);
    auction.reclaim_asset(auction_id);
    assert_eq!(token.owner_of(token_id), seller);
    assert_eq!(auction.get_auction(auction_id).fulfillment_status, FulfillmentStatus::Reclaimed);
}

#[test]
// Baseline: ~20,610,374 L2 gas and ~2,784 L1 data gas.
#[available_gas(l1_data_gas: 3_300, l2_gas: 25_000_000)]
fn returns_erc1155_after_unfinalized_auction_expires() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let token_id = 88;
    let token = deploy_mock_erc1155(seller, token_id, 25);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc1155, token: token.contract_address, token_id, amount: 7,
    };

    start_cheat_caller_address(token.contract_address, seller);
    IMockERC1155ControlDispatcher { contract_address: token.contract_address }
        .set_approval_for_all(auction.contract_address, true);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    assert_eq!(token.balance_of(auction.contract_address, token_id), 7);

    start_cheat_block_timestamp(auction.contract_address, ABORT_AFTER);
    auction.reclaim_asset(auction_id);
    assert_eq!(token.balance_of(seller, token_id), 25);
    assert_eq!(token.balance_of(auction.contract_address, token_id), 0);
    assert_eq!(auction.get_auction(auction_id).fulfillment_status, FulfillmentStatus::Reclaimed);
}

#[test]
#[should_panic(expected: "WRONG_WINNER_DOMAIN")]
fn rejects_onchain_asset_with_offchain_winner_domain() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let token = deploy_mock_erc20(seller, 100);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc20, token: token.contract_address, token_id: 0, amount: 40,
    };
    let mut bad_config = asset_config(asset);
    bad_config.winner_payload_domain = 0x303;

    set_context(auction, 100, seller);
    auction.create_auction(bad_config);
}

#[test]
fn matches_typescript_asset_commitment_vectors() {
    assert_eq!(
        compute_asset_winner_commitment(address(0x111), 9, address(0x555), 0x666),
        0x389f3d8b639107ceb0a260f4bbb07017e8f138fc002bc8016593d47751bb705,
    );
}

#[test]
#[should_panic(expected: "INVALID_WINNER_OPENING")]
fn rejects_invalid_asset_winner_opening() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let recipient = address(0xb0b);
    let token = deploy_mock_erc20(seller, 100);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc20, token: token.contract_address, token_id: 0, amount: 40,
    };
    start_cheat_caller_address(token.contract_address, seller);
    IMockERC20ControlDispatcher { contract_address: token.contract_address }
        .approve(auction.contract_address, asset.amount);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    let winner_commitment = auction.compute_asset_winner_commitment(auction_id, recipient, 0xc1a1);
    let (bid_handle, group_handle) = submit_and_accept_asset_bid(
        auction, auction_id, 0xa1, 0x701, 30, 0x801, winner_commitment,
    );
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle, amount: 30, salt: 0x801 }].span(),
        group_handle,
    );
    auction.claim_asset(auction_id, recipient, 0xbad);
}

#[test]
#[should_panic(expected: "ASSET_NOT_ESCROWED")]
fn rejects_duplicate_asset_claim() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let recipient = address(0xb0b);
    let token = deploy_mock_erc20(seller, 100);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc20, token: token.contract_address, token_id: 0, amount: 40,
    };
    start_cheat_caller_address(token.contract_address, seller);
    IMockERC20ControlDispatcher { contract_address: token.contract_address }
        .approve(auction.contract_address, asset.amount);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    let secret = 0xc1a1;
    let winner_commitment = auction.compute_asset_winner_commitment(auction_id, recipient, secret);
    let (bid_handle, group_handle) = submit_and_accept_asset_bid(
        auction, auction_id, 0xa1, 0x701, 30, 0x801, winner_commitment,
    );
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle, amount: 30, salt: 0x801 }].span(),
        group_handle,
    );
    auction.claim_asset(auction_id, recipient, secret);
    auction.claim_asset(auction_id, recipient, secret);
}

#[test]
#[should_panic(expected: "ASSET_NOT_RECLAIMABLE")]
fn rejects_asset_reclaim_while_bidding() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let token_id = 77;
    let token = deploy_mock_erc721(seller, token_id);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc721, token: token.contract_address, token_id, amount: 1,
    };
    start_cheat_caller_address(token.contract_address, seller);
    IMockERC721ControlDispatcher { contract_address: token.contract_address }
        .approve(auction.contract_address, token_id);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    set_context(auction, 150, address(0x999));
    auction.reclaim_asset(auction_id);
}

#[test]
#[should_panic(expected: "UNSOLICITED_ERC721")]
fn rejects_unsolicited_erc721_safe_transfer() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let token_id = 77;
    let token = deploy_mock_erc721(seller, token_id);
    start_cheat_caller_address(token.contract_address, seller);
    token.safe_transfer_from(seller, auction.contract_address, token_id, array![].span());
}

#[test]
// Baseline: ~46,777,426 L2 gas and ~5,760 L1 data gas.
#[available_gas(l1_data_gas: 6_800, l2_gas: 56_000_000)]
fn delivers_erc721_to_committed_winner() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let recipient = address(0xb0b);
    let token_id = 77;
    let token = deploy_mock_erc721(seller, token_id);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc721, token: token.contract_address, token_id, amount: 1,
    };
    start_cheat_caller_address(token.contract_address, seller);
    IMockERC721ControlDispatcher { contract_address: token.contract_address }
        .approve(auction.contract_address, token_id);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    let secret = 0xc1a1;
    let winner_commitment = auction.compute_asset_winner_commitment(auction_id, recipient, secret);
    let (bid_handle, group_handle) = submit_and_accept_asset_bid(
        auction, auction_id, 0xa1, 0x701, 30, 0x801, winner_commitment,
    );
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle, amount: 30, salt: 0x801 }].span(),
        group_handle,
    );
    auction.claim_asset(auction_id, recipient, secret);
    assert_eq!(token.owner_of(token_id), recipient);
    assert_eq!(auction.get_auction(auction_id).fulfillment_status, FulfillmentStatus::Claimed);
}

#[test]
// Baseline: ~48,579,866 L2 gas and ~5,952 L1 data gas.
#[available_gas(l1_data_gas: 7_100, l2_gas: 58_000_000)]
fn delivers_erc1155_to_committed_winner() {
    let auction = deploy();
    let seller = address(0xa11ce);
    let recipient = address(0xb0b);
    let token_id = 88;
    let token = deploy_mock_erc1155(seller, token_id, 25);
    let asset = AuctionFulfillment {
        kind: FulfillmentKind::Erc1155, token: token.contract_address, token_id, amount: 7,
    };
    start_cheat_caller_address(token.contract_address, seller);
    IMockERC1155ControlDispatcher { contract_address: token.contract_address }
        .set_approval_for_all(auction.contract_address, true);
    stop_cheat_caller_address(token.contract_address);
    let auction_id = create_asset_auction(auction, seller, asset);
    let secret = 0xc1a1;
    let winner_commitment = auction.compute_asset_winner_commitment(auction_id, recipient, secret);
    let (bid_handle, group_handle) = submit_and_accept_asset_bid(
        auction, auction_id, 0xa1, 0x701, 30, 0x801, winner_commitment,
    );
    settle(
        auction,
        auction_id,
        array![RevealedBid { bid_handle, amount: 30, salt: 0x801 }].span(),
        group_handle,
    );
    auction.claim_asset(auction_id, recipient, secret);
    assert_eq!(token.balance_of(recipient, token_id), 7);
    assert_eq!(token.balance_of(auction.contract_address, token_id), 0);
    assert_eq!(auction.get_auction(auction_id).fulfillment_status, FulfillmentStatus::Claimed);
}
