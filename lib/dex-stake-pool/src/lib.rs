//! Real reserve-backed SPL/Sanctum LST mint/redeem edges through a hash-pinned
//! wrapped-SOL bridge. There is no listing API or fabricated reserve liquidity.
mod bridge;
mod math;

use anyhow::{bail, ensure, Context, Result};
use async_trait::async_trait;
use router_feed_lib::router_rpc_client::{RouterRpcClient, RouterRpcClientTrait};
use router_lib::dex::{
    AccountProviderView, DexEdge, DexEdgeIdentifier, DexInterface, DexSubscriptionMode, Quote,
    SwapInstruction,
};
use solana_account_decoder::UiAccountEncoding;
use solana_client::{
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, RpcFilterType},
};
use solana_sdk::{
    account::ReadableAccount,
    clock::Clock,
    pubkey::Pubkey,
    stake::{self, state::StakeStateV2},
    sysvar,
};
use spl_stake_pool::state::StakePool;
use spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::{Account as TokenAccount, AccountState, Mint},
};
use std::{
    any::Any,
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Arc,
};

pub const WSOL: Pubkey = solana_sdk::pubkey!("So11111111111111111111111111111111111111112");
pub const POOL_PROGRAMS: [Pubkey; 3] = [
    solana_sdk::pubkey!("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"),
    solana_sdk::pubkey!("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY"),
    solana_sdk::pubkey!("SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Mint,
    Redeem,
}

#[derive(Clone)]
pub struct StakePoolEdgeIdentifier {
    pub pool: Pubkey,
    pub pool_program: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub reserve: Pubkey,
    pub manager_fee: Pubkey,
    pub direction: Direction,
}

impl DexEdgeIdentifier for StakePoolEdgeIdentifier {
    fn key(&self) -> Pubkey {
        self.pool
    }
    fn desc(&self) -> String {
        format!("StakePool_{}_{:?}", self.pool, self.direction)
    }
    fn input_mint(&self) -> Pubkey {
        if self.direction == Direction::Mint {
            WSOL
        } else {
            self.mint
        }
    }
    fn output_mint(&self) -> Pubkey {
        if self.direction == Direction::Mint {
            self.mint
        } else {
            WSOL
        }
    }
    fn accounts_needed(&self) -> usize {
        if self.direction == Direction::Mint {
            17
        } else {
            15
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

struct StakePoolEdge {
    pool: StakePool,
    available_sol: u64,
}
impl DexEdge for StakePoolEdge {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct StakePoolDex {
    bridge: bridge::VerifiedBridge,
    edges: HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>>,
}

fn decode_pool(data: &[u8]) -> Result<StakePool> {
    let pool = solana_sdk::borsh0_10::try_from_slice_unchecked::<StakePool>(data)?;
    ensure!(pool.is_valid(), "account is not an initialized stake pool");
    ensure!(
        pool.token_program_id == spl_token::id() || pool.token_program_id == spl_token_2022::id(),
        "unsupported pool token program"
    );
    Ok(pool)
}

fn edge_id(id: &Arc<dyn DexEdgeIdentifier>) -> Result<&StakePoolEdgeIdentifier> {
    id.as_any()
        .downcast_ref()
        .context("wrong edge type for stake-pool adapter")
}

impl StakePoolDex {
    fn load_state(
        &self,
        id: &StakePoolEdgeIdentifier,
        chain: &AccountProviderView,
    ) -> Result<StakePoolEdge> {
        self.bridge.verify(chain)?;
        let data = chain.account(&id.pool)?;
        ensure!(
            *data.account.owner() == id.pool_program,
            "stake-pool program owner changed"
        );
        let pool = decode_pool(data.account.data())?;
        ensure!(
            pool.pool_mint == id.mint
                && pool.token_program_id == id.token_program
                && pool.reserve_stake == id.reserve
                && pool.manager_fee_account == id.manager_fee,
            "stake-pool route accounts changed; rediscovery required"
        );
        let clock: Clock =
            bincode::deserialize(chain.account(&sysvar::clock::id())?.account.data())?;
        ensure!(
            pool.last_update_epoch >= clock.epoch,
            "stake pool accounting needs an epoch update"
        );
        let (withdraw, bump) =
            Pubkey::find_program_address(&[id.pool.as_ref(), b"withdraw"], &id.pool_program);
        ensure!(
            bump == pool.stake_withdraw_bump_seed,
            "invalid stake-pool withdrawal authority"
        );
        let mint_account = chain.account(&id.mint)?;
        ensure!(
            *mint_account.account.owner() == id.token_program,
            "stake-pool mint owner mismatch"
        );
        let mint = StateWithExtensions::<Mint>::unpack(mint_account.account.data())?;
        ensure!(
            mint.base.is_initialized
                && mint.base.decimals == 9
                && mint.base.mint_authority.contains(&withdraw)
                && mint.base.freeze_authority.is_none(),
            "stake-pool mint authority or decimals mismatch"
        );
        ensure!(
            mint.get_extension_types()?.iter().all(|extension| matches!(
                extension,
                ExtensionType::TransferFeeConfig
                    | ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
            )),
            "unsupported stake-pool mint extension"
        );
        let fee_account = chain.account(&id.manager_fee)?;
        ensure!(
            *fee_account.account.owner() == id.token_program,
            "stake-pool manager fee account owner mismatch"
        );
        let fee = StateWithExtensions::<TokenAccount>::unpack(fee_account.account.data())?;
        ensure!(
            fee.base.mint == id.mint && fee.base.state == AccountState::Initialized,
            "stake-pool manager fee account is unavailable"
        );
        let reserve = chain.account(&id.reserve)?;
        ensure!(
            *reserve.account.owner() == stake::program::id(),
            "stake-pool reserve owner mismatch"
        );
        let state: StakeStateV2 = bincode::deserialize(reserve.account.data())?;
        let available_sol = match state {
            StakeStateV2::Initialized(meta) => {
                ensure!(
                    meta.authorized.withdrawer == withdraw,
                    "stake-pool reserve withdrawal authority mismatch"
                );
                reserve
                    .account
                    .lamports()
                    .checked_sub(meta.rent_exempt_reserve)
                    .context("stake reserve is below rent exemption")?
            }
            _ => bail!("stake-pool reserve is not initialized withdrawal liquidity"),
        };
        Ok(StakePoolEdge {
            pool,
            available_sol,
        })
    }
}

#[async_trait]
impl DexInterface for StakePoolDex {
    async fn initialize(
        rpc: &mut RouterRpcClient,
        options: HashMap<String, String>,
    ) -> Result<Arc<dyn DexInterface>> {
        let bridge = bridge::VerifiedBridge::initialize(
            rpc,
            options
                .get("bridge_program")
                .context("stake-pool requires bridge_program")?,
            options
                .get("bridge_program_sha256")
                .context("stake-pool requires bridge_program_sha256")?,
        )
        .await?;
        let mut pools = Vec::new();
        if let Some(selected) = options.get("pools") {
            let selected: HashSet<Pubkey> = selected
                .split(',')
                .filter(|v| !v.trim().is_empty())
                .map(|v| Pubkey::from_str(v.trim()))
                .collect::<std::result::Result<_, _>>()?;
            ensure!(!selected.is_empty(), "stake-pool pools option is empty");
            let fetched = rpc.get_multiple_accounts(&selected).await?;
            ensure!(
                fetched.len() == selected.len(),
                "a configured stake pool is missing"
            );
            for (key, account) in fetched {
                ensure!(
                    POOL_PROGRAMS.contains(&account.owner),
                    "configured pool has an unsupported owner"
                );
                pools.push((key, account.owner, decode_pool(&account.data)?));
            }
        } else {
            for program in POOL_PROGRAMS {
                let accounts = rpc
                    .get_program_accounts_with_config(
                        &program,
                        RpcProgramAccountsConfig {
                            filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
                                0,
                                vec![1],
                            ))]),
                            account_config: RpcAccountInfoConfig {
                                encoding: Some(if rpc.is_gpa_compression_enabled() {
                                    UiAccountEncoding::Base64Zstd
                                } else {
                                    UiAccountEncoding::Base64
                                }),
                                ..Default::default()
                            },
                            ..Default::default()
                        },
                    )
                    .await?;
                for account in accounts {
                    ensure!(
                        account.owner == program,
                        "stake-pool discovery owner mismatch"
                    );
                    match decode_pool(&account.data) {
                        Ok(pool) => pools.push((account.pubkey, program, pool)),
                        Err(error) => {
                            tracing::warn!(pool = %account.pubkey, %error, "stake-pool discovery rejected malformed state")
                        }
                    }
                }
            }
        }
        let mut edges: HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> = HashMap::new();
        for (key, program, pool) in pools {
            for direction in [Direction::Mint, Direction::Redeem] {
                let id = Arc::new(StakePoolEdgeIdentifier {
                    pool: key,
                    pool_program: program,
                    mint: pool.pool_mint,
                    token_program: pool.token_program_id,
                    reserve: pool.reserve_stake,
                    manager_fee: pool.manager_fee_account,
                    direction,
                }) as Arc<dyn DexEdgeIdentifier>;
                let mut dependencies = vec![
                    key,
                    pool.pool_mint,
                    pool.reserve_stake,
                    pool.manager_fee_account,
                    sysvar::clock::id(),
                    bridge.program,
                ];
                dependencies.extend(bridge.programdata);
                for account in dependencies {
                    edges.entry(account).or_default().push(id.clone());
                }
            }
        }
        ensure!(!edges.is_empty(), "no stake pools were discovered");
        Ok(Arc::new(Self { bridge, edges }))
    }
    fn name(&self) -> String {
        "StakePool".into()
    }
    fn program_ids(&self) -> HashSet<Pubkey> {
        POOL_PROGRAMS
            .into_iter()
            .chain([
                self.bridge.program,
                spl_token::id(),
                spl_token_2022::id(),
                stake::program::id(),
                solana_sdk::system_program::id(),
            ])
            .collect()
    }
    fn subscription_mode(&self) -> DexSubscriptionMode {
        DexSubscriptionMode::Accounts(self.edges.keys().copied().collect())
    }
    fn edges_per_pk(&self) -> HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> {
        self.edges.clone()
    }
    fn load(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        chain: &AccountProviderView,
    ) -> Result<Arc<dyn DexEdge>> {
        Ok(Arc::new(self.load_state(edge_id(id)?, chain)?))
    }
    fn quote(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        edge: &Arc<dyn DexEdge>,
        _chain: &AccountProviderView,
        input: u64,
    ) -> Result<Quote> {
        let id = edge_id(id)?;
        let edge = edge
            .as_any()
            .downcast_ref::<StakePoolEdge>()
            .context("wrong loaded stake-pool edge")?;
        let (out_amount, fee_amount) =
            math::exact_in(&edge.pool, id.direction, input, edge.available_sol)?;
        Ok(Quote {
            in_amount: input,
            out_amount,
            fee_amount,
            fee_mint: id.mint,
        })
    }
    fn supports_exact_out(&self, _id: &Arc<dyn DexEdgeIdentifier>) -> bool {
        false
    }
    fn quote_exact_out(
        &self,
        _id: &Arc<dyn DexEdgeIdentifier>,
        _edge: &Arc<dyn DexEdge>,
        _chain: &AccountProviderView,
        _output: u64,
    ) -> Result<Quote> {
        bail!("stake-pool adapter supports exact input only")
    }
    fn build_swap_ix(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        chain: &AccountProviderView,
        wallet: &Pubkey,
        input: u64,
        output: u64,
        slippage: i32,
    ) -> Result<SwapInstruction> {
        let id = edge_id(id)?;
        let state = self.load_state(id, chain)?;
        let (fresh_output, _) =
            math::exact_in(&state.pool, id.direction, input, state.available_sol)?;
        let minimum = math::minimum_output(output, slippage)?;
        ensure!(
            fresh_output >= minimum,
            "stake-pool quote moved beyond slippage; requote required"
        );
        let out_mint = id.output_mint();
        let out_program = if id.direction == Direction::Mint {
            id.token_program
        } else {
            spl_token::id()
        };
        Ok(SwapInstruction {
            instruction: bridge::instruction(self.bridge.program, id, *wallet, input, minimum)?,
            out_pubkey: bridge::ata(wallet, &out_mint, &out_program),
            out_mint,
            in_amount_offset: 1,
            cu_estimate: Some(if id.direction == Direction::Mint {
                180_000
            } else {
                120_000
            }),
        })
    }
}
