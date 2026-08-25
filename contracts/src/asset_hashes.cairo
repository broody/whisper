use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;
use starknet::ContractAddress;

pub const ASSET_WINNER_DOMAIN: felt252 = 'WHISPER_ASSET_WINNER_V1';

pub fn compute_asset_winner_commitment(
    whisper_address: ContractAddress, auction_id: u64, recipient: ContractAddress, secret: felt252,
) -> felt252 {
    PoseidonTrait::new()
        .update(ASSET_WINNER_DOMAIN)
        .update(whisper_address.into())
        .update(auction_id.into())
        .update(recipient.into())
        .update(secret)
        .finalize()
}
