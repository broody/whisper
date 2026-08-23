use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;

pub const IDENTITY_DOMAIN: felt252 = 'WHISPER_ID_V1';
pub const BID_DOMAIN: felt252 = 'WHISPER_BID_V1';

/// Derives an auction-scoped pseudonymous bidder identity from the identity key
/// supplied by STRK20's proven `ComputeAndInvoke` action.
pub fn compute_identity_commitment(identity_key: felt252, auction_id: u64) -> felt252 {
    PoseidonTrait::new()
        .update(IDENTITY_DOMAIN)
        .update(identity_key)
        .update(auction_id.into())
        .finalize()
}

/// Commits every public bid transcript field into one deterministic handle.
pub fn compute_bid_handle(
    auction_id: u64,
    identity_commitment: felt252,
    note_id: felt252,
    capsule_hash: felt252,
    refund_commitment: felt252,
    winner_commitment: felt252,
) -> felt252 {
    PoseidonTrait::new()
        .update(BID_DOMAIN)
        .update(auction_id.into())
        .update(identity_commitment)
        .update(note_id)
        .update(capsule_hash)
        .update(refund_commitment)
        .update(winner_commitment)
        .finalize()
}
