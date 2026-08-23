use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address,
};
use starknet::{ContractAddress, SyscallResultTrait};
use crate::hashes::{compute_bid_handle, compute_identity_commitment};
use crate::interface::{
    IWhisperAuctionDispatcher, IWhisperAuctionDispatcherTrait, IWhisperPrivacyActionDispatcher,
    IWhisperPrivacyActionDispatcherTrait,
};
use crate::pricing::compute_vickrey_price;
use crate::types::{AuctionConfig, AuctionStatus, BidIntent, BidSubmission, RevealedBid};

const RESERVE_PRICE: u128 = 10;
const MAX_BID: u128 = 1_000;
const BID_DEADLINE: u64 = 200;
const REVEAL_AFTER: u64 = 200;
const ABORT_AFTER: u64 = 300;

fn address(value: felt252) -> ContractAddress {
    value.try_into().unwrap()
}

fn pool_address() -> ContractAddress {
    address(0x100)
}

fn creator_address() -> ContractAddress {
    address(0x200)
}

fn config(token: ContractAddress) -> AuctionConfig {
    AuctionConfig {
        payment_token: token,
        proceeds_recipient_commitment: 0x301,
        metadata_hash: 0x302,
        winner_payload_domain: 0x303,
        reserve_price: RESERVE_PRICE,
        max_bid: MAX_BID,
        max_bids: 16,
        bidding_deadline: BID_DEADLINE,
        force_reveal_after: REVEAL_AFTER,
        abort_after: ABORT_AFTER,
        vault_address: address(0x400),
        vault_public_key: 0x401,
    }
}

fn deploy() -> IWhisperAuctionDispatcher {
    let pool = pool_address();
    let mut calldata = array![];
    pool.serialize(ref calldata);
    let contract_class = declare("WhisperAuction").unwrap();
    let (contract_address, _) = contract_class.contract_class().deploy(@calldata).unwrap_syscall();
    IWhisperAuctionDispatcher { contract_address }
}

fn create_auction(auction: IWhisperAuctionDispatcher, token: ContractAddress) -> u64 {
    set_context(auction, 100, creator_address());
    auction.create_auction(config(token))
}

fn set_context(auction: IWhisperAuctionDispatcher, timestamp: u64, caller: ContractAddress) {
    start_cheat_block_timestamp(auction.contract_address, timestamp);
    start_cheat_caller_address(auction.contract_address, caller);
}

fn bid_submission(auction_id: u64, handle: felt252, identity: felt252) -> BidSubmission {
    BidSubmission {
        auction_id,
        bid_handle: handle,
        identity_commitment: identity,
        note_id: handle + 1_000,
        capsule_hash: handle + 2_000,
        refund_commitment: handle + 3_000,
        winner_commitment: handle + 4_000,
    }
}

fn bid_intent(auction_id: u64, note_id: felt252) -> BidIntent {
    BidIntent {
        auction_id,
        note_id,
        capsule_hash: 0x701,
        refund_commitment: 0x702,
        winner_commitment: 0x703,
    }
}

fn record_bid(
    auction: IWhisperAuctionDispatcher, auction_id: u64, handle: felt252, identity: felt252,
) {
    set_context(auction, 150, pool_address());
    auction.record_bid(bid_submission(auction_id, handle, identity));
}

