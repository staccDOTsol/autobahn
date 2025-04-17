use std::any::Any;

use anchor_spl::token::spl_token::state::Account;
use solana_program::pubkey::Pubkey;

use crate::internal::state::PoolState;
use router_lib::dex::{DexEdge, DexEdgeIdentifier};

/// Represents a trading pair/edge in the Raydium Launchpad DEX
pub struct RaydiumLaunchpadEdgeIdentifier {
    pub pool_state: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub is_buy: bool, // true for buy_exact_in or buy_exact_out, false for sell_exact_in or sell_exact_out
}

impl DexEdgeIdentifier for RaydiumLaunchpadEdgeIdentifier {
    fn key(&self) -> Pubkey {
        self.pool_state
    }

    fn desc(&self) -> String {
        format!("RaydiumLaunchpad_{}", self.pool_state)
    }

    fn input_mint(&self) -> Pubkey {
        if self.is_buy {
            // For buys, the input token is the quote token (e.g., USDC)
            self.quote_mint
        } else {
            // For sells, the input token is the base token
            self.base_mint
        }
    }

    fn output_mint(&self) -> Pubkey {
        if self.is_buy {
            // For buys, the output token is the base token
            self.base_mint
        } else {
            // For sells, the output token is the quote token
            self.quote_mint
        }
    }

    fn accounts_needed(&self) -> usize {
        // Based on the number of accounts in the buy_exact_in or sell_exact_in instructions
        14
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Contains the state information needed for a launchpad edge
pub struct RaydiumLaunchpadEdge {
    pub pool_state: PoolState,
    pub base_vault: Account,
    pub quote_vault: Account,
}

impl DexEdge for RaydiumLaunchpadEdge {
    fn as_any(&self) -> &dyn Any {
        self
    }
} 