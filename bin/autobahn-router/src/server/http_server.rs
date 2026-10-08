use crate::prelude::*;
use crate::server::errors::*;
use crate::server::route_provider::RouteProvider;
use axum::extract::Query;
use axum::response::Html;
use axum::{extract::Form, http::header::HeaderMap, routing, Json, Router};
use router_lib::model::quote_request::QuoteRequest;
use router_lib::model::transaction_version::TransactionVersion;
use super::transaction_v1;
use router_lib::model::quote_response::{QuoteAccount, QuoteResponse};
use router_lib::model::swap_request::{SwapForm, SwapRequest};
use router_lib::model::swap_response::{InstructionResponse, SwapIxResponse, SwapResponse, TransactionConfig};
use serde_json::Value;
use solana_program::address_lookup_table::AddressLookupTableAccount;
use solana_program::message::VersionedMessage;
use solana_sdk::account::ReadableAccount;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::signature::NullSigner;
use solana_sdk::transaction::VersionedTransaction;
use std::time::Instant;
use tokio::task::JoinHandle;
use tower_http::cors::{AllowHeaders, AllowMethods, Any, CorsLayer};

use crate::alt::alt_optimizer;
use crate::ix_builder::SwapInstructionsBuilder;
use crate::liquidity::{LiquidityProvider, LiquidityProviderArcRw};
use crate::routing_types::Route;
use crate::server::alt_provider::AltProvider;
use crate::server::hash_provider::HashProvider;
use crate::{debug_tools, metrics};
use router_config_lib::Config;
use router_lib::dex::{AccountProvider, AccountProviderView, SwapMode};
use router_lib::model::liquidity_request::LiquidityRequest;
use router_lib::model::liquidity_response::LiquidityResponse;
use router_lib::model::quote_response::{RoutePlan, SwapInfo};

// make sure the transaction can be executed
const MAX_ACCOUNTS_PER_TX: usize = 64;
const DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: u64 = 10_000;

pub struct HttpServer {
    pub join_handle: JoinHandle<()>,
}

struct BuiltSwapTransaction {
    bytes: Vec<u8>,
    accounts_count: usize,
    last_valid_block_height: u64,
    priority_fee_lamports: u64,
}

fn amount_threshold(amount: u64, slippage_bps: u64, exact_out: bool) -> anyhow::Result<u64> {
    anyhow::ensure!(slippage_bps < 10_000, "Slippage must be between 0 and 9999 basis points");
    let bps = if exact_out { 10_000 + slippage_bps } else { 10_000 - slippage_bps };
    let numerator = u128::from(amount) * u128::from(bps);
    let rounded = if exact_out { (numerator + 9_999) / 10_000 } else { numerator / 10_000 };
    u64::try_from(rounded).map_err(|_| anyhow::anyhow!("Slippage threshold exceeds token amount range"))
}

impl HttpServer {
    pub async fn start<
        TRouteProvider: RouteProvider + Send + Sync + 'static,
        THashProvider: HashProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TAccountProvider: AccountProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        route_provider: Arc<TRouteProvider>,
        hash_provider: Arc<THashProvider>,
        alt_provider: Arc<TAltProvider>,
        live_account_provider: Arc<TAccountProvider>,
        liquidity_provider: LiquidityProviderArcRw,
        ix_builder: Arc<TIxBuilder>,
        config: Config,
        exit: tokio::sync::broadcast::Receiver<()>,
    ) -> anyhow::Result<HttpServer> {
        let join_handle = HttpServer::new_server(
            route_provider,
            hash_provider,
            alt_provider,
            live_account_provider,
            liquidity_provider,
            ix_builder,
            config,
            exit,
        )
        .await?;

        Ok(HttpServer { join_handle })
    }
}

