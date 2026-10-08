//! RPC-backed, dynamically rediscovered routes for markets without aggregator/USD coverage.
//! Reuses Autobahn's actual DexInterface and CPI executor. No synthetic pool prices.
#[cfg(test)]
#[path = "rpc_routing_tests.rs"]
mod tests;
use crate::{
    edge::Edge,
    prelude::*,
    routing_types::{Route, RouteStep},
    server::route_provider::RouteProvider,
};
use mango_feeds_connector::chain_data::AccountData;
use router_config_lib::Config;
use router_feed_lib::{
    router_rpc_client::{RouterRpcClient, RouterRpcClientTrait},
    router_rpc_wrapper::RouterRpcWrapper,
};
use router_lib::{
    dex::{AccountProvider, AccountProviderView, DexInterface, SwapMode},
    model::quote_response::QuoteResponse,
};
use solana_sdk::{account::AccountSharedData, commitment_config::CommitmentConfig};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Graph {
    edges: Vec<Arc<Edge>>,
    incoming: HashMap<Pubkey, Vec<usize>>,
    outgoing: HashMap<Pubkey, Vec<usize>>,
}
impl Graph {
    fn new(dexs: Vec<Arc<dyn DexInterface>>) -> Self {
        let mut graph = Self::default();
        let mut seen = HashSet::new();
        for dex in dexs {
            for id in dex.edges_per_pk().into_values().flatten() {
                if !seen.insert((dex.name(), id.key(), id.input_mint(), id.output_mint())) {
                    continue;
                }
                let index = graph.edges.len();
                graph
                    .outgoing
                    .entry(id.input_mint())
                    .or_default()
                    .push(index);
                graph
                    .incoming
                    .entry(id.output_mint())
                    .or_default()
                    .push(index);
                graph.edges.push(Arc::new(Edge {
                    input_mint: id.input_mint(),
                    output_mint: id.output_mint(),
                    accounts_needed: id.accounts_needed(),
                    dex: dex.clone(),
                    id,
                    state: Default::default(),
                }));
            }
        }
        graph
    }
    // Work backwards first: recursive leaves do not fan out into unrelated tokens.
    fn paths(
        &self,
        from: Pubkey,
        to: Pubkey,
        max_hops: usize,
        max_paths: usize,
        max_accounts: usize,
    ) -> Vec<Vec<usize>> {
        let mut distance = HashMap::from([(to, 0usize)]);
        let mut queue = VecDeque::from([to]);
        while let Some(mint) = queue.pop_front() {
            let depth = distance[&mint];
            if depth >= max_hops {
                continue;
            }
            for i in self.incoming.get(&mint).into_iter().flatten() {
                let previous = self.edges[*i].input_mint;
                if !distance.contains_key(&previous) {
                    distance.insert(previous, depth + 1);
                    queue.push_back(previous);
                }
            }
        }
        let mut found = vec![];
        let mut pending = VecDeque::from([(from, vec![], HashSet::from([from]), 0usize)]);
        let mut visited = 0;
        while let Some((mint, path, mints, accounts)) = pending.pop_front() {
            visited += 1;
            if visited > 100_000 || found.len() >= max_paths {
                break;
            }
            for i in self.outgoing.get(&mint).into_iter().flatten() {
                let edge = &self.edges[*i];
                let next = edge.output_mint;
                let count = accounts.saturating_add(edge.accounts_needed);
                if mints.contains(&next)
                    || count > max_accounts
                    || distance
                        .get(&next)
                        .map_or(true, |d| path.len() + 1 + d > max_hops)
                {
                    continue;
                }
                let mut next_path = path.clone();
                next_path.push(*i);
                if next == to {
                    found.push(next_path);
                    if found.len() >= max_paths {
                        break;
                    }
                } else if next_path.len() < max_hops {
                    let mut next_mints = mints.clone();
                    next_mints.insert(next);
                    pending.push_back((next, next_path, next_mints, count));
                }
            }
        }
        found
    }
}

/// One request sees one value per account. Quotes never mix repeated reads of a
/// changed pool, and the next request starts a new snapshot. No USD prerequisite.
struct RequestAccounts {
    source: AccountProviderView,
    accounts: Mutex<HashMap<Pubkey, AccountData>>,
}
impl AccountProvider for RequestAccounts {
    fn account(&self, key: &Pubkey) -> anyhow::Result<AccountData> {
        let mut cache = self.accounts.lock().unwrap();
        if let Some(value) = cache.get(key) {
            return Ok(value.clone());
        }
        let value = self.source.account(key)?;
        cache.insert(*key, value.clone());
        Ok(value)
    }
    fn newest_processed_slot(&self) -> u64 {
        self.accounts
            .lock()
            .unwrap()
            .values()
            .map(|v| v.slot)
            .max()
            .unwrap_or(0)
    }
}

