use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;

pub const BID_GROUP_DOMAIN: felt252 = 'WHISPER_GROUP_V1';
pub const BID_DOMAIN: felt252 = 'WHISPER_TRANCHE_V1';
pub const OPERATOR_DOMAIN: felt252 = 'WHISPER_OP_V1';
pub const REVEAL_DOMAIN: felt252 = 'WHISPER_REVEAL_V1';

/// Derives an unlinkable logical bid group from client-generated randomness and
/// the group's fixed private-output routing commitments.
pub fn compute_bid_group_handle(
    auction_id: u64, bid_nonce: felt252, refund_commitment: felt252, winner_commitment: felt252,
) -> felt252 {
    PoseidonTrait::new()
        .update(BID_GROUP_DOMAIN)
        .update(auction_id.into())
        .update(bid_nonce)
        .update(refund_commitment)
        .update(winner_commitment)
        .finalize()
}

/// Commits the reusable STRK20 identity derived specifically for the Whisper
/// contract. This authenticates the backend-controlled vault operator without
/// publishing its account or viewing key.
pub fn compute_operator_identity_commitment(identity_key: felt252) -> felt252 {
    PoseidonTrait::new().update(OPERATOR_DOMAIN).update(identity_key).finalize()
}

/// Commits the private reveal payload. An AEAD-encrypted capsule containing the
/// opening and output-routing material is transported offchain under the
/// auction's application-layer reveal key. Settlement publishes the opening.
pub fn compute_reveal_commitment(
    auction_id: u64,
    amount: u128,
    salt: felt252,
    refund_commitment: felt252,
    winner_commitment: felt252,
) -> felt252 {
    PoseidonTrait::new()
        .update(REVEAL_DOMAIN)
        .update(auction_id.into())
        .update(amount.into())
        .update(salt)
        .update(refund_commitment)
        .update(winner_commitment)
        .finalize()
}

/// Commits every public bid transcript field into one deterministic handle.
pub fn compute_bid_handle(
    auction_id: u64, group_handle: felt252, tranche_index: u32, reveal_commitment: felt252,
) -> felt252 {
    PoseidonTrait::new()
        .update(BID_DOMAIN)
        .update(auction_id.into())
        .update(group_handle)
        .update(tranche_index.into())
        .update(reveal_commitment)
        .finalize()
}
