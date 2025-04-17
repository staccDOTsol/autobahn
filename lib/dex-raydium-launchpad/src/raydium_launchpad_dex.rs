use crate::constants;
use crate::internal::{TradeDirection, PoolStatus};
use crate::internal::state::PoolState;
use crate::raydium_launchpad_edge::{RaydiumLaunchpadEdge, RaydiumLaunchpadEdgeIdentifier};
use crate::raydium_launchpad_ix_builder;
use crate::REFERRAL_BPS;

use anchor_lang::Id;
use anchor_spl::token::spl_token::state::{Account, AccountState};
use anchor_spl::token::Token;
use itertools::Itertools;
use router_feed_lib::router_rpc_client::{RouterRpcClient, RouterRpcClientTrait};
use router_lib::dex::{
    AccountProviderView, DexEdge, DexEdgeIdentifier, DexInterface, DexSubscriptionMode,
    MixedDexSubscription, Quote, SwapInstruction,
};
use solana_account_decoder::UiAccountEncoding;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_client::rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType};
use solana_program::program_pack::Pack;
use solana_program::pubkey::Pubkey;
use solana_sdk::account::ReadableAccount;
use solana_sdk::commitment_config::CommitmentConfig;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::info;

/// Represents the Raydium Launchpad DEX adapter for the router
pub struct RaydiumLaunchpadDex {
    pub edges: HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>>,
}

/// Create a new RaydiumLaunchpadDex instance
pub async fn create_dex(
    rpc: &mut RouterRpcClient,
    _options: HashMap<String, String>,
) -> anyhow::Result<Arc<dyn DexInterface>> {
    let pools = fetch_launchpad_pools(rpc, crate::id()).await?;

    info!("Number of Raydium Launchpad pools: {:?}", pools.len());

    // Filter pools that are in Trade status
    let filtered_pools = pools
        .into_iter()
        .filter(|(_, pool)| PoolStatus::from_u8(pool.status).is_tradable())
        .filter(|(_, pool)| pool.base_mint != pool.quote_mint) // Filter out same token pools
        .collect_vec();

    info!(
        "Number of tradable Raydium Launchpad pools: {:?}",
        filtered_pools.len()
    );

    // Create edge pairs (buy and sell directions) for each pool
    let edge_pairs = filtered_pools
        .iter()
        .map(|(pool_pk, pool)| {
            (
                Arc::new(RaydiumLaunchpadEdgeIdentifier {
                    pool_state: *pool_pk,
                    base_mint: pool.base_mint,
                    quote_mint: pool.quote_mint,
                    is_buy: true, // buy direction (quote -> base)
                }) as Arc<dyn DexEdgeIdentifier>,
                Arc::new(RaydiumLaunchpadEdgeIdentifier {
                    pool_state: *pool_pk,
                    base_mint: pool.base_mint,
                    quote_mint: pool.quote_mint,
                    is_buy: false, // sell direction (base -> quote)
                }) as Arc<dyn DexEdgeIdentifier>,
            )
        })
        .collect_vec();

    // Map edges to relevant public keys
    let mut edges_per_pk = HashMap::new();
    for ((pool_pk, pool), (buy_edge, sell_edge)) in filtered_pools.iter().zip(edge_pairs.iter()) {
        let entry = vec![buy_edge.clone(), sell_edge.clone()];
        edges_per_pk.insert(*pool_pk, entry.clone()); // Pool state account
        edges_per_pk.insert(pool.base_vault, entry.clone()); // Base vault account
        edges_per_pk.insert(pool.quote_vault, entry.clone()); // Quote vault account
    }

    let dex = RaydiumLaunchpadDex {
        edges: edges_per_pk,
    };

    Ok(Arc::new(dex))
}

impl DexInterface for RaydiumLaunchpadDex {
    async fn initialize(
        rpc: &mut RouterRpcClient,
        options: HashMap<String, String>,
    ) -> anyhow::Result<Arc<dyn DexInterface>> {
        create_dex(rpc, options).await
    }

    fn name(&self) -> String {
        "RaydiumLaunchpad".to_string()
    }

    fn subscription_mode(&self) -> DexSubscriptionMode {
        // Track the program and all accounts related to it
        DexSubscriptionMode::Mixed(MixedDexSubscription {
            accounts: Default::default(),
            programs: HashSet::from([crate::ID]),
            token_accounts_for_owner: HashSet::new(), // We don't track specific token accounts
        })
    }

    fn program_ids(&self) -> HashSet<Pubkey> {
        [crate::id()].into_iter().collect()
    }

    fn edges_per_pk(&self) -> HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> {
        self.edges.clone()
    }

    fn load(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        chain_data: &AccountProviderView,
    ) -> anyhow::Result<Arc<dyn DexEdge>> {
        let id = id.as_any().downcast_ref::<RaydiumLaunchpadEdgeIdentifier>().unwrap();

        // Load the pool state
        let pool_account = chain_data.account(&id.pool_state)?;
        let pool_state = PoolState::load_checked(pool_account.account.data())?;
        
        // Load the token vaults
        let base_vault_account = chain_data.account(&pool_state.base_vault)?;
        let base_vault = Account::unpack(base_vault_account.account.data())?;
        
        let quote_vault_account = chain_data.account(&pool_state.quote_vault)?;
        let quote_vault = Account::unpack(quote_vault_account.account.data())?;

        Ok(Arc::new(RaydiumLaunchpadEdge {
            pool_state,
            base_vault,
            quote_vault,
        }))
    }

