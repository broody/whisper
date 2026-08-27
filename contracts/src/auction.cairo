#[starknet::contract]
pub mod WhisperAuction {
    use core::dict::{Felt252Dict, Felt252DictTrait};
    use core::hash::HashStateTrait;
    use core::num::traits::{CheckedAdd, Zero};
    use core::poseidon::PoseidonTrait;
    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_upgrades::UpgradeableComponent;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{
        ClassHash, ContractAddress, get_block_timestamp, get_caller_address, get_contract_address,
    };
    use crate::asset_hashes::{ASSET_WINNER_DOMAIN, compute_asset_winner_commitment};
    use crate::asset_interface::{
        IERC1155AssetDispatcher, IERC1155AssetDispatcherTrait, IERC1155Receiver,
        IERC20AssetDispatcher, IERC20AssetDispatcherTrait, IERC721AssetDispatcher,
        IERC721AssetDispatcherTrait, IERC721Receiver, ISRC5,
    };
    use crate::asset_types::{AuctionFulfillment, FulfillmentKind, FulfillmentStatus};
    use crate::hashes::{
        compute_bid_group_handle, compute_bid_handle, compute_operator_identity_commitment,
        compute_reveal_commitment,
    };
    use crate::interface::{
        IWhisperAuction, IWhisperBidAction, IWhisperPrivacyAction, IWhisperUpgradeable,
    };
    use crate::pricing::compute_vickrey_price;
    use crate::types::{
        AbortInput, AcceptBidInput, Auction, AuctionConfig, AuctionResult, AuctionSchedule,
        AuctionStatus, BidGroup, BidIntent, BidSubmission, BidTopUpIntent, OpenNoteDeposit,
        PrivacyCommand, PrivacyRequest, RevealedBid, SealedBid, SettlementInput, WalletBidRequest,
    };

    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableTwoStepImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    const ACCEPTED_BIDS_DOMAIN: felt252 = 'WHISPER_BIDS_V1';
    const IERC721_RECEIVER_ID: felt252 =
        0x3a0dff5f70d80458ad14ae37bb182a728e3c8cdda0402a5daa86620bdf910bc;
    const IERC1155_RECEIVER_ID: felt252 =
        0x15e8665b5af20040c3af1670509df02eb916375cdf7d8cbaf7bd553a257515e;
    pub const MAX_SUPPORTED_BIDS: u32 = 256;

