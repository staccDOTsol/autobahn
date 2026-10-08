use super::*;
use router_config_lib::RpcRoutingConfig;
use router_lib::dex::{DexEdge, DexEdgeIdentifier, DexSubscriptionMode, Quote, SwapInstruction};
use router_lib::model::quote_response::{RoutePlan, SwapInfo};
use std::{
    any::Any,
    sync::atomic::{AtomicU64, Ordering},
};

#[derive(Clone)]
struct TestId {
    key: Pubkey,
    input: Pubkey,
    output: Pubkey,
    multiplier: u64,
    partial: bool,
    curve_reserve: Option<u64>,
}
impl DexEdgeIdentifier for TestId {
    fn key(&self) -> Pubkey {
        self.key
    }
    fn desc(&self) -> String {
        "test edge".into()
    }
    fn input_mint(&self) -> Pubkey {
        self.input
    }
    fn output_mint(&self) -> Pubkey {
        self.output
    }
    fn accounts_needed(&self) -> usize {
        3
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
struct TestLoaded;
impl DexEdge for TestLoaded {
    fn as_any(&self) -> &dyn Any {
        self
    }
}
struct TestDex {
    ids: Vec<TestId>,
    calls: Arc<Mutex<Vec<(Pubkey, u64)>>>,
}
#[async_trait::async_trait]
impl DexInterface for TestDex {
    async fn initialize(
        _: &mut RouterRpcClient,
        _: HashMap<String, String>,
    ) -> anyhow::Result<Arc<dyn DexInterface>> {
        anyhow::bail!("test fixture is constructed directly")
    }
    fn name(&self) -> String {
        "unpriced test venue".into()
    }
    fn subscription_mode(&self) -> DexSubscriptionMode {
        DexSubscriptionMode::Accounts(HashSet::new())
    }
    fn edges_per_pk(&self) -> HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> {
        // Real adapters list each edge once per subscribed account. Exercise deduplication.
        let ids: Vec<_> = self
            .ids
            .iter()
            .cloned()
            .map(|id| Arc::new(id) as Arc<dyn DexEdgeIdentifier>)
            .collect();
        HashMap::from([
            (Pubkey::new_unique(), ids.clone()),
            (Pubkey::new_unique(), ids),
        ])
    }
    fn program_ids(&self) -> HashSet<Pubkey> {
        HashSet::new()
    }
    fn load(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        accounts: &AccountProviderView,
    ) -> anyhow::Result<Arc<dyn DexEdge>> {
        // Exercise the request cache for both the execution-sized quote and
        // price-impact probes. The underlying source changes on every read.
        accounts.account(&id.key())?;
        Ok(Arc::new(TestLoaded))
    }
    fn quote(
        &self,
        id: &Arc<dyn DexEdgeIdentifier>,
        _: &Arc<dyn DexEdge>,
        _: &AccountProviderView,
        amount: u64,
    ) -> anyhow::Result<Quote> {
        let id = id.as_any().downcast_ref::<TestId>().unwrap();
        self.calls.lock().unwrap().push((id.key, amount));
        let output = if let Some(reserve) = id.curve_reserve {
            ((amount as u128 * reserve as u128 * id.multiplier as u128)
                / (reserve as u128 + amount as u128)) as u64
        } else {
            amount
                .checked_mul(id.multiplier)
                .context("test amount overflow")?
        };
        Ok(Quote {
            in_amount: amount - u64::from(id.partial),
            out_amount: output,
            fee_amount: 0,
            fee_mint: id.input,
        })
    }
    fn build_swap_ix(
        &self,
        _: &Arc<dyn DexEdgeIdentifier>,
        _: &AccountProviderView,
        _: &Pubkey,
        _: u64,
        _: u64,
        _: i32,
    ) -> anyhow::Result<SwapInstruction> {
        anyhow::bail!("quote tests do not execute")
    }
    fn supports_exact_out(&self, _: &Arc<dyn DexEdgeIdentifier>) -> bool {
        false
    }
    fn quote_exact_out(
        &self,
        _: &Arc<dyn DexEdgeIdentifier>,
        _: &Arc<dyn DexEdge>,
        _: &AccountProviderView,
        _: u64,
    ) -> anyhow::Result<Quote> {
        anyhow::bail!("unsupported")
    }
}
struct ChangingAccounts(AtomicU64);
impl AccountProvider for ChangingAccounts {
    fn account(&self, _: &Pubkey) -> anyhow::Result<AccountData> {
        let slot = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(AccountData {
            slot,
            write_version: slot,
            account: AccountSharedData::new(slot, 0, &Pubkey::default()),
        })
    }
    fn newest_processed_slot(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
fn id(input: Pubkey, output: Pubkey, multiplier: u64) -> TestId {
    TestId {
        key: Pubkey::new_unique(),
        input,
        output,
        multiplier,
        partial: false,
        curve_reserve: None,
    }
}
fn provider(
    ids: Vec<TestId>,
    max_hops: usize,
) -> (RpcRouteProvider, Arc<Mutex<Vec<(Pubkey, u64)>>>) {
    let calls = Arc::new(Mutex::new(vec![]));
    let dex = Arc::new(TestDex {
        ids,
        calls: calls.clone(),
    });
    let mut config = Config::default();
    config.rpc_routing = Some(RpcRoutingConfig {
        refresh_seconds: 10,
        max_hops,
        max_paths: 64,
    });
    (
        RpcRouteProvider {
            graph: Arc::new(RwLock::new(Arc::new(Graph::new(vec![dex])))),
            edge_count: Arc::new(AtomicUsize::new(0)),
            accounts: Arc::new(ChangingAccounts(AtomicU64::new(0))),
            config,
            refresh: tokio::sync::Mutex::new(Instant::now()),
            watched: Default::default(),
            legacy: Default::default(),
            registered: Default::default(),
            publish: Default::default(),
        },
        calls,
    )
}

#[test]
fn recursive_unpriced_edges_propagate_full_integer_outputs() {
    let m: Vec<_> = (0..5).map(|_| Pubkey::new_unique()).collect();
    let ids: Vec<_> = (0..4).map(|i| id(m[i], m[i + 1], (i + 2) as u64)).collect();
    let keys: Vec<_> = ids.iter().map(|i| i.key).collect();
    let (provider, calls) = provider(ids, 8);
    assert_eq!(provider.graph.read().unwrap().edges.len(), 4);
    // Above f64's exact integer range; no token prices/cache/list exists in this provider.
    let amount = 9_007_199_254_740_993;
    let route = provider
        .best_quote(m[0], m[4], amount, 12, SwapMode::ExactIn)
        .unwrap();
    assert_eq!(route.out_amount, amount * 120);
    assert_eq!(
        calls.lock().unwrap()[..4],
        [
            (keys[0], amount),
            (keys[1], amount * 2),
            (keys[2], amount * 6),
            (keys[3], amount * 24)
        ]
    );
    assert_eq!(route.steps.len(), 4);
    assert_eq!(route.price_impact_bps, Some(0)); // measured linear execution rate
    assert!(provider
        .best_quote(m[0], m[4], amount, 11, SwapMode::ExactIn)
        .is_err());
    assert!(provider
        .best_quote(m[0], m[4], amount, 12, SwapMode::ExactOut)
        .is_err());
}

#[test]
fn paths_reject_cycles_and_obey_hop_and_path_limits() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let c = Pubkey::new_unique();
    let (provider, _) = provider(
        vec![id(a, b, 2), id(b, a, 100), id(b, c, 3), id(a, c, 1)],
        4,
    );
    let graph = provider.graph.read().unwrap();
    let paths = graph.paths(a, c, 4, 20, 30);
    assert_eq!(paths.len(), 2);
    assert!(paths.iter().all(|p| p.len() <= 2));
    assert_eq!(graph.paths(a, c, 1, 20, 30).len(), 1);
    assert_eq!(graph.paths(a, c, 4, 1, 30).len(), 1);
    assert!(graph.paths(a, c, 4, 20, 2).is_empty());
}

#[test]
fn partial_fill_does_not_win_and_refreshed_graph_replaces_route() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let mut partial = id(a, b, 100);
    partial.partial = true;
    let (provider, calls) = provider(vec![partial, id(a, b, 2)], 4);
    assert_eq!(
        provider
            .best_quote(a, b, 100, 10, SwapMode::ExactIn)
            .unwrap()
            .out_amount,
        200
    );
    *provider.graph.write().unwrap() = Arc::new(Graph::new(vec![Arc::new(TestDex {
        ids: vec![id(a, b, 3)],
        calls,
    })]));
    assert_eq!(
        provider
            .best_quote(a, b, 100, 10, SwapMode::ExactIn)
            .unwrap()
            .out_amount,
        300
    );
}

fn response(ids: &[TestId]) -> QuoteResponse {
    let mut amount = 10u64;
    let route_plan = ids
        .iter()
        .map(|id| {
            let input = amount;
            amount *= id.multiplier;
            RoutePlan {
                percent: 100,
                swap_info: Some(SwapInfo {
                    amm_key: id.key.to_string(),
                    label: None,
                    input_mint: id.input.to_string(),
                    output_mint: id.output.to_string(),
                    in_amount: input.to_string(),
                    out_amount: amount.to_string(),
                    fee_amount: "0".into(),
                    fee_mint: id.input.to_string(),
                }),
            }
        })
        .collect();
    QuoteResponse {
        input_mint: ids[0].input.to_string(),
        in_amount: Some("10".into()),
        output_mint: ids.last().unwrap().output.to_string(),
        out_amount: amount.to_string(),
        other_amount_threshold: "1".into(),
        swap_mode: "ExactIn".into(),
        slippage_bps: 100,
        platform_fee: None,
        price_impact_pct: Some("0".into()),
        route_plan,
        accounts: None,
        context_slot: 1,
        time_taken: 0.0,
    }
}

#[test]
fn imported_route_validates_every_amount_and_mode() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let c = Pubkey::new_unique();
    let ids = vec![id(a, b, 2), id(b, c, 3)];
    let valid = response(&ids);
    let (provider, _) = provider(ids, 2);
    assert_eq!(provider.try_from(&valid).unwrap().out_amount, 60);
    for mutate in [
        |q: &mut QuoteResponse| q.in_amount = Some("11".into()),
        |q: &mut QuoteResponse| q.route_plan[1].swap_info.as_mut().unwrap().in_amount = "19".into(),
        |q: &mut QuoteResponse| q.out_amount = "61".into(),
        |q: &mut QuoteResponse| q.route_plan[0].swap_info.as_mut().unwrap().out_amount = "0".into(),
        |q: &mut QuoteResponse| q.swap_mode = "ExactOut".into(),
        |q: &mut QuoteResponse| q.route_plan[0].percent = 50,
        |q: &mut QuoteResponse| {
            q.route_plan[0].swap_info.as_mut().unwrap().amm_key = Pubkey::new_unique().to_string()
        },
        |q: &mut QuoteResponse| {
            q.route_plan[1].swap_info.as_mut().unwrap().input_mint =
                Pubkey::new_unique().to_string()
        },
        |q: &mut QuoteResponse| q.route_plan.push(q.route_plan[1].clone()),
        |q: &mut QuoteResponse| q.route_plan.clear(),
    ] as [fn(&mut QuoteResponse); 10]
    {
        let mut invalid = valid.clone();
        mutate(&mut invalid);
        assert!(
            provider.try_from(&invalid).is_err(),
            "accepted invalid quote: {invalid:?}"
        );
    }
}

#[test]
fn imported_route_cannot_repeat_a_mint_even_when_edge_exists() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let c = Pubkey::new_unique();
    let ids = vec![id(a, b, 2), id(b, a, 3), id(a, c, 4)];
    let invalid = response(&ids);
    let (provider, _) = provider(ids, 4);
    assert!(provider.try_from(&invalid).is_err());
}

