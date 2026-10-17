//! Router platform fee: 10 bps of every swap the router builds, paid in kind
//! to the fee owner's associated token account for the fee mint.
//! `tools/fee-burn` sweeps those balances into FR28 and burns them.
//!
//! Classic SPL fees go through the Autobahn executor's `ChargeFees`, which
//! logs a `PlatformFeeLog`. The deployed executor's `ChargeFeesV2` omits the
//! authority and mint from its CPI and fails with `MissingAccount` on mainnet,
//! so Token-2022 fees are a direct `TransferChecked` instead.

use crate::routing_types::Route;
use anchor_lang::Id;
use anchor_spl::token::Token;
use anyhow::Context;
use router_lib::dex::SwapMode;
use router_lib::model::quote_response::QuoteResponse;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey;
use solana_program::pubkey::Pubkey;
use spl_associated_token_account::get_associated_token_address_with_program_id;

pub const FEE_BPS: u64 = 10;
const BPS_DENOMINATOR: u64 = 10_000;

/// Dedicated fee wallet. It must hold nothing but fees: `tools/fee-burn`
/// converts every token balance it owns into FR28 and burns it.
pub const FEE_OWNER: Pubkey = pubkey!("Gp6tbJ5pLZfez5xGG42tCqvzf37AdUELyo9amS8mTLdz");

/// Ignore the executor's referrer split; the platform keeps the whole fee.
const PLATFORM_FEE_PERCENT: u8 = 100;
const TOKEN_TRANSFER_CHECKED: u8 = 12;
pub const FEE_CU_ESTIMATE: u32 = 30_000;