    #[storage]
    struct Storage {
        pool_address: ContractAddress,
        next_auction_id: u64,
        auctions: Map<u64, Auction>,
        bid_groups: Map<(u64, felt252), BidGroup>,
        bids: Map<(u64, felt252), SealedBid>,
        bid_handles: Map<(u64, u32), felt252>,
        used_note_ids: Map<felt252, bool>,
        results: Map<u64, AuctionResult>,
        locked: bool,
        pending_kind: FulfillmentKind,
        pending_token: ContractAddress,
        pending_seller: ContractAddress,
        pending_token_id: u256,
        pending_amount: u256,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        AuctionCreated: AuctionCreated,
        AuctionStarted: AuctionStarted,
        BidSubmitted: BidSubmitted,
        BidFunded: BidFunded,
        BidRevealed: BidRevealed,
        AuctionSettled: AuctionSettled,
        AuctionAborted: AuctionAborted,
        AssetClaimed: AssetClaimed,
        AssetReclaimed: AssetReclaimed,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AuctionCreated {
        #[key]
        pub auction_id: u64,
        #[key]
        pub creator: ContractAddress,
        pub created_at: u64,
        pub payment_token: ContractAddress,
        pub proceeds_recipient_commitment: felt252,
        pub metadata_hash: felt252,
        pub fulfillment_kind: FulfillmentKind,
        pub asset_token: ContractAddress,
        pub asset_token_id: u256,
        pub asset_amount: u256,
        pub winner_payload_domain: felt252,
        pub reserve_price: u128,
        pub max_bids: u32,
        pub schedule: AuctionSchedule,
        pub started_at: u64,
        pub bidding_deadline: u64,
        pub force_reveal_after: u64,
        pub abort_after: u64,
        pub vault_address: ContractAddress,
        pub vault_public_key: felt252,
        pub reveal_public_key: felt252,
        pub operator_identity_commitment: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AuctionStarted {
        #[key]
        pub auction_id: u64,
        pub started_at: u64,
        pub bidding_deadline: u64,
        pub force_reveal_after: u64,
        pub abort_after: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BidSubmitted {
        #[key]
        pub auction_id: u64,
        #[key]
        pub bid_handle: felt252,
        #[key]
        pub group_handle: felt252,
        pub tranche_index: u32,
        pub submission_index: u32,
        pub auction_submission_count: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BidFunded {
        #[key]
        pub auction_id: u64,
        #[key]
        pub bid_handle: felt252,
        #[key]
        pub group_handle: felt252,
        pub note_id: felt252,
        pub bid_index: u32,
        pub auction_funded_tranche_count: u32,
        pub group_funded_tranche_count: u32,
        pub accepted_bids_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BidRevealed {
        #[key]
        pub auction_id: u64,
        #[key]
        pub bid_handle: felt252,
        #[key]
        pub group_handle: felt252,
        pub tranche_index: u32,
        pub bid_index: u32,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AuctionSettled {
        #[key]
        pub auction_id: u64,
        #[key]
        pub winner_group_handle: felt252,
        pub has_winner: bool,
        pub winner_commitment: felt252,
        pub winning_bid: u128,
        pub second_highest_bid: u128,
        pub clearing_price: u128,
        pub submission_count: u32,
        pub funded_tranche_count: u32,
        pub funded_bid_count: u32,
        pub eligible_bid_count: u32,
        pub accepted_bids_hash: felt252,
        pub reveals_root: felt252,
        pub outputs_root: felt252,
        pub settlement_hash: felt252,
        pub settled_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AuctionAborted {
        #[key]
        pub auction_id: u64,
        pub recovery_hash: felt252,
        pub submission_count: u32,
        pub funded_tranche_count: u32,
        pub aborted_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AssetClaimed {
        #[key]
        pub auction_id: u64,
        #[key]
        pub recipient: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct AssetReclaimed {
        #[key]
        pub auction_id: u64,
        #[key]
        pub seller: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool_address: ContractAddress, owner: ContractAddress) {
        assert!(!pool_address.is_zero(), "ZERO_POOL");
        self.pool_address.write(pool_address);
        self.next_auction_id.write(1);
        self.ownable.initializer(owner);
    }

    #[abi(embed_v0)]
    impl UpgradeableImpl of IWhisperUpgradeable<ContractState> {
        fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
            self.ownable.assert_only_owner();
            self.upgradeable.upgrade(new_class_hash);
        }
    }

    #[abi(embed_v0)]
    impl WhisperAuctionImpl of IWhisperAuction<ContractState> {
        fn create_auction(ref self: ContractState, config: AuctionConfig) -> u64 {
            self.enter();
            let now = get_block_timestamp();
            assert!(!config.payment_token.is_zero(), "ZERO_TOKEN");
            assert!(config.proceeds_recipient_commitment.is_non_zero(), "ZERO_PROCEEDS");
            assert!(config.winner_payload_domain.is_non_zero(), "ZERO_WINNER_DOMAIN");
            assert!(config.max_bids.is_non_zero(), "ZERO_MAX_BIDS");
            assert!(config.max_bids <= MAX_SUPPORTED_BIDS, "MAX_BIDS_TOO_HIGH");
            assert!(!config.vault_address.is_zero(), "ZERO_VAULT");
            assert!(config.vault_public_key.is_non_zero(), "ZERO_VAULT_KEY");
            assert!(config.reveal_public_key.is_non_zero(), "ZERO_REVEAL_KEY");
            assert!(config.operator_identity_commitment.is_non_zero(), "ZERO_OPERATOR");

            let auction_id = self.next_auction_id.read();
            let creator = get_caller_address();
            let (status, started_at, bidding_deadline, force_reveal_after, abort_after) = self
                .initialize_schedule(config.schedule, now);
            self.validate_fulfillment(config.fulfillment, config.winner_payload_domain);
            self.pull_asset(creator, config.fulfillment);
            self.next_auction_id.write(auction_id + 1);
            let auction = Auction {
                id: auction_id,
                creator,
                payment_token: config.payment_token,
                proceeds_recipient_commitment: config.proceeds_recipient_commitment,
                metadata_hash: config.metadata_hash,
                fulfillment: config.fulfillment,
                fulfillment_status: self.initial_fulfillment_status(config.fulfillment.kind),
                winner_payload_domain: config.winner_payload_domain,
                reserve_price: config.reserve_price,
                max_bids: config.max_bids,
                schedule: config.schedule,
                started_at,
                bidding_deadline,
                force_reveal_after,
                abort_after,
                vault_address: config.vault_address,
                vault_public_key: config.vault_public_key,
                reveal_public_key: config.reveal_public_key,
                operator_identity_commitment: config.operator_identity_commitment,
                accepted_bids_hash: PoseidonTrait::new()
                    .update(ACCEPTED_BIDS_DOMAIN)
                    .update(auction_id.into())
                    .finalize(),
                submission_count: 0,
                bid_count: 0,
                status,
                settlement_hash: 0,
                recovery_hash: 0,
            };
            self.auctions.write(auction_id, auction);
            self.exit();
            self
                .emit(
                    AuctionCreated {
                        auction_id,
                        creator,
                        created_at: now,
                        payment_token: config.payment_token,
                        proceeds_recipient_commitment: config.proceeds_recipient_commitment,
                        metadata_hash: config.metadata_hash,
                        fulfillment_kind: config.fulfillment.kind,
                        asset_token: config.fulfillment.token,
                        asset_token_id: config.fulfillment.token_id,
                        asset_amount: config.fulfillment.amount,
                        winner_payload_domain: config.winner_payload_domain,
                        reserve_price: config.reserve_price,
                        max_bids: config.max_bids,
                        schedule: config.schedule,
                        started_at,
                        bidding_deadline,
                        force_reveal_after,
                        abort_after,
                        vault_address: config.vault_address,
                        vault_public_key: config.vault_public_key,
                        reveal_public_key: config.reveal_public_key,
                        operator_identity_commitment: config.operator_identity_commitment,
                    },
                );
            auction_id
        }

        fn claim_asset(
            ref self: ContractState, auction_id: u64, recipient: ContractAddress, secret: felt252,
        ) {
            self.enter();
            assert!(!recipient.is_zero(), "ZERO_RECIPIENT");
            assert!(recipient != get_contract_address(), "RECIPIENT_IS_WHISPER");
            assert!(secret.is_non_zero(), "ZERO_CLAIM_SECRET");
            let mut auction = self.require_escrowed_asset(auction_id);
            assert!(auction.status == AuctionStatus::Settled, "AUCTION_NOT_SETTLED");
            let result = self.results.read(auction_id);
            assert!(result.has_winner, "AUCTION_HAS_NO_WINNER");
            assert!(
                compute_asset_winner_commitment(
                    get_contract_address(), auction_id, recipient, secret,
                ) == result
                    .winner_commitment,
                "INVALID_WINNER_OPENING",
            );

            auction.fulfillment_status = FulfillmentStatus::Claimed;
            self.auctions.write(auction_id, auction);
            self.push_asset(recipient, auction.fulfillment);
            self.exit();
            self.emit(AssetClaimed { auction_id, recipient });
        }

        fn reclaim_asset(ref self: ContractState, auction_id: u64) {
            self.enter();
            let mut auction = self.require_escrowed_asset(auction_id);
            let reclaimable = match auction.status {
                AuctionStatus::Aborted => true,
                AuctionStatus::Settled => !self.results.read(auction_id).has_winner,
                AuctionStatus::Bidding => get_block_timestamp() >= auction.abort_after,
                AuctionStatus::Pending => false,
                AuctionStatus::Unset => false,
            };
            assert!(reclaimable, "ASSET_NOT_RECLAIMABLE");

            auction.fulfillment_status = FulfillmentStatus::Reclaimed;
            self.auctions.write(auction_id, auction);
            self.push_asset(auction.creator, auction.fulfillment);
            self.exit();
            self.emit(AssetReclaimed { auction_id, seller: auction.creator });
        }

        fn get_pool_address(self: @ContractState) -> ContractAddress {
            self.pool_address.read()
        }

        fn get_asset_winner_payload_domain(self: @ContractState) -> felt252 {
            ASSET_WINNER_DOMAIN
        }

        fn compute_asset_winner_commitment(
            self: @ContractState, auction_id: u64, recipient: ContractAddress, secret: felt252,
        ) -> felt252 {
            compute_asset_winner_commitment(get_contract_address(), auction_id, recipient, secret)
        }

        fn get_auction(self: @ContractState, auction_id: u64) -> Auction {
            self.require_auction(auction_id)
        }

        fn get_bid_group(self: @ContractState, auction_id: u64, group_handle: felt252) -> BidGroup {
            let group = self.bid_groups.read((auction_id, group_handle));
            assert!(group.group_handle.is_non_zero(), "BID_GROUP_NOT_FOUND");
            group
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
    impl WhisperBidActionImpl of IWhisperBidAction<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, request: WalletBidRequest,
        ) -> Span<OpenNoteDeposit> {
            self.assert_pool();
            match request {
                WalletBidRequest::SubmitBid(intent) => self.submit_bid_group(intent),
                WalletBidRequest::AddBidTranche(intent) => self.add_bid_tranche(intent),
            }
            let deposits: Array<OpenNoteDeposit> = array![];
            deposits.span()
        }
    }

    #[abi(embed_v0)]
    impl WhisperPrivacyActionImpl of IWhisperPrivacyAction<ContractState> {
        fn privacy_compute(
            self: @ContractState, identity_key: felt252, request: PrivacyRequest,
        ) -> PrivacyCommand {
            assert!(identity_key.is_non_zero(), "ZERO_IDENTITY_KEY");
            match request {
                PrivacyRequest::AcceptBid(input) => {
                    self.assert_operator(identity_key, input.auction_id);
                    PrivacyCommand::AcceptBid(input)
                },
                PrivacyRequest::Settle(input) => {
                    self.assert_operator(identity_key, input.auction_id);
                    PrivacyCommand::Settle(input)
                },
                PrivacyRequest::Abort(input) => {
                    self.assert_operator(identity_key, input.auction_id);
                    PrivacyCommand::Abort(input)
                },
            }
        }

        fn privacy_invoke_with_computation(
            ref self: ContractState, command: PrivacyCommand,
        ) -> Span<OpenNoteDeposit> {
            self.assert_pool();
            match command {
                PrivacyCommand::AcceptBid(input) => self.accept_funded_bid(input),
                PrivacyCommand::Settle(input) => self.settle_auction(input),
                PrivacyCommand::Abort(input) => self.abort_auction(input),
            }
            let deposits: Array<OpenNoteDeposit> = array![];
            deposits.span()
        }
    }

    #[abi(embed_v0)]
    impl ERC721ReceiverImpl of IERC721Receiver<ContractState> {
        fn on_erc721_received(
            self: @ContractState,
            operator: ContractAddress,
            from: ContractAddress,
            token_id: u256,
            data: Span<felt252>,
        ) -> felt252 {
            let _ = data;
            assert!(self.locked.read(), "UNSOLICITED_ERC721");
            assert!(operator == get_contract_address(), "UNEXPECTED_OPERATOR");
            assert!(self.pending_kind.read() == FulfillmentKind::Erc721, "UNEXPECTED_ASSET_KIND");
            assert!(get_caller_address() == self.pending_token.read(), "UNEXPECTED_TOKEN");
            assert!(from == self.pending_seller.read(), "UNEXPECTED_SELLER");
            assert!(token_id == self.pending_token_id.read(), "UNEXPECTED_TOKEN_ID");
            IERC721_RECEIVER_ID
        }
    }

    #[abi(embed_v0)]
    impl ERC1155ReceiverImpl of IERC1155Receiver<ContractState> {
        fn on_erc1155_received(
            self: @ContractState,
            operator: ContractAddress,
            from: ContractAddress,
            token_id: u256,
            value: u256,
            data: Span<felt252>,
        ) -> felt252 {
            let _ = data;
            assert!(self.locked.read(), "UNSOLICITED_ERC1155");
            assert!(operator == get_contract_address(), "UNEXPECTED_OPERATOR");
            assert!(self.pending_kind.read() == FulfillmentKind::Erc1155, "UNEXPECTED_ASSET_KIND");
            assert!(get_caller_address() == self.pending_token.read(), "UNEXPECTED_TOKEN");
            assert!(from == self.pending_seller.read(), "UNEXPECTED_SELLER");
            assert!(token_id == self.pending_token_id.read(), "UNEXPECTED_TOKEN_ID");
            assert!(value == self.pending_amount.read(), "UNEXPECTED_AMOUNT");
            IERC1155_RECEIVER_ID
        }

        fn on_erc1155_batch_received(
            self: @ContractState,
            operator: ContractAddress,
            from: ContractAddress,
            token_ids: Span<u256>,
            values: Span<u256>,
            data: Span<felt252>,
        ) -> felt252 {
            let _ = operator;
            let _ = from;
            let _ = token_ids;
            let _ = values;
            let _ = data;
            panic!("BATCH_NOT_SUPPORTED")
        }
    }

    #[abi(embed_v0)]
    impl SRC5Impl of ISRC5<ContractState> {
        fn supports_interface(self: @ContractState, interface_id: felt252) -> bool {
            interface_id == IERC721_RECEIVER_ID || interface_id == IERC1155_RECEIVER_ID
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn enter(ref self: ContractState) {
            assert!(!self.locked.read(), "REENTRANT_CALL");
            self.locked.write(true);
        }

        fn exit(ref self: ContractState) {
            self.clear_pending_receipt();
            self.locked.write(false);
        }

        fn assert_pool(self: @ContractState) {
            assert!(get_caller_address() == self.pool_address.read(), "ONLY_POOL");
        }

        fn require_auction(self: @ContractState, auction_id: u64) -> Auction {
            let auction = self.auctions.read(auction_id);
            assert!(auction.status != AuctionStatus::Unset, "AUCTION_NOT_FOUND");
            auction
        }

        fn require_escrowed_asset(self: @ContractState, auction_id: u64) -> Auction {
            let auction = self.require_auction(auction_id);
            assert!(
                auction.fulfillment_status == FulfillmentStatus::Escrowed, "ASSET_NOT_ESCROWED",
            );
            auction
        }

        fn initial_fulfillment_status(
            self: @ContractState, kind: FulfillmentKind,
        ) -> FulfillmentStatus {
            match kind {
                FulfillmentKind::Offchain => FulfillmentStatus::Offchain,
                FulfillmentKind::Erc20 => FulfillmentStatus::Escrowed,
                FulfillmentKind::Erc721 => FulfillmentStatus::Escrowed,
                FulfillmentKind::Erc1155 => FulfillmentStatus::Escrowed,
            }
        }

        fn initialize_schedule(
            self: @ContractState, schedule: AuctionSchedule, now: u64,
        ) -> (AuctionStatus, u64, u64, u64, u64) {
            match schedule {
                AuctionSchedule::Absolute(timing) => {
                    assert!(timing.bidding_deadline > now, "INVALID_BID_DEADLINE");
                    assert!(
                        timing.force_reveal_after > timing.bidding_deadline, "INVALID_REVEAL_TIME",
                    );
                    assert!(timing.abort_after > timing.force_reveal_after, "INVALID_ABORT_TIME");
                    (
                        AuctionStatus::Bidding,
                        now,
                        timing.bidding_deadline,
                        timing.force_reveal_after,
                        timing.abort_after,
                    )
                },
                AuctionSchedule::StartOnBid(periods) => {
                    assert!(periods.bidding_duration.is_non_zero(), "ZERO_BIDDING_DURATION");
                    assert!(periods.acceptance_duration.is_non_zero(), "ZERO_ACCEPTANCE_DURATION");
                    assert!(periods.settlement_duration.is_non_zero(), "ZERO_SETTLEMENT_DURATION");
                    (AuctionStatus::Pending, 0, 0, 0, 0)
                },
            }
        }

        fn validate_fulfillment(
            self: @ContractState, fulfillment: AuctionFulfillment, winner_payload_domain: felt252,
        ) {
            match fulfillment.kind {
                FulfillmentKind::Offchain => {
                    assert!(fulfillment.token.is_zero(), "OFFCHAIN_TOKEN");
                    assert!(fulfillment.token_id == 0, "OFFCHAIN_TOKEN_ID");
                    assert!(fulfillment.amount == 0, "OFFCHAIN_AMOUNT");
                },
                FulfillmentKind::Erc20 => {
                    assert!(!fulfillment.token.is_zero(), "ZERO_ASSET_TOKEN");
                    assert!(fulfillment.token_id == 0, "ERC20_TOKEN_ID");
                    assert!(fulfillment.amount > 0, "ZERO_ASSET_AMOUNT");
                    assert!(winner_payload_domain == ASSET_WINNER_DOMAIN, "WRONG_WINNER_DOMAIN");
                },
                FulfillmentKind::Erc721 => {
                    assert!(!fulfillment.token.is_zero(), "ZERO_ASSET_TOKEN");
                    assert!(fulfillment.amount == 1, "ERC721_AMOUNT");
                    assert!(winner_payload_domain == ASSET_WINNER_DOMAIN, "WRONG_WINNER_DOMAIN");
                },
                FulfillmentKind::Erc1155 => {
                    assert!(!fulfillment.token.is_zero(), "ZERO_ASSET_TOKEN");
                    assert!(fulfillment.amount > 0, "ZERO_ASSET_AMOUNT");
                    assert!(winner_payload_domain == ASSET_WINNER_DOMAIN, "WRONG_WINNER_DOMAIN");
                },
            }
        }

        fn pull_asset(
            ref self: ContractState, seller: ContractAddress, fulfillment: AuctionFulfillment,
        ) {
            let escrow = get_contract_address();
            match fulfillment.kind {
                FulfillmentKind::Offchain => {},
                FulfillmentKind::Erc20 => {
                    let token = IERC20AssetDispatcher { contract_address: fulfillment.token };
                    let before = token.balance_of(escrow);
                    assert!(
                        token.transfer_from(seller, escrow, fulfillment.amount),
                        "ERC20_PULL_FAILED",
                    );
                    assert!(
                        token.balance_of(escrow) == before + fulfillment.amount,
                        "ERC20_AMOUNT_MISMATCH",
                    );
                },
                FulfillmentKind::Erc721 => {
                    self.set_pending_receipt(seller, fulfillment);
                    IERC721AssetDispatcher { contract_address: fulfillment.token }
                        .safe_transfer_from(seller, escrow, fulfillment.token_id, array![].span());
                    assert!(
                        IERC721AssetDispatcher { contract_address: fulfillment.token }
                            .owner_of(fulfillment.token_id) == escrow,
                        "ERC721_OWNER_MISMATCH",
                    );
                    self.clear_pending_receipt();
                },
                FulfillmentKind::Erc1155 => {
                    let token = IERC1155AssetDispatcher { contract_address: fulfillment.token };
                    let before = token.balance_of(escrow, fulfillment.token_id);
                    self.set_pending_receipt(seller, fulfillment);
                    token
                        .safe_transfer_from(
                            seller,
                            escrow,
                            fulfillment.token_id,
                            fulfillment.amount,
                            array![].span(),
                        );
                    assert!(
                        token.balance_of(escrow, fulfillment.token_id) == before
                            + fulfillment.amount,
                        "ERC1155_AMOUNT_MISMATCH",
                    );
                    self.clear_pending_receipt();
                },
            }
        }

        fn push_asset(
            ref self: ContractState, recipient: ContractAddress, fulfillment: AuctionFulfillment,
        ) {
            let escrow = get_contract_address();
            match fulfillment.kind {
                FulfillmentKind::Offchain => panic!("NO_ONCHAIN_ASSET"),
                FulfillmentKind::Erc20 => {
                    let token = IERC20AssetDispatcher { contract_address: fulfillment.token };
                    let before = token.balance_of(recipient);
                    assert!(token.transfer(recipient, fulfillment.amount), "ERC20_PUSH_FAILED");
                    assert!(
                        token.balance_of(recipient) == before + fulfillment.amount,
                        "ERC20_AMOUNT_MISMATCH",
                    );
                },
                FulfillmentKind::Erc721 => {
                    IERC721AssetDispatcher { contract_address: fulfillment.token }
                        .safe_transfer_from(
                            escrow, recipient, fulfillment.token_id, array![].span(),
                        );
                    assert!(
                        IERC721AssetDispatcher { contract_address: fulfillment.token }
                            .owner_of(fulfillment.token_id) == recipient,
                        "ERC721_OWNER_MISMATCH",
                    );
                },
                FulfillmentKind::Erc1155 => {
                    let token = IERC1155AssetDispatcher { contract_address: fulfillment.token };
                    let before = token.balance_of(recipient, fulfillment.token_id);
                    token
                        .safe_transfer_from(
                            escrow,
                            recipient,
                            fulfillment.token_id,
                            fulfillment.amount,
                            array![].span(),
                        );
                    assert!(
                        token.balance_of(recipient, fulfillment.token_id) == before
                            + fulfillment.amount,
                        "ERC1155_AMOUNT_MISMATCH",
                    );
                },
            }
        }

        fn set_pending_receipt(
            ref self: ContractState, seller: ContractAddress, fulfillment: AuctionFulfillment,
        ) {
            self.pending_kind.write(fulfillment.kind);
            self.pending_token.write(fulfillment.token);
            self.pending_seller.write(seller);
            self.pending_token_id.write(fulfillment.token_id);
            self.pending_amount.write(fulfillment.amount);
        }

        fn clear_pending_receipt(ref self: ContractState) {
            self.pending_kind.write(FulfillmentKind::Offchain);
            self.pending_token.write(0.try_into().unwrap());
            self.pending_seller.write(0.try_into().unwrap());
            self.pending_token_id.write(0);
            self.pending_amount.write(0);
        }

        fn assert_operator(self: @ContractState, identity_key: felt252, auction_id: u64) {
            let auction = self.require_auction(auction_id);
            assert!(
                compute_operator_identity_commitment(identity_key) == auction
                    .operator_identity_commitment,
                "ONLY_OPERATOR",
            );
        }

        fn submit_bid_group(ref self: ContractState, intent: BidIntent) {
            assert!(intent.bid_nonce.is_non_zero(), "ZERO_BID_NONCE");
            assert!(intent.reveal_commitment.is_non_zero(), "ZERO_REVEAL_COMMITMENT");
            assert!(intent.refund_commitment.is_non_zero(), "ZERO_REFUND");
            assert!(intent.winner_commitment.is_non_zero(), "ZERO_WINNER_COMMITMENT");
            let group_handle = compute_bid_group_handle(
                intent.auction_id,
                intent.bid_nonce,
                intent.refund_commitment,
                intent.winner_commitment,
            );
            assert!(group_handle.is_non_zero(), "ZERO_GROUP_HANDLE");
            assert!(
                self.bid_groups.read((intent.auction_id, group_handle)).group_handle.is_zero(),
                "DUPLICATE_BID_GROUP",
            );
            self
                .bid_groups
                .write(
                    (intent.auction_id, group_handle),
                    BidGroup {
                        auction_id: intent.auction_id,
                        group_handle,
                        refund_commitment: intent.refund_commitment,
                        winner_commitment: intent.winner_commitment,
                        tranche_count: 0,
                        funded_tranche_count: 0,
                        settled: false,
                    },
                );
            self
                .record_bid_submission(
                    BidSubmission {
                        auction_id: intent.auction_id,
                        bid_handle: compute_bid_handle(
                            intent.auction_id, group_handle, 0, intent.reveal_commitment,
                        ),
                        group_handle,
                        tranche_index: 0,
                        reveal_commitment: intent.reveal_commitment,
                        refund_commitment: intent.refund_commitment,
                        winner_commitment: intent.winner_commitment,
                    },
                );
        }

        fn add_bid_tranche(ref self: ContractState, intent: BidTopUpIntent) {
            assert!(intent.group_handle.is_non_zero(), "ZERO_GROUP_HANDLE");
            assert!(intent.reveal_commitment.is_non_zero(), "ZERO_REVEAL_COMMITMENT");
            let group = self.bid_groups.read((intent.auction_id, intent.group_handle));
            assert!(group.group_handle.is_non_zero(), "BID_GROUP_NOT_FOUND");
            assert!(!group.settled, "BID_GROUP_SETTLED");
            let tranche_index = group.tranche_count;
            let bid_handle = compute_bid_handle(
                intent.auction_id, intent.group_handle, tranche_index, intent.reveal_commitment,
            );
            self
                .record_bid_submission(
                    BidSubmission {
                        auction_id: intent.auction_id,
                        bid_handle,
                        group_handle: intent.group_handle,
                        tranche_index,
                        reveal_commitment: intent.reveal_commitment,
                        refund_commitment: group.refund_commitment,
                        winner_commitment: group.winner_commitment,
                    },
                );
        }

        fn record_bid_submission(ref self: ContractState, bid: BidSubmission) {
            let mut auction = self.require_auction(bid.auction_id);
            assert!(
                auction.status == AuctionStatus::Pending
                    || auction.status == AuctionStatus::Bidding,
                "NOT_BIDDING",
            );
            let now = get_block_timestamp();
            if auction.status == AuctionStatus::Pending {
                assert!(auction.started_at.is_zero(), "INVALID_START_STATE");
                let periods = match auction.schedule {
                    AuctionSchedule::StartOnBid(periods) => periods,
                    AuctionSchedule::Absolute(_) => panic!("INVALID_START_STATE"),
                };
                auction.status = AuctionStatus::Bidding;
                auction.started_at = now;
                auction
                    .bidding_deadline = now
                    .checked_add(periods.bidding_duration)
                    .expect('SCHEDULE_OVERFLOW');
                auction
                    .force_reveal_after = auction
                    .bidding_deadline
                    .checked_add(periods.acceptance_duration)
                    .expect('SCHEDULE_OVERFLOW');
                auction
                    .abort_after = auction
                    .force_reveal_after
                    .checked_add(periods.settlement_duration)
                    .expect('SCHEDULE_OVERFLOW');
                self
                    .emit(
                        AuctionStarted {
                            auction_id: bid.auction_id,
                            started_at: auction.started_at,
                            bidding_deadline: auction.bidding_deadline,
                            force_reveal_after: auction.force_reveal_after,
                            abort_after: auction.abort_after,
                        },
                    );
            }
            assert!(now < auction.bidding_deadline, "BIDDING_CLOSED");
            assert!(bid.bid_handle.is_non_zero(), "ZERO_BID_HANDLE");
            assert!(bid.group_handle.is_non_zero(), "ZERO_GROUP_HANDLE");
            assert!(bid.reveal_commitment.is_non_zero(), "ZERO_REVEAL_COMMITMENT");
            assert!(bid.refund_commitment.is_non_zero(), "ZERO_REFUND");
            assert!(bid.winner_commitment.is_non_zero(), "ZERO_WINNER_COMMITMENT");
            assert!(
                self.bids.read((bid.auction_id, bid.bid_handle)).bid_handle.is_zero(),
                "DUPLICATE_BID_HANDLE",
            );
            let mut group = self.bid_groups.read((bid.auction_id, bid.group_handle));
            assert!(group.group_handle.is_non_zero(), "BID_GROUP_NOT_FOUND");
            assert!(bid.tranche_index == group.tranche_count, "WRONG_TRANCHE_INDEX");

            let submission_index = auction.submission_count;
            let sealed_bid = SealedBid {
                auction_id: bid.auction_id,
                bid_handle: bid.bid_handle,
                group_handle: bid.group_handle,
                tranche_index: bid.tranche_index,
                note_id: 0,
                reveal_commitment: bid.reveal_commitment,
                refund_commitment: bid.refund_commitment,
                winner_commitment: bid.winner_commitment,
                submitted_at: get_block_timestamp(),
                funded: false,
                settled: false,
            };

            self.bids.write((bid.auction_id, bid.bid_handle), sealed_bid);
            group.tranche_count += 1;
            self.bid_groups.write((bid.auction_id, bid.group_handle), group);
            auction.submission_count += 1;
            self.auctions.write(bid.auction_id, auction);
            self
                .emit(
                    BidSubmitted {
                        auction_id: bid.auction_id,
                        bid_handle: bid.bid_handle,
                        group_handle: bid.group_handle,
                        tranche_index: bid.tranche_index,
                        submission_index,
                        auction_submission_count: auction.submission_count,
                    },
                );
        }

        fn accept_funded_bid(ref self: ContractState, input: AcceptBidInput) {
            let mut auction = self.require_auction(input.auction_id);
            assert!(auction.status != AuctionStatus::Pending, "AUCTION_NOT_STARTED");
            assert!(auction.status == AuctionStatus::Bidding, "NOT_BIDDING");
            assert!(get_block_timestamp() < auction.force_reveal_after, "ACCEPTANCE_CLOSED");
            assert!(auction.bid_count < auction.max_bids, "MAX_BIDS_REACHED");
            assert!(input.note_id.is_non_zero(), "ZERO_NOTE_ID");
            assert!(!self.used_note_ids.read(input.note_id), "DUPLICATE_NOTE_ID");
            let mut bid = self.bids.read((input.auction_id, input.bid_handle));
            assert!(bid.bid_handle.is_non_zero(), "BID_NOT_FOUND");
            assert!(!bid.funded, "BID_ALREADY_FUNDED");

            let bid_index = auction.bid_count;
            let accepted_bids_hash = PoseidonTrait::new()
                .update(auction.accepted_bids_hash)
                .update(input.bid_handle)
                .finalize();
            bid.funded = true;
            bid.note_id = input.note_id;
            self.bids.write((input.auction_id, input.bid_handle), bid);
            let mut group = self.bid_groups.read((input.auction_id, bid.group_handle));
            group.funded_tranche_count += 1;
            self.bid_groups.write((input.auction_id, bid.group_handle), group);
            self.used_note_ids.write(input.note_id, true);
            self.bid_handles.write((input.auction_id, bid_index), input.bid_handle);
            auction.accepted_bids_hash = accepted_bids_hash;
            auction.bid_count += 1;
            self.auctions.write(input.auction_id, auction);
            self
                .emit(
                    BidFunded {
                        auction_id: input.auction_id,
                        bid_handle: input.bid_handle,
                        group_handle: bid.group_handle,
                        note_id: input.note_id,
                        bid_index,
                        auction_funded_tranche_count: auction.bid_count,
                        group_funded_tranche_count: group.funded_tranche_count,
                        accepted_bids_hash,
                    },
                );
        }

        fn settle_auction(ref self: ContractState, input: SettlementInput) {
            let SettlementInput {
                auction_id,
                accepted_bids_hash,
                revealed_bids,
                winner_bid_handle,
                reveals_root,
                outputs_root,
                settlement_hash,
            } = input;
            let mut auction = self.require_auction(auction_id);
            let now = get_block_timestamp();
            assert!(auction.status != AuctionStatus::Pending, "AUCTION_NOT_STARTED");
            assert!(auction.status == AuctionStatus::Bidding, "NOT_SETTLEABLE");
            assert!(now >= auction.force_reveal_after, "REVEAL_TOO_EARLY");
            assert!(now < auction.abort_after, "SETTLEMENT_EXPIRED");
            assert!(accepted_bids_hash == auction.accepted_bids_hash, "BID_SET_MISMATCH");
            assert!(reveals_root.is_non_zero(), "ZERO_REVEALS_ROOT");
            assert!(outputs_root.is_non_zero(), "ZERO_OUTPUTS_ROOT");
            assert!(settlement_hash.is_non_zero(), "ZERO_SETTLEMENT_HASH");

            let expected_len: usize = auction.bid_count.into();
            assert!(revealed_bids.len() == expected_len, "INCOMPLETE_BID_SET");
            let mut group_totals: Felt252Dict<u128> = Default::default();
            let mut seen_groups: Felt252Dict<bool> = Default::default();
            let mut group_handles: Array<felt252> = array![];
            let mut index = 0;
            while index < revealed_bids.len() {
                let revealed = *revealed_bids.at(index);
                let bid_index: u32 = index.try_into().unwrap();
                let expected_handle = self.bid_handles.read((auction_id, bid_index));
                assert!(revealed.bid_handle == expected_handle, "BID_ORDER_MISMATCH");
                assert!(revealed.amount.is_non_zero(), "ZERO_BID_TRANCHE");
                let bid = self.bids.read((auction_id, revealed.bid_handle));
                assert!(bid.funded, "BID_NOT_FUNDED");
                assert!(
                    compute_reveal_commitment(
                        auction_id,
                        revealed.amount,
                        revealed.salt,
                        bid.refund_commitment,
                        bid.winner_commitment,
                    ) == bid
                        .reveal_commitment,
                    "INVALID_REVEAL",
                );
                let total = group_totals
                    .get(bid.group_handle)
                    .checked_add(revealed.amount)
                    .expect('BID_TOTAL_OVERFLOW');
                group_totals.insert(bid.group_handle, total);
                if !seen_groups.get(bid.group_handle) {
                    seen_groups.insert(bid.group_handle, true);
                    group_handles.append(bid.group_handle);
                }
                self
                    .emit(
                        BidRevealed {
                            auction_id,
                            bid_handle: revealed.bid_handle,
                            group_handle: bid.group_handle,
                            tranche_index: bid.tranche_index,
                            bid_index,
                            amount: revealed.amount,
                        },
                    );
                index += 1;
            }

            let mut aggregate_bids: Array<RevealedBid> = array![];
            index = 0;
            while index < group_handles.len() {
                let group_handle = *group_handles.at(index);
                let amount = group_totals.get(group_handle);
                if amount >= auction.reserve_price {
                    aggregate_bids
                        .append(RevealedBid { bid_handle: group_handle, amount, salt: 0 });
                }
                index += 1;
            }

            let funded_bid_count: u32 = group_handles.len().try_into().unwrap();
            let eligible_bid_count: u32 = aggregate_bids.len().try_into().unwrap();

            let result = if aggregate_bids.is_empty() {
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
                let pricing = compute_vickrey_price(aggregate_bids.span(), auction.reserve_price);
                assert!(pricing.winner_bid_handle == winner_bid_handle, "WRONG_WINNER");
                let winner = self.bid_groups.read((auction_id, winner_bid_handle));
                assert!(winner.funded_tranche_count.is_non_zero(), "WINNER_NOT_FUNDED");
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
                let mut bid = self.bids.read((auction_id, revealed.bid_handle));
                bid.settled = true;
                self.bids.write((auction_id, revealed.bid_handle), bid);
                let mut group = self.bid_groups.read((auction_id, bid.group_handle));
                group.settled = true;
                self.bid_groups.write((auction_id, bid.group_handle), group);
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
                        winner_group_handle: result.winner_bid_handle,
                        has_winner: result.has_winner,
                        winner_commitment: result.winner_commitment,
                        winning_bid: result.winning_bid,
                        second_highest_bid: result.second_highest_bid,
                        clearing_price: result.clearing_price,
                        submission_count: auction.submission_count,
                        funded_tranche_count: auction.bid_count,
                        funded_bid_count,
                        eligible_bid_count,
                        accepted_bids_hash,
                        reveals_root,
                        outputs_root,
                        settlement_hash,
                        settled_at: result.settled_at,
                    },
                );
        }

        fn abort_auction(ref self: ContractState, input: AbortInput) {
            let mut auction = self.require_auction(input.auction_id);
            let now = get_block_timestamp();
            assert!(auction.status != AuctionStatus::Pending, "AUCTION_NOT_STARTED");
            assert!(auction.status == AuctionStatus::Bidding, "NOT_ABORTABLE");
            assert!(now >= auction.abort_after, "ABORT_TOO_EARLY");
            assert!(input.recovery_hash.is_non_zero(), "ZERO_RECOVERY_HASH");
            auction.status = AuctionStatus::Aborted;
            auction.recovery_hash = input.recovery_hash;
            self.auctions.write(input.auction_id, auction);
            self
                .emit(
                    AuctionAborted {
                        auction_id: input.auction_id,
                        recovery_hash: input.recovery_hash,
                        submission_count: auction.submission_count,
                        funded_tranche_count: auction.bid_count,
                        aborted_at: now,
                    },
                );
        }
    }
}
