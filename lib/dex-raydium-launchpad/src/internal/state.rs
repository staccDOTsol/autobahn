use anchor_lang::prelude::*;
use arrayref::{array_mut_ref, array_ref, array_refs, mut_array_refs};
use solana_program::pubkey::Pubkey;
use std::ops::Deref;

/// Represents the curve types available in Raydium Launchpad
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveType {
    ConstantProduct = 0,
    Fixed = 1,
    Linear = 2,
}

impl CurveType {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(CurveType::ConstantProduct),
            1 => Some(CurveType::Fixed),
            2 => Some(CurveType::Linear),
            _ => None,
        }
    }
}

/// Vesting schedule for tokens
#[derive(Debug, Clone)]
pub struct VestingSchedule {
    pub total_locked_amount: u64,
    pub cliff_period: u64,
    pub unlock_period: u64,
    pub start_time: u64,
    pub allocated_share_amount: u64,
}

impl VestingSchedule {
    pub const LEN: usize = 8 * 5; // 5 u64 fields

    pub fn deserialize(data: &[u8]) -> Self {
        let total_locked_amount = u64::from_le_bytes(*array_ref![data, 0, 8]);
        let cliff_period = u64::from_le_bytes(*array_ref![data, 8, 8]);
        let unlock_period = u64::from_le_bytes(*array_ref![data, 16, 8]);
        let start_time = u64::from_le_bytes(*array_ref![data, 24, 8]);
        let allocated_share_amount = u64::from_le_bytes(*array_ref![data, 32, 8]);

        Self {
            total_locked_amount,
            cliff_period,
            unlock_period,
            start_time,
            allocated_share_amount,
        }
    }
}

/// Pool state account structure for Raydium Launchpad
#[derive(Debug, Clone)]
pub struct PoolState {
    pub epoch: u64,
    pub auth_bump: u8,
    pub status: u8,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub migrate_type: u8,
    pub supply: u64,
    pub total_base_sell: u64,
    pub virtual_base: u64,
    pub virtual_quote: u64,
    pub real_base: u64,
    pub real_quote: u64,
    pub total_quote_fund_raising: u64,
    pub quote_protocol_fee: u64,
    pub platform_fee: u64,
    pub migrate_fee: u64,
    pub vesting_schedule: VestingSchedule,
    pub global_config: Pubkey,
    pub platform_config: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub creator: Pubkey,
    // padding field omitted for brevity
}

impl PoolState {
    pub fn load_checked(data: &[u8]) -> Result<Self, ProgramError> {
        // Verify account discriminator
        const DISCRIMINATOR: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
        if data.len() < 8 || data[0..8] != DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        // Skip discriminator
        let data = &data[8..];
        
        // Read single fields
        let epoch = u64::from_le_bytes(*array_ref![data, 0, 8]);
        let auth_bump = data[8];
        let status = data[9];
        let base_decimals = data[10];
        let quote_decimals = data[11];
        let migrate_type = data[12];
        
        // Padding/alignment
        let offset = 16; // Aligned to 8 bytes
        
        // Read remaining u64 fields
        let supply = u64::from_le_bytes(*array_ref![data, offset, 8]);
        let total_base_sell = u64::from_le_bytes(*array_ref![data, offset + 8, 8]);
        let virtual_base = u64::from_le_bytes(*array_ref![data, offset + 16, 8]);
        let virtual_quote = u64::from_le_bytes(*array_ref![data, offset + 24, 8]);
        let real_base = u64::from_le_bytes(*array_ref![data, offset + 32, 8]);
        let real_quote = u64::from_le_bytes(*array_ref![data, offset + 40, 8]);
        let total_quote_fund_raising = u64::from_le_bytes(*array_ref![data, offset + 48, 8]);
        let quote_protocol_fee = u64::from_le_bytes(*array_ref![data, offset + 56, 8]);
        let platform_fee = u64::from_le_bytes(*array_ref![data, offset + 64, 8]);
        let migrate_fee = u64::from_le_bytes(*array_ref![data, offset + 72, 8]);
        
        // Read vesting schedule (40 bytes)
        let vesting_schedule_data = &data[offset + 80..offset + 80 + VestingSchedule::LEN];
        let vesting_schedule = VestingSchedule::deserialize(vesting_schedule_data);
        
        // Read Pubkey fields (32 bytes each)
        let pubkey_offset = offset + 80 + VestingSchedule::LEN;
        let global_config = Pubkey::new(array_ref![data, pubkey_offset, 32]);
        let platform_config = Pubkey::new(array_ref![data, pubkey_offset + 32, 32]);
        let base_mint = Pubkey::new(array_ref![data, pubkey_offset + 64, 32]);
        let quote_mint = Pubkey::new(array_ref![data, pubkey_offset + 96, 32]);
        let base_vault = Pubkey::new(array_ref![data, pubkey_offset + 128, 32]);
        let quote_vault = Pubkey::new(array_ref![data, pubkey_offset + 160, 32]);
        let creator = Pubkey::new(array_ref![data, pubkey_offset + 192, 32]);
        
        Ok(Self {
            epoch,
            auth_bump,
            status,
            base_decimals,
            quote_decimals,
            migrate_type,
            supply,
            total_base_sell,
            virtual_base,
            virtual_quote,
            real_base,
            real_quote,
            total_quote_fund_raising,
            quote_protocol_fee,
            platform_fee,
            migrate_fee,
            vesting_schedule,
            global_config,
            platform_config,
            base_mint,
            quote_mint,
            base_vault,
            quote_vault,
            creator,
        })
    }
} 