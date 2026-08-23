use crate::types::{PricingResult, RevealedBid};

/// Computes a deterministic single-winner Vickrey result.
///
/// Bids rank by amount descending and then by bid handle ascending. The caller
/// is responsible for validating token binding, bid bounds, and completeness.
pub fn compute_vickrey_price(
    revealed_bids: Span<RevealedBid>, reserve_price: u128,
) -> PricingResult {
    assert!(!revealed_bids.is_empty(), "NO_BIDS");

    let first = *revealed_bids.at(0);
    let mut winner_bid_handle = first.bid_handle;
    let mut winning_bid = first.amount;
    let mut second_highest_bid = 0;
    let mut index = 1;

    while index < revealed_bids.len() {
        let bid = *revealed_bids.at(index);
        let bid_handle_value: u256 = bid.bid_handle.into();
        let winner_handle_value: u256 = winner_bid_handle.into();
        let replaces_winner = bid.amount > winning_bid
            || (bid.amount == winning_bid && bid_handle_value < winner_handle_value);

        if replaces_winner {
            second_highest_bid = winning_bid;
            winning_bid = bid.amount;
            winner_bid_handle = bid.bid_handle;
        } else if bid.amount > second_highest_bid {
            second_highest_bid = bid.amount;
        }

        index += 1;
    }

    PricingResult {
        winner_bid_handle,
        winning_bid,
        second_highest_bid,
        clearing_price: if second_highest_bid > reserve_price {
            second_highest_bid
        } else {
            reserve_price
        },
    }
}