impl HttpServer {
    async fn new_server<
        TRouteProvider: RouteProvider + Send + Sync + 'static,
        THashProvider: HashProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TAccountProvider: AccountProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        route_provider: Arc<TRouteProvider>,
        hash_provider: Arc<THashProvider>,
        alt_provider: Arc<TAltProvider>,
        live_account_provider: Arc<TAccountProvider>,
        liquidity_provider: LiquidityProviderArcRw,
        ix_builder: Arc<TIxBuilder>,
        config: Config,
        exit: tokio::sync::broadcast::Receiver<()>,
    ) -> anyhow::Result<JoinHandle<()>> {
        let addr = &config.server.address;
        let alt = config.routing.lookup_tables.clone();
        let should_reprice = config
            .debug_config
            .as_ref()
            .map(|x| x.reprice_using_live_rpc)
            .unwrap_or(false);
        let reprice_frequency = if should_reprice {
            config
                .debug_config
                .as_ref()
                .map(|x| x.reprice_probability)
                .unwrap_or(1.0)
        } else {
            0.0
        };

        let app = Self::setup_router(
            alt,
            route_provider,
            hash_provider,
            alt_provider,
            live_account_provider,
            liquidity_provider,
            ix_builder,
            reprice_frequency,
        )?;
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let handle = axum::serve(listener, app).with_graceful_shutdown(Self::shutdown_signal(exit));

        info!("HTTP Server started at {}", addr);

        let join_handle = tokio::spawn(async move {
            handle.await.expect("HTTP Server failed");
        });

        Ok(join_handle)
    }

    async fn shutdown_signal(mut exit: tokio::sync::broadcast::Receiver<()>) {
        exit.recv()
            .await
            .expect("listening to exit broadcast failed");
        warn!("shutting down http server...");
    }

    async fn quote_handler<
        TRouteProvider: RouteProvider + Send + Sync + 'static,
        THashProvider: HashProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TAccountProvider: AccountProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        address_lookup_table_addresses: Vec<String>,
        route_provider: Arc<TRouteProvider>,
        hash_provider: Arc<THashProvider>,
        alt_provider: Arc<TAltProvider>,
        live_account_provider: Arc<TAccountProvider>,
        ix_builder: Arc<TIxBuilder>,
        reprice_probability: f64,
        Form(input): Form<QuoteRequest>,
    ) -> Result<Json<Value>, AppError> {
        let started_at = Instant::now();
        if input.amount == 0 { return Err(anyhow::anyhow!("Amount must be positive").into()); }
        amount_threshold(input.amount, input.slippage_bps, false)?;
        let input_mint = Pubkey::from_str(&input.input_mint)?;
        let output_mint = Pubkey::from_str(&input.output_mint)?;
        let swap_mode = input.swap_mode.or(input.mode).unwrap_or_default();
        let mut max_accounts = input.max_accounts.unwrap_or(64) as usize;

        let route = loop {
            let route_candidate = route_provider.best_quote(
                input_mint,
                output_mint,
                input.amount,
                max_accounts,
                swap_mode,
            )?;

            let built = Self::build_swap_tx(
                address_lookup_table_addresses.clone(),
                hash_provider.clone(),
                alt_provider.clone(),
                ix_builder.clone(),
                &route_candidate,
                Pubkey::new_unique().to_string(),
                true,
                true,
                0,
                "0".to_string(),
                swap_mode,
                DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
                input.transaction_version,
            )
            .await?;

            let tx_size = built.bytes.len();
            let accounts_count = built.accounts_count;
            if accounts_count <= MAX_ACCOUNTS_PER_TX && tx_size <= input.transaction_version.max_size() {
                break Ok(route_candidate);
            } else if max_accounts >= 10 {
                warn!("TX too big ({tx_size} bytes, {accounts_count} accounts), retrying with fewer accounts; max_accounts was {max_accounts}..");
                max_accounts -= 5;
            } else {
                break Err(anyhow::format_err!(
                    "TX too big ({tx_size} bytes, {accounts_count} accounts), aborting"
                ));
            }
        };

        let route: Route = route?;

        Self::log_repriced_amount(live_account_provider, reprice_probability, &route);

        let other_amount_threshold = amount_threshold(
            if swap_mode == SwapMode::ExactOut { route.in_amount } else { route.out_amount },
            input.slippage_bps,
            swap_mode == SwapMode::ExactOut,
        )?;

        let route_plan = route
            .steps
            .iter()
            .map(|step| RoutePlan {
                percent: 100,
                swap_info: Some(SwapInfo {
                    amm_key: step.edge.key().to_string(),
                    label: Some(step.edge.dex.name().to_string()),
                    input_mint: step.edge.input_mint.to_string(),
                    output_mint: step.edge.output_mint.to_string(),
                    in_amount: step.in_amount.to_string(),
                    out_amount: step.out_amount.to_string(),
                    fee_amount: step.fee_amount.to_string(),
                    fee_mint: step.fee_mint.to_string(),
                }),
            })
            .collect_vec();

        let accounts = match route.accounts {
            None => None,
            Some(a) => Some(
                a.iter()
                    .map(|x| QuoteAccount {
                        address: x.0.to_string(),
                        slot: x.1.slot,
                        data: x.1.account.data().iter().copied().collect::<Vec<u8>>(),
                    })
                    .collect(),
            ),
        };

        let context_slot = route.slot;
        let json_response = serde_json::json!(QuoteResponse {
            input_mint: input_mint.to_string(),
            in_amount: Some(route.in_amount.to_string()),
            output_mint: output_mint.to_string(),
            out_amount: route.out_amount.to_string(),
            other_amount_threshold: other_amount_threshold.to_string(),
            swap_mode: swap_mode.to_string(),
            slippage_bps: input.slippage_bps as i32,
            platform_fee: None, // TODO
            price_impact_pct: route
                .price_impact_bps
                .map(|bps| (bps as f64 / 100.0).to_string()),
            route_plan,
            accounts,
            context_slot,
            time_taken: started_at.elapsed().as_secs_f64(),
        });

        Ok(Json(json_response))
    }

    async fn swap_handler<
        TRouteProvider: RouteProvider + Send + Sync + 'static,
        THashProvider: HashProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TAccountProvider: AccountProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        address_lookup_table_addresses: Vec<String>,
        route_provider: Arc<TRouteProvider>,
        hash_provider: Arc<THashProvider>,
        alt_provider: Arc<TAltProvider>,
        live_account_provider: Arc<TAccountProvider>,
        ix_builder: Arc<TIxBuilder>,
        _reprice_probability: f64,
        Query(_query): Query<SwapForm>,
        Json(input): Json<SwapRequest>,
    ) -> Result<Json<Value>, AppError> {
        if input.as_legacy_transaction { return Err(anyhow::anyhow!("Legacy transactions are unsupported; request transactionVersion 0 or 1").into()); }
        let route = route_provider.try_from(&input.quote_response)?;
        let swap_mode: SwapMode = SwapMode::from_str(&input.quote_response.swap_mode)
            .map_err(|_| anyhow::Error::msg("Invalid SwapMode"))?;
        let route = refresh_before_build(
            route,
            live_account_provider,
            swap_mode,
            input.quote_response.other_amount_threshold.parse()?,
            input.quote_response.slippage_bps,
        )?;
        // Exact-out still uses the executor's exact-input CPI chaining. Spend the
        // freshly required amount, never the user's entire maximum by default.
        let build_threshold = match swap_mode {
            SwapMode::ExactIn => input.quote_response.other_amount_threshold.clone(),
            SwapMode::ExactOut => route.in_amount.to_string(),
        };

        let compute_unit_price_micro_lamports = match input.compute_unit_price_micro_lamports {
            Some(price) => price,
            None => DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
        };

        let built = Self::build_swap_tx(
            address_lookup_table_addresses,
            hash_provider,
            alt_provider,
            ix_builder,
            &route,
            input.user_public_key,
            input.wrap_and_unwrap_sol,
            input.auto_create_out_ata,
            input.quote_response.slippage_bps,
            build_threshold,
            swap_mode,
            compute_unit_price_micro_lamports,
            input.transaction_version,
        )
        .await?;

        if built.bytes.len() > input.transaction_version.max_size() || built.accounts_count > MAX_ACCOUNTS_PER_TX {
            return Err(anyhow::anyhow!("Route exceeds transaction limits; request a new quote").into());
        }
        let json_response = serde_json::json!(SwapResponse {
            transaction_version: input.transaction_version,
            swap_transaction: built.bytes,
            last_valid_block_height: built.last_valid_block_height,
            priorization_fee_lamports: built.priority_fee_lamports,
        });

        Ok(Json(json_response))
    }

    fn log_repriced_amount<TAccountProvider: AccountProvider + Send + Sync + 'static>(
        live_account_provider: Arc<TAccountProvider>,
        reprice_probability: f64,
        route: &Route,
    ) {
        let should_reprice = rand::random::<f64>() < reprice_probability;
        if !should_reprice {
            return;
        }

        let repriced_out_amount = reprice(&route, live_account_provider);
        match repriced_out_amount {
            Ok(repriced_out) => {
                let diff = ((repriced_out as f64 / route.out_amount as f64) - 1.0) * 10000.0;
                let pair = format!(
                    "{}-{}",
                    debug_tools::name(&route.input_mint),
                    debug_tools::name(&route.output_mint)
                );
                metrics::REPRICING_DIFF_BPS
                    .with_label_values(&[&pair])
                    .set(diff);

                info!(
                    "Router quote: {}, Rpc quote: {}, Diff: {:.1}bps",
                    route.out_amount, repriced_out, diff
                );
            }
            Err(e) => {
                warn!("Repricing failed: {:?}", e)
            }
        }
    }

    async fn build_swap_tx<
        THashProvider: HashProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        address_lookup_table_addresses: Vec<String>,
        hash_provider: Arc<THashProvider>,
        alt_provider: Arc<TAltProvider>,
        ix_builder: Arc<TIxBuilder>,
        route_plan: &Route,
        wallet_pk: String,
        wrap_unwrap_sol: bool,
        auto_create_out_ata: bool,
        slippage_bps: i32,
        other_amount_threshold: String,
        swap_mode: SwapMode,
        compute_unit_price_micro_lamports: u64,
        transaction_version: TransactionVersion,
    ) -> Result<BuiltSwapTransaction, AppError> {
        let wallet_pk = Pubkey::from_str(&wallet_pk)?;

        let ixs = ix_builder.build_ixs(
            &wallet_pk,
            route_plan,
            wrap_unwrap_sol,
            auto_create_out_ata,
            slippage_bps,
            other_amount_threshold.parse()?,
            swap_mode,
        )?;

        let priority_fee_lamports = u64::try_from(
            (u128::from(compute_unit_price_micro_lamports) * u128::from(ixs.cu_estimate) + 999_999) / 1_000_000
        ).map_err(|_| anyhow::anyhow!("Priority fee exceeds lamport range"))?;
        let cu_estimate = ixs.cu_estimate;
        let transaction_addresses = ixs.accounts().into_iter().collect();
        let mut instructions = ixs.setup_instructions.into_iter()
            .chain(std::iter::once(ixs.swap_instruction))
            .chain(ixs.cleanup_instructions.into_iter())
            .collect_vec();
        let (blockhash, last_valid_block_height) = hash_provider.get_latest_hash().await?;
        let (bytes, accounts) = match transaction_version {
            TransactionVersion::V1 => transaction_v1::compile_unsigned(
                &wallet_pk, &instructions, &blockhash, cu_estimate, priority_fee_lamports,
            )?,
            TransactionVersion::V0 => {
                instructions.splice(0..0, [
                    ComputeBudgetInstruction::set_compute_unit_price(compute_unit_price_micro_lamports),
                    ComputeBudgetInstruction::set_compute_unit_limit(cu_estimate),
                ]);
                let all_alts = Self::load_all_alts(address_lookup_table_addresses, alt_provider).await;
                let alts = alt_optimizer::get_best_alt(&all_alts, &transaction_addresses)?;
                let v0_message = solana_sdk::message::v0::Message::try_compile(
                    &wallet_pk, &instructions, &alts, blockhash,
                )?;
                let accounts = v0_message.account_keys.len() + v0_message.address_table_lookups.iter()
                    .map(|lookup| lookup.writable_indexes.len() + lookup.readonly_indexes.len()).sum::<usize>();
                let tx = VersionedTransaction::try_new(VersionedMessage::V0(v0_message), &[&NullSigner::new(&wallet_pk)])?;
                (bincode::serialize(&tx)?, accounts)
            }
        };

        Ok(BuiltSwapTransaction { bytes, accounts_count: accounts, last_valid_block_height, priority_fee_lamports })
    }

    async fn swap_ix_handler<
        TRouteProvider: RouteProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TAccountProvider: AccountProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        address_lookup_table_addresses: Vec<String>,
        route_provider: Arc<TRouteProvider>,
        alt_provider: Arc<TAltProvider>,
        live_account_provider: Arc<TAccountProvider>,
        ix_builder: Arc<TIxBuilder>,
        Query(_query): Query<SwapForm>,
        Json(input): Json<SwapRequest>,
    ) -> Result<Json<Value>, AppError> {
        if input.as_legacy_transaction { return Err(anyhow::anyhow!("Legacy transactions are unsupported; request transactionVersion 0 or 1").into()); }
        let wallet_pk = Pubkey::from_str(&input.user_public_key)?;

        let route_plan = route_provider.try_from(&input.quote_response)?;
        let swap_mode: SwapMode = SwapMode::from_str(&input.quote_response.swap_mode)
            .map_err(|_| anyhow::Error::msg("Invalid SwapMode"))?;
        let route_plan = refresh_before_build(
            route_plan,
            live_account_provider,
            swap_mode,
            input.quote_response.other_amount_threshold.parse()?,
            input.quote_response.slippage_bps,
        )?;
        let build_threshold = match swap_mode {
            SwapMode::ExactIn => input.quote_response.other_amount_threshold.parse()?,
            SwapMode::ExactOut => route_plan.in_amount,
        };

        let compute_unit_price_micro_lamports = match input.compute_unit_price_micro_lamports {
            Some(price) => price,
            None => DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
        };

        let ixs = ix_builder.build_ixs(
            &wallet_pk,
            &route_plan,
            input.wrap_and_unwrap_sol,
            input.auto_create_out_ata,
            input.quote_response.slippage_bps,
            build_threshold,
            swap_mode,
        )?;

        let transaction_addresses = ixs.accounts().into_iter().collect();
        let alts = if input.transaction_version == TransactionVersion::V0 {
            let all_alts = Self::load_all_alts(address_lookup_table_addresses, alt_provider).await;
            alt_optimizer::get_best_alt(&all_alts, &transaction_addresses)?
        } else { vec![] };

        let swap_ix = InstructionResponse::from_ix(ixs.swap_instruction)?;
        let setup_ixs: anyhow::Result<Vec<_>> = ixs
            .setup_instructions
            .into_iter()
            .map(|x| InstructionResponse::from_ix(x))
            .collect();
        let cleanup_ixs: anyhow::Result<Vec<_>> = ixs
            .cleanup_instructions
            .into_iter()
            .map(|x| InstructionResponse::from_ix(x))
            .collect();

        let compute_budget_ixs = if input.transaction_version == TransactionVersion::V0 { vec![
            InstructionResponse::from_ix(ComputeBudgetInstruction::set_compute_unit_price(
                compute_unit_price_micro_lamports,
            ))?,
            InstructionResponse::from_ix(ComputeBudgetInstruction::set_compute_unit_limit(
                ixs.cu_estimate,
            ))?,
        ] } else { vec![] };
        let transaction_config = if input.transaction_version == TransactionVersion::V1 {
            Some(TransactionConfig {
                compute_unit_limit: ixs.cu_estimate,
                loaded_accounts_data_size_limit: transaction_v1::MAX_LOADED_ACCOUNT_BYTES,
                priority_fee_lamports: u64::try_from((u128::from(compute_unit_price_micro_lamports)
                    * u128::from(ixs.cu_estimate) + 999_999) / 1_000_000)?,
            })
        } else { None };

        let json_response = serde_json::json!(SwapIxResponse {
            transaction_version: input.transaction_version,
            transaction_config,
            token_ledger_instruction: None,
            compute_budget_instructions: Some(compute_budget_ixs),
            setup_instructions: Some(setup_ixs?),
            swap_instruction: swap_ix,
            cleanup_instructions: Some(cleanup_ixs?),
            address_lookup_table_addresses: Some(alts.iter().map(|x| x.key.to_string()).collect()),
        });

        Ok(Json(json_response))
    }

    async fn handler() -> Html<&'static str> {
        Html("マンゴールーター")
    }

    async fn liquidity_handler(
        liquidity_provider: LiquidityProviderArcRw,
        Form(input): Form<LiquidityRequest>,
    ) -> Result<Json<Value>, AppError> {
        let mut result = HashMap::new();
        let reader = liquidity_provider.read().unwrap();

        for mint_str in input.mints.split(",") {
            let mint_str = mint_str.trim().to_string();
            let mint = Pubkey::from_str(&mint_str)?;
            result.insert(
                mint_str,
                reader.get_total_liquidity_in_dollars(mint).unwrap_or(0.0),
            );
        }

        drop(reader);
        let json_response = serde_json::json!(LiquidityResponse { liquidity: result });

        Ok(Json(json_response))
    }

    fn extract_client_key(headers: &HeaderMap) -> &str {
        if let Some(client_key) = headers.get("x-client-key") {
            client_key.to_str().unwrap_or("invalid")
        } else {
            "unknown"
        }
    }

    fn setup_router<
        TRouteProvider: RouteProvider + Send + Sync + 'static,
        THashProvider: HashProvider + Send + Sync + 'static,
        TAltProvider: AltProvider + Send + Sync + 'static,
        TAccountProvider: AccountProvider + Send + Sync + 'static,
        TIxBuilder: SwapInstructionsBuilder + Send + Sync + 'static,
    >(
        address_lookup_tables: Vec<String>,
        route_provider: Arc<TRouteProvider>,
        hash_provider: Arc<THashProvider>,
        alt_provider: Arc<TAltProvider>,
        live_account_provider: Arc<TAccountProvider>,
        liquidity_provider: LiquidityProviderArcRw,
        ix_builder: Arc<TIxBuilder>,
        reprice_probability: f64,
    ) -> anyhow::Result<Router<()>> {
        metrics::HTTP_REQUESTS_FAILED.reset();

        let mut router = Router::new().merge(super::liquidity_operations::routes());
        let cors = CorsLayer::new()
            .allow_methods(AllowMethods::any())
            .allow_headers(AllowHeaders::any())
            .allow_origin(Any);

        router = router.route("/", routing::get(Self::handler));
        let health_routes = route_provider.clone();
        router = router.route(
            "/health",
            routing::get(move || {
                let discovery = health_routes.discovery_status();
                async move { Json(serde_json::json!({ "status": "ok", "discovery": discovery })) }
            }),
        );
        let venues = route_provider.clone();
        router = router.route("/venues", routing::get(move || {
            let status = venues.discovery_status();
            async move { Json(status) }
        }));

        let lp = liquidity_provider.clone();
        router = router.route(
            "/liquidity",
            routing::get(move |form| Self::liquidity_handler(lp, form)),
        );

        let alt = address_lookup_tables.clone();
        let rp = route_provider.clone();
        let hp = hash_provider.clone();
        let altp = alt_provider.clone();
        let lap = live_account_provider.clone();
        let ixb = ix_builder.clone();
        router = router.route(
            "/quote",
            routing::get(move |headers, form| async move {
                let client_key = Self::extract_client_key(&headers);
                let timer = metrics::HTTP_REQUEST_TIMING
                    .with_label_values(&["quote", client_key])
                    .start_timer();

                let response =
                    Self::quote_handler(alt, rp, hp, altp, lap, ixb, reprice_probability, form)
                        .await;

                match response {
                    Ok(_) => {
                        timer.observe_duration();
                        metrics::HTTP_REQUESTS_TOTAL
                            .with_label_values(&["quote", client_key])
                            .inc();
                    }
                    Err(_) => {
                        metrics::HTTP_REQUESTS_FAILED
                            .with_label_values(&["quote", client_key])
                            .inc();
                    }
                }
                response
            }),
        );

        let alt = address_lookup_tables.clone();
        let rp = route_provider.clone();
        let hp = hash_provider.clone();
        let altp = alt_provider.clone();
        let lap = live_account_provider.clone();
        let ixb = ix_builder.clone();
        router = router.route(
            "/swap",
            routing::post(move |headers, query, form| async move {
                let client_key = Self::extract_client_key(&headers);
                let timer = metrics::HTTP_REQUEST_TIMING
                    .with_label_values(&["swap", client_key])
                    .start_timer();

                let response = Self::swap_handler(
                    alt,
                    rp,
                    hp,
                    altp,
                    lap,
                    ixb,
                    reprice_probability,
                    query,
                    form,
                )
                .await;

                match response {
                    Ok(_) => {
                        timer.observe_duration();
                        metrics::HTTP_REQUESTS_TOTAL
                            .with_label_values(&["swap", client_key])
                            .inc();
                    }
                    Err(_) => {
                        metrics::HTTP_REQUESTS_FAILED
                            .with_label_values(&["swap", client_key])
                            .inc();
                    }
                }
                response
            }),
        );

        let alt = address_lookup_tables.clone();
        let rp = route_provider.clone();
        let altp = alt_provider.clone();
        let lap = live_account_provider.clone();
        let ixb = ix_builder.clone();
        router = router.route(
            "/swap-instructions",
            routing::post(move |headers, query, form| async move {
                let client_key = Self::extract_client_key(&headers);
                let timer = metrics::HTTP_REQUEST_TIMING
                    .with_label_values(&["swap-ix", client_key])
                    .start_timer();

                let response = Self::swap_ix_handler(alt, rp, altp, lap, ixb, query, form).await;

                match response {
                    Ok(_) => {
                        timer.observe_duration();
                        metrics::HTTP_REQUESTS_TOTAL
                            .with_label_values(&["swap-ix", client_key])
                            .inc();
                    }
                    Err(_) => {
                        metrics::HTTP_REQUESTS_FAILED
                            .with_label_values(&["swap-ix", client_key])
                            .inc();
                    }
                }
                response
            }),
        );

        router = router.layer(cors);
        Ok(router)
    }

    async fn load_all_alts<TAltProvider: AltProvider + Send + Sync + 'static>(
        address_lookup_table_addresses: Vec<String>,
        alt_provider: Arc<TAltProvider>,
    ) -> Vec<AddressLookupTableAccount> {
        let mut all_alts = vec![];
        for alt in address_lookup_table_addresses {
            match alt_provider.get_alt(Pubkey::from_str(&alt).unwrap()).await {
                Ok(alt) => all_alts.push(alt),
                Err(_) => {}
            }
        }
        all_alts
    }
}

