use crate::Direction;
use anyhow::{ensure, Context, Result};
use spl_stake_pool::state::{Fee, StakePool};

/// Current SPL/Sanctum fee application rounds UP. spl-stake-pool 1.0.0 is
/// retained for the shared Borsh state ABI, not its older floor-fee method.
/// Canonical source revisions are documented in PROVENANCE.md.
fn fee(amount: u64, fee: &Fee) -> Result<u64> {
    if fee.denominator == 0 || fee.numerator == 0 {
        return Ok(0);
    }
    ensure!(
        fee.numerator <= fee.denominator,
        "invalid stake-pool fee ratio"
    );
    let numerator = u128::from(amount) * u128::from(fee.numerator);
    let value = (numerator + u128::from(fee.denominator) - 1) / u128::from(fee.denominator);
    Ok(u64::try_from(value)?)
}

pub fn exact_in(
    pool: &StakePool,
    direction: Direction,
    input: u64,
    available_sol: u64,
) -> Result<(u64, u64)> {
    ensure!(input > 0, "stake-pool input is zero");
    let (output, charged) = match direction {
        Direction::Mint => {
            ensure!(
                pool.sol_deposit_authority.is_none(),
                "stake pool requires a SOL deposit authority"
            );
            let gross = pool
                .calc_pool_tokens_for_deposit(input)
                .context("stake-pool mint arithmetic overflow")?;
            let charged = fee(gross, &pool.sol_deposit_fee)?;
            (
                gross
                    .checked_sub(charged)
                    .context("invalid stake-pool deposit fee")?,
                charged,
            )
        }
        Direction::Redeem => {
            ensure!(
                pool.sol_withdraw_authority.is_none(),
                "stake pool requires a SOL withdrawal authority"
            );
            let charged = fee(input, &pool.sol_withdrawal_fee)?;
            let burnt = input
                .checked_sub(charged)
                .context("invalid stake-pool withdrawal fee")?;
            let output = pool
                .calc_lamports_withdraw_amount(burnt)
                .context("stake-pool redemption arithmetic overflow")?;
            ensure!(
                output <= available_sol,
                "stake-pool SOL reserve cannot cover redemption"
            );
            (output, charged)
        }
    };
    ensure!(output > 0, "stake-pool output rounds to zero");
    Ok((output, charged))
}

pub fn minimum_output(output: u64, slippage_bps: i32) -> Result<u64> {
    ensure!(
        (0..10_000).contains(&slippage_bps),
        "invalid stake-pool slippage"
    );
    Ok(u64::try_from(
        u128::from(output) * (10_000 - slippage_bps as u128) / 10_000,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pool() -> StakePool {
        StakePool {
            total_lamports: 2_000_000_000,
            pool_token_supply: 1_000_000_000,
            sol_deposit_fee: Fee {
                numerator: 1,
                denominator: 1000,
            },
            sol_withdrawal_fee: Fee {
                numerator: 2,
                denominator: 1000,
            },
            ..StakePool::default()
        }
    }
    #[test]
    fn exact_backing_and_ceil_fee_match_each_direction() {
        assert_eq!(
            exact_in(&pool(), Direction::Mint, 10_001, u64::MAX).unwrap(),
            (4_995, 5)
        );
        assert_eq!(
            exact_in(&pool(), Direction::Redeem, 1_001, u64::MAX).unwrap(),
            (1_996, 3)
        );
    }
    #[test]
    fn reserve_shortfall_zero_output_and_restricted_pools_are_errors() {
        assert!(exact_in(&pool(), Direction::Redeem, 1000, 1).is_err());
        assert!(exact_in(&pool(), Direction::Mint, 1, u64::MAX).is_err());
        let mut restricted = pool();
        restricted.sol_deposit_authority = Some(solana_sdk::pubkey::Pubkey::new_unique());
        assert!(exact_in(&restricted, Direction::Mint, 10_000, u64::MAX).is_err());
    }
    #[test]
    fn slippage_remains_exact_above_f64_integer_precision() {
        assert_eq!(
            minimum_output(u64::MAX, 1).unwrap(),
            18_444_899_399_302_180_659
        );
        assert!(minimum_output(10, -1).is_err());
        assert!(minimum_output(10, 10_000).is_err());
    }
}
