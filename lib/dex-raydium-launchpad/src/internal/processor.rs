use anchor_spl::token::spl_token::state::Account;
use anyhow::Result;

use crate::internal::TradeDirection;
use crate::internal::state::{PoolState, CurveType};

/// Calculate the protocol and platform fees
fn calculate_fees(
    amount: u64, 
    protocol_fee_rate: u64, 
    platform_fee_rate: u64, 
    share_fee_rate: u64
) -> (u64, u64, u64) {
    let protocol_fee = (amount * protocol_fee_rate) / 1_000_000;
    let platform_fee = (amount * platform_fee_rate) / 1_000_000;
    let share_fee = (amount * share_fee_rate) / 1_000_000;
    
    (protocol_fee, platform_fee, share_fee)
}

/// Simulate a swap with exact input amount for various curve types
pub fn simulate_swap_exact_in(
    pool: &PoolState,
    base_vault: &Account,
    quote_vault: &Account,
    direction: TradeDirection,
    amount_in: u64,
    share_fee_rate: u64,
) -> Result<(u64, u64, u64, u64)> {
    // Find cached protocol fee rates from program, placeholder values used
    let protocol_fee_rate = 300; // e.g. 0.03% (300 / 1_000_000)
    let platform_fee_rate = 700; // e.g. 0.07% (700 / 1_000_000)
    
    // Calculate fees
    let (protocol_fee, platform_fee, share_fee) = 
        calculate_fees(amount_in, protocol_fee_rate, platform_fee_rate, share_fee_rate);
    
    let net_amount_in = amount_in - protocol_fee - platform_fee - share_fee;
    
    // Get actual token balances
    let base_balance = base_vault.amount;
    let quote_balance = quote_vault.amount;
    
    // Calculate output amount based on curve type
    let curve_type = CurveType::from_u8(pool.status).unwrap_or(CurveType::ConstantProduct);
    
    let out_amount = match curve_type {
        CurveType::ConstantProduct => {
            // For constant product curve (x * y = k)
            match direction {
                TradeDirection::Buy => {
                    // Quote in, base out
                    // Assuming virtual_quote/virtual_base represents the price ratio
                    // and real_base is the available balance for trading
                    let total_base = pool.real_base + pool.virtual_base;
                    let total_quote = pool.real_quote + pool.virtual_quote;
                    
                    // Formula: dx = y * dX / (X + dX)
                    // Where:
                    // - X is total_quote
                    // - y is total_base
                    // - dX is net_amount_in (quote tokens)
                    // - dx is the output amount (base tokens)
                    
                    let numerator = total_base.saturating_mul(net_amount_in);
                    let denominator = total_quote.saturating_add(net_amount_in);
                    
                    if denominator == 0 {
                        return Ok((0, protocol_fee, platform_fee, share_fee));
                    }
                    
                    numerator / denominator
                },
                TradeDirection::Sell => {
                    // Base in, quote out
                    let total_base = pool.real_base + pool.virtual_base;
                    let total_quote = pool.real_quote + pool.virtual_quote;
                    
                    // Formula: dx = X * dY / (Y + dY)
                    // Where:
                    // - Y is total_base
                    // - X is total_quote
                    // - dY is net_amount_in (base tokens)
                    // - dx is the output amount (quote tokens)
                    
                    let numerator = total_quote.saturating_mul(net_amount_in);
                    let denominator = total_base.saturating_add(net_amount_in);
                    
                    if denominator == 0 {
                        return Ok((0, protocol_fee, platform_fee, share_fee));
                    }
                    
                    numerator / denominator
                }
            }
        },
        CurveType::Fixed => {
            // For fixed price curve (price = virtual_quote/virtual_base)
            let price = if pool.virtual_base == 0 {
                return Ok((0, protocol_fee, platform_fee, share_fee));
            } else {
                pool.virtual_quote as f64 / pool.virtual_base as f64
            };
            
            match direction {
                TradeDirection::Buy => {
                    // Quote in, base out
                    // Divide by price to get base amount
                    let out_f64 = net_amount_in as f64 / price;
                    out_f64 as u64
                },
                TradeDirection::Sell => {
                    // Base in, quote out
                    // Multiply by price to get quote amount
                    let out_f64 = net_amount_in as f64 * price;
                    out_f64 as u64
                }
            }
        },
        CurveType::Linear => {
            // For linear price curve (price = initial_price + slope * amount_sold)
            // Slope is represented by virtual_base
            let initial_price = if pool.virtual_base == 0 {
                0.0
            } else {
                pool.virtual_quote as f64 / pool.virtual_base as f64
            };
            
            let slope = pool.virtual_base as f64;
            let amount_sold = pool.total_base_sell as f64;
            
            let current_price = initial_price + slope * amount_sold;
            
            match direction {
                TradeDirection::Buy => {
                    // Quote in, base out
                    // This is more complex for linear pricing, simplified approximation
                    let out_f64 = net_amount_in as f64 / current_price;
                    out_f64 as u64
                },
                TradeDirection::Sell => {
                    // Base in, quote out
                    let out_f64 = net_amount_in as f64 * current_price;
                    out_f64 as u64
                }
            }
        }
    };
    
    // Ensure the output amount is available in the pool
    let available_out = match direction {
        TradeDirection::Buy => base_balance,
        TradeDirection::Sell => quote_balance,
    };
    
    let final_out = std::cmp::min(out_amount, available_out);
    
    Ok((final_out, protocol_fee, platform_fee, share_fee))
}

