use anyhow::Error;
use litesvm::LiteSVM;
use log::{error, info, warn};
use router_test_lib::execution_dump::{ExecutionDump, ExecutionItem};
use router_test_lib::{execution_dump, serialize};
use sha2::Digest;
use sha2::Sha256;
use solana_program::clock::Clock;
use solana_program::instruction::Instruction;
use solana_program::program_pack::Pack;
use solana_program::program_stubs::{set_syscall_stubs, SyscallStubs};
use solana_program::pubkey::Pubkey;
use solana_program::sysvar::SysvarId;
use solana_program::{program_option::COption, rent::Rent};
use solana_sdk::account::{Account, AccountSharedData, ReadableAccount};
use solana_sdk::bpf_loader_upgradeable::UpgradeableLoaderState;
use solana_sdk::message::{Message, VersionedMessage};
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::VersionedTransaction;
use spl_associated_token_account::{
    get_associated_token_address, get_associated_token_address_with_program_id,
};
use spl_token::state::AccountState;
use spl_token_2022::extension::{
    immutable_owner::ImmutableOwner, transfer_fee::TransferFeeAmount, BaseStateWithExtensions,
    ExtensionType, StateWithExtensions, StateWithExtensionsMut,
};
use spl_token_2022::state::AccountState as AccountState2022;
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;

struct TestLogSyscallStubs;
impl SyscallStubs for TestLogSyscallStubs {
    fn sol_log(&self, message: &str) {
        info!("{}", message)
    }

    fn sol_log_data(&self, _fields: &[&[u8]]) {
        // do nothing
    }
}

