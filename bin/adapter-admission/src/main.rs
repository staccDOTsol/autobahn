//! Offline quote capture against a mainnet RPC snapshot, using the compiled adapter.
//! The independent simulator consumes the dump; this process never signs or sends.
use anyhow::{bail, Context, Result};
use router_lib::test_tools::{generate_dex_rpc_dump, rpc};
use std::{collections::HashMap, env, fs};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        bail!("usage: adapter-admission ADAPTER SNAPSHOT OPTIONS_JSON");
    }
    let options: HashMap<String, String> = serde_json::from_str(&fs::read_to_string(&args[3])?)?;
    let capture = env::var_os("ADMISSION_CAPTURE").is_some();
    let (mut rpc, chain_data) = if capture {
        rpc::rpc_dumper_client(env::var("ADMISSION_RPC_URL").context("ADMISSION_RPC_URL is required for recorded capture")?, &args[2])
    } else {
        rpc::rpc_replayer_client(&args[2])
    };
    let dex = adapter_registry::initialize_one(&args[1], &mut rpc, options).await?;
    // Two sizes prevent an adapter returning one canned price from passing replay.
    // Balance changes and exact outputs are independently verified in the simulator.
    let amount: u64 = env::var("ADMISSION_AMOUNT")
        .context("ADMISSION_AMOUNT is required")?
        .parse()?;
    if amount == 0 {
        bail!("zero admission amount");
    }
    if capture {
        return generate_dex_rpc_dump::run_dump_mainnet_data_with_custom_amount(
            dex,
            rpc,
            chain_data,
            Box::new(move |_| amount),
        )
        .await;
    }
    generate_dex_rpc_dump::run_dump_swap_ix_with_custom_amount(
        "admission_swap.lz4",
        dex,
        chain_data,
        Box::new(move |_| amount),
    )
    .await
}
