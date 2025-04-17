mod internal;
mod raydium_launchpad_dex;
mod raydium_launchpad_edge;
mod raydium_launchpad_ix_builder;

use std::collections::HashMap;
use std::sync::Arc;

use router_feed_lib::router_rpc_client::RouterRpcClient;
use router_lib::dex::DexInterface;
use solana_program::pubkey::Pubkey;

// Raydium Launchpad program ID
pub const ID: Pubkey = Pubkey::new_from_array([
    5,   4,  59, 149,  77, 202,  38, 225,
  239, 145, 181,  44,  79, 143, 137, 175,
  138, 111,  90, 200, 198,  33,  86, 241,
  113, 207,  15,  33, 172,  81, 201,  34
]);

// Referral account and basis points
pub const REFERRAL_ACCOUNT: Pubkey = Pubkey::new_from_array([
    86, 149,   6, 130, 241, 147,  19, 241,
   238,  97, 198,  67, 192,  90, 201,  72,
    32, 125,  34, 139,  11, 159,  30,  63,
    84, 125,  10, 166, 144, 186, 167,  58
 ]);
pub const REFERRAL_BPS: u64 = 1000; // 10%

pub fn id() -> Pubkey {
    ID
}

// Create a Raydium Launchpad DEX integration
pub async fn create_raydium_launchpad_dex(
    rpc: &mut RouterRpcClient,
    options: HashMap<String, String>,
) -> anyhow::Result<Arc<dyn DexInterface>> {
    raydium_launchpad_dex::create_dex(rpc, options).await
}

// Authority seed constants
pub mod constants {
    // The seeds used for PDAs
    pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth_seed";
    pub const POOL_SEED: &[u8] = b"pool";
    pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
    pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";
} 