#[test]
fn request_account_cache_is_scoped_to_one_quote() {
    let source = Arc::new(ChangingAccounts(AtomicU64::new(0)));
    let key = Pubkey::new_unique();
    let first = RequestAccounts {
        source: source.clone(),
        accounts: Default::default(),
    };
    assert_eq!(first.account(&key).unwrap().slot, 1);
    assert_eq!(first.account(&key).unwrap().slot, 1);
    assert_eq!(first.newest_processed_slot(), 1);
    let next = RequestAccounts {
        source,
        accounts: Default::default(),
    };
    assert_eq!(next.account(&key).unwrap().slot, 2);
}

#[test]
fn discovery_batches_are_bounded_and_unknown_mints_have_a_retry_cooldown() {
    let now = Instant::now();
    let mut cache = RootCache::default();
    for _ in 0..ROOT_BATCH + 2 {
        cache.schedule(Pubkey::new_unique(), false, now).unwrap();
    }
    let first = cache.due(now);
    assert_eq!(first.len(), ROOT_BATCH);
    let second = cache.due(now);
    assert_eq!(second.len(), 2);
    assert!(first.iter().all(|mint| !second.contains(mint)));
    assert!(cache
        .due(now + NEGATIVE_RETRY - Duration::from_millis(1))
        .is_empty());
    assert_eq!(cache.due(now + NEGATIVE_RETRY).len(), ROOT_BATCH);
}