fn reprice<TAccountProvider: AccountProvider + Send + Sync + 'static>(
    route: &Route,
    account_provider: Arc<TAccountProvider>,
) -> anyhow::Result<u64> {
    let account_provider = account_provider.clone() as AccountProviderView;
    let mut amount = route.in_amount;
    for step in &route.steps {
        let prepared_quote = step.edge.prepare(&account_provider)?;
        let quote = step.edge.quote(&prepared_quote, &account_provider, amount);
        amount = quote?.out_amount;
    }
    Ok(amount)
}

/// Re-quote every hop immediately before either transaction-building endpoint.
/// Client route amounts are a request, not an executable quote. Keep its signed
/// intent (exact amount plus slippage bound), replace all intermediate amounts.
fn refresh_before_build<TAccountProvider: AccountProvider + Send + Sync + 'static>(
    mut route: Route,
    provider: Arc<TAccountProvider>,
    mode: SwapMode,
    threshold: u64,
    slippage_bps: i32,
) -> anyhow::Result<Route> {
    anyhow::ensure!(
        (0..10_000).contains(&slippage_bps),
        "Invalid slippage tolerance"
    );
    anyhow::ensure!(
        threshold > 0 && route.in_amount > 0 && route.out_amount > 0,
        "Swap amounts and slippage bound must be positive"
    );
    anyhow::ensure!(!route.steps.is_empty(), "Cannot build an empty route");
    let mut mint = route.input_mint;
    let mut used = HashSet::new();
    for step in &route.steps {
        anyhow::ensure!(step.edge.input_mint == mint, "Disconnected route");
        anyhow::ensure!(
            used.insert(step.edge.key()),
            "Repeated pool requires sequential state simulation; request a different route"
        );
        mint = step.edge.output_mint;
    }
    anyhow::ensure!(mint == route.output_mint, "Route output mint mismatch");
    let provider = provider as AccountProviderView;
    match mode {
        SwapMode::ExactIn => {
            let mut amount = route.in_amount;
            for step in &mut route.steps {
                let state = step
                    .edge
                    .prepare(&provider)
                    .context("Fresh route account load failed")?;
                let quote = step
                    .edge
                    .quote(&state, &provider, amount)
                    .context("Fresh exact-input quote failed; request a new quote")?;
                anyhow::ensure!(
                    quote.in_amount == amount && quote.out_amount > 0,
                    "Fresh route did not fill the requested amount"
                );
                step.in_amount = quote.in_amount;
                step.out_amount = quote.out_amount;
                step.fee_amount = quote.fee_amount;
                step.fee_mint = quote.fee_mint;
                amount = quote.out_amount;
            }
            anyhow::ensure!(
                amount >= threshold,
                "Quote moved outside the minimum output; request a new quote"
            );
            route.out_amount = amount;
        }
        SwapMode::ExactOut => {
            let mut amount = route.out_amount;
            for step in route.steps.iter_mut().rev() {
                anyhow::ensure!(
                    step.edge.supports_exact_out(),
                    "Route does not support exact output"
                );
                let state = step
                    .edge
                    .prepare(&provider)
                    .context("Fresh route account load failed")?;
                let quote = step
                    .edge
                    .quote_exact_out(&state, &provider, amount)
                    .context("Fresh exact-output quote failed; request a new quote")?;
                anyhow::ensure!(
                    quote.out_amount >= amount && quote.in_amount > 0,
                    "Fresh route cannot fill the requested output"
                );
                step.in_amount = quote.in_amount;
                step.out_amount = amount;
                step.fee_amount = quote.fee_amount;
                step.fee_mint = quote.fee_mint;
                amount = quote.in_amount;
            }
            anyhow::ensure!(
                amount <= threshold,
                "Quote moved outside the maximum input; request a new quote"
            );
            route.in_amount = amount;
        }
    }
    // The client-supplied captured accounts no longer describe this fresh quote.
    route.accounts = None;
    Ok(route)
}

