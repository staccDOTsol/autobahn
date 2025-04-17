pub mod state;
pub mod processor;

/// Enum to specify the trade direction
#[derive(Copy, Clone, Debug)]
pub enum TradeDirection {
    Buy,  // Buy base tokens with quote tokens
    Sell, // Sell base tokens for quote tokens
}

/// Defines different pool statuses
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PoolStatus {
    Fund = 0,    // Initial state, pool is accepting funds
    Migrate = 1, // Pool funding ended, waiting for migration
    Trade = 2,   // Pool migration complete, trading enabled
}

impl PoolStatus {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => PoolStatus::Fund,
            1 => PoolStatus::Migrate,
            2 => PoolStatus::Trade,
            _ => panic!("Invalid PoolStatus value: {}", value),
        }
    }

    pub fn is_tradable(&self) -> bool {
        *self == PoolStatus::Trade
    }
} 