const ROOT_LIMIT: usize = 1024;
const ROOT_BATCH: usize = 8;
const NEGATIVE_RETRY: Duration = Duration::from_secs(15);
const ROOT_REDISCOVERY: Duration = Duration::from_secs(60);
const VENUE_REDISCOVERY: Duration = Duration::from_secs(300);

fn redacted_discovery_error(error: &anyhow::Error) -> String {
    static URLS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    URLS.get_or_init(|| regex::Regex::new(r#"(?i)https?://[^\s\"'<>]+"#).unwrap())
        .replace_all(&error.to_string(), "[redacted RPC URL]")
        .into_owned()
}

async fn bounded_discovery<T>(
    future: impl std::future::Future<Output = anyhow::Result<T>>,
    limit: Duration,
) -> anyhow::Result<T> {
    tokio::time::timeout(limit, future)
        .await
        .context("Token discovery exceeded its time budget; retry shortly")?
}

struct RootEntry {
    last_used: Instant,
    last_attempt: Option<Instant>,
    adapter: Option<Arc<dyn DexInterface>>,
    pinned: bool,
    error: Option<String>,
}
#[derive(Default)]
struct RootCache {
    entries: HashMap<Pubkey, RootEntry>,
}
impl RootCache {
    fn schedule(&mut self, mint: Pubkey, pinned: bool, now: Instant) -> anyhow::Result<()> {
        if let Some(entry) = self.entries.get_mut(&mint) {
            entry.last_used = now;
            entry.pinned |= pinned;
            return Ok(());
        }
        if self.entries.len() >= ROOT_LIMIT {
            let oldest = self
                .entries
                .iter()
                .filter(|(_, e)| !e.pinned)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(key, _)| *key)
                .context("Configured discovery roots fill the cache capacity")?;
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            mint,
            RootEntry {
                last_used: now,
                last_attempt: None,
                adapter: None,
                pinned,
                error: None,
            },
        );
        Ok(())
    }
    fn due(&mut self, now: Instant) -> Vec<Pubkey> {
        let mut due: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, e)| {
                e.last_attempt.map_or(true, |last| {
                    now.duration_since(last)
                        >= if e.adapter.is_some() {
                            ROOT_REDISCOVERY
                        } else {
                            NEGATIVE_RETRY
                        }
                })
            })
            .map(|(key, entry)| (*key, entry.last_attempt, entry.last_used))
            .collect();
        // Never-requested roots first, then oldest attempts: no hot-root starvation.
        due.sort_by_key(|(_, attempted, _)| *attempted);
        due.truncate(ROOT_BATCH);
        due.into_iter()
            .map(|(key, _, _)| {
                self.entries.get_mut(&key).unwrap().last_attempt = Some(now);
                key
            })
            .collect()
    }
}
#[derive(Default)]
struct LegacyCache {
    adapters: HashMap<&'static str, Arc<dyn DexInterface>>,
    status: HashMap<&'static str, String>,
    attempted: HashMap<&'static str, Instant>,
    bootstrapped: HashSet<&'static str>,
}