#[cfg(test)]
mod fresh_quote_tests {
    use super::*;
    use crate::edge::EdgeState;
    use crate::mock::test::{MockDexIdentifier, MockDexInterface};
    use crate::routing_types::RouteStep;
    use mango_feeds_connector::chain_data::AccountData;

    struct NoAccounts;
    impl AccountProvider for NoAccounts {
        fn account(&self, _key: &Pubkey) -> anyhow::Result<AccountData> {
            bail!("No accounts required by mock")
        }
        fn newest_processed_slot(&self) -> u64 {
            123
        }
    }

    fn route() -> Route {
        let mints = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        let steps = (0..2)
            .map(|i| {
                let edge = Arc::new(Edge {
                    input_mint: mints[i],
                    output_mint: mints[i + 1],
                    id: Arc::new(MockDexIdentifier {
                        key: Pubkey::new_unique(),
                        input_mint: mints[i],
                        output_mint: mints[i + 1],
                        price: (i + 2) as f64,
                    }),
                    dex: Arc::new(MockDexInterface {}),
                    accounts_needed: 0,
                    state: RwLock::new(EdgeState::default()),
                });
                RouteStep {
                    edge,
                    in_amount: 9999,
                    out_amount: 9999,
                    fee_amount: 9999,
                    fee_mint: mints[i],
                }
            })
            .collect();
        Route {
            input_mint: mints[0],
            output_mint: mints[2],
            in_amount: 100,
            out_amount: 600,
            price_impact_bps: None,
            steps,
            slot: 1,
            accounts: Some(HashMap::new()),
        }
    }