/// Fees collect in these whenever one side of a swap is one of them, so the
/// burn crank mostly starts from deep SOL and stablecoin markets.
const PREFERRED_FEE_MINTS: [Pubkey; 3] = [
    pubkey!("So11111111111111111111111111111111111111112"),
    pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeeSide {
    Input,
    Output,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeeLeg {
    pub side: FeeSide,
    pub mint: Pubkey,
    pub amount: u64,
}

/// Exact-input swaps pay on output when only the output is SOL, USDC or USDT;
/// everything else, including every exact-output swap, pays on input.
pub fn fee_side(input_mint: &Pubkey, output_mint: &Pubkey, mode: SwapMode) -> FeeSide {
    let preferred = |mint: &Pubkey| PREFERRED_FEE_MINTS.contains(mint);
    match mode {
        SwapMode::ExactIn if preferred(output_mint) && !preferred(input_mint) => FeeSide::Output,
        _ => FeeSide::Input,
    }
}

/// 10 bps of a gross amount, rounded down.
pub fn fee_of(gross: u64) -> u64 {
    (u128::from(gross) * u128::from(FEE_BPS) / u128::from(BPS_DENOMINATOR)) as u64
}

/// The amount to add to `net` so the addition is 10 bps of the total, rounded up.
pub fn fee_on_top(net: u64) -> anyhow::Result<u64> {
    let kept = u128::from(BPS_DENOMINATOR - FEE_BPS);
    let fee = (u128::from(net) * u128::from(FEE_BPS) + kept - 1) / kept;
    u64::try_from(fee).context("Fee exceeds token amount range")
}

/// What the hops route for a request of `amount`: exact-input swaps paying on
/// input route the amount after the fee; otherwise the request itself.
pub fn route_amount(side: FeeSide, mode: SwapMode, amount: u64) -> u64 {
    match (mode, side) {
        (SwapMode::ExactIn, FeeSide::Input) => amount - fee_of(amount),
        _ => amount,
    }
}

/// The fee for a quoted (or freshly re-quoted) route. `requested` is the
/// user's exact amount: the gross input for exact-in, the output for exact-out.
pub fn leg(
    side: FeeSide,
    mode: SwapMode,
    requested: u64,
    route: &Route,
) -> anyhow::Result<FeeLeg> {
    let (mint, amount) = match (mode, side) {
        (SwapMode::ExactIn, FeeSide::Input) => (route.input_mint, fee_of(requested)),
        (SwapMode::ExactIn, FeeSide::Output) => (route.output_mint, fee_of(route.out_amount)),
        (SwapMode::ExactOut, _) => (route.input_mint, fee_on_top(route.in_amount)?),
    };
    Ok(FeeLeg { side, mint, amount })
}

/// What the user spends and receives once the fee is taken.
pub fn user_amounts(route: &Route, fee: &FeeLeg) -> anyhow::Result<(u64, u64)> {
    match fee.side {
        FeeSide::Input => Ok((
            route
                .in_amount
                .checked_add(fee.amount)
                .context("Fee exceeds token amount range")?,
            route.out_amount,
        )),
        FeeSide::Output => Ok((
            route.in_amount,
            route
                .out_amount
                .checked_sub(fee.amount)
                .context("Fee exceeds route output")?,
        )),
    }
}

/// A client quote describes user amounts. Rewrite it to the hop amounts the
/// route providers check against the route plan. The exact-input hop amount is
/// derived from the user's gross input, never read from the plan, so a client
/// cannot shrink the fee by editing the quote.
pub fn hop_quote(quote: &QuoteResponse, side: FeeSide, mode: SwapMode) -> anyhow::Result<QuoteResponse> {
    let hop = |index: usize| {
        quote
            .route_plan
            .get(index)
            .and_then(|plan| plan.swap_info.as_ref())
            .context("Quote has no route")
    };
    let mut hops = quote.clone();
    match (mode, side) {
        (SwapMode::ExactIn, FeeSide::Input) => {
            let gross: u64 = quote.in_amount.as_ref().context("missing input")?.parse()?;
            hops.in_amount = Some(route_amount(side, mode, gross).to_string());
        }
        (SwapMode::ExactIn, FeeSide::Output) => {
            hops.out_amount = hop(quote.route_plan.len().saturating_sub(1))?.out_amount.clone();
        }
        (SwapMode::ExactOut, _) => {
            hops.in_amount = Some(hop(0)?.in_amount.clone());
        }
    }
    hops.platform_fee = None;
    Ok(hops)
}

pub fn fee_account(mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&FEE_OWNER, mint, token_program)
}

/// Creates the fee account when missing (the swapper pays its rent once per
/// mint) and moves the fee from `source` into it.
pub fn instructions(
    wallet: &Pubkey,
    source: &Pubkey,
    fee: &FeeLeg,
    token_program: &Pubkey,
    decimals: impl FnOnce() -> anyhow::Result<u8>,
) -> anyhow::Result<[Instruction; 2]> {
    let vault = fee_account(&fee.mint, token_program);
    let create = spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        wallet,
        &FEE_OWNER,
        &fee.mint,
        token_program,
    );
    let charge = if *token_program == Token::id() {
        let mut data = vec![autobahn_executor::Instructions::ChargeFees as u8];
        data.extend_from_slice(&fee.amount.to_le_bytes());
        data.push(PLATFORM_FEE_PERCENT);
        Instruction {
            program_id: autobahn_executor::id(),
            accounts: vec![
                AccountMeta::new_readonly(*token_program, false),
                AccountMeta::new(*source, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(*wallet, true),
            ],
            data,
        }
    } else {
        let mut data = vec![TOKEN_TRANSFER_CHECKED];
        data.extend_from_slice(&fee.amount.to_le_bytes());
        data.push(decimals()?);
        Instruction {
            program_id: *token_program,
            accounts: vec![
                AccountMeta::new(*source, false),
                AccountMeta::new_readonly(fee.mint, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(*wallet, true),
            ],
            data,
        }
    };
    Ok([create, charge])
}

#[cfg(test)]
mod tests {
    use super::*;
    use router_lib::model::quote_response::{RoutePlan, SwapInfo};

    const SOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
    const USDC: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

    #[test]
    fn fee_is_ten_bps_rounded_in_the_users_favor() {
        assert_eq!(fee_of(1_000_000_000), 1_000_000);
        assert_eq!(fee_of(999), 0);
        assert_eq!(fee_of(u64::MAX), (u128::from(u64::MAX) * 10 / 10_000) as u64);
        assert_eq!(fee_on_top(9_990).unwrap(), 10);
        assert_eq!(fee_on_top(9_991).unwrap(), 11);
        let net = 123_456_789;
        let fee = fee_on_top(net).unwrap();
        assert!(fee_of(net + fee) <= fee && fee <= fee_of(net + fee) + 1);
    }

    #[test]
    fn fees_collect_in_sol_and_stables_when_either_side_allows() {
        let memecoin = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert_eq!(fee_side(&SOL, &memecoin, SwapMode::ExactIn), FeeSide::Input);
        assert_eq!(fee_side(&memecoin, &SOL, SwapMode::ExactIn), FeeSide::Output);
        assert_eq!(fee_side(&memecoin, &USDC, SwapMode::ExactIn), FeeSide::Output);
        assert_eq!(fee_side(&USDC, &SOL, SwapMode::ExactIn), FeeSide::Input);
        assert_eq!(fee_side(&memecoin, &other, SwapMode::ExactIn), FeeSide::Input);
        assert_eq!(fee_side(&memecoin, &SOL, SwapMode::ExactOut), FeeSide::Input);
    }

    fn quote(in_amount: &str, first_in: &str, last_out: &str, out_amount: &str) -> QuoteResponse {
        let info = |input: &str, output: &str| SwapInfo {
            amm_key: Pubkey::new_unique().to_string(),
            label: None,
            input_mint: Pubkey::new_unique().to_string(),
            output_mint: Pubkey::new_unique().to_string(),
            in_amount: input.to_string(),
            out_amount: output.to_string(),
            fee_amount: "0".to_string(),
            fee_mint: Pubkey::new_unique().to_string(),
        };
        QuoteResponse {
            input_mint: SOL.to_string(),
            in_amount: Some(in_amount.to_string()),
            output_mint: USDC.to_string(),
            out_amount: out_amount.to_string(),
            other_amount_threshold: "1".to_string(),
            swap_mode: "ExactIn".to_string(),
            slippage_bps: 50,
            platform_fee: None,
            price_impact_pct: None,
            route_plan: vec![
                RoutePlan { percent: 100, swap_info: Some(info(first_in, "7")) },
                RoutePlan { percent: 100, swap_info: Some(info("7", last_out)) },
            ],
            accounts: None,
            context_slot: 1,
            time_taken: 0.0,
        }
    }

    #[test]
    fn hop_quote_derives_the_input_hop_amount_from_the_gross_input() {
        // A client that edits the plan to route its whole input still routes 99.9%.
        let edited = quote("1000000", "1000000", "500", "500");
        let hops = hop_quote(&edited, FeeSide::Input, SwapMode::ExactIn).unwrap();
        assert_eq!(hops.in_amount.as_deref(), Some("999000"));
        assert_eq!(hops.out_amount, "500");
        assert!(hops.platform_fee.is_none());
    }

    #[test]
    fn hop_quote_restores_gross_output_and_exact_out_hop_input() {
        let output_side = quote("1000000", "1000000", "500000", "499500");
        let hops = hop_quote(&output_side, FeeSide::Output, SwapMode::ExactIn).unwrap();
        assert_eq!(hops.in_amount.as_deref(), Some("1000000"));
        assert_eq!(hops.out_amount, "500000");
        let exact_out = quote("1001001", "1000000", "500000", "500000");
        let hops = hop_quote(&exact_out, FeeSide::Input, SwapMode::ExactOut).unwrap();
        assert_eq!(hops.in_amount.as_deref(), Some("1000000"));
    }

    #[test]
    fn classic_fees_use_the_executor_and_token_2022_fees_transfer_checked() {
        let wallet = Pubkey::new_unique();
        let source = Pubkey::new_unique();
        let fee = FeeLeg { side: FeeSide::Input, mint: USDC, amount: 1_000 };
        let [create, charge] =
            instructions(&wallet, &source, &fee, &Token::id(), || unreachable!()).unwrap();
        let vault = fee_account(&USDC, &Token::id());
        assert_eq!(create.program_id, spl_associated_token_account::id());
        assert!(create.accounts.iter().any(|meta| meta.pubkey == vault));
        assert!(create.accounts.iter().any(|meta| meta.pubkey == FEE_OWNER));
        assert_eq!(charge.program_id, autobahn_executor::id());
        assert_eq!(charge.data, [&[4u8][..], &1_000u64.to_le_bytes(), &[100]].concat());
        assert_eq!(
            charge.accounts.iter().map(|meta| meta.pubkey).collect::<Vec<_>>(),
            vec![Token::id(), source, vault, wallet]
        );
        assert!(charge.accounts[3].is_signer);

        let token_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        let mint = Pubkey::new_unique();
        let fee = FeeLeg { side: FeeSide::Output, mint, amount: 77 };
        let [_, charge] = instructions(&wallet, &source, &fee, &token_2022, || Ok(6)).unwrap();
        let vault = fee_account(&mint, &token_2022);
        assert_ne!(vault, fee_account(&mint, &Token::id()));
        assert_eq!(charge.program_id, token_2022);
        assert_eq!(charge.data, [&[12u8][..], &77u64.to_le_bytes(), &[6]].concat());
        assert_eq!(
            charge.accounts.iter().map(|meta| meta.pubkey).collect::<Vec<_>>(),
            vec![source, mint, vault, wallet]
        );
    }
}