/// Simulate a swap with exact output amount for various curve types
pub fn simulate_swap_exact_out(
    pool: &PoolState,
    base_vault: &Account,
    quote_vault: &Account,
    direction: TradeDirection,
    amount_out: u64,
    share_fee_rate: u64,
) -> Result<(u64, u64, u64, u64)> {
    // Ensure the requested output is available
    let available_out = match direction {
        TradeDirection::Buy => base_vault.amount,
        TradeDirection::Sell => quote_vault.amount,
    };
    
    if amount_out > available_out {
        return Ok((0, 0, 0, 0));
    }
    
    // Find cached protocol fee rates
    let protocol_fee_rate = 300; // 0.03%
    let platform_fee_rate = 700; // 0.07%
    
    // Calculate input amount based on curve type
    let curve_type = CurveType::from_u8(pool.status).unwrap_or(CurveType::ConstantProduct);
    
    let gross_amount_in = match curve_type {
        CurveType::ConstantProduct => {
            match direction {
                TradeDirection::Buy => {
                    // Need to provide quote tokens to get exact base tokens
                    let total_base = pool.real_base + pool.virtual_base;
                    let total_quote = pool.real_quote + pool.virtual_quote;
                    
                    // Formula: dX = X * dY / (Y - dY)
                    // Where:
                    // - Y is total_base
                    // - X is total_quote
                    // - dY is amount_out (base tokens)
                    // - dX is the input amount (quote tokens)
                    
                    if amount_out >= total_base {
                        return Ok((0, 0, 0, 0)); // Not enough liquidity
                    }
                    
                    let numerator = total_quote.saturating_mul(amount_out);
                    let denominator = total_base.saturating_sub(amount_out);
                    
                    if denominator == 0 {
                        return Ok((0, 0, 0, 0));
                    }
                    
                    numerator / denominator
                },
                TradeDirection::Sell => {
                    // Need to provide base tokens to get exact quote tokens
                    let total_base = pool.real_base + pool.virtual_base;
                    let total_quote = pool.real_quote + pool.virtual_quote;
                    
                    // Formula: dY = Y * dX / (X - dX)
                    // Where:
                    // - X is total_quote
                    // - Y is total_base
                    // - dX is amount_out (quote tokens)
                    // - dY is the input amount (base tokens)
                    
                    if amount_out >= total_quote {
                        return Ok((0, 0, 0, 0)); // Not enough liquidity
                    }
                    
                    let numerator = total_base.saturating_mul(amount_out);
                    let denominator = total_quote.saturating_sub(amount_out);
                    
                    if denominator == 0 {
                        return Ok((0, 0, 0, 0));
                    }
                    
                    numerator / denominator
                }
            }
        },
        CurveType::Fixed => {
            // For fixed price curve (price = virtual_quote/virtual_base)
            let price = if pool.virtual_base == 0 {
                return Ok((0, 0, 0, 0));
            } else {
                pool.virtual_quote as f64 / pool.virtual_base as f64
            };
            
            match direction {
                TradeDirection::Buy => {
                    // Need quote to get exact base
                    let in_f64 = amount_out as f64 * price;
                    in_f64 as u64
                },
                TradeDirection::Sell => {
                    // Need base to get exact quote
                    let in_f64 = amount_out as f64 / price;
                    in_f64 as u64
                }
            }
        },
        CurveType::Linear => {
            // For linear price curve
            let initial_price = if pool.virtual_base == 0 {
                0.0
            } else {
                pool.virtual_quote as f64 / pool.virtual_base as f64
            };
            
            let slope = pool.virtual_base as f64;
            let amount_sold = pool.total_base_sell as f64;
            
            let current_price = initial_price + slope * amount_sold;
            
            match direction {
                TradeDirection::Buy => {
                    // Need quote to get exact base
                    let in_f64 = amount_out as f64 * current_price;
                    in_f64 as u64
                },
                TradeDirection::Sell => {
                    // Need base to get exact quote
                    let in_f64 = amount_out as f64 / current_price;
                    in_f64 as u64
                }
            }
        }
    };
    
    // Calculate fees (added on top of the input amount)
    let (protocol_fee, platform_fee, share_fee) = 
        calculate_fees(gross_amount_in, protocol_fee_rate, platform_fee_rate, share_fee_rate);
    
    let total_in = gross_amount_in + protocol_fee + platform_fee + share_fee;
    
    Ok((total_in, protocol_fee, platform_fee, share_fee))
} 