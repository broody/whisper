use starknet::ContractAddress;

/// The fulfillment model fixed when an auction is created. `Offchain` keeps
/// delivery in the consuming application; token variants are escrowed by
/// `WhisperAuction` before bidding opens.
#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub enum FulfillmentKind {
    #[default]
    Offchain,
    Erc20,
    Erc721,
    Erc1155,
}

/// Fixed-width ABI representation used by every auction. Offchain fulfillment
/// requires all token fields to be zero. ERC-20 uses `amount`; ERC-721 uses
/// `token_id` and amount one; ERC-1155 uses both token ID and amount.
#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub struct AuctionFulfillment {
    pub kind: FulfillmentKind,
    pub token: ContractAddress,
    pub token_id: u256,
    pub amount: u256,
}

#[derive(Copy, Drop, Serde, Debug, PartialEq, starknet::Store)]
pub enum FulfillmentStatus {
    #[default]
    Offchain,
    Escrowed,
    Claimed,
    Reclaimed,
}