// Enumerate keys without account data, then hydrate at most four 100-account
// replies at a time. Full GPA bodies otherwise duplicate hundreds of MB through
// JSON, base64, decoded account, and adapter layers during each venue refresh.
struct BoundedDiscoveryRpc {
    inner: RouterRpcClient,
    hydration: Arc<solana_client::nonblocking::rpc_client::RpcClient>,
}
fn hydrated_discovery_account(
    program: &Pubkey,
    config: &solana_client::rpc_config::RpcProgramAccountsConfig,
    account: solana_sdk::account::Account,
) -> Option<solana_sdk::account::Account> {
    if account.owner != *program || account.executable {
        return None;
    }
    if config.filters.as_ref().is_some_and(|filters| {
        let shared = AccountSharedData::from(account.clone());
        !filters.iter().all(|filter| filter.allows(&shared))
    }) {
        return None;
    }
    let mut account = account;
    if let Some(slice) = &config.account_config.data_slice {
        account.data = account
            .data
            .get(slice.offset..)
            .unwrap_or_default()
            .iter()
            .take(slice.length)
            .copied()
            .collect();
    }
    Some(account)
}
#[async_trait::async_trait]
impl RouterRpcClientTrait for BoundedDiscoveryRpc {
    async fn get_account(
        &mut self,
        key: &Pubkey,
    ) -> anyhow::Result<Option<solana_sdk::account::Account>> {
        self.inner.get_account(key).await
    }
    async fn get_multiple_accounts(
        &mut self,
        keys: &HashSet<Pubkey>,
    ) -> anyhow::Result<Vec<(Pubkey, solana_sdk::account::Account)>> {
        self.inner.get_multiple_accounts(keys).await
    }
    async fn get_program_accounts_with_config(
        &mut self,
        program: &Pubkey,
        config: solana_client::rpc_config::RpcProgramAccountsConfig,
    ) -> anyhow::Result<Vec<router_feed_lib::account_write::AccountWrite>> {
        use futures::{stream, StreamExt};
        use router_feed_lib::account_write::{account_write_from, SNAP_ACCOUNT_WRITE_VERSION};
        let mut enumeration = config.clone();
        enumeration.account_config.data_slice = Some(solana_account_decoder::UiDataSliceConfig {
            offset: 0,
            length: 0,
        });
        let listed = self
            .inner
            .get_program_accounts_with_config(program, enumeration)
            .await?;
        let minimum_slot = listed.iter().map(|a| a.slot).max().unwrap_or(0);
        let keys: Vec<_> = listed.into_iter().map(|a| a.pubkey).collect();
        let mut hydrated = Vec::with_capacity(keys.len());
        let batches = keys.chunks(100).map(|chunk| chunk.to_vec());
        let mut replies = stream::iter(batches)
            .map(|chunk| {
                let rpc = self.hydration.clone();
                let account_config = solana_client::rpc_config::RpcAccountInfoConfig {
                    encoding: Some(solana_account_decoder::UiAccountEncoding::Base64),
                    commitment: config.account_config.commitment,
                    min_context_slot: Some(
                        minimum_slot.max(config.account_config.min_context_slot.unwrap_or(0)),
                    ),
                    data_slice: None,
                };
                async move {
                    let reply = rpc
                        .get_multiple_accounts_with_config(&chunk, account_config)
                        .await?;
                    anyhow::Ok((chunk, reply))
                }
            })
            .buffer_unordered(4);
        while let Some(reply) = replies.next().await {
            let (chunk, reply) = reply?;
            for (key, value) in chunk.into_iter().zip(reply.value) {
                if let Some(account) =
                    value.and_then(|account| hydrated_discovery_account(program, &config, account))
                {
                    hydrated.push(account_write_from(
                        key,
                        reply.context.slot,
                        SNAP_ACCOUNT_WRITE_VERSION,
                        account,
                    ));
                }
            }
        }
        Ok(hydrated)
    }
    fn is_gpa_compression_enabled(&self) -> bool {
        false
    }
}

// First publish a small, genuine SOL/USDC snapshot, then expand to every pool.
// The mint filters only affect this bootstrap RPC wrapper, never ongoing discovery.
struct PairDiscoveryRpc {
    inner: RouterRpcClient,
    pair: (Pubkey, Pubkey),
}
#[async_trait::async_trait]
impl RouterRpcClientTrait for PairDiscoveryRpc {
    async fn get_account(
        &mut self,
        key: &Pubkey,
    ) -> anyhow::Result<Option<solana_sdk::account::Account>> {
        self.inner.get_account(key).await
    }
    async fn get_multiple_accounts(
        &mut self,
        keys: &HashSet<Pubkey>,
    ) -> anyhow::Result<Vec<(Pubkey, solana_sdk::account::Account)>> {
        self.inner.get_multiple_accounts(keys).await
    }
    async fn get_program_accounts_with_config(
        &mut self,
        program: &Pubkey,
        config: solana_client::rpc_config::RpcProgramAccountsConfig,
    ) -> anyhow::Result<Vec<router_feed_lib::account_write::AccountWrite>> {
        let offsets = match program.to_string().as_str() {
            // Offsets in the existing adapter's serialized Whirlpool/PoolState/AmmInfo layouts.
            "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" => Some((101, 181)),
            "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C" => Some((168, 200)),
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" => Some((400, 432)),
            _ => None,
        };
        let Some((a, b)) = offsets else {
            return self
                .inner
                .get_program_accounts_with_config(program, config)
                .await;
        };
        let mut accounts = Vec::new();
        for (left, right) in [self.pair, (self.pair.1, self.pair.0)] {
            let mut filtered = config.clone();
            let filters = filtered.filters.get_or_insert_with(Vec::new);
            filters.push(solana_client::rpc_filter::RpcFilterType::Memcmp(
                solana_client::rpc_filter::Memcmp::new_raw_bytes(a, left.to_bytes().to_vec()),
            ));
            filters.push(solana_client::rpc_filter::RpcFilterType::Memcmp(
                solana_client::rpc_filter::Memcmp::new_raw_bytes(b, right.to_bytes().to_vec()),
            ));
            accounts.extend(
                self.inner
                    .get_program_accounts_with_config(program, filtered)
                    .await?,
            );
        }
        Ok(accounts)
    }
    fn is_gpa_compression_enabled(&self) -> bool {
        false
    }
}

