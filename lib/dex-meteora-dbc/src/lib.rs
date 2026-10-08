//! Meteora's arbitrary-quote, pre-migration bonding curves. The pinned MIT SDK
//! performs the actual quote math and Anchor instruction encoding offline.
mod discovery;
mod worker;

use anyhow::{Context, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use discovery::DiscoveryWalk;
use router_feed_lib::router_rpc_client::{RouterRpcClient, RouterRpcClientTrait};
use router_lib::dex::{
    AccountProviderView, DexEdge, DexEdgeIdentifier, DexInterface, DexSubscriptionMode,
    Quote, SwapInstruction,
};
use serde::Deserialize;
use serde_json::{json, Value};
use solana_account_decoder::UiAccountEncoding;
use solana_client::{
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    rpc_filter::{Memcmp, RpcFilterType},
};
use solana_sdk::{
    account::ReadableAccount,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    sysvar::SysvarId,
};
use std::{
    any::Any,
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Arc,
};
use worker::Engine;

pub const PROGRAM_ID: Pubkey = solana_sdk::pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoolIdentity {
    #[serde(deserialize_with = "public_key")]
    config: Pubkey,
    #[serde(deserialize_with = "public_key")]
    base_mint: Pubkey,
    #[serde(deserialize_with = "public_key")]
    base_vault: Pubkey,
    #[serde(deserialize_with = "public_key")]
    quote_vault: Pubkey,
    migrated: bool,
}

fn public_key<'de, D: serde::Deserializer<'de>>(
    decoder: D,
) -> std::result::Result<Pubkey, D::Error> {
    Pubkey::from_str(&String::deserialize(decoder)?).map_err(serde::de::Error::custom)
}

async fn fetch_pools(
    rpc: &mut RouterRpcClient,
    base: Option<Pubkey>,
) -> Result<Vec<(Pubkey, Pubkey, Vec<u8>)>> {
    let mut filters = vec![RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
        0,
        POOL_DISCRIMINATOR.to_vec(),
    ))];
    if let Some(mint) = base {
        // MIT SDK VirtualPool IDL: discriminator8 + VolatilityTracker64 +
        // config32 + creator32. The public fixture asserts this offset.
        filters.push(RpcFilterType::Memcmp(Memcmp::new_raw_bytes(
            136,
            mint.to_bytes().to_vec(),
        )));
    }
    Ok(rpc
        .get_program_accounts_with_config(
            &PROGRAM_ID,
            RpcProgramAccountsConfig {
                filters: Some(filters),
                account_config: RpcAccountInfoConfig {
                    encoding: Some(UiAccountEncoding::Base64),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .await?
        .into_iter()
        .map(|a| (a.pubkey, a.owner, a.data))
        .collect())
}

fn decode_identities(
    engine: &Engine,
    pools: &[(Pubkey, Pubkey, Vec<u8>)],
) -> Result<Vec<(Pubkey, PoolIdentity)>> {
    let mut identities = Vec::new();
    for chunk in pools.chunks(100) {
        let valid: Vec<_> = chunk
            .iter()
            .filter(|(_, owner, _)| *owner == PROGRAM_ID)
            .collect();
        let data: Vec<_> = valid
            .iter()
            .map(|(_, _, data)| BASE64.encode(data))
            .collect();
        let result = engine.call(json!({"op": "inspectPools", "data": data}))?;
        let decoded = result.as_array().context("Invalid DBC batch decode")?;
        anyhow::ensure!(decoded.len() == valid.len(), "Incomplete DBC batch decode");
        for ((pool, _, _), value) in valid.into_iter().zip(decoded) {
            match serde_json::from_value::<PoolIdentity>(value.clone()) {
                Ok(identity) if !identity.migrated => identities.push((*pool, identity)),
                Ok(_) => {}
                Err(error) => tracing::warn!(%pool, %error, "Cannot decode DBC pool"),
            }
        }
    }
    Ok(identities)
}

async fn load_quotes(
    rpc: &mut RouterRpcClient,
    engine: &Engine,
    keys: HashSet<Pubkey>,
) -> Result<HashMap<Pubkey, Pubkey>> {
    let mut quotes = HashMap::new();
    let keys: Vec<_> = keys.into_iter().collect();
    for chunk in keys.chunks(100) {
        for (key, config) in rpc
            .get_multiple_accounts(&chunk.iter().copied().collect())
            .await?
        {
            if config.owner != PROGRAM_ID {
                continue;
            }
            let result =
                engine.call(json!({"op": "inspectConfig", "data": BASE64.encode(config.data)}));
            if let Ok(result) = result {
                if let Some(quote) = result["quoteMint"]
                    .as_str()
                    .and_then(|s| Pubkey::from_str(s).ok())
                {
                    quotes.insert(key, quote);
                }
            }
        }
    }
    Ok(quotes)
}

#[derive(Clone)]
pub struct MeteoraDbcEdgeIdentifier {
    pub pool: Pubkey,
    identity: PoolIdentity,
    quote_mint: Pubkey,
    base_to_quote: bool,
}
impl DexEdgeIdentifier for MeteoraDbcEdgeIdentifier {
    fn key(&self) -> Pubkey {
        self.pool
    }
    fn desc(&self) -> String {
        format!(
            "MeteoraDBC {} {}->{}",
            self.pool,
            self.input_mint(),
            self.output_mint()
        )
    }
    fn input_mint(&self) -> Pubkey {
        if self.base_to_quote {
            self.identity.base_mint
        } else {
            self.quote_mint
        }
    }
    fn output_mint(&self) -> Pubkey {
        if self.base_to_quote {
            self.quote_mint
        } else {
            self.identity.base_mint
        }
    }
    fn accounts_needed(&self) -> usize {
        13
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
struct MeteoraDbcEdge {
    request: Value,
}
impl DexEdge for MeteoraDbcEdge {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct MeteoraDbcDex {
    engine: Arc<Engine>,
    edges: HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>>,
    accounts: HashSet<Pubkey>,
}

impl MeteoraDbcDex {
    fn identifier(id: &Arc<dyn DexEdgeIdentifier>) -> Result<&MeteoraDbcEdgeIdentifier> {
        id.as_any()
            .downcast_ref()
            .context("Incorrect DBC edge identifier")
    }

    fn request(id: &MeteoraDbcEdgeIdentifier, provider: &AccountProviderView) -> Result<Value> {
        let pool = provider.account(&id.pool)?;
        let config = provider.account(&id.identity.config)?;
        anyhow::ensure!(
            *pool.account.owner() == PROGRAM_ID && *config.account.owner() == PROGRAM_ID,
            "DBC pool/config owner mismatch"
        );
        let clock = provider.account(&Clock::id())?;
        let clock = clock.account.deserialize_data::<Clock>()?;
        anyhow::ensure!(clock.unix_timestamp >= 0, "Invalid Clock timestamp");
        let token = |address: &Pubkey| -> Result<Value> {
            let account = provider.account(address)?;
            Ok(
                json!({ "data": BASE64.encode(account.account.data()), "owner": account.account.owner().to_string() }),
            )
        };
        Ok(json!({
            "pool": id.pool.to_string(), "config": id.identity.config.to_string(),
            "poolData": BASE64.encode(pool.account.data()), "configData": BASE64.encode(config.account.data()),
            "baseMint": id.identity.base_mint.to_string(), "quoteMint": id.quote_mint.to_string(),
            "baseToQuote": id.base_to_quote,
            "baseAccount": token(&id.identity.base_mint)?, "quoteAccount": token(&id.quote_mint)?,
            "baseVaultAccount": token(&id.identity.base_vault)?, "quoteVaultAccount": token(&id.identity.quote_vault)?,
            "slot": clock.slot.to_string(), "timestamp": clock.unix_timestamp.to_string()
        }))
    }

    fn quote_inner(&self, edge: &Arc<dyn DexEdge>, amount: u64, exact_out: bool) -> Result<Quote> {
        let edge = edge
            .as_any()
            .downcast_ref::<MeteoraDbcEdge>()
            .context("Incorrect DBC edge")?;
        let mut request = edge.request.clone();
        request["op"] = json!("quote");
        request["amount"] = json!(amount.to_string());
        request["exactOut"] = json!(exact_out);
        let quote = self.engine.call(request)?;
        let amount = |name| -> Result<u64> {
            Ok(quote[name]
                .as_str()
                .context("Missing DBC quote amount")?
                .parse()?)
        };
        Ok(Quote {
            in_amount: amount("inAmount")?,
            out_amount: amount("outAmount")?,
            fee_amount: amount("feeAmount")?,
            fee_mint: Pubkey::from_str(quote["feeMint"].as_str().context("Missing DBC fee mint")?)?,
        })
    }
}

#[async_trait]
impl DexInterface for MeteoraDbcDex {
    async fn initialize(
        rpc: &mut RouterRpcClient,
        options: HashMap<String, String>,
    ) -> Result<Arc<dyn DexInterface>> {
        let engine = Engine::shared(
            options.get("worker_path").cloned(),
            options.get("node_path").cloned(),
        )?;
        let (identities, quotes) = if let Some(bases) = options.get("base_mints") {
            let roots: Vec<Pubkey> = bases
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(Pubkey::from_str)
                .collect::<Result<_, _>>()?;
            let mut walk = DiscoveryWalk::new(roots)?;
            let mut seen_pools = HashSet::new();
            let mut identities = Vec::new();
            let mut quotes = HashMap::new();
            while let Some((base, depth)) = walk.next() {
                let pools = fetch_pools(rpc, Some(base)).await?;
                let found = decode_identities(&engine, &pools)?;
                let missing = found
                    .iter()
                    .map(|(_, i)| i.config)
                    .filter(|key| !quotes.contains_key(key))
                    .collect();
                quotes.extend(load_quotes(rpc, &engine, missing).await?);
                for (key, identity) in found {
                    if let Some(quote) = quotes.get(&identity.config) {
                        walk.add_parent(*quote, depth)?;
                    }
                    if seen_pools.insert(key) {
                        identities.push((key, identity));
                    }
                }
            }
            (identities, quotes)
        } else {
            let pools = if let Some(pools) = options.get("pools") {
                let keys: Vec<Pubkey> = pools
                    .split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(Pubkey::from_str)
                    .collect::<Result<_, _>>()?;
                let mut pools = Vec::new();
                for chunk in keys.chunks(100) {
                    pools.extend(
                        rpc.get_multiple_accounts(&chunk.iter().copied().collect())
                            .await?
                            .into_iter()
                            .map(|(key, account)| (key, account.owner, account.data)),
                    );
                }
                pools
            } else {
                fetch_pools(rpc, None).await?
            };
            let identities = decode_identities(&engine, &pools)?;
            let quotes = load_quotes(
                rpc,
                &engine,
                identities.iter().map(|(_, i)| i.config).collect(),
            )
            .await?;
            (identities, quotes)
        };
        let mut edges: HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> = HashMap::new();
        let mut accounts = HashSet::from([Clock::id()]);
        for (pool, identity) in identities {
            let Some(quote_mint) = quotes.get(&identity.config).copied() else {
                continue;
            };
            let pair: Vec<Arc<dyn DexEdgeIdentifier>> = [false, true]
                .into_iter()
                .map(|base_to_quote| {
                    Arc::new(MeteoraDbcEdgeIdentifier {
                        pool,
                        identity: identity.clone(),
                        quote_mint,
                        base_to_quote,
                    }) as Arc<dyn DexEdgeIdentifier>
                })
                .collect();
            for key in [
                pool,
                identity.config,
                identity.base_mint,
                quote_mint,
                identity.base_vault,
                identity.quote_vault,
            ] {
                edges.entry(key).or_default().extend(pair.iter().cloned());
                accounts.insert(key);
            }
        }
        Ok(Arc::new(Self {
            engine,
            edges,
            accounts,
        }))
    }
    fn name(&self) -> String {
        "MeteoraDBC".to_owned()
    }
    fn subscription_mode(&self) -> DexSubscriptionMode {
        // Discovery supplies a bounded set of pools and every account needed by
        // those edges. New pools are discovered by the routing refresh, so a
        // whole-program subscription would duplicate that work and make a
        // single-pool admission capture scan every DBC account on mainnet.
        DexSubscriptionMode::Accounts(self.accounts.clone())
    }
    fn edges_per_pk(&self) -> HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> {
        self.edges.clone()
    }
    fn program_ids(&self) -> HashSet<Pubkey> {
        HashSet::from([PROGRAM_ID])
    }
    fn load(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        provider: &AccountProviderView,
    ) -> Result<Arc<dyn DexEdge>> {
        let mut request = Self::request(Self::identifier(id)?, provider)?;
        request["op"] = json!("validate");
        self.engine.call(request.clone())?;
        Ok(Arc::new(MeteoraDbcEdge { request }))
    }
    fn quote(
        &self,
        _id: &Arc<dyn DexEdgeIdentifier>,
        edge: &Arc<dyn DexEdge>,
        _provider: &AccountProviderView,
        amount: u64,
    ) -> Result<Quote> {
        self.quote_inner(edge, amount, false)
    }
    fn quote_exact_out(
        &self,
        _id: &Arc<dyn DexEdgeIdentifier>,
        edge: &Arc<dyn DexEdge>,
        _provider: &AccountProviderView,
        amount: u64,
    ) -> Result<Quote> {
        self.quote_inner(edge, amount, true)
    }
    fn supports_exact_out(&self, _id: &Arc<dyn DexEdgeIdentifier>) -> bool {
        true
    }
    fn build_swap_ix(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        provider: &AccountProviderView,
        wallet: &Pubkey,
        amount: u64,
        output: u64,
        slippage: i32,
    ) -> Result<SwapInstruction> {
        anyhow::ensure!((0..=10_000).contains(&slippage), "Invalid DBC slippage");
        let minimum = (output as u128 * (10_000 - slippage) as u128 / 10_000) as u64;
        let mut request = Self::request(Self::identifier(id)?, provider)?;
        request["op"] = json!("build");
        request["wallet"] = json!(wallet.to_string());
        request["amount"] = json!(amount.to_string());
        request["minimumOut"] = json!(minimum.to_string());
        let result = self.engine.call(request)?;
        let key = |name| -> Result<Pubkey> {
            Ok(Pubkey::from_str(
                result[name]
                    .as_str()
                    .context("Missing DBC instruction key")?,
            )?)
        };
        anyhow::ensure!(
            key("program")? == PROGRAM_ID,
            "Unexpected DBC instruction program"
        );
        let accounts = result["accounts"]
            .as_array()
            .context("Missing DBC instruction accounts")?
            .iter()
            .map(|a| -> Result<AccountMeta> {
                Ok(AccountMeta {
                    pubkey: Pubkey::from_str(a["pubkey"].as_str().context("Missing account key")?)?,
                    is_signer: a["isSigner"].as_bool().context("Missing signer flag")?,
                    is_writable: a["isWritable"].as_bool().context("Missing writable flag")?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(SwapInstruction {
            instruction: Instruction {
                program_id: PROGRAM_ID,
                accounts,
                data: BASE64.decode(
                    result["data"]
                        .as_str()
                        .context("Missing DBC instruction data")?,
                )?,
            },
            out_pubkey: key("output")?,
            out_mint: key("outputMint")?,
            in_amount_offset: 8,
            cu_estimate: Some(120_000),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../worker/test/bread-mainnet.json")).unwrap()
    }
    fn fixture_request() -> Value {
        let f = fixture();
        let accounts = &f["accounts"];
        let account = |name: &str| accounts[f[name].as_str().unwrap()].clone();
        let clock = BASE64
            .decode(
                accounts["SysvarC1ock11111111111111111111111111111111"]["data"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        json!({
            "pool": f["pool"], "config": f["config"], "baseMint": f["baseMint"], "quoteMint": f["quoteMint"],
            "poolData": account("pool")["data"], "configData": account("config")["data"],
            "baseAccount": account("baseMint"), "quoteAccount": account("quoteMint"),
            "baseVaultAccount": account("baseVault"), "quoteVaultAccount": account("quoteVault"),
            "slot": u64::from_le_bytes(clock[0..8].try_into().unwrap()).to_string(),
            "timestamp": i64::from_le_bytes(clock[32..40].try_into().unwrap()).to_string(), "baseToQuote": false,
        })
    }

    #[test]
    fn sdk_pool_identity_decodes_base58_and_discovery_offset_matches_fixture() {
        let engine = Engine::new(None, None).unwrap();
        let f = fixture();
        let data = BASE64
            .decode(
                f["accounts"][f["pool"].as_str().unwrap()]["data"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
        let pool = Pubkey::from_str(f["pool"].as_str().unwrap()).unwrap();
        let result = decode_identities(&engine, &[(pool, PROGRAM_ID, data.clone())]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].1.base_mint.to_string(),
            f["baseMint"].as_str().unwrap()
        );
        assert_eq!(&data[136..168], result[0].1.base_mint.as_ref());
        assert_eq!(
            result[0].1.config.to_string(),
            f["config"].as_str().unwrap()
        );
    }

    #[test]
    fn rust_bridge_quotes_real_fixture_and_worker_survives_rejected_quote() {
        let engine = Engine::shared(None, None).unwrap();
        let dex = MeteoraDbcDex {
            engine,
            edges: HashMap::new(),
            accounts: HashSet::new(),
        };
        let edge = Arc::new(MeteoraDbcEdge {
            request: fixture_request(),
        }) as Arc<dyn DexEdge>;
        assert!(dex.quote_inner(&edge, 0, false).is_err());
        let quote = dex.quote_inner(&edge, 1_000_000, false).unwrap();
        assert_eq!(
            (quote.in_amount, quote.out_amount, quote.fee_amount),
            (1_000_000, 17_553_844, 10_022)
        );
        let inverse = dex.quote_inner(&edge, quote.out_amount, true).unwrap();
        assert!(inverse.in_amount <= quote.in_amount);
    }
}