#[test]
fn computes_second_price_and_private_change_amount() {
    let bids = array![
        RevealedBid { bid_handle: 11, amount: 14 }, RevealedBid { bid_handle: 22, amount: 30 },
        RevealedBid { bid_handle: 33, amount: 22 },
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
    let bids = array![RevealedBid { bid_handle: 44, amount: 90 }];
    let result = compute_vickrey_price(bids.span(), RESERVE_PRICE);

    assert_eq!(result.winner_bid_handle, 44);
    assert_eq!(result.second_highest_bid, 0);
    assert_eq!(result.clearing_price, RESERVE_PRICE);
}

#[test]
fn tied_bid_uses_smallest_handle_and_pays_tied_amount() {
    let bids = array![
        RevealedBid { bid_handle: 20, amount: 50 }, RevealedBid { bid_handle: 10, amount: 50 },
        RevealedBid { bid_handle: 30, amount: 40 },
    ];
    let result = compute_vickrey_price(bids.span(), RESERVE_PRICE);

    assert_eq!(result.winner_bid_handle, 10);
    assert_eq!(result.winning_bid, 50);
    assert_eq!(result.second_highest_bid, 50);
    assert_eq!(result.clearing_price, 50);
}

#[test]
fn derives_pool_proven_identity_and_bid_transcript() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let privacy = IWhisperPrivacyActionDispatcher { contract_address: auction.contract_address };
    let identity_key = 0xabc;
    let intent = bid_intent(auction_id, 0x704);

    let bid = privacy.privacy_compute(identity_key, intent);
    let expected_identity = compute_identity_commitment(identity_key, auction_id);
    let expected_handle = compute_bid_handle(
        auction_id,
        expected_identity,
        intent.note_id,
        intent.capsule_hash,
        intent.refund_commitment,
        intent.winner_commitment,
    );

    assert_eq!(bid.identity_commitment, expected_identity);
    assert_eq!(bid.bid_handle, expected_handle);
    assert_eq!(bid.note_id, intent.note_id);
    assert_eq!(bid.winner_commitment, intent.winner_commitment);
}

#[test]
fn matches_canonical_typescript_bid_transcript_vector() {
    let identity_commitment = compute_identity_commitment(0xabc, 1);
    let bid_handle = compute_bid_handle(1, identity_commitment, 0x704, 0x701, 0x702, 0x703);

    assert_eq!(
        identity_commitment, 0x388934032e394e858e5fd474159ead3a6dd48d0419c2a4b9ffa38c353b72ef1,
    );
    assert_eq!(bid_handle, 0x3d1d493a715d646b29f80a915b17c9b9248c8f35b1289aef7be88888a6453c5);
}

#[test]
fn scopes_pool_identity_commitments_to_each_auction() {
    let first = compute_identity_commitment(0xabc, 1);
    let second = compute_identity_commitment(0xabc, 2);

    assert!(first != second);
}

#[test]
fn pool_compute_and_invoke_records_bid_without_open_note_deposits() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let privacy = IWhisperPrivacyActionDispatcher { contract_address: auction.contract_address };
    let intent = bid_intent(auction_id, 0x704);
    let bid = privacy.privacy_compute(0xabc, intent);

    set_context(auction, 150, pool_address());
    let (deposits, associated_addresses) = privacy.privacy_invoke_with_computation(bid);

    assert!(deposits.is_empty());
    assert!(associated_addresses.is_empty());
    let stored = auction.get_bid(auction_id, bid.bid_handle);
    assert_eq!(stored.identity_commitment, bid.identity_commitment);
    assert_eq!(stored.note_id, intent.note_id);
    assert_eq!(stored.winner_commitment, intent.winner_commitment);
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
fn records_pool_authenticated_bids_and_settles_vickrey_result() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    record_bid(auction, auction_id, 11, 101);
    record_bid(auction, auction_id, 22, 102);
    record_bid(auction, auction_id, 33, 103);

    let state_before = auction.get_auction(auction_id);
    assert_eq!(state_before.bid_count, 3);
    assert_eq!(auction.get_bid_handle(auction_id, 0), 11);
    assert_eq!(auction.get_bid_handle(auction_id, 1), 22);
    assert_eq!(auction.get_bid_handle(auction_id, 2), 33);

    let revealed = array![
        RevealedBid { bid_handle: 11, amount: 14 }, RevealedBid { bid_handle: 22, amount: 30 },
        RevealedBid { bid_handle: 33, amount: 22 },
    ];
    set_context(auction, REVEAL_AFTER, pool_address());
    auction
        .force_reveal_and_settle(
            auction_id, state_before.accepted_bids_hash, revealed.span(), 22, 0x901, 0x902, 0x903,
        );

    let state_after = auction.get_auction(auction_id);
    let result = auction.get_result(auction_id);
    assert_eq!(state_after.status, AuctionStatus::Settled);
    assert_eq!(state_after.settlement_hash, 0x903);
    assert!(result.has_winner);
    assert_eq!(result.winner_bid_handle, 22);
    assert_eq!(result.winner_commitment, 4_022);
    assert_eq!(result.winning_bid, 30);
    assert_eq!(result.second_highest_bid, 22);
    assert_eq!(result.clearing_price, 22);
    assert!(auction.get_bid(auction_id, 11).settled);
    assert!(auction.get_bid(auction_id, 22).settled);
    assert!(auction.get_bid(auction_id, 33).settled);
}