pub struct RpcRouteProvider {
    graph: RwLock<Arc<Graph>>,
    accounts: AccountProviderView,
    config: Config,
    refresh: tokio::sync::Mutex<Instant>,
    watched: Mutex<RootCache>,
    registered: Mutex<Option<(Instant, Vec<Arc<dyn DexInterface>>)>>,
    legacy: Mutex<LegacyCache>,
    publish: Mutex<()>,
}
impl RpcRouteProvider {
    fn rpc(&self) -> anyhow::Result<RouterRpcClient> {
        let source = self.config.sources.first().context("RPC source missing")?;
        Ok(RouterRpcClient {
            rpc: Box::new(RouterRpcWrapper {
                rpc: super::build_rpc(source),
                gpa_compression_enabled: false,
            }),
            gpa_compression_enabled: false,
        })
    }
    fn discovery_rpc(&self) -> anyhow::Result<RouterRpcClient> {
        let mut source = self
            .config
            .sources
            .first()
            .context("RPC source missing")?
            .clone();
        // Background full-venue snapshots are larger than per-quote account reads.
        // Keep the trading RPC timeout unchanged, and bound the complete initializer below.
        source.request_timeout_in_seconds = Some(60);
        Ok(RouterRpcClient {
            rpc: Box::new(BoundedDiscoveryRpc {
                inner: RouterRpcClient {
                    rpc: Box::new(RouterRpcWrapper {
                        rpc: super::build_rpc(&source),
                        gpa_compression_enabled: false,
                    }),
                    gpa_compression_enabled: false,
                },
                hydration: Arc::new(super::build_rpc(&source)),
            }),
            gpa_compression_enabled: false,
        })
    }
    fn publish_graph(&self) {
        // Serialize publication, not network reads. The last publication always
        // includes all completed root and venue snapshots, whichever finishes first.
        let _publication = self.publish.lock().unwrap();
        let mut dexs = Vec::new();
        {
            let roots = self.watched.lock().unwrap();
            let mut entries: Vec<_> = roots.entries.values().collect();
            entries.sort_by_key(|entry| std::cmp::Reverse(entry.last_attempt));
            let mut instances = HashSet::new();
            for entry in entries {
                if let Some(adapter) = &entry.adapter {
                    let address = Arc::as_ptr(adapter) as *const () as usize;
                    if instances.insert(address) {
                        dexs.push(adapter.clone());
                    }
                }
            }
        }
        if let Some((_, registered)) = self.registered.lock().unwrap().as_ref() {
            dexs.extend(registered.iter().cloned());
        }
        dexs.extend(self.legacy.lock().unwrap().adapters.values().cloned());
        let graph = Graph::new(dexs);
        info!(edges = graph.edges.len(), "Published routing graph");
        *self.graph.write().unwrap() = Arc::new(graph);
    }
    async fn refresh(&self, force: bool) -> anyhow::Result<()> {
        let mut last = self.refresh.lock().await;
        if last.elapsed() < Duration::from_secs(2) {
            return Ok(());
        }
        *last = Instant::now(); // Errors and unknown roots cannot bypass throttling.
        let mut rpc = self.rpc()?;
        let registry_due = self
            .registered
            .lock()
            .unwrap()
            .as_ref()
            .map_or(true, |(when, _)| {
                !force && when.elapsed() >= VENUE_REDISCOVERY
            });
        if registry_due {
            let mut options = self.config.adapters.clone();
            let dbc = options.entry("meteora-dbc".into()).or_default();
            // Configured roots are queued below. Never do a full DBC GPA merely
            // because no visitor has requested a token yet. Explicit pool options
            // remain a separate configured seed snapshot.
            if !dbc.contains_key("pools") {
                dbc.insert("base_mints".into(), String::new());
            } else {
                dbc.remove("base_mints");
            }
            match adapter_registry::initialize(&mut rpc, &options, &self.config.disabled_adapters)
                .await
            {
                Ok(adapters) => *self.registered.lock().unwrap() = Some((Instant::now(), adapters)),
                Err(error) => {
                    if self.registered.lock().unwrap().is_none() {
                        return Err(error);
                    }
                    warn!(error=%redacted_discovery_error(&error), "Configured adapter refresh failed; retaining healthy snapshot");
                }
            }
        }
        if !self
            .config
            .disabled_adapters
            .iter()
            .any(|id| id == "meteora-dbc")
        {
            let roots = self.watched.lock().unwrap().due(Instant::now());
            if !roots.is_empty() {
                let mut options = self
                    .config
                    .adapters
                    .get("meteora-dbc")
                    .cloned()
                    .unwrap_or_default();
                options.insert(
                    "base_mints".into(),
                    roots
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(","),
                );
                match bounded_discovery(
                    adapter_registry::initialize_one("meteora-dbc", &mut rpc, options),
                    Duration::from_secs(20),
                )
                .await
                {
                    Ok(adapter) => {
                        let mints: HashSet<_> = adapter
                            .edges_per_pk()
                            .into_values()
                            .flatten()
                            .flat_map(|id| [id.input_mint(), id.output_mint()])
                            .collect();
                        let mut cache = self.watched.lock().unwrap();
                        for root in roots {
                            if let Some(entry) = cache.entries.get_mut(&root) {
                                entry.last_attempt = Some(Instant::now());
                                entry.adapter = if mints.contains(&root) {
                                    Some(adapter.clone())
                                } else {
                                    None
                                };
                                entry.error = None;
                            }
                        }
                    }
                    Err(error) => {
                        let mut cache = self.watched.lock().unwrap();
                        for root in &roots {
                            if let Some(entry) = cache.entries.get_mut(root) {
                                entry.last_attempt = Some(Instant::now());
                                entry.error = Some(redacted_discovery_error(&error));
                            }
                        }
                        warn!(error=%redacted_discovery_error(&error), roots=roots.len(), "Root discovery failed; retaining healthy snapshots");
                        *last = Instant::now();
                        self.publish_after_unlock(cache);
                        return Err(error);
                    }
                }
            }
        }
        self.publish_graph();
        *last = Instant::now();
        Ok(())
    }
    fn publish_after_unlock(&self, guard: std::sync::MutexGuard<'_, RootCache>) {
        drop(guard);
        self.publish_graph();
    }
    fn legacy_venues(&self) -> Vec<(&'static str, bool)> {
        vec![
            ("Orca", self.config.orca.enabled),
            ("Cropper", self.config.cropper.enabled),
            ("RaydiumCP", self.config.raydium_cp.enabled),
            ("Raydium", self.config.raydium.enabled),
            ("Saber", self.config.saber.enabled),
            ("OpenbookV2", self.config.openbook_v2.enabled),
            ("Infinity", self.config.infinity.enabled),
            ("Invariant", self.config.invariant.enabled),
        ]
    }
    async fn refresh_legacy(&self) -> anyhow::Result<bool> {
        let (venue, bootstrap) = {
            let mut cache = self.legacy.lock().unwrap();
            let selected = self
                .legacy_venues()
                .into_iter()
                .filter(|(_, enabled)| *enabled)
                .filter(|(name, _)| cache.status.get(name).map_or(true, |s| s != "loading"))
                .filter(|(name, _)| {
                    cache
                        .attempted
                        .get(name)
                        .map_or(true, |at| at.elapsed() >= VENUE_REDISCOVERY)
                })
                .min_by_key(|(name, _)| cache.attempted.get(name).copied());
            let Some((name, _)) = selected else {
                return Ok(false);
            };
            cache.status.insert(name, "loading".into());
            cache.attempted.insert(name, Instant::now());
            let bootstrap =
                matches!(name, "Orca" | "RaydiumCP" | "Raydium") && cache.bootstrapped.insert(name);
            (name, bootstrap)
        };
        let mut rpc = self.discovery_rpc()?;
        if bootstrap {
            rpc = RouterRpcClient {
                rpc: Box::new(PairDiscoveryRpc {
                    inner: rpc,
                    pair: (
                        "So11111111111111111111111111111111111111112".parse()?,
                        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".parse()?,
                    ),
                }),
                gpa_compression_enabled: false,
            };
        }
        let empty = HashMap::new();
        let result = bounded_discovery(
            async {
                match venue {
                    "Orca" | "Cropper" => {
                        dex_orca::OrcaDex::initialize(
                            &mut rpc,
                            HashMap::from([
                                (
                                    "program_id".into(),
                                    if venue == "Orca" {
                                        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
                                    } else {
                                        "H8W3ctz92svYg6mkn1UtGfu2aQr2fnUFHM1RhScEtQDt"
                                    }
                                    .into(),
                                ),
                                ("program_name".into(), venue.into()),
                            ]),
                        )
                        .await
                    }
                    "RaydiumCP" => dex_raydium_cp::RaydiumCpDex::initialize(&mut rpc, empty).await,
                    "Raydium" => dex_raydium::RaydiumDex::initialize(&mut rpc, empty).await,
                    "Saber" => dex_saber::SaberDex::initialize(&mut rpc, empty).await,
                    "OpenbookV2" => {
                        dex_openbook_v2::OpenbookV2Dex::initialize(&mut rpc, empty).await
                    }
                    "Infinity" => dex_infinity::InfinityDex::initialize(&mut rpc, empty).await,
                    "Invariant" => dex_invariant::InvariantDex::initialize(&mut rpc, empty).await,
                    _ => unreachable!(),
                }
            },
            Duration::from_secs(90),
        )
        .await;
        {
            let mut cache = self.legacy.lock().unwrap();
            match result {
                Ok(adapter) => {
                    cache.adapters.insert(venue, adapter);
                    cache.status.insert(venue, "ready".into());
                }
                Err(error) => {
                    // RPC errors can contain credential-bearing endpoint URLs.
                    // Public discovery status exposes the state, never that URL.
                    cache.status.insert(venue, "error".into());
                    warn!(venue, error=%redacted_discovery_error(&error), "Venue discovery failed; retaining any previous snapshot");
                }
            }
        }
        self.publish_graph();
        if bootstrap {
            // All never-attempted venues get a turn before the full expansion.
            self.legacy
                .lock()
                .unwrap()
                .attempted
                .insert(venue, Instant::now() - VENUE_REDISCOVERY);
        }
        Ok(true)
    }
    pub fn discovery_status(&self) -> serde_json::Value {
        let roots = self.watched.lock().unwrap();
        let legacy = self.legacy.lock().unwrap();
        let venues: Vec<_> = self.legacy_venues().into_iter().filter(|(_, enabled)| *enabled)
            .map(|(name, _)| serde_json::json!({"venue":name,"status":legacy.status.get(name).map(String::as_str).unwrap_or("pending"),"available":legacy.adapters.contains_key(name)})).collect();
        serde_json::json!({"venues":venues,"roots":roots.entries.len(),
            "pendingRoots":roots.entries.values().filter(|r|r.last_attempt.is_none()).count(),
            "failedRoots":roots.entries.values().filter(|r|r.error.is_some()).count(),
            "edges":self.graph.read().unwrap().edges.len()})
    }
    fn graph_for(&self, from: Pubkey, to: Pubkey) -> anyhow::Result<Arc<Graph>> {
        let graph = self.graph.read().unwrap().clone();
        let mut missing = Vec::new();
        if !graph.outgoing.contains_key(&from) {
            missing.push(from);
        }
        if !graph.incoming.contains_key(&to) && !missing.contains(&to) {
            missing.push(to);
        }
        {
            let mut roots = self.watched.lock().unwrap();
            let now = Instant::now();
            for mint in [from, to] {
                if let Some(entry) = roots.entries.get_mut(&mint) {
                    entry.last_used = now;
                }
            }
            for mint in &missing {
                roots.schedule(*mint, false, now)?;
            }
        }
        if !missing.is_empty()
            && !self
                .config
                .disabled_adapters
                .iter()
                .any(|id| id == "meteora-dbc")
        {
            tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(self.refresh(true))
            })?;
            let roots = self.watched.lock().unwrap();
            anyhow::ensure!(
                !missing.iter().any(|mint| roots
                    .entries
                    .get(mint)
                    .map_or(false, |e| e.last_attempt.is_none())),
                "Token discovery queued; retry shortly"
            );
        }
        Ok(self.graph.read().unwrap().clone())
    }
}
impl RouteProvider for RpcRouteProvider {
    fn discovery_status(&self) -> serde_json::Value {
        RpcRouteProvider::discovery_status(self)
    }
    fn prepare_pruned_edges_and_cleanup_cache(&self, _: &HashSet<Pubkey>, _: SwapMode) {}
    fn prepare_cache_for_input_mint<F>(
        &self,
        _: Pubkey,
        _: u64,
        _: usize,
        _: F,
    ) -> anyhow::Result<()>
    where
        F: Fn(&Pubkey, &Pubkey) -> bool,
    {
        Ok(())
    }
    fn best_quote(
        &self,
        from: Pubkey,
        to: Pubkey,
        amount: u64,
        max_accounts: usize,
        mode: SwapMode,
    ) -> anyhow::Result<Route> {
        anyhow::ensure!(
            mode == SwapMode::ExactIn,
            "RPC graph currently supports ExactIn; ExactOut requires an adapter inverse quote"
        );
        anyhow::ensure!(amount > 0 && from != to, "invalid mint pair or amount");
        let settings = self.config.rpc_routing.as_ref().unwrap();
        let graph = self.graph_for(from, to)?;
        let paths = graph.paths(
            from,
            to,
            settings.max_hops,
            settings.max_paths,
            max_accounts,
        );
        let accounts = Arc::new(RequestAccounts {
            source: self.accounts.clone(),
            accounts: Default::default(),
        }) as AccountProviderView;
        let mut best: Option<Route> = None;
        let started = Instant::now();
        for path in paths {
            if started.elapsed() > Duration::from_secs(10) {
                break;
            }
            let candidate = (|| -> anyhow::Result<Route> {
                let mut input = amount;
                let mut steps = vec![];
                for i in path {
                    let edge = graph.edges[i].clone();
                    let loaded = edge.prepare(&accounts)?;
                    let quote = edge.quote(&loaded, &accounts, input)?;
                    anyhow::ensure!(
                        quote.in_amount == input && quote.out_amount > 0,
                        "partial or empty route edge"
                    );
                    steps.push(RouteStep {
                        edge,
                        in_amount: input,
                        out_amount: quote.out_amount,
                        fee_amount: quote.fee_amount,
                        fee_mint: quote.fee_mint,
                    });
                    input = quote.out_amount;
                }
                Ok(Route {
                    input_mint: from,
                    output_mint: to,
                    in_amount: amount,
                    out_amount: input,
                    price_impact_bps: None,
                    steps,
                    slot: accounts.newest_processed_slot(),
                    accounts: None,
                })
            })();
            if let Ok(route) = candidate {
                if best
                    .as_ref()
                    .map_or(true, |b| route.out_amount > b.out_amount)
                {
                    best = Some(route);
                }
            }
        }
        let mut best = best.context("No executable route at this amount")?;
        best.price_impact_bps =
            crate::price_impact::sample_impact_bps(best.in_amount, best.out_amount, |mut input| {
                for step in &best.steps {
                    let loaded = step.edge.prepare(&accounts).ok()?;
                    let quote = step.edge.quote(&loaded, &accounts, input).ok()?;
                    if quote.in_amount != input
                        || quote.out_amount < crate::price_impact::MIN_SAMPLE_UNITS
                    {
                        return None;
                    }
                    input = quote.out_amount;
                }
                Some(input)
            });
        Ok(best)
    }
    fn try_from(&self, response: &QuoteResponse) -> anyhow::Result<Route> {
        let from: Pubkey = response.input_mint.parse()?;
        let to: Pubkey = response.output_mint.parse()?;
        let graph = self.graph_for(from, to)?;
        anyhow::ensure!(
            response.swap_mode == "ExactIn",
            "RPC graph only admits ExactIn routes"
        );
        let amount: u64 = response
            .in_amount
            .as_ref()
            .context("missing input")?
            .parse()?;
        let output_amount: u64 = response.out_amount.parse()?;
        anyhow::ensure!(
            amount > 0
                && output_amount > 0
                && response.route_plan.len() <= self.config.rpc_routing.as_ref().unwrap().max_hops,
            "invalid route amounts/length"
        );
        let mut expected_amount = amount;
        let mut expected = from;
        let mut steps = vec![];
        let mut seen = HashSet::from([from]);
        for plan in &response.route_plan {
            anyhow::ensure!(
                plan.percent == 100,
                "split route not supported by this executor path"
            );
            let info = plan.swap_info.as_ref().context("missing swap info")?;
            let input: Pubkey = info.input_mint.parse()?;
            let output: Pubkey = info.output_mint.parse()?;
            let key: Pubkey = info.amm_key.parse()?;
            anyhow::ensure!(
                input == expected && seen.insert(output),
                "disconnected or cyclic route"
            );
            let edge = graph
                .edges
                .iter()
                .find(|e| e.key() == key && e.input_mint == input && e.output_mint == output)
                .context("route edge no longer exists")?
                .clone();
            let step_in: u64 = info.in_amount.parse()?;
            let step_out: u64 = info.out_amount.parse()?;
            anyhow::ensure!(
                step_in == expected_amount && step_out > 0,
                "inconsistent hop amounts"
            );
            steps.push(RouteStep {
                edge,
                in_amount: step_in,
                out_amount: step_out,
                fee_amount: info.fee_amount.parse()?,
                fee_mint: info.fee_mint.parse()?,
            });
            expected = output;
            expected_amount = step_out;
        }
        anyhow::ensure!(
            !steps.is_empty() && expected == to && expected_amount == output_amount,
            "route does not reach requested output"
        );
        Ok(Route {
            input_mint: from,
            output_mint: to,
            in_amount: amount,
            out_amount: response.out_amount.parse()?,
            price_impact_bps: None,
            steps,
            slot: response.context_slot,
            accounts: None,
        })
    }
}

