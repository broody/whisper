use starknet::ContractAddress;

/// Minimal standard token ABIs used by Whisper's integrated asset escrow. The
/// function selectors and argument types match the Starknet token standards.
#[starknet::interface]
pub trait IERC20Asset<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
}

#[starknet::interface]
pub trait IERC721Asset<TContractState> {
    fn owner_of(self: @TContractState, token_id: u256) -> ContractAddress;
    fn safe_transfer_from(
        ref self: TContractState,
        from: ContractAddress,
        to: ContractAddress,
        token_id: u256,
        data: Span<felt252>,
    );
}

#[starknet::interface]
pub trait IERC1155Asset<TContractState> {
    fn balance_of(self: @TContractState, account: ContractAddress, token_id: u256) -> u256;
    fn safe_transfer_from(
        ref self: TContractState,
        from: ContractAddress,
        to: ContractAddress,
        token_id: u256,
        value: u256,
        data: Span<felt252>,
    );
}

#[starknet::interface]
pub trait IERC721Receiver<TContractState> {
    fn on_erc721_received(
        self: @TContractState,
        operator: ContractAddress,
        from: ContractAddress,
        token_id: u256,
        data: Span<felt252>,
    ) -> felt252;
}

#[starknet::interface]
pub trait IERC1155Receiver<TContractState> {
    fn on_erc1155_received(
        self: @TContractState,
        operator: ContractAddress,
        from: ContractAddress,
        token_id: u256,
        value: u256,
        data: Span<felt252>,
    ) -> felt252;

    fn on_erc1155_batch_received(
        self: @TContractState,
        operator: ContractAddress,
        from: ContractAddress,
        token_ids: Span<u256>,
        values: Span<u256>,
        data: Span<felt252>,
    ) -> felt252;
}

#[starknet::interface]
pub trait ISRC5<TContractState> {
    fn supports_interface(self: @TContractState, interface_id: felt252) -> bool;
}
