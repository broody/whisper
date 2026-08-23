#[starknet::contract]
pub mod WhisperAuction {
    use core::hash::HashStateTrait;
    use core::num::traits::Zero;
    use core::poseidon::PoseidonTrait;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use crate::hashes::{compute_bid_handle, compute_identity_commitment};
    use crate::interface::{IWhisperAuction, IWhisperPrivacyAction};
    use crate::pricing::compute_vickrey_price;
    use crate::types::{
        Auction, AuctionConfig, AuctionResult, AuctionStatus, BidIntent, BidSubmission,
        OpenNoteDeposit, RevealedBid, SealedBid,
    };

    const ACCEPTED_BIDS_DOMAIN: felt252 = 'WHISPER_BIDS_V1';
    pub const MAX_SUPPORTED_BIDS: u32 = 256;

    #[storage]
    struct Storage {
        pool_address: ContractAddress,
        next_auction_id: u64,
        auctions: Map<u64, Auction>,
        bids: Map<(u64, felt252), SealedBid>,
        bid_handles: Map<(u64, u32), felt252>,
        used_identities: Map<(u64, felt252), bool>,
        used_note_ids: Map<felt252, bool>,
        results: Map<u64, AuctionResult>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        AuctionCreated: AuctionCreated,
        BidRecorded: BidRecorded,
        BidRevealed: BidRevealed,
        AuctionSettled: AuctionSettled,
        AuctionAborted: AuctionAborted,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionCreated {
        #[key]
        auction_id: u64,
        #[key]
        creator: ContractAddress,
        payment_token: ContractAddress,
        metadata_hash: felt252,
        reserve_price: u128,
        max_bid: u128,
        max_bids: u32,
        bidding_deadline: u64,
        force_reveal_after: u64,
        abort_after: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct BidRecorded {
        #[key]
        auction_id: u64,
        #[key]
        bid_handle: felt252,
        note_id: felt252,
        bid_index: u32,
        accepted_bids_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct BidRevealed {
        #[key]
        auction_id: u64,
        #[key]
        bid_handle: felt252,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionSettled {
        #[key]
        auction_id: u64,
        #[key]
        winner_bid_handle: felt252,
        winner_commitment: felt252,
        winning_bid: u128,
        second_highest_bid: u128,
        clearing_price: u128,
        reveals_root: felt252,
        outputs_root: felt252,
        settlement_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct AuctionAborted {
        #[key]
        auction_id: u64,
        recovery_hash: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool_address: ContractAddress) {
        assert!(!pool_address.is_zero(), "ZERO_POOL");
        self.pool_address.write(pool_address);
        self.next_auction_id.write(1);
    }

    #[abi(embed_v0)]
    impl WhisperAuctionImpl of IWhisperAuction<ContractState> {
        fn create_auction(ref self: ContractState, config: AuctionConfig) -> u64 {
            let now = get_block_timestamp();
            assert!(!config.payment_token.is_zero(), "ZERO_TOKEN");
            assert!(config.proceeds_recipient_commitment.is_non_zero(), "ZERO_PROCEEDS");
            assert!(config.winner_payload_domain.is_non_zero(), "ZERO_WINNER_DOMAIN");
            assert!(config.max_bid >= config.reserve_price, "INVALID_BID_RANGE");
            assert!(config.max_bids.is_non_zero(), "ZERO_MAX_BIDS");
            assert!(config.max_bids <= MAX_SUPPORTED_BIDS, "MAX_BIDS_TOO_HIGH");
            assert!(config.bidding_deadline > now, "INVALID_BID_DEADLINE");
            assert!(config.force_reveal_after >= config.bidding_deadline, "INVALID_REVEAL_TIME");
            assert!(config.abort_after > config.force_reveal_after, "INVALID_ABORT_TIME");
            assert!(!config.vault_address.is_zero(), "ZERO_VAULT");
            assert!(config.vault_public_key.is_non_zero(), "ZERO_VAULT_KEY");

            let auction_id = self.next_auction_id.read();
            self.next_auction_id.write(auction_id + 1);
            let creator = get_caller_address();
            let auction = Auction {
                id: auction_id,
                creator,
                payment_token: config.payment_token,
                proceeds_recipient_commitment: config.proceeds_recipient_commitment,
                metadata_hash: config.metadata_hash,
                winner_payload_domain: config.winner_payload_domain,
                reserve_price: config.reserve_price,
                max_bid: config.max_bid,
                max_bids: config.max_bids,
                bidding_deadline: config.bidding_deadline,
                force_reveal_after: config.force_reveal_after,
                abort_after: config.abort_after,
                vault_address: config.vault_address,
                vault_public_key: config.vault_public_key,
                accepted_bids_hash: PoseidonTrait::new()
                    .update(ACCEPTED_BIDS_DOMAIN)
                    .update(auction_id.into())
                    .finalize(),
                bid_count: 0,
                status: AuctionStatus::Bidding,
                settlement_hash: 0,
                recovery_hash: 0,
            };
            self.auctions.write(auction_id, auction);
            self
                .emit(
                    AuctionCreated {
                        auction_id,
                        creator,
                        payment_token: config.payment_token,
                        metadata_hash: config.metadata_hash,
                        reserve_price: config.reserve_price,
                        max_bid: config.max_bid,
                        max_bids: config.max_bids,
                        bidding_deadline: config.bidding_deadline,
                        force_reveal_after: config.force_reveal_after,
                        abort_after: config.abort_after,
                    },
                );
            auction_id
        }

        fn record_bid(ref self: ContractState, bid: BidSubmission) {
            self.assert_pool();
            self.record_verified_bid(bid);
        }

        fn force_reveal_and_settle(
            ref self: ContractState,
            auction_id: u64,
            accepted_bids_hash: felt252,
            revealed_bids: Span<RevealedBid>,
            winner_bid_handle: felt252,
            reveals_root: felt252,
            outputs_root: felt252,
            settlement_hash: felt252,
        ) {
            self.assert_pool();
            let mut auction = self.require_auction(auction_id);
            let now = get_block_timestamp();
            assert!(auction.status == AuctionStatus::Bidding, "NOT_SETTLEABLE");
            assert!(now >= auction.force_reveal_after, "REVEAL_TOO_EARLY");
            assert!(now < auction.abort_after, "SETTLEMENT_EXPIRED");
            assert!(accepted_bids_hash == auction.accepted_bids_hash, "BID_SET_MISMATCH");
            assert!(reveals_root.is_non_zero(), "ZERO_REVEALS_ROOT");
            assert!(outputs_root.is_non_zero(), "ZERO_OUTPUTS_ROOT");
            assert!(settlement_hash.is_non_zero(), "ZERO_SETTLEMENT_HASH");

            let expected_len: usize = auction.bid_count.into();
            assert!(revealed_bids.len() == expected_len, "INCOMPLETE_BID_SET");
            let mut index = 0;
            while index < revealed_bids.len() {
                let revealed = *revealed_bids.at(index);
                let bid_index: u32 = index.try_into().unwrap();
                let expected_handle = self.bid_handles.read((auction_id, bid_index));
                assert!(revealed.bid_handle == expected_handle, "BID_ORDER_MISMATCH");
                assert!(
                    revealed.amount >= auction.reserve_price && revealed.amount <= auction.max_bid,
                    "BID_OUT_OF_RANGE",
                );
                self
                    .emit(
                        BidRevealed {
                            auction_id, bid_handle: revealed.bid_handle, amount: revealed.amount,
                        },
                    );
                index += 1;
            }

            let result = if revealed_bids.is_empty() {
                assert!(winner_bid_handle.is_zero(), "UNEXPECTED_WINNER");
                AuctionResult {
                    auction_id,
                    has_winner: false,
                    winner_bid_handle: 0,
                    winner_commitment: 0,
                    winning_bid: 0,
                    second_highest_bid: 0,
                    clearing_price: 0,
                    reveals_root,
                    outputs_root,
                    settlement_hash,
                    settled_at: now,
                }
            } else {
                let pricing = compute_vickrey_price(revealed_bids, auction.reserve_price);
                assert!(pricing.winner_bid_handle == winner_bid_handle, "WRONG_WINNER");
                let winner = self.bids.read((auction_id, winner_bid_handle));
                assert!(winner.bid_handle.is_non_zero(), "WINNER_NOT_FOUND");
                AuctionResult {
                    auction_id,
                    has_winner: true,
                    winner_bid_handle,
                    winner_commitment: winner.winner_commitment,
                    winning_bid: pricing.winning_bid,
                    second_highest_bid: pricing.second_highest_bid,
                    clearing_price: pricing.clearing_price,
                    reveals_root,
                    outputs_root,
                    settlement_hash,
                    settled_at: now,
                }
            };

            index = 0;
            while index < revealed_bids.len() {
                let revealed = *revealed_bids.at(index);
                let mut sealed_bid = self.bids.read((auction_id, revealed.bid_handle));
                sealed_bid.settled = true;
                self.bids.write((auction_id, revealed.bid_handle), sealed_bid);
                index += 1;
            }

            auction.status = AuctionStatus::Settled;
            auction.settlement_hash = settlement_hash;
            self.auctions.write(auction_id, auction);
            self.results.write(auction_id, result);
            self
                .emit(
                    AuctionSettled {
                        auction_id,
                        winner_bid_handle: result.winner_bid_handle,
                        winner_commitment: result.winner_commitment,
                        winning_bid: result.winning_bid,
                        second_highest_bid: result.second_highest_bid,
                        clearing_price: result.clearing_price,
                        reveals_root,
                        outputs_root,
                        settlement_hash,
                    },
                );
        }

        fn abort_auction(ref self: ContractState, auction_id: u64, recovery_hash: felt252) {
            self.assert_pool();
            let mut auction = self.require_auction(auction_id);
            assert!(auction.status == AuctionStatus::Bidding, "NOT_ABORTABLE");
            assert!(get_block_timestamp() >= auction.abort_after, "ABORT_TOO_EARLY");
            assert!(recovery_hash.is_non_zero(), "ZERO_RECOVERY_HASH");
            auction.status = AuctionStatus::Aborted;
            auction.recovery_hash = recovery_hash;
            self.auctions.write(auction_id, auction);
            self.emit(AuctionAborted { auction_id, recovery_hash });
        }

        fn get_pool_address(self: @ContractState) -> ContractAddress {
            self.pool_address.read()
        }

        fn get_auction(self: @ContractState, auction_id: u64) -> Auction {
            self.require_auction(auction_id)
        }

        fn get_bid(self: @ContractState, auction_id: u64, bid_handle: felt252) -> SealedBid {
            let bid = self.bids.read((auction_id, bid_handle));
            assert!(bid.bid_handle.is_non_zero(), "BID_NOT_FOUND");
            bid
        }

        fn get_bid_handle(self: @ContractState, auction_id: u64, index: u32) -> felt252 {
            let auction = self.require_auction(auction_id);
            assert!(index < auction.bid_count, "BID_INDEX_OUT_OF_RANGE");
            self.bid_handles.read((auction_id, index))
        }

        fn get_result(self: @ContractState, auction_id: u64) -> AuctionResult {
            let auction = self.require_auction(auction_id);
            assert!(auction.status == AuctionStatus::Settled, "RESULT_NOT_AVAILABLE");
            self.results.read(auction_id)
        }
    }

    #[abi(embed_v0)]
    impl WhisperPrivacyActionImpl of IWhisperPrivacyAction<ContractState> {
        fn privacy_compute(
            self: @ContractState, identity_key: felt252, intent: BidIntent,
        ) -> BidSubmission {
            assert!(identity_key.is_non_zero(), "ZERO_IDENTITY_KEY");
            let auction = self.require_auction(intent.auction_id);
            assert!(auction.status == AuctionStatus::Bidding, "NOT_BIDDING");
            assert!(get_block_timestamp() < auction.bidding_deadline, "BIDDING_CLOSED");
            self.bid_from_intent(identity_key, intent)
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, bid: BidSubmission,
        ) -> (Span<OpenNoteDeposit>, Span<ContractAddress>) {
            self.assert_pool();
            self.record_verified_bid(bid);
            let deposits: Array<OpenNoteDeposit> = array![];
            let associated_addresses: Array<ContractAddress> = array![];
            (deposits.span(), associated_addresses.span())
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn assert_pool(self: @ContractState) {
            assert!(get_caller_address() == self.pool_address.read(), "ONLY_POOL");
        }

        fn require_auction(self: @ContractState, auction_id: u64) -> Auction {
            let auction = self.auctions.read(auction_id);
            assert!(auction.status != AuctionStatus::Unset, "AUCTION_NOT_FOUND");
            auction
        }

        fn bid_from_intent(
            self: @ContractState, identity_key: felt252, intent: BidIntent,
        ) -> BidSubmission {
            assert!(intent.note_id.is_non_zero(), "ZERO_NOTE_ID");
            assert!(intent.capsule_hash.is_non_zero(), "ZERO_CAPSULE");
            assert!(intent.refund_commitment.is_non_zero(), "ZERO_REFUND");
            assert!(intent.winner_commitment.is_non_zero(), "ZERO_WINNER_COMMITMENT");
            let identity_commitment = compute_identity_commitment(identity_key, intent.auction_id);
            let bid_handle = compute_bid_handle(
                intent.auction_id,
                identity_commitment,
                intent.note_id,
                intent.capsule_hash,
                intent.refund_commitment,
                intent.winner_commitment,
            );
            BidSubmission {
                auction_id: intent.auction_id,
                bid_handle,
                identity_commitment,
                note_id: intent.note_id,
                capsule_hash: intent.capsule_hash,
                refund_commitment: intent.refund_commitment,
                winner_commitment: intent.winner_commitment,
            }
        }

        fn record_verified_bid(ref self: ContractState, bid: BidSubmission) {
            let mut auction = self.require_auction(bid.auction_id);
            assert!(auction.status == AuctionStatus::Bidding, "NOT_BIDDING");
            assert!(get_block_timestamp() < auction.bidding_deadline, "BIDDING_CLOSED");
            assert!(auction.bid_count < auction.max_bids, "MAX_BIDS_REACHED");
            assert!(bid.bid_handle.is_non_zero(), "ZERO_BID_HANDLE");
            assert!(bid.identity_commitment.is_non_zero(), "ZERO_IDENTITY");
            assert!(bid.note_id.is_non_zero(), "ZERO_NOTE_ID");
            assert!(bid.capsule_hash.is_non_zero(), "ZERO_CAPSULE");
            assert!(bid.refund_commitment.is_non_zero(), "ZERO_REFUND");
            assert!(bid.winner_commitment.is_non_zero(), "ZERO_WINNER_COMMITMENT");
            assert!(
                self.bids.read((bid.auction_id, bid.bid_handle)).bid_handle.is_zero(),
                "DUPLICATE_BID_HANDLE",
            );
            assert!(
                !self.used_identities.read((bid.auction_id, bid.identity_commitment)),
                "DUPLICATE_IDENTITY",
            );
            assert!(!self.used_note_ids.read(bid.note_id), "DUPLICATE_NOTE_ID");

            let bid_index = auction.bid_count;
            let accepted_bids_hash = PoseidonTrait::new()
                .update(auction.accepted_bids_hash)
                .update(bid.bid_handle)
                .finalize();
            let sealed_bid = SealedBid {
                auction_id: bid.auction_id,
                bid_handle: bid.bid_handle,
                identity_commitment: bid.identity_commitment,
                note_id: bid.note_id,
                capsule_hash: bid.capsule_hash,
                refund_commitment: bid.refund_commitment,
                winner_commitment: bid.winner_commitment,
                submitted_at: get_block_timestamp(),
                settled: false,
            };

            self.bids.write((bid.auction_id, bid.bid_handle), sealed_bid);
            self.bid_handles.write((bid.auction_id, bid_index), bid.bid_handle);
            self.used_identities.write((bid.auction_id, bid.identity_commitment), true);
            self.used_note_ids.write(bid.note_id, true);
            auction.accepted_bids_hash = accepted_bids_hash;
            auction.bid_count += 1;
            self.auctions.write(bid.auction_id, auction);
            self
                .emit(
                    BidRecorded {
                        auction_id: bid.auction_id,
                        bid_handle: bid.bid_handle,
                        note_id: bid.note_id,
                        bid_index,
                        accepted_bids_hash,
                    },
                );
        }
    }
}