    fn quote(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        edge: &Arc<dyn DexEdge>,
        _chain_data: &AccountProviderView,
        in_amount: u64,
    ) -> anyhow::Result<Quote> {
        let id = id.as_any().downcast_ref::<RaydiumLaunchpadEdgeIdentifier>().unwrap();
        let edge = edge.as_any().downcast_ref::<RaydiumLaunchpadEdge>().unwrap();

        let pool = &edge.pool_state;
        let base_vault = &edge.base_vault;
        let quote_vault = &edge.quote_vault;

        // Check if vaults are frozen (unusable)
        let base_vault_is_frozen = base_vault.state == AccountState::Frozen;
        let quote_vault_is_frozen = quote_vault.state == AccountState::Frozen;

        if base_vault_is_frozen || quote_vault_is_frozen {
            return Ok(Quote {
                in_amount,
                out_amount: 0,
                fee_amount: 0,
                fee_mint: Default::default(),
            });
        }

        // Use the referral BPS for share fee rate
        let share_fee_rate = REFERRAL_BPS;
        
        // Determine trade direction
        let direction = if id.is_buy {
            TradeDirection::Buy
        } else {
            TradeDirection::Sell
        };

        // Simulate the swap to get output amount and fees
        let (out_amount, protocol_fee, platform_fee, share_fee) = 
            crate::internal::processor::simulate_swap_exact_in(
                pool, 
                base_vault, 
                quote_vault, 
                direction, 
                in_amount,
                share_fee_rate,
            )?;

        let total_fee = protocol_fee + platform_fee + share_fee;
        let fee_mint = if id.is_buy {
            pool.quote_mint
        } else {
            pool.base_mint
        };

        // If the pool is not in trade status, return 0 output
        if !PoolStatus::from_u8(pool.status).is_tradable() {
            Ok(Quote {
                in_amount,
                out_amount: 0,
                fee_amount: total_fee,
                fee_mint,
            })
        } else {
            Ok(Quote {
                in_amount,
                out_amount,
                fee_amount: total_fee,
                fee_mint,
            })
        }
    }

    fn build_swap_ix(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        chain_data: &AccountProviderView,
        wallet_pk: &Pubkey,
        in_amount: u64,
        out_amount: u64,
        max_slippage_bps: i32,
    ) -> anyhow::Result<SwapInstruction> {
        let id = id.as_any().downcast_ref::<RaydiumLaunchpadEdgeIdentifier>().unwrap();
        raydium_launchpad_ix_builder::build_swap_ix(
            id,
            chain_data,
            wallet_pk,
            in_amount,
            out_amount,
            max_slippage_bps,
        )
    }

    fn supports_exact_out(&self, _id: &Arc<dyn DexEdgeIdentifier>) -> bool {
        true // Raydium Launchpad supports exact out swaps
    }

    fn quote_exact_out(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        edge: &Arc<dyn DexEdge>,
        _chain_data: &AccountProviderView,
        out_amount: u64,
    ) -> anyhow::Result<Quote> {
        let id = id.as_any().downcast_ref::<RaydiumLaunchpadEdgeIdentifier>().unwrap();
        let edge = edge.as_any().downcast_ref::<RaydiumLaunchpadEdge>().unwrap();

        let pool = &edge.pool_state;
        let base_vault = &edge.base_vault;
        let quote_vault = &edge.quote_vault;

        // Use the referral BPS for share fee rate
        let share_fee_rate = REFERRAL_BPS;
        
        // Determine trade direction
        let direction = if id.is_buy {
            TradeDirection::Buy
        } else {
            TradeDirection::Sell
        };

        // Simulate the swap to get input amount and fees
        let (in_amount, protocol_fee, platform_fee, share_fee) = 
            crate::internal::processor::simulate_swap_exact_out(
                pool, 
                base_vault, 
                quote_vault, 
                direction, 
                out_amount,
                share_fee_rate,
            )?;

        let total_fee = protocol_fee + platform_fee + share_fee;
        let fee_mint = if id.is_buy {
            pool.quote_mint
        } else {
            pool.base_mint
        };

        // If the pool is not in trade status, return 0 output
        if !PoolStatus::from_u8(pool.status).is_tradable() {
            Ok(Quote {
                in_amount,
                out_amount: 0,
                fee_amount: total_fee,
                fee_mint,
            })
        } else {
            Ok(Quote {
                in_amount,
                out_amount,
                fee_amount: total_fee,
                fee_mint,
            })
        }
    }
}

/// Fetch all Raydium Launchpad pool accounts
async fn fetch_launchpad_pools(
    rpc: &mut RouterRpcClient,
    program_id: Pubkey,
) -> anyhow::Result<Vec<(Pubkey, PoolState)>> {
    // Pool state discriminator from IDL: [247, 237, 227, 245, 215, 195, 222, 70]
    let pool_discriminator = [247, 237, 227, 245, 215, 195, 222, 70];
    
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            // Filter by discriminator to get only PoolState accounts
            RpcFilterType::Memcmp(Memcmp {
                offset: 0,
                bytes: MemcmpEncodedBytes::Bytes(pool_discriminator.to_vec()),
                encoding: None,
            }),
        ]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::finalized()),
            ..Default::default()
        },
        ..Default::default()
    };

    let snapshot = rpc
        .get_program_accounts_with_config(&program_id, config)
        .await?;

    let result = snapshot
        .iter()
        .filter_map(|account| {
            let pool = PoolState::load_checked(account.data.as_slice());
            pool.ok().map(|x| (account.pubkey, x))
        })
        .collect_vec();

    Ok(result)
} 