#[test]
fn settles_empty_auction_without_winner() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let state = auction.get_auction(auction_id);
    let revealed = array![];

    set_context(auction, REVEAL_AFTER, pool_address());
    auction
        .force_reveal_and_settle(
            auction_id, state.accepted_bids_hash, revealed.span(), 0, 0x901, 0x902, 0x903,
        );

    let result = auction.get_result(auction_id);
    assert!(!result.has_winner);
    assert_eq!(result.clearing_price, 0);
}

#[test]
fn aborts_after_force_reveal_operator_timeout() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    record_bid(auction, auction_id, 11, 101);

    set_context(auction, ABORT_AFTER, pool_address());
    auction.abort_auction(auction_id, 0xa01);

    let state = auction.get_auction(auction_id);
    assert_eq!(state.status, AuctionStatus::Aborted);
    assert_eq!(state.settlement_hash, 0);
    assert_eq!(state.recovery_hash, 0xa01);
}

#[test]
#[should_panic]
fn rejects_bid_not_authenticated_by_pool() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));

    set_context(auction, 150, address(0x999));
    auction.record_bid(bid_submission(auction_id, 11, 101));
}

#[test]
#[should_panic]
fn rejects_privacy_invoke_not_authenticated_by_pool() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let privacy = IWhisperPrivacyActionDispatcher { contract_address: auction.contract_address };
    let bid = privacy.privacy_compute(0xabc, bid_intent(auction_id, 0x704));

    set_context(auction, 150, address(0x999));
    privacy.privacy_invoke_with_computation(bid);
}

#[test]
#[should_panic]
fn rejects_duplicate_private_identity() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    record_bid(auction, auction_id, 11, 101);
    record_bid(auction, auction_id, 22, 101);
}

#[test]
#[should_panic]
fn rejects_force_reveal_before_deadline() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let state = auction.get_auction(auction_id);
    let revealed = array![];

    set_context(auction, REVEAL_AFTER - 1, pool_address());
    auction
        .force_reveal_and_settle(
            auction_id, state.accepted_bids_hash, revealed.span(), 0, 0x901, 0x902, 0x903,
        );
}

#[test]
#[should_panic]
fn rejects_incomplete_force_reveal_batch() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    record_bid(auction, auction_id, 11, 101);
    record_bid(auction, auction_id, 22, 102);
    let state = auction.get_auction(auction_id);
    let revealed = array![RevealedBid { bid_handle: 11, amount: 20 }];

    set_context(auction, REVEAL_AFTER, pool_address());
    auction
        .force_reveal_and_settle(
            auction_id, state.accepted_bids_hash, revealed.span(), 11, 0x901, 0x902, 0x903,
        );
}

#[test]
#[should_panic]
fn rejects_wrong_vickrey_winner() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    record_bid(auction, auction_id, 11, 101);
    record_bid(auction, auction_id, 22, 102);
    let state = auction.get_auction(auction_id);
    let revealed = array![
        RevealedBid { bid_handle: 11, amount: 20 }, RevealedBid { bid_handle: 22, amount: 30 },
    ];

    set_context(auction, REVEAL_AFTER, pool_address());
    auction
        .force_reveal_and_settle(
            auction_id, state.accepted_bids_hash, revealed.span(), 11, 0x901, 0x902, 0x903,
        );
}

#[test]
#[should_panic]
fn rejects_revealed_amount_outside_auction_bounds() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    record_bid(auction, auction_id, 11, 101);
    let state = auction.get_auction(auction_id);
    let revealed = array![RevealedBid { bid_handle: 11, amount: MAX_BID + 1 }];

    set_context(auction, REVEAL_AFTER, pool_address());
    auction
        .force_reveal_and_settle(
            auction_id, state.accepted_bids_hash, revealed.span(), 11, 0x901, 0x902, 0x903,
        );
}