pub async fn run(config: Config) -> anyhow::Result<()> {
    let settings = config.rpc_routing.as_ref().unwrap();
    anyhow::ensure!(
        (1..=32).contains(&settings.max_hops)
            && (1..=4096).contains(&settings.max_paths)
            && settings.refresh_seconds >= 2,
        "invalid RPC routing limits"
    );
    let source = config.sources.first().context("RPC source missing")?;
    let live = Arc::new(crate::server::live_account_provider::LiveAccountProvider {
        rpc_client: super::build_blocking_rpc(source),
    });
    let mut roots = RootCache::default();
    if let Some(bases) = config
        .adapters
        .get("meteora-dbc")
        .and_then(|options| options.get("base_mints"))
    {
        for mint in bases
            .split(',')
            .map(str::trim)
            .filter(|mint| !mint.is_empty())
        {
            roots.schedule(mint.parse()?, true, Instant::now())?;
        }
    }
    let provider = Arc::new(RpcRouteProvider {
        graph: Default::default(),
        accounts: live.clone(),
        config: config.clone(),
        refresh: tokio::sync::Mutex::new(Instant::now() - Duration::from_secs(3600)),
        watched: Mutex::new(roots),
        legacy: Default::default(),
        registered: Default::default(),
        publish: Default::default(),
    });
    provider.refresh(true).await?;
    let (exit, _) = tokio::sync::broadcast::channel(4);
    let (updates, _) = tokio::sync::broadcast::channel(4);
    let (prices, _) = router_lib::price_feeds::price_cache::PriceCache::new(
        exit.subscribe(),
        updates.subscribe(),
    );
    let liquidity = Arc::new(RwLock::new(crate::liquidity::LiquidityProvider::new(
        crate::token_cache::TokenCache::new(HashMap::new()),
        prices,
    )));
    let hash = Arc::new(crate::server::hash_provider::RpcHashProvider {
        rpc_client: super::build_rpc(source),
        last_update: Default::default(),
    });
    let alt = Arc::new(crate::server::alt_provider::RpcAltProvider {
        rpc_client: super::build_rpc(source),
        cache: Default::default(),
    });
    let builder = Arc::new(crate::ix_builder::SwapInstructionsBuilderImpl::new(
        crate::ix_builder::SwapStepInstructionBuilderImpl {
            chain_data: live.clone(),
        },
        1,
    ));
    let refresh_seconds = settings.refresh_seconds;
    let server = crate::server::http_server::HttpServer::start(
        provider.clone(),
        hash,
        alt,
        live,
        liquidity,
        builder,
        config,
        exit.subscribe(),
    )
    .await?;
    let mut venue_jobs = Vec::new();
    // At most two large venue scans, independent of root discovery's mutex.
    // HTTP is already bound and exposes each venue's pending/loading/error state.
    for _ in 0..2 {
        let provider = provider.clone();
        venue_jobs.push(tokio::spawn(async move {
            loop {
                match provider.refresh_legacy().await {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(error) => warn!(error=%redacted_discovery_error(&error), "Legacy venue discovery failed"),
                }
                tokio::time::sleep(Duration::from_secs(refresh_seconds)).await;
            }
        }));
    }
    let refresh = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(refresh_seconds));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(e) = provider.refresh(false).await {
                warn!(error=%redacted_discovery_error(&e),"Discovery refresh failed; retaining previous graph");
            }
        }
    });
    tokio::select! { result=server.join_handle=>{result?;}, _=tokio::signal::ctrl_c()=>{} }
    let _ = exit.send(());
    refresh.abort();
    for job in venue_jobs {
        job.abort();
    }
    Ok(())
}