#[tokio::test]
async fn discovery_deadline_cancels_pending_work_without_changing_recursion_depth() {
    struct Cancelled(Arc<AtomicU64>);
    impl Drop for Cancelled {
        fn drop(&mut self) {
            self.0.store(1, Ordering::SeqCst);
        }
    }
    let flag = Arc::new(AtomicU64::new(0));
    let guard = Cancelled(flag.clone());
    let request = async move {
        let _guard = guard;
        std::future::pending::<anyhow::Result<()>>().await
    };
    let error = bounded_discovery(request, Duration::from_millis(1))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("time budget"));
    assert_eq!(flag.load(Ordering::SeqCst), 1);
}

#[test]
fn discovery_diagnostics_redact_credential_bearing_rpc_urls() {
    let error = anyhow::anyhow!("request https://rpc.example/path?api-key=private failed: 429; retry https://backup.example/key");
    let text = redacted_discovery_error(&error);
    assert!(text.contains("429"));
    assert!(!text.contains("private"));
    assert!(!text.contains("rpc.example"));
    assert!(!text.contains("backup.example"));
}

#[test]
fn discovery_cache_evicts_idle_requests_but_preserves_configured_roots() {
    let now = Instant::now();
    let pinned = Pubkey::new_unique();
    let idle = Pubkey::new_unique();
    let mut cache = RootCache::default();
    cache.schedule(pinned, true, now).unwrap();
    cache.schedule(idle, false, now).unwrap();
    for _ in 2..ROOT_LIMIT {
        cache
            .schedule(Pubkey::new_unique(), false, now + Duration::from_secs(1))
            .unwrap();
    }
    let incoming = Pubkey::new_unique();
    cache
        .schedule(incoming, false, now + Duration::from_secs(2))
        .unwrap();
    assert_eq!(cache.entries.len(), ROOT_LIMIT);
    assert!(cache.entries.contains_key(&pinned));
    assert!(cache.entries.contains_key(&incoming));
    assert!(!cache.entries.contains_key(&idle));
}

