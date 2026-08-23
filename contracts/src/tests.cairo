use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address,
};
use starknet::{ContractAddress, SyscallResultTrait};
use crate::hashes::{
    compute_bid_handle, compute_identity_commitment, compute_operator_identity_commitment,
    compute_reveal_commitment,
};
use crate::interface::{
    IWhisperAuctionDispatcher, IWhisperAuctionDispatcherTrait, IWhisperPrivacyActionDispatcher,
    IWhisperPrivacyActionDispatcherTrait,
};
use crate::pricing::compute_vickrey_price;
use crate::types::{
    AbortInput, AcceptBidInput, AuctionConfig, AuctionStatus, BidIntent, PrivacyRequest,
    RevealedBid, SettlementInput,
};

const RESERVE_PRICE: u128 = 10;
const BID_DEADLINE: u64 = 200;
const REVEAL_AFTER: u64 = 220;
const ABORT_AFTER: u64 = 300;
const OPERATOR_IDENTITY_KEY: felt252 = 0x444;

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

fn deploy() -> IWhisperAuctionDispatcher {
    let pool = pool_address();
    let mut calldata = array![];
    pool.serialize(ref calldata);
    let contract_class = declare("WhisperAuction").unwrap();
    let (contract_address, _) = contract_class.contract_class().deploy(@calldata).unwrap_syscall();
    IWhisperAuctionDispatcher { contract_address }
}

fn privacy(auction: IWhisperAuctionDispatcher) -> IWhisperPrivacyActionDispatcher {
    IWhisperPrivacyActionDispatcher { contract_address: auction.contract_address }
}

fn create_auction(auction: IWhisperAuctionDispatcher, token: ContractAddress) -> u64 {
    set_context(auction, 100, creator_address());
    auction.create_auction(config(token))
}

fn set_context(auction: IWhisperAuctionDispatcher, timestamp: u64, caller: ContractAddress) {
    start_cheat_block_timestamp(auction.contract_address, timestamp);
    start_cheat_caller_address(auction.contract_address, caller);
}

fn bid_intent(auction_id: u64, note_id: felt252, amount: u128, salt: felt252) -> BidIntent {
    let refund_commitment = note_id + 0x1000;
    let winner_commitment = note_id + 0x2000;
    BidIntent {
        auction_id,
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
    identity_key: felt252,
    note_id: felt252,
    amount: u128,
    salt: felt252,
) -> felt252 {
    let intent = bid_intent(auction_id, note_id, amount, salt);
    let identity_commitment = compute_identity_commitment(identity_key, auction_id);
    let bid_handle = compute_bid_handle(
        auction_id,
        identity_commitment,
        intent.reveal_commitment,
        intent.refund_commitment,
        intent.winner_commitment,
    );
    set_context(auction, 150, address(0x999));
    let command = privacy(auction).privacy_compute(identity_key, PrivacyRequest::SubmitBid(intent));
    set_context(auction, 150, pool_address());
    privacy(auction).privacy_invoke_with_computation(command);
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
fn derives_pool_identity_and_bid_transcript() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let identity_key = 0xabc;
    let intent = bid_intent(auction_id, 0x704, 30, 0x705);
    let command = privacy(auction).privacy_compute(identity_key, PrivacyRequest::SubmitBid(intent));
    match command {
        crate::types::PrivacyCommand::SubmitBid(bid) => {
            let expected_identity = compute_identity_commitment(identity_key, auction_id);
            assert_eq!(bid.identity_commitment, expected_identity);
            assert_eq!(bid.reveal_commitment, intent.reveal_commitment);
        },
        _ => panic!("WRONG_COMMAND"),
    }
}

#[test]
fn matches_canonical_typescript_bid_transcript_vector() {
    let identity_commitment = compute_identity_commitment(0xabc, 1);
    let bid_handle = compute_bid_handle(1, identity_commitment, 0x701, 0x702, 0x703);
    assert_eq!(
        identity_commitment, 0x388934032e394e858e5fd474159ead3a6dd48d0419c2a4b9ffa38c353b72ef1,
    );
    assert_eq!(bid_handle, 0x11c9d1b216ef5e67b87296fe6d25da64c546d2d1a95af2de7a56e37a7abaf5b);
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
fn scopes_pool_identity_commitments_to_each_auction() {
    assert!(compute_identity_commitment(0xabc, 1) != compute_identity_commitment(0xabc, 2));
}

#[test]
fn pool_compute_and_invoke_submits_unfunded_bid() {
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
#[should_panic]
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
    settle(auction, auction_id, revealed.span(), second);

    let state = auction.get_auction(auction_id);
    let result = auction.get_result(auction_id);
    assert_eq!(state.status, AuctionStatus::Settled);
    assert_eq!(result.winner_bid_handle, second);
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
    settle(auction, auction_id, revealed.span(), handle);
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
#[should_panic]
fn rejects_privacy_invoke_not_authenticated_by_pool() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let command = privacy(auction)
        .privacy_compute(
            0xabc, PrivacyRequest::SubmitBid(bid_intent(auction_id, 0x704, 30, 0x705)),
        );
    set_context(auction, 150, address(0x999));
    privacy(auction).privacy_invoke_with_computation(command);
}

#[test]
#[should_panic]
fn rejects_duplicate_private_identity() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    submit_bid(auction, auction_id, 0xabc, 0x704, 30, 0x705);
    submit_bid(auction, auction_id, 0xabc, 0x706, 31, 0x707);
}

#[test]
#[should_panic]
fn rejects_operator_reusing_vault_note() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_bid(auction, auction_id, 0xa1, 0x704, 30, 0x705);
    let second = submit_bid(auction, auction_id, 0xa2, 0x706, 31, 0x707);
    accept_bid(auction, auction_id, first, 0x900);
    accept_bid(auction, auction_id, second, 0x900);
}

#[test]
#[should_panic]
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
#[should_panic]
fn rejects_force_reveal_before_deadline() {
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
#[should_panic]
fn rejects_incomplete_force_reveal_batch() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 20, 0x801);
    submit_and_accept_bid(auction, auction_id, 0xa2, 0x702, 30, 0x802);
    let revealed = array![RevealedBid { bid_handle: first, amount: 20, salt: 0x801 }];
    settle(auction, auction_id, revealed.span(), first);
}

#[test]
#[should_panic]
fn rejects_wrong_vickrey_winner() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let first = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 20, 0x801);
    let second = submit_and_accept_bid(auction, auction_id, 0xa2, 0x702, 30, 0x802);
    let revealed = array![
        RevealedBid { bid_handle: first, amount: 20, salt: 0x801 },
        RevealedBid { bid_handle: second, amount: 30, salt: 0x802 },
    ];
    settle(auction, auction_id, revealed.span(), first);
}

#[test]
#[should_panic]
fn rejects_revealed_amount_below_reserve() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, RESERVE_PRICE - 1, 0x801);
    let revealed = array![
        RevealedBid { bid_handle: handle, amount: RESERVE_PRICE - 1, salt: 0x801 },
    ];
    settle(auction, auction_id, revealed.span(), handle);
}

#[test]
#[should_panic]
fn rejects_reveal_that_does_not_open_bid_commitment() {
    let auction = deploy();
    let auction_id = create_auction(auction, address(0x501));
    let handle = submit_and_accept_bid(auction, auction_id, 0xa1, 0x701, 30, 0x801);
    let revealed = array![RevealedBid { bid_handle: handle, amount: 31, salt: 0x801 }];
    settle(auction, auction_id, revealed.span(), handle);
}
