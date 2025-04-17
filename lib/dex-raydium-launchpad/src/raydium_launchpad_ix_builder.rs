use crate::constants;
use crate::internal::state::PoolState;
use crate::raydium_launchpad_edge::RaydiumLaunchpadEdgeIdentifier;
use crate::{REFERRAL_ACCOUNT, REFERRAL_BPS};

use anchor_lang::Id;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::Token;
use router_lib::dex::{AccountProviderView, SwapInstruction};
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use solana_sdk::account::ReadableAccount;

/// Builds a buy_exact_in instruction for Raydium Launchpad
pub fn build_buy_exact_in_ix(
    id: &RaydiumLaunchpadEdgeIdentifier,
    chain_data: &AccountProviderView,
    wallet_pk: &Pubkey,
    amount_in: u64,
    out_amount: u64,
    max_slippage_bps: i32,
    share_fee_rate: u64,
) -> anyhow::Result<SwapInstruction> {
    let pool_account = chain_data.account(&id.pool_state)?;
    let pool = PoolState::load_checked(pool_account.account.data())?;
    
    let minimum_amount_out =
        ((out_amount as f64 * (10_000f64 - max_slippage_bps as f64)) / 10_000f64).floor() as u64;
    
    // Token accounts for wallet
    let quote_token_account = get_associated_token_address(wallet_pk, &pool.quote_mint);
    let base_token_account = get_associated_token_address(wallet_pk, &pool.base_mint);
    
    // PDA for authority
    let authority = Pubkey::find_program_address(
        &[constants::VAULT_AUTH_SEED],
        &crate::ID,
    ).0;
    
    // Build buy_exact_in instruction data
    let discriminator: [u8; 8] = [250, 234, 13, 123, 213, 156, 19, 236]; // buy_exact_in discriminator
    let expected_size = 8 + 8 + 8 + 8; // discriminator + amount_in + minimum_amount_out + share_fee_rate
    
    let mut data = Vec::with_capacity(expected_size);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());
    data.extend_from_slice(&REFERRAL_BPS.to_le_bytes()); // Use the referral BPS instead of share_fee_rate
    
    // Event authority PDA
    let event_authority = Pubkey::find_program_address(
        &[constants::EVENT_AUTHORITY_SEED],
        &crate::ID,
    ).0;
    
    // Build instruction with accounts in order required by the program
    let result = SwapInstruction {
        instruction: Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(*wallet_pk, true), // payer
                AccountMeta::new_readonly(authority, false), // authority
                AccountMeta::new_readonly(pool.global_config, false), // global_config
                AccountMeta::new_readonly(pool.platform_config, false), // platform_config
                AccountMeta::new(id.pool_state, false), // pool_state
                AccountMeta::new(base_token_account, false), // user_base_token
                AccountMeta::new(quote_token_account, false), // user_quote_token
                AccountMeta::new(pool.base_vault, false), // base_vault
                AccountMeta::new(pool.quote_vault, false), // quote_vault
                AccountMeta::new_readonly(pool.base_mint, false), // base_token_mint
                AccountMeta::new_readonly(pool.quote_mint, false), // quote_token_mint
                AccountMeta::new_readonly(Token::id(), false), // base_token_program
                AccountMeta::new_readonly(Token::id(), false), // quote_token_program
                AccountMeta::new_readonly(event_authority, false), // event_authority
                AccountMeta::new_readonly(crate::ID, false), // program
                AccountMeta::new_readonly(REFERRAL_ACCOUNT, false), // always use our referral account
            ],
            data,
        },
        out_pubkey: base_token_account, // The token account receiving the output tokens
        out_mint: pool.base_mint, // The mint of the output tokens
        in_amount_offset: 8, // Offset in instruction data where the input amount is stored (after discriminator)
        cu_estimate: Some(250_000), // Estimated compute units
    };
    
    Ok(result)
}