    #[test]
    fn thresholds_preserve_large_integer_amounts_and_round_in_the_users_favor() {
        assert_eq!(super::amount_threshold(u64::MAX, 1, false).unwrap(),
            (u128::from(u64::MAX) * 9_999 / 10_000) as u64);
        assert_eq!(super::amount_threshold(1, 1, true).unwrap(), 2);
        assert_eq!(super::amount_threshold(10_001, 1, false).unwrap(), 9_999);
        assert!(super::amount_threshold(u64::MAX, 1, true).is_err());
        assert!(super::amount_threshold(10, 10_000, false).is_err());
    }

    #[test]
    fn fresh_exact_in_replaces_stale_intermediate_amounts() {
        let result =
            refresh_before_build(route(), Arc::new(NoAccounts), SwapMode::ExactIn, 590, 100)
                .unwrap();
        assert_eq!(
            (result.steps[0].in_amount, result.steps[0].out_amount),
            (100, 200)
        );
        assert_eq!(
            (result.steps[1].in_amount, result.steps[1].out_amount),
            (200, 600)
        );
        assert_eq!(result.out_amount, 600);
        assert!(result.accounts.is_none());
    }

    #[test]
    fn fresh_exact_in_rejects_output_below_authorized_minimum() {
        let error =
            refresh_before_build(route(), Arc::new(NoAccounts), SwapMode::ExactIn, 601, 100)
                .err()
                .unwrap();
        assert!(error.to_string().contains("minimum output"));
    }