#[test]
fn venue_publication_preserves_discovered_roots_and_exposes_loading_errors() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let c = Pubkey::new_unique();
    let (mut provider, calls) = provider(vec![id(a, b, 2)], 4);
    provider.config.cropper.enabled = true;
    let root_dex = provider.graph.read().unwrap().edges[0].dex.clone();
    let now = Instant::now();
    provider
        .watched
        .lock()
        .unwrap()
        .schedule(a, false, now)
        .unwrap();
    provider
        .watched
        .lock()
        .unwrap()
        .entries
        .get_mut(&a)
        .unwrap()
        .adapter = Some(root_dex);
    let legacy = Arc::new(TestDex {
        ids: vec![id(b, c, 3)],
        calls,
    });
    provider
        .legacy
        .lock()
        .unwrap()
        .adapters
        .insert("Cropper", legacy);
    provider
        .legacy
        .lock()
        .unwrap()
        .status
        .insert("Cropper", "error".into());
    provider.publish_graph();
    assert_eq!(
        provider
            .best_quote(a, c, 10, 6, SwapMode::ExactIn)
            .unwrap()
            .out_amount,
        60
    );
    let status = provider.discovery_status();
    assert_eq!(status["venues"][0]["venue"], "Cropper");
    assert_eq!(status["venues"][0]["available"], true);
    assert_eq!(status["venues"][0]["status"], "error");
    assert_eq!(status["edges"], 2);
}

#[test]
fn price_impact_uses_a_smaller_real_path_quote_on_the_same_snapshot() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let mut curve = id(a, b, 1);
    curve.curve_reserve = Some(1_000_000_000);
    let key = curve.key;
    let (mut provider, calls) = provider(vec![curve], 2);
    let changing = Arc::new(ChangingAccounts(AtomicU64::new(0)));
    provider.accounts = changing.clone();
    let route = provider
        .best_quote(a, b, 100_000_000, 10, SwapMode::ExactIn)
        .unwrap();
    assert_eq!(route.out_amount, 90_909_090);
    assert_eq!(route.price_impact_bps, Some(908));
    assert_eq!(
        *calls.lock().unwrap(),
        vec![(key, 100_000_000), (key, 10_000), (key, 100_000)]
    );
    assert_eq!(
        changing.0.load(Ordering::SeqCst),
        1,
        "impact samples must reuse the execution quote's account value"
    );
}