#[tokio::test]
async fn test_quote_match_swap_for_orca() -> anyhow::Result<()> {
    run_all_swap_from_dump("orca_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_cropper() -> anyhow::Result<()> {
    run_all_swap_from_dump("cropper_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_saber() -> anyhow::Result<()> {
    run_all_swap_from_dump("saber_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_raydium() -> anyhow::Result<()> {
    run_all_swap_from_dump("raydium_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_raydium_cp() -> anyhow::Result<()> {
    run_all_swap_from_dump("raydium_cp_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_openbook_v2() -> anyhow::Result<()> {
    run_all_swap_from_dump("openbook_v2_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_infinity() -> anyhow::Result<()> {
    run_all_swap_from_dump("infinity_swap.lz4").await?
}

#[tokio::test]
async fn test_quote_match_swap_for_invariant() -> anyhow::Result<()> {
    run_all_swap_from_dump("invariant_swap.lz4").await?
}

#[tokio::test]
async fn test_admission_replay() -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var_os("ADMISSION_STRICT").is_some(),
        "admission must run with strict replay enabled"
    );
    run_all_swap_from_dump("admission_swap.lz4").await??;
    Ok(())
}

async fn run_all_swap_from_dump(dump_name: &str) -> Result<Result<(), Error>, Error> {
    let _ = tracing_subscriber::fmt::try_init();

    let mut skip_count = option_env!("SKIP_COUNT")
        .map(|x| u32::from_str(x).unwrap_or(0))
        .unwrap_or(0);
    let mut stop_at = u32::MAX;
    let skip_ixs_index = vec![];

    let run_lot_size = option_env!("RUN_LOT_SIZE")
        .map(|x| u32::from_str(x).unwrap_or(500))
        .unwrap_or(500);

    if let Some(run_lot) = option_env!("RUN_LOT").map(|x| u32::from_str(x).unwrap_or(0)) {
        skip_count = run_lot_size * run_lot;
        stop_at = run_lot_size * (1 + run_lot);
    }

    set_syscall_stubs(Box::new(TestLogSyscallStubs {}));

    let strict = std::env::var_os("ADMISSION_STRICT").is_some();
    let path = if strict {
        std::env::var("ADMISSION_REPLAY_PATH")?
    } else {
        format!("tests/fixtures/{}", dump_name)
    };
    let mut data = serialize::deserialize_from_file::<execution_dump::ExecutionDump>(&path)?;
    if strict {
        apply_recorded_mainnet_state(&mut data)?;
        anyhow::ensure!(
            !data.cache.is_empty() && data.cache.len() <= 4096,
            "expected bounded nonempty execution evidence"
        );
        anyhow::ensure!(
            data.cache.iter().all(|q| !q.is_exact_out
                && q.input_amount > 0
                && q.output_amount > 0
                && q.input_amount <= u64::MAX / 2),
            "invalid replay amounts/mode"
        );
    }
    let wallet = Keypair::from_base58_string(data.wallet_keypair.as_str());

    let mut success = 0;
    let mut index = 0;

    let clock_account = data
        .accounts
        .get(&Clock::id())
        .ok_or("invalid dump doesnt contain clock sysvar")
        .unwrap();
    let clock = clock_account.deserialize_data::<Clock>()?;
    let simulate = option_env!("SIMULATE")
        .map(|x| bool::from_str(x).unwrap_or(false))
        .unwrap_or_default();
    let debug_hashes = option_env!("DEBUG_HASHES")
        .map(|x| bool::from_str(x).unwrap_or(false))
        .unwrap_or_default();

    let mut ctx = setup_test_chain(&clock, &data)?;

    let mut cus_required = vec![];
    for quote in &data.cache {
        if quote.is_exact_out {
            continue;
        }

        index += 1;
        if skip_count > 0 {
            skip_count -= 1;
            continue;
        }
        if index > stop_at {
            continue;
        }
        if skip_ixs_index.contains(&(index)) {
            continue;
        }

        let instruction = deserialize_instruction(&quote.instruction)?;

        create_wallet(&mut ctx, wallet.pubkey());

        let initial_in_balance = quote.input_amount * 2;
        let initial_out_balance = 1_000_000;

        // let slot = ctx.banks_client.get_root_slot().await.unwrap();
        // ctx.warp_to_slot(slot+3).unwrap();

        let input_mint_is_2022 = is_2022(&data.accounts, quote.input_mint).await;
        let output_mint_is_2022 = is_2022(&data.accounts, quote.output_mint).await;

        set_balance(
            &mut ctx,
            wallet.pubkey(),
            quote.input_mint,
            initial_in_balance,
            input_mint_is_2022,
        )?;
        set_balance(
            &mut ctx,
            wallet.pubkey(),
            quote.output_mint,
            initial_out_balance,
            output_mint_is_2022,
        )?;

        for meta in &instruction.accounts {
            let Some(account) = ctx.get_account(&meta.pubkey) else {
                log::warn!("missing account : {:?}", meta.pubkey);
                continue;
            };

            if debug_hashes {
                let mut hasher = Sha256::new();
                hasher.update(account.data());
                let result = hasher.finalize();
                let base64 = base64::encode(result);
                log::debug!(
                    "account : {:?} dump : {base64:?} executable : {}",
                    meta.pubkey,
                    account.executable()
                );
            }
        }

        if simulate {
            if let Some(cus) = simulate_cu_usage(&mut ctx, &wallet, &instruction).await {
                cus_required.push(cus);
            }
        }

        match swap(&mut ctx, &wallet, &instruction).await {
            Ok(_) => Ok(()),
            Err(e) => {
                debug_print_ix(
                    &mut success,
                    &mut index,
                    quote,
                    &mut ctx,
                    &instruction,
                    input_mint_is_2022,
                    output_mint_is_2022,
                )
                .await;

                Err(e)
            }
        }?;

        let post_in_balance = get_balance(
            &mut ctx,
            wallet.pubkey(),
            quote.input_mint,
            input_mint_is_2022,
        )
        .await?;
        let post_out_balance = get_balance(
            &mut ctx,
            wallet.pubkey(),
            quote.output_mint,
            output_mint_is_2022,
        )
        .await?;

        let sent_in_amount = initial_in_balance.saturating_sub(post_in_balance);
        let received_out_amount = post_out_balance.saturating_sub(initial_out_balance);

        info!(
            "Swapped #{index}: {} ({}) -> {} ({})",
            sent_in_amount, quote.input_mint, received_out_amount, quote.output_mint
        );
        info!(
            "Expected: {} -> {}",
            quote.input_amount, quote.output_amount
        );

        let unexpected_in_amount = quote.input_amount < sent_in_amount;
        let unexpected_out_amount = if quote.is_exact_out {
            quote.output_amount > received_out_amount
        } else {
            quote.output_amount != received_out_amount
        };

        if unexpected_in_amount || unexpected_out_amount {
            debug_print_ix(
                &mut success,
                &mut index,
                quote,
                &mut ctx,
                &instruction,
                input_mint_is_2022,
                output_mint_is_2022,
            )
            .await;
        }

        if quote.is_exact_out {
            assert!(quote.input_amount >= sent_in_amount);
            assert!(quote.output_amount <= received_out_amount);
        } else {
            assert_eq!(
                quote.input_amount, sent_in_amount,
                "ExactIn must consume precisely the quoted input"
            );
            assert_eq!(quote.output_amount, received_out_amount);
        }

        success += 1;

        // reset the mutable accounts for next test
        reinitialize_accounts(
            &mut ctx,
            &data,
            &instruction
                .accounts
                .iter()
                .filter_map(|x| if x.is_writable { Some(x.pubkey) } else { None })
                .collect(),
        )?;
    }

    cus_required.sort();
    let count = cus_required.len();
    if count > 0 {
        let median_index = count / 2;
        let p75_index = count * 75 / 100;
        let p95_index = count * 95 / 100;
        let p99_index = count * 99 / 100;
        println!("Cu usage stats");
        println!(
            "Count: {}, Min :{}, Max: {}, Median: {}, p75:{}, p95: {}, p99:{}",
            count,
            cus_required[0],
            cus_required[count - 1],
            cus_required[median_index],
            cus_required[p75_index],
            cus_required[p95_index],
            cus_required[p99_index]
        );
    }

    anyhow::ensure!(success > 0, "Empty replay is not a passing admission");
    info!("Successfully ran {} swaps", success);

    Ok(Ok(()))
}

async fn debug_print_ix(
    success: &mut i32,
    index: &mut u32,
    quote: &ExecutionItem,
    ctx: &mut LiteSVM,
    instruction: &Instruction,
    input_mint_is_2022: bool,
    output_mint_is_2022: bool,
) {
    error!(
        "Faulty swapping #{} quote{}: \r\n{} -> {} ({} -> {})\r\n (successfully run {} swap)",
        index,
        if quote.is_exact_out {
            " (ExactOut)"
        } else {
            ""
        },
        quote.input_mint,
        quote.output_mint,
        quote.input_amount,
        quote.output_amount,
        success
    );

    error!("Faulty ix: {:?}", instruction);
    error!(
        "* input mint: {} (is 2022 -> {})",
        quote.input_mint, input_mint_is_2022
    );
    error!(
        "* output mint: {} (is 2022 -> {})",
        quote.output_mint, output_mint_is_2022
    );

    for acc in &instruction.accounts {
        let account = ctx
            .get_account(&acc.pubkey)
            .map(|x| (x.executable, x.owner.to_string()))
            .unwrap_or((false, "???".to_string()));

        warn!(
            "Account: {} (exec={}) is owned by {} ",
            acc.pubkey, account.0, account.1
        );
    }
}

async fn is_2022(accounts: &HashMap<Pubkey, AccountSharedData>, mint: Pubkey) -> bool {
    let result = accounts.get(&mint);
    let Some(result) = result else {
        warn!("Missing Mint: {}", mint);
        return false;
    };

    *result.owner() == Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}

fn deserialize_instruction(swap_ix: &Vec<u8>) -> anyhow::Result<Instruction> {
    let instruction: Instruction = bincode::deserialize(swap_ix.as_slice())?;
    Ok(instruction)
}

fn reinitialize_accounts(
    program_test: &mut LiteSVM,
    dump: &ExecutionDump,
    accounts_list: &Vec<Pubkey>,
) -> anyhow::Result<()> {
    log::debug!("reinitializing accounts : {:?}", accounts_list.len());
    for pk in accounts_list {
        let Some(account) = dump.accounts.get(&pk) else {
            if dump.missing_accounts.contains(pk) {
                program_test.set_account(*pk, Account::default())?;
            }
            continue;
        };
        log::debug!(
            "Setting data for {} with owner {} and is executable {}",
            pk,
            account.owner(),
            account.executable()
        );

        log::debug!("Setting data for {}", pk);
        program_test.set_account(
            *pk,
            solana_sdk::account::Account {
                lamports: account.lamports(),
                owner: *account.owner(),
                data: account.data().to_vec(),
                rent_epoch: account.rent_epoch(),
                executable: account.executable(),
            },
        )?;
    }

    Ok(())
}

fn initialize_accounts(program_test: &mut LiteSVM, dump: &ExecutionDump) -> anyhow::Result<()> {
    log::debug!("initializing accounts : {:?}", dump.accounts.len());
    let mut accounts_list = dump.programs.clone();
    accounts_list.extend(dump.accounts.iter().map(|x| x.0.clone()));

    for pk in accounts_list {
        let Some(account) = dump.accounts.get(&pk) else {
            continue;
        };
        if *account.owner() == solana_sdk::bpf_loader_upgradeable::ID {
            log::debug!("{pk:?} has upgradable loader");
            let state = bincode::deserialize::<UpgradeableLoaderState>(&account.data()).unwrap();
            if let UpgradeableLoaderState::Program {
                programdata_address,
            } = state
            {
                // load buffer accounts first
                match dump.accounts.get(&programdata_address) {
                    Some(program_buffer) => {
                        log::debug!("loading buffer:  {programdata_address:?}");
                        program_test.set_account(
                            programdata_address,
                            solana_sdk::account::Account {
                                lamports: program_buffer.lamports(),
                                owner: *program_buffer.owner(),
                                data: program_buffer.data().to_vec(),
                                rent_epoch: program_buffer.rent_epoch(),
                                executable: program_buffer.executable(),
                            },
                        )?;
                    }
                    None => {
                        error!("{programdata_address:?} is not there");
                    }
                }
            }
        }
        log::debug!(
            "Setting data for {} with owner {} and is executable {}",
            pk,
            account.owner(),
            account.executable()
        );

        log::debug!("Setting data for {}", pk);
        program_test.set_account(
            pk,
            solana_sdk::account::Account {
                lamports: account.lamports(),
                owner: *account.owner(),
                data: account.data().to_vec(),
                rent_epoch: account.rent_epoch(),
                executable: account.executable(),
            },
        )?;
    }

    Ok(())
}

async fn simulate_cu_usage(
    ctx: &mut LiteSVM,
    owner: &Keypair,
    instruction: &Instruction,
) -> Option<u64> {
    let tx = VersionedTransaction::try_new(
        VersionedMessage::Legacy(Message::new(&[instruction.clone()], Some(&owner.pubkey()))),
        &[owner],
    )
    .unwrap();

    let sim = ctx.simulate_transaction(tx);
    match sim {
        Ok(sim) => {
            let cus = sim.compute_units_consumed;
            log::debug!("----logs");
            for log in sim.logs {
                log::debug!("{log:?}");
            }
            if cus > 0 {
                Some(cus)
            } else {
                None
            }
        }
        Err(e) => {
            log::warn!("Error simulating : {:?}", e);
            None
        }
    }
}

async fn swap(ctx: &mut LiteSVM, owner: &Keypair, instruction: &Instruction) -> anyhow::Result<()> {
    let tx = VersionedTransaction::try_new(
        VersionedMessage::Legacy(Message::new(&[instruction.clone()], Some(&owner.pubkey()))),
        &[owner],
    )
    .unwrap();

    let result = ctx.send_transaction(tx);
    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            log::error!("------------- LOGS ------------------");
            for log in &e.meta.logs {
                log::error!("{log:?}");
            }
            Err(anyhow::format_err!("Failed to swap {:?}", e.err))
        }
    }
}

async fn get_balance(
    ctx: &mut LiteSVM,
    owner: Pubkey,
    mint: Pubkey,
    is_2022: bool,
) -> anyhow::Result<u64> {
    let token_program_id = if is_2022 {
        spl_token_2022::ID
    } else {
        spl_token::ID
    };

    let ata_address =
        get_associated_token_address_with_program_id(&owner, &mint, &token_program_id);

    let Some(ata) = ctx.get_account(&ata_address) else {
        return Ok(0);
    };

    if is_2022 {
        Ok(
            StateWithExtensions::<spl_token_2022::state::Account>::unpack(&ata.data)?
                .base
                .amount,
        )
    } else {
        Ok(spl_token::state::Account::unpack(&ata.data)?.amount)
    }
}

fn set_balance(
    ctx: &mut LiteSVM,
    owner: Pubkey,
    mint: Pubkey,
    amount: u64,
    is_2022: bool,
) -> anyhow::Result<()> {
    let token_program_id = if is_2022 {
        spl_token_2022::ID
    } else {
        spl_token::ID
    };

    let ata_address =
        get_associated_token_address_with_program_id(&owner, &mint, &token_program_id);
    let mint_account = ctx
        .get_account(&mint)
        .ok_or_else(|| anyhow::anyhow!("missing replay mint"))?;
    anyhow::ensure!(
        mint_account.owner == token_program_id,
        "replay mint owner mismatch"
    );
    let account = funded_wallet_token_account(
        &mint_account,
        mint,
        owner,
        amount,
        &ctx.get_sysvar::<Rent>(),
    )?;
    ctx.set_account(ata_address, account)?;

    Ok(())
}

fn funded_wallet_token_account(
    mint_account: &Account,
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    rent: &Rent,
) -> anyhow::Result<Account> {
    let token2022 = mint_account.owner == spl_token_2022::ID;
    anyhow::ensure!(
        token2022 || mint_account.owner == spl_token::ID,
        "unsupported replay mint owner"
    );
    let native = (!token2022 && mint == spl_token::native_mint::ID)
        || (token2022 && mint == spl_token_2022::native_mint::ID);
    let mut extensions = vec![];
    if token2022 {
        let mint_state =
            StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_account.data)?;
        let mint_extensions = mint_state.get_extension_types()?;
        anyhow::ensure!(
            mint_extensions.iter().all(|extension| matches!(
                extension,
                ExtensionType::TransferFeeConfig
                    | ExtensionType::MetadataPointer
                    | ExtensionType::TokenMetadata
            )),
            "unsupported Token-2022 mint extension in admission wallet setup"
        );
        extensions = ExtensionType::get_required_init_account_extensions(&mint_extensions);
        extensions.push(ExtensionType::ImmutableOwner);
    } else {
        spl_token::state::Mint::unpack(&mint_account.data)?;
    }
    let length = if token2022 {
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&extensions)?
    } else {
        spl_token::state::Account::LEN
    };
    let reserve = rent.minimum_balance(length);
    let native_reserve = if native {
        COption::Some(reserve)
    } else {
        COption::None
    };
    let mut data = vec![0; length];
    if token2022 {
        let mut state =
            StateWithExtensionsMut::<spl_token_2022::state::Account>::unpack_uninitialized(
                &mut data,
            )?;
        state.init_extension::<ImmutableOwner>(true)?;
        if extensions.contains(&ExtensionType::TransferFeeAmount) {
            state.init_extension::<TransferFeeAmount>(true)?;
        }
        state.base = spl_token_2022::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState2022::Initialized,
            is_native: native_reserve,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        state.pack_base();
        state.init_account_type()?;
    } else {
        spl_token::state::Account {
            mint,
            owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: native_reserve,
            delegated_amount: 0,
            close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
    }
    Ok(Account {
        lamports: reserve
            .checked_add(if native { amount } else { 0 })
            .ok_or_else(|| anyhow::anyhow!("native backing overflow"))?,
        data,
        owner: mint_account.owner,
        executable: false,
        rent_epoch: u64::MAX,
    })
}

fn create_wallet(ctx: &mut LiteSVM, address: Pubkey) {
    let _ = ctx.airdrop(&address, 1_000_000_000);
}

pub fn find_file(filename: &str) -> Option<PathBuf> {
    for dir in default_shared_object_dirs() {
        let candidate = dir.join(filename);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn default_shared_object_dirs() -> Vec<PathBuf> {
    let mut search_path = vec![];
    if let Ok(bpf_out_dir) = std::env::var("BPF_OUT_DIR") {
        search_path.push(PathBuf::from(bpf_out_dir));
    } else if let Ok(bpf_out_dir) = std::env::var("SBF_OUT_DIR") {
        search_path.push(PathBuf::from(bpf_out_dir));
    }
    search_path.push(PathBuf::from("tests/fixtures"));
    if let Ok(dir) = std::env::current_dir() {
        search_path.push(dir);
    }
    log::trace!("SBF .so search path: {:?}", search_path);
    search_path
}

fn setup_test_chain(clock: &Clock, dump: &ExecutionDump) -> anyhow::Result<LiteSVM> {
    let mut program_test = LiteSVM::new();
    program_test.set_sysvar(clock);

    initialize_accounts(&mut program_test, dump)?;

    // Adapter admission executes the actual venue instruction from captured mainnet
    // bytecode. It does not load a candidate-supplied executor shared object.
    if std::env::var_os("ADMISSION_STRICT").is_none() {
        let path = find_file("autobahn_executor.so")
            .ok_or_else(|| anyhow::anyhow!("missing executor SBF fixture"))?;
        program_test.add_program_from_file(autobahn_executor::ID, path)?;
    }

    // TODO: make this dynamic based on routes
    let mut cb = solana_program_runtime::compute_budget::ComputeBudget::default();
    cb.compute_unit_limit = 1_400_000;
    program_test.set_compute_budget(cb);

    Ok(program_test)
}

// This file is compiled from the trusted default branch BEFORE candidate code runs.
// The recorder lives in another container and only it can write this snapshot.
// Discard ALL candidate account bytes, including sysvars and program bytecode.
fn apply_recorded_mainnet_state(dump: &mut ExecutionDump) -> anyhow::Result<()> {
    let path = std::env::var("ADMISSION_CANONICAL_PATH")?;
    let bytes = std::fs::read(path)?;
    anyhow::ensure!(
        bytes.len() <= 512 * 1024 * 1024,
        "oversized recorder snapshot"
    );
    let snapshot: serde_json::Value = serde_json::from_slice(&bytes)?;
    let expected_amount: u64 = std::env::var("ADMISSION_AMOUNT")?.parse()?;
    canonicalize_dump(dump, &snapshot, expected_amount)
}

fn canonicalize_dump(
    dump: &mut ExecutionDump,
    snapshot: &serde_json::Value,
    expected_amount: u64,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        snapshot["version"].as_u64() == Some(1)
            && snapshot["failed"].as_bool() == Some(false)
            && snapshot["complete"].as_bool() == Some(true),
        "recorder failed or unsupported snapshot"
    );
    let records = snapshot["accounts"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("missing canonical accounts"))?;
    anyhow::ensure!(
        !records.is_empty() && records.len() <= 50_000,
        "invalid canonical account count"
    );
    anyhow::ensure!(
        expected_amount > 0 && expected_amount <= u64::MAX / 2,
        "invalid trusted admission amount"
    );
    let mut accounts = HashMap::new();
    let mut recorded_keys = std::collections::HashSet::new();
    for (address, record) in records {
        recorded_keys.insert(address.parse::<Pubkey>()?);
        anyhow::ensure!(
            record["slot"].as_u64().unwrap_or(0) > 0,
            "missing canonical slot"
        );
        let account = &record["account"];
        if account.is_null() {
            continue;
        }
        anyhow::ensure!(
            account["data"][1].as_str() == Some("base64"),
            "invalid account encoding"
        );
        let data = base64::decode(
            account["data"][0]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing canonical bytes"))?,
        )?;
        let account = Account {
            lamports: account["lamports"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("missing lamports"))?,
            owner: account["owner"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing owner"))?
                .parse()?,
            executable: account["executable"]
                .as_bool()
                .ok_or_else(|| anyhow::anyhow!("missing executable flag"))?,
            rent_epoch: account["rentEpoch"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("missing rent epoch"))?,
            data,
        };
        accounts.insert(address.parse::<Pubkey>()?, AccountSharedData::from(account));
    }
    anyhow::ensure!(!dump.programs.is_empty(), "missing program set");
    for program in &dump.programs {
        let account = accounts
            .get(program)
            .ok_or_else(|| anyhow::anyhow!("program not recorded from mainnet: {program}"))?;
        anyhow::ensure!(account.executable(), "not executable: {program}");
        if *account.owner() == solana_sdk::bpf_loader_upgradeable::ID {
            match bincode::deserialize::<UpgradeableLoaderState>(account.data())? {
                UpgradeableLoaderState::Program {
                    programdata_address,
                } => {
                    let code = accounts
                        .get(&programdata_address)
                        .ok_or_else(|| anyhow::anyhow!("missing canonical program data"))?;
                    anyhow::ensure!(
                        *code.owner() == solana_sdk::bpf_loader_upgradeable::ID,
                        "invalid program data owner"
                    );
                    anyhow::ensure!(
                        matches!(
                            bincode::deserialize::<UpgradeableLoaderState>(code.data())?,
                            UpgradeableLoaderState::ProgramData { .. }
                        ) && code.data().len()
                            > UpgradeableLoaderState::size_of_programdata_metadata(),
                        "missing canonical executable bytes"
                    );
                }
                _ => anyhow::bail!("invalid program state"),
            }
        }
    }
    let wallet = Keypair::from_base58_string(&dump.wallet_keypair).pubkey();
    for item in &dump.cache {
        let instruction = deserialize_instruction(&item.instruction)?;
        anyhow::ensure!(
            dump.programs.contains(&instruction.program_id),
            "instruction uses undeclared program"
        );
        anyhow::ensure!(
            accounts.contains_key(&item.input_mint) && accounts.contains_key(&item.output_mint),
            "mint missing from recorder"
        );
        anyhow::ensure!(
            item.input_mint != item.output_mint,
            "same-mint evidence does not prove a swap"
        );
        anyhow::ensure!(
            item.input_amount == expected_amount && item.output_amount > 0 && !item.is_exact_out,
            "replay does not exercise the trusted requested input amount/mode"
        );
        let mint_program = |mint: &Pubkey| -> anyhow::Result<Pubkey> {
            let owner = *accounts.get(mint).unwrap().owner();
            anyhow::ensure!(
                owner == spl_token::ID || owner == spl_token_2022::ID,
                "unsupported canonical mint owner"
            );
            Ok(owner)
        };
        let input_ata = get_associated_token_address_with_program_id(
            &wallet,
            &item.input_mint,
            &mint_program(&item.input_mint)?,
        );
        let output_ata = get_associated_token_address_with_program_id(
            &wallet,
            &item.output_mint,
            &mint_program(&item.output_mint)?,
        );
        for meta in &instruction.accounts {
            anyhow::ensure!(
                !meta.is_signer || meta.pubkey == wallet,
                "unexpected replay signer"
            );
            anyhow::ensure!(
                recorded_keys.contains(&meta.pubkey)
                    || meta.pubkey == wallet
                    || meta.pubkey == input_ata
                    || meta.pubkey == output_ata
                    || replay_builtin(&meta.pubkey),
                "instruction account was never recorded: {}",
                meta.pubkey
            );
        }
    }
    dump.accounts = accounts;
    dump.missing_accounts = recorded_keys
        .into_iter()
        .filter(|key| !dump.accounts.contains_key(key))
        .collect();
    Ok(())
}

fn replay_builtin(key: &Pubkey) -> bool {
    // Only addresses the trusted runtime constructs itself may bypass recording.
    // All venue accounts, PDAs and nonbuiltin programs need a recorded value,
    // including an explicit null for accounts the instruction creates on-chain.
    [
        solana_sdk::system_program::ID,
        solana_sdk::stake::program::ID,
        spl_token::ID,
        spl_token_2022::ID,
        spl_associated_token_account::ID,
        solana_sdk::sysvar::instructions::ID,
        solana_sdk::sysvar::rent::ID,
        solana_sdk::sysvar::clock::ID,
        solana_sdk::sysvar::stake_history::ID,
        solana_sdk::sysvar::epoch_schedule::ID,
    ]
    .contains(key)
}

#[cfg(test)]
mod admission_validation_tests {
    use super::*;
    use solana_program::instruction::AccountMeta;
    use spl_token_2022::extension::{transfer_fee::TransferFeeConfig, transfer_hook::TransferHook};

    fn mint(token2022: bool, extensions: &[ExtensionType]) -> Account {
        if token2022 {
            let length =
                ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(extensions)
                    .unwrap();
            let mut data = vec![0; length];
            let mut state =
                StateWithExtensionsMut::<spl_token_2022::state::Mint>::unpack_uninitialized(
                    &mut data,
                )
                .unwrap();
            if extensions.contains(&ExtensionType::TransferFeeConfig) {
                state.init_extension::<TransferFeeConfig>(true).unwrap();
            }
            if extensions.contains(&ExtensionType::TransferHook) {
                state.init_extension::<TransferHook>(true).unwrap();
            }
            state.base = spl_token_2022::state::Mint {
                mint_authority: COption::None,
                supply: 1_000_000,
                decimals: 9,
                is_initialized: true,
                freeze_authority: COption::None,
            };
            state.pack_base();
            state.init_account_type().unwrap();
            Account {
                owner: spl_token_2022::ID,
                data,
                lamports: 1_000_000,
                ..Account::default()
            }
        } else {
            let mut data = vec![0; spl_token::state::Mint::LEN];
            spl_token::state::Mint {
                mint_authority: COption::None,
                supply: 1_000_000,
                decimals: 9,
                is_initialized: true,
                freeze_authority: COption::None,
            }
            .pack_into_slice(&mut data);
            Account {
                owner: spl_token::ID,
                data,
                lamports: 1_000_000,
                ..Account::default()
            }
        }
    }

    #[test]
    fn admission_native_wallet_tokens_are_fully_backed_and_syncable() {
        let amount = 4_123_456_789;
        let funded = funded_wallet_token_account(
            &mint(false, &[]),
            spl_token::native_mint::ID,
            Pubkey::new_unique(),
            amount,
            &Rent::default(),
        )
        .unwrap();
        let token = spl_token::state::Account::unpack(&funded.data).unwrap();
        let reserve = Rent::default().minimum_balance(spl_token::state::Account::LEN);
        assert_eq!(token.is_native, COption::Some(reserve));
        assert_eq!(token.amount, amount);
        assert_eq!(funded.lamports, reserve + amount);
        assert!(funded_wallet_token_account(
            &mint(false, &[]),
            spl_token::native_mint::ID,
            Pubkey::new_unique(),
            u64::MAX,
            &Rent::default()
        )
        .is_err());
    }

    #[test]
    fn admission_token_2022_wallet_has_required_fee_extension_and_real_balance() {
        let key = Pubkey::new_unique();
        let funded = funded_wallet_token_account(
            &mint(true, &[ExtensionType::TransferFeeConfig]),
            key,
            Pubkey::new_unique(),
            123_456,
            &Rent::default(),
        )
        .unwrap();
        let token =
            StateWithExtensions::<spl_token_2022::state::Account>::unpack(&funded.data).unwrap();
        assert_eq!(token.base.amount, 123_456);
        assert_eq!(token.base.mint, key);
        assert_eq!(token.base.is_native, COption::None);
        assert!(token.get_extension::<ImmutableOwner>().is_ok());
        assert_eq!(
            u64::from(
                token
                    .get_extension::<TransferFeeAmount>()
                    .unwrap()
                    .withheld_amount
            ),
            0
        );
        assert_eq!(
            funded.lamports,
            Rent::default().minimum_balance(funded.data.len())
        );
        assert!(funded_wallet_token_account(
            &mint(true, &[ExtensionType::TransferHook]),
            key,
            Pubkey::new_unique(),
            1,
            &Rent::default()
        )
        .unwrap_err()
        .to_string()
        .contains("unsupported Token-2022"));
    }

    fn recorded(account: &Account) -> serde_json::Value {
        serde_json::json!({"slot": 10, "account": {"lamports":account.lamports,"owner":account.owner.to_string(),"executable":account.executable,"rentEpoch":account.rent_epoch,"data":[base64::encode(&account.data),"base64"]}})
    }

    fn evidence() -> (ExecutionDump, serde_json::Value, Pubkey) {
        let wallet = Keypair::new();
        let input = Pubkey::new_unique();
        let output = Pubkey::new_unique();
        let program = Pubkey::new_unique();
        let missing = Pubkey::new_unique();
        let instruction = Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(wallet.pubkey(), true),
                AccountMeta::new(missing, false),
            ],
            data: vec![1],
        };
        let dump = ExecutionDump {
            wallet_keypair: wallet.to_base58_string(),
            programs: [program].into_iter().collect(),
            cache: vec![ExecutionItem {
                input_mint: input,
                output_mint: output,
                input_amount: 100,
                output_amount: 90,
                instruction: bincode::serialize(&instruction).unwrap(),
                is_exact_out: false,
            }],
            accounts: HashMap::from([(missing, AccountSharedData::new(999, 100, &program))]),
            missing_accounts: Default::default(),
        };
        let program_state = Account {
            executable: true,
            owner: solana_sdk::bpf_loader::ID,
            data: vec![1, 2, 3],
            ..Account::default()
        };
        let mut records = serde_json::Map::new();
        records.insert(program.to_string(), recorded(&program_state));
        records.insert(input.to_string(), recorded(&mint(false, &[])));
        records.insert(output.to_string(), recorded(&mint(false, &[])));
        let snapshot =
            serde_json::json!({"version":1,"failed":false,"complete":true,"accounts":records});
        (dump, snapshot, missing)
    }

    #[test]
    fn admission_requires_recorded_metas_and_discards_candidate_funding() {
        let (mut dump, mut snapshot, missing) = evidence();
        assert!(canonicalize_dump(&mut dump, &snapshot, 100)
            .unwrap_err()
            .to_string()
            .contains("never recorded"));
        snapshot["accounts"][missing.to_string()] = serde_json::json!({"slot":10,"account":null});
        canonicalize_dump(&mut dump, &snapshot, 100).unwrap();
        assert!(!dump.accounts.contains_key(&missing));
        assert!(dump.missing_accounts.contains(&missing));
    }

    #[test]
    fn admission_rejects_canned_amount_failed_capture_and_unknown_signer() {
        let (dump, mut snapshot, missing) = evidence();
        snapshot["accounts"][missing.to_string()] = serde_json::json!({"slot":10,"account":null});
        assert!(canonicalize_dump(&mut dump.clone(), &snapshot, 101).is_err());
        let mut exact_out = dump.clone();
        exact_out.cache[0].is_exact_out = true;
        assert!(canonicalize_dump(&mut exact_out, &snapshot, 100)
            .unwrap_err()
            .to_string()
            .contains("trusted requested input amount/mode"));
        let mut incomplete = snapshot.clone();
        incomplete["complete"] = false.into();
        assert!(canonicalize_dump(&mut dump.clone(), &incomplete, 100).is_err());
        let mut failed = snapshot.clone();
        failed["failed"] = true.into();
        assert!(canonicalize_dump(&mut dump.clone(), &failed, 100).is_err());
        let mut signed = dump;
        let mut instruction = deserialize_instruction(&signed.cache[0].instruction).unwrap();
        instruction.accounts[1].is_signer = true;
        signed.cache[0].instruction = bincode::serialize(&instruction).unwrap();
        assert!(canonicalize_dump(&mut signed, &snapshot, 100)
            .unwrap_err()
            .to_string()
            .contains("unexpected replay signer"));
    }
}
