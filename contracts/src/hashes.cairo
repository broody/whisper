use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;

pub const IDENTITY_DOMAIN: felt252 = 'WHISPER_ID_V1';
pub const BID_DOMAIN: felt252 = 'WHISPER_BID_V1';
pub const OPERATOR_DOMAIN: felt252 = 'WHISPER_OP_V1';
pub const REVEAL_DOMAIN: felt252 = 'WHISPER_REVEAL_V1';

/// Derives an auction-scoped pseudonymous bidder identity from the identity key
/// supplied by STRK20's proven `ComputeAndInvoke` action.
pub fn compute_identity_commitment(identity_key: felt252, auction_id: u64) -> felt252 {
    PoseidonTrait::new()
        .update(IDENTITY_DOMAIN)
        .update(identity_key)
        .update(auction_id.into())
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
    auction_id: u64,
    identity_commitment: felt252,
    reveal_commitment: felt252,
    refund_commitment: felt252,
    winner_commitment: felt252,
) -> felt252 {
    PoseidonTrait::new()
        .update(BID_DOMAIN)
        .update(auction_id.into())
        .update(identity_commitment)
        .update(reveal_commitment)
        .update(refund_commitment)
        .update(winner_commitment)
        .finalize()
}