#[test]
fn unavailable_price_impact_serializes_as_null_and_round_trips() {
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let ids = vec![id(a, b, 2)];
    let (provider, _) = provider(ids.clone(), 2);
    let route = provider
        .best_quote(a, b, 100, 10, SwapMode::ExactIn)
        .unwrap();
    assert_eq!(route.price_impact_bps, None);
    let mut quote = response(&ids);
    quote.price_impact_pct = None;
    let wire = serde_json::to_value(&quote).unwrap();
    assert!(wire["priceImpactPct"].is_null());
    let parsed: QuoteResponse = serde_json::from_value(wire).unwrap();
    assert_eq!(parsed.price_impact_pct, None);
    assert!(provider.try_from(&parsed).is_ok());
}

#[tokio::test]
async fn initial_pair_snapshot_preserves_existing_filters_and_queries_both_orientations() {
    use solana_client::rpc_config::RpcProgramAccountsConfig;
    use solana_client::rpc_filter::RpcFilterType;
    struct RecordingRpc(Arc<Mutex<Vec<RpcProgramAccountsConfig>>>);
    #[async_trait::async_trait]
    impl RouterRpcClientTrait for RecordingRpc {
        async fn get_account(
            &mut self,
            _: &Pubkey,
        ) -> anyhow::Result<Option<solana_sdk::account::Account>> {
            unreachable!()
        }
        async fn get_multiple_accounts(
            &mut self,
            _: &HashSet<Pubkey>,
        ) -> anyhow::Result<Vec<(Pubkey, solana_sdk::account::Account)>> {
            unreachable!()
        }
        async fn get_program_accounts_with_config(
            &mut self,
            _: &Pubkey,
            config: RpcProgramAccountsConfig,
        ) -> anyhow::Result<Vec<router_feed_lib::account_write::AccountWrite>> {
            self.0.lock().unwrap().push(config);
            Ok(vec![])
        }
        fn is_gpa_compression_enabled(&self) -> bool {
            false
        }
    }
    let calls = Arc::new(Mutex::new(vec![]));
    let a = Pubkey::new_unique();
    let b = Pubkey::new_unique();
    let mut rpc = PairDiscoveryRpc {
        inner: RouterRpcClient {
            rpc: Box::new(RecordingRpc(calls.clone())),
            gpa_compression_enabled: false,
        },
        pair: (a, b),
    };
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![RpcFilterType::DataSize(653)]),
        ..Default::default()
    };
    rpc.get_program_accounts_with_config(
        &"whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
            .parse()
            .unwrap(),
        config.clone(),
    )
    .await
    .unwrap();
    {
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        for (call, left, right) in [(&calls[0], a, b), (&calls[1], b, a)] {
            let filters = call.filters.as_ref().unwrap();
            assert_eq!(filters[0], RpcFilterType::DataSize(653));
            assert_eq!(filters.len(), 3);
            let mut account = vec![0; 653];
            account[101..133].copy_from_slice(left.as_ref());
            account[181..213].copy_from_slice(right.as_ref());
            for filter in &filters[1..] {
                let RpcFilterType::Memcmp(check) = filter else {
                    panic!("missing mint filter")
                };
                assert!(check.bytes_match(&account));
            }
        }
    }
    // Unrelated program requests remain unchanged; bootstrap is not a global token allowlist.
    rpc.get_program_accounts_with_config(&Pubkey::new_unique(), config)
        .await
        .unwrap();
    assert_eq!(calls.lock().unwrap()[2].filters.as_ref().unwrap().len(), 1);
}

#[test]
fn hydration_rechecks_owner_filters_and_applies_requested_slice_after_validation() {
    use solana_client::{
        rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
        rpc_filter::{Memcmp, RpcFilterType},
    };
    let program = Pubkey::new_unique();
    let config = RpcProgramAccountsConfig {
        filters: Some(vec![
            RpcFilterType::DataSize(4),
            RpcFilterType::Memcmp(Memcmp::new_raw_bytes(1, vec![2, 3])),
        ]),
        account_config: RpcAccountInfoConfig {
            data_slice: Some(solana_account_decoder::UiDataSliceConfig {
                offset: 2,
                length: 1,
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let account = solana_sdk::account::Account {
        lamports: 1,
        data: vec![1, 2, 3, 4],
        owner: program,
        executable: false,
        rent_epoch: 0,
    };
    assert_eq!(
        hydrated_discovery_account(&program, &config, account.clone())
            .unwrap()
            .data,
        vec![3]
    );
    let mut changed = account.clone();
    changed.owner = Pubkey::new_unique();
    assert!(hydrated_discovery_account(&program, &config, changed).is_none());
    let mut changed = account.clone();
    changed.data[1] = 9;
    assert!(hydrated_discovery_account(&program, &config, changed).is_none());
    let mut changed = account;
    changed.executable = true;
    assert!(hydrated_discovery_account(&program, &config, changed).is_none());
}
