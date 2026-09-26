// src/matching/simulator.rs
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub is_bid: true, // true for buy, false for sell
    pub price: f64,
    pub volume: f64,
}

pub struct BatchResult {
    pub clearing_price: f64,
    pub executed_volume: f64,
    pub execution_time_ms: u128,
}

pub struct BatchOrderSimulator;

impl BatchOrderSimulator {
    /// Simulates high-throughput batch order matching and computes the uniform clearing price.
    /// Maximizes total executed trade volume while minimizing order slippage under $50ms for 1,000 orders.
    pub fn simulate_batch_auction(mut bids: Vec<Order>, mut asks: Vec<Order>) -> BatchResult {
        let start_time = Instant::now();

        // Sort bids descending (highest price willing to pay first)
        bids.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap());
        // Sort asks ascending (lowest price willing to sell first)
        asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap());

        let mut clearing_price = 0.0;
        let mut max_volume = 0.0;
        
        // Collect candidate clearing prices (marginal bid and ask intersection points)
        let mut candidate_prices: Vec<f64> = Vec::new();
        for b in &bids {
            candidate_prices.push(b.price);
        }
        for a in &asks {
            candidate_prices.push(a.price);
        }
        candidate_prices.dedup();

        // Evaluate uniform clearing price that maximizes matched volume
        for &price in &candidate_prices {
            let bid_volume: f64 = bids
                .iter()
                .filter(|b| b.price >= price)
                .map(|b| b.volume)
                .sum();

            let ask_volume: f64 = asks
                .iter()
                .filter(|a| a.price <= price)
                .map(|a| a.volume)
                .sum();

            let matched_volume = bid_volume.min(ask_volume);

            if matched_volume > max_volume {
                max_volume = matched_volume;
                clearing_price = price;
            }
        }

        let execution_time_ms = start_time.elapsed().as_millis();

        BatchResult {
            clearing_price,
            executed_volume: max_volume,
            execution_time_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_batch_matching_performance_and_volume() {
        let mut bids = Vec::new();
        let mut asks = Vec::new();

        // Generate 1,000 synthetic test orders (500 bids, 500 asks)
        for i in 0..500 {
            bids.push(Order {
                id: i,
                is_bid: true,
                price: 100.0 - (i as f64 * 0.05),
                volume: 10.0,
            });
            asks.push(Order {
                id: i + 500,
                is_bid: false,
                price: 90.0 + (i as f64 * 0.05),
                volume: 10.0,
            });
        }

        let result = BatchOrderSimulator::simulate_batch_auction(bids, asks);

        // Verify execution speed requirement (< 50ms for 1,000 orders)
        assert!(
            result.execution_time_ms < 50,
            "Batch execution took {}ms, exceeding the 50ms limit",
            result.execution_time_ms
        );
        assert!(result.executed_volume > 0.0, "Executed volume must be positive");
        assert!(result.clearing_price > 0.0, "Clearing price must be valid");
    }
}