/// Builds a sell_exact_in instruction for Raydium Launchpad
pub fn build_sell_exact_in_ix(
    id: &RaydiumLaunchpadEdgeIdentifier,
    chain_data: &AccountProviderView,
    wallet_pk: &Pubkey,
    amount_in: u64,
    out_amount: u64,
    max_slippage_bps: i32,
    share_fee_rate: u64,
) -> anyhow::Result<SwapInstruction> {
    let pool_account = chain_data.account(&id.pool_state)?;
    let pool = PoolState::load_checked(pool_account.account.data())?;
    
    let minimum_amount_out =
        ((out_amount as f64 * (10_000f64 - max_slippage_bps as f64)) / 10_000f64).floor() as u64;
    
    // Token accounts for wallet
    let quote_token_account = get_associated_token_address(wallet_pk, &pool.quote_mint);
    let base_token_account = get_associated_token_address(wallet_pk, &pool.base_mint);
    
    // PDA for authority
    let authority = Pubkey::find_program_address(
        &[constants::VAULT_AUTH_SEED],
        &crate::ID,
    ).0;
    
    // Build sell_exact_in instruction data
    let discriminator: [u8; 8] = [149, 39, 222, 155, 211, 124, 152, 26]; // sell_exact_in discriminator
    let expected_size = 8 + 8 + 8 + 8; // discriminator + amount_in + minimum_amount_out + share_fee_rate
    
    let mut data = Vec::with_capacity(expected_size);
    data.extend_from_slice(&discriminator);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());
    data.extend_from_slice(&REFERRAL_BPS.to_le_bytes()); // Use the referral BPS instead of share_fee_rate
    
    // Event authority PDA
    let event_authority = Pubkey::find_program_address(
        &[constants::EVENT_AUTHORITY_SEED],
        &crate::ID,
    ).0;
    
    // Build instruction with accounts in order required by the program
    let result = SwapInstruction {
        instruction: Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(*wallet_pk, true), // payer
                AccountMeta::new_readonly(authority, false), // authority
                AccountMeta::new_readonly(pool.global_config, false), // global_config
                AccountMeta::new_readonly(pool.platform_config, false), // platform_config
                AccountMeta::new(id.pool_state, false), // pool_state
                AccountMeta::new(base_token_account, false), // user_base_token
                AccountMeta::new(quote_token_account, false), // user_quote_token
                AccountMeta::new(pool.base_vault, false), // base_vault
                AccountMeta::new(pool.quote_vault, false), // quote_vault
                AccountMeta::new_readonly(pool.base_mint, false), // base_token_mint
                AccountMeta::new_readonly(pool.quote_mint, false), // quote_token_mint
                AccountMeta::new_readonly(Token::id(), false), // base_token_program
                AccountMeta::new_readonly(Token::id(), false), // quote_token_program
                AccountMeta::new_readonly(event_authority, false), // event_authority
                AccountMeta::new_readonly(crate::ID, false), // program
                AccountMeta::new_readonly(REFERRAL_ACCOUNT, false), // always use our referral account
            ],
            data,
        },
        out_pubkey: quote_token_account, // The token account receiving the output tokens
        out_mint: pool.quote_mint, // The mint of the output tokens
        in_amount_offset: 8, // Offset in instruction data where the input amount is stored (after discriminator)
        cu_estimate: Some(250_000), // Estimated compute units
    };
    
    Ok(result)
}

/// Builds a swap instruction based on the edge type
pub fn build_swap_ix(
    id: &RaydiumLaunchpadEdgeIdentifier,
    chain_data: &AccountProviderView,
    wallet_pk: &Pubkey,
    amount_in: u64,
    out_amount: u64,
    max_slippage_bps: i32,
) -> anyhow::Result<SwapInstruction> {
    // We'll use our referral fee rate instead of default 0
    let share_fee_rate = REFERRAL_BPS;
    
    if id.is_buy {
        build_buy_exact_in_ix(id, chain_data, wallet_pk, amount_in, out_amount, max_slippage_bps, share_fee_rate)
    } else {
        build_sell_exact_in_ix(id, chain_data, wallet_pk, amount_in, out_amount, max_slippage_bps, share_fee_rate)
    }
} 