    #[test]
    fn fresh_exact_out_works_backwards_and_enforces_maximum_spend() {
        let result =
            refresh_before_build(route(), Arc::new(NoAccounts), SwapMode::ExactOut, 150, 100)
                .unwrap();
        assert_eq!(result.in_amount, 100);
        assert_eq!(result.steps[1].in_amount, 200);
        assert_eq!(result.out_amount, 600);
        let error =
            refresh_before_build(route(), Arc::new(NoAccounts), SwapMode::ExactOut, 99, 100)
                .err()
                .unwrap();
        assert!(error.to_string().contains("maximum input"));
    }

    #[test]
    fn malformed_route_and_unbounded_slippage_fail_before_build() {
        for tolerance in [-1, 10000, i32::MAX] {
            assert!(refresh_before_build(
                route(),
                Arc::new(NoAccounts),
                SwapMode::ExactIn,
                1,
                tolerance
            )
            .is_err());
        }
        let mut disconnected = route();
        disconnected.output_mint = Pubkey::new_unique();
        assert!(
            refresh_before_build(disconnected, Arc::new(NoAccounts), SwapMode::ExactIn, 1, 10)
                .is_err()
        );
        let mut repeated = route();
        repeated.steps.push(repeated.steps[0].clone());
        assert!(
            refresh_before_build(repeated, Arc::new(NoAccounts), SwapMode::ExactIn, 1, 10).is_err()
        );
        assert!(
            refresh_before_build(route(), Arc::new(NoAccounts), SwapMode::ExactIn, 0, 10).is_err()
        );
    }
}
