use crate::platform_fee::{self, FeeLeg, FeeSide};
use crate::routing_types::{Route, RouteStep};
use crate::swap::Swap;
use anchor_lang::Id;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::Token;
use anyhow::Context;
use autobahn_executor::swap_ix::generate_swap_ix_data;
use router_lib::dex::{AccountProviderView, SwapInstruction, SwapMode};
use solana_program::instruction::Instruction;
use solana_program::pubkey::Pubkey;
use solana_sdk::account::ReadableAccount;
use spl_associated_token_account::get_associated_token_address_with_program_id;
use std::str::FromStr;

const CU_PER_HOP_DEFAULT: u32 = 80_000;
const CU_BASE: u32 = 150_000;

pub trait SwapStepInstructionBuilder {
    fn token_program(&self, _mint: &Pubkey) -> anyhow::Result<Pubkey> {
        Ok(Token::id())
    }
    fn mint_decimals(&self, _mint: &Pubkey) -> anyhow::Result<u8> {
        anyhow::bail!("mint decimals unavailable")
    }
    fn build_ix(
        &self,
        wallet_pk: &Pubkey,
        step: &RouteStep,
        max_slippage_bps: i32,
        swap_mode: SwapMode,
        other_amount: u64,
    ) -> anyhow::Result<SwapInstruction>; // TODO handle multi hop from same edge ?
}

pub trait SwapInstructionsBuilder {
    fn build_ixs(
        &self,
        wallet_pk: &Pubkey,
        route: &Route,
        wrap_and_unwrap_sol: bool,
        auto_create_out: bool,
        max_slippage_bps: i32,
        other_amount_threshold: u64,
        swap_mode: SwapMode,
        fee: Option<FeeLeg>,
    ) -> anyhow::Result<Swap>;
}

pub struct SwapStepInstructionBuilderImpl {
    pub chain_data: AccountProviderView,
}

impl SwapStepInstructionBuilder for SwapStepInstructionBuilderImpl {
    fn token_program(&self, mint: &Pubkey) -> anyhow::Result<Pubkey> {
        let owner = *self.chain_data.account(mint)?.account.owner();
        let token2022: Pubkey = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".parse()?;
        anyhow::ensure!(
            owner == Token::id() || owner == token2022,
            "unsupported mint owner"
        );
        Ok(owner)
    }
    fn mint_decimals(&self, mint: &Pubkey) -> anyhow::Result<u8> {
        // Classic and Token-2022 mints share the base layout; decimals is byte 44.
        let account = self.chain_data.account(mint)?;
        account.account.data().get(44).copied().context("invalid mint account")
    }
    fn build_ix(
        &self,
        wallet_pk: &Pubkey,
        step: &RouteStep,
        max_slippage_bps: i32,
        swap_mode: SwapMode,
        other_amount: u64,
    ) -> anyhow::Result<SwapInstruction> {
        let in_amount = match swap_mode {
            SwapMode::ExactIn => step.in_amount,
            SwapMode::ExactOut => other_amount,
        };

        step.edge.build_swap_ix(
            &self.chain_data,
            wallet_pk,
            in_amount,
            step.out_amount,
            max_slippage_bps,
        )
    }
}

pub struct SwapInstructionsBuilderImpl<T: SwapStepInstructionBuilder> {
    ix_builder: T,
    router_version: u8,
}

impl<T: SwapStepInstructionBuilder> SwapInstructionsBuilderImpl<T> {
    pub fn new(ix_builder: T, router_version: u8) -> SwapInstructionsBuilderImpl<T> {
        Self {
            ix_builder,
            router_version,
        }
    }
}

impl<T: SwapStepInstructionBuilder> SwapInstructionsBuilder for SwapInstructionsBuilderImpl<T> {
    fn build_ixs(
        &self,
        wallet_pk: &Pubkey,
        route: &Route,
        auto_wrap_sol: bool,
        auto_create_out: bool,
        max_slippage_bps: i32,
        other_amount_threshold: u64,
        swap_mode: SwapMode,
        fee: Option<FeeLeg>,
    ) -> anyhow::Result<Swap> {
        if route.steps.len() == 0 {
            anyhow::bail!("Can't generate instructions for empty route");
        }

        let mut setup_instructions = vec![];
        let mut cleanup_instructions = vec![];
        let fee = fee.filter(|fee| fee.amount > 0);
        let input_fee = fee
            .filter(|fee| fee.side == FeeSide::Input)
            .map_or(0, |fee| fee.amount);

        let exec_program_id: Pubkey = autobahn_executor::id();
        let sol_mint: Pubkey =
            Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap();

        if auto_wrap_sol && route.input_mint == sol_mint {
            Self::create_ata(&wallet_pk, &mut setup_instructions, &sol_mint, &Token::id());
            let wsol_account = get_associated_token_address(wallet_pk, &sol_mint);

            let in_amount = match swap_mode {
                SwapMode::ExactIn => route.in_amount,
                SwapMode::ExactOut => other_amount_threshold,
            }
            .checked_add(input_fee)
            .context("Fee exceeds token amount range")?;

            setup_instructions.push(solana_program::system_instruction::transfer(
                &wallet_pk,
                &wsol_account,
                in_amount,
            ));
            setup_instructions.push(anchor_spl::token::spl_token::instruction::sync_native(
                &Token::id(),
                &wsol_account,
            )?);

            Self::close_wsol_ata(&wallet_pk, &mut cleanup_instructions, &wsol_account)?;
        }

        // We don't really care about Orca/Raydium/Openbook min out amount
        //   since we are checking it at the end of execution anyway
        //   .. and it prevent using the "overquote" heuristic
        let max_slippage_for_hop_bps = max_slippage_bps * 2;

        let swap_instructions = route
            .steps
            .iter()
            .map(|x| {
                self.ix_builder.build_ix(
                    wallet_pk,
                    x,
                    max_slippage_for_hop_bps,
                    swap_mode,
                    other_amount_threshold,
                )
            })
            .collect::<anyhow::Result<Vec<SwapInstruction>>>()?;

        let mut cu_estimate = CU_BASE;

        for step in &swap_instructions {
            if auto_create_out || (step.out_mint == sol_mint && auto_wrap_sol) {
                let token_program = self.ix_builder.token_program(&step.out_mint)?;
                anyhow::ensure!(
                    step.out_pubkey
                        == get_associated_token_address_with_program_id(
                            wallet_pk,
                            &step.out_mint,
                            &token_program
                        ),
                    "adapter output is not the correct owner ATA"
                );
                Self::create_ata(
                    &wallet_pk,
                    &mut setup_instructions,
                    &step.out_mint,
                    &token_program,
                );
                cu_estimate += 12_000;
            }

            if step.out_mint == sol_mint && auto_wrap_sol {
                let wsol_account = get_associated_token_address(wallet_pk, &sol_mint);
                Self::close_wsol_ata(&wallet_pk, &mut cleanup_instructions, &wsol_account)?;
                cu_estimate += 12_000;
            }

            cu_estimate += step.cu_estimate.unwrap_or(CU_PER_HOP_DEFAULT);
        }

        let (instructions, in_out): (Vec<_>, Vec<_>) = swap_instructions
            .into_iter()
            .map(|x| (x.instruction, (x.in_amount_offset, x.out_pubkey)))
            .unzip();
        let (in_amount_offsets, out_account_pubkeys): (Vec<_>, Vec<_>) = in_out.into_iter().unzip();

        let min_out_amount = match swap_mode {
            SwapMode::ExactIn => other_amount_threshold,
            SwapMode::ExactOut => route.out_amount,
        };

        let in_account = get_associated_token_address_with_program_id(
            &wallet_pk,
            &route.input_mint,
            &self.ix_builder.token_program(&route.input_mint)?,
        );

        if let Some(fee) = fee {
            let (source, expected_mint) = match fee.side {
                FeeSide::Input => (in_account, route.input_mint),
                FeeSide::Output => (
                    *out_account_pubkeys.last().context("route has no output")?,
                    route.output_mint,
                ),
            };
            anyhow::ensure!(fee.mint == expected_mint, "fee mint is not on the route's fee side");
            let token_program = self.ix_builder.token_program(&fee.mint)?;
            let [create_fee_account, charge] = platform_fee::instructions(
                wallet_pk,
                &source,
                &fee,
                &token_program,
                || self.ix_builder.mint_decimals(&fee.mint),
            )?;
            setup_instructions.push(create_fee_account);
            match fee.side {
                // After any wrap funds the input account, before the swap spends it.
                FeeSide::Input => setup_instructions.push(charge),
                // After the swap fills the output account, before a wSOL unwrap closes it.
                FeeSide::Output => cleanup_instructions.insert(0, charge),
            }
            cu_estimate += platform_fee::FEE_CU_ESTIMATE;
        }

        let swap_instruction = generate_swap_ix_data(
            min_out_amount,
            instructions.as_slice(),
            in_amount_offsets.as_slice(),
            in_account,
            out_account_pubkeys.as_slice(),
            exec_program_id,
            self.router_version,
        );

        Ok(Swap {
            setup_instructions,
            swap_instruction,
            cleanup_instructions,
            cu_estimate,
        })
    }
}

impl<T: SwapStepInstructionBuilder> SwapInstructionsBuilderImpl<T> {
    fn close_wsol_ata(
        wallet_pk: &&Pubkey,
        cleanup_instructions: &mut Vec<Instruction>,
        wsol_account: &Pubkey,
    ) -> anyhow::Result<()> {
        cleanup_instructions.push(anchor_spl::token::spl_token::instruction::close_account(
            &Token::id(),
            &wsol_account,
            &wallet_pk,
            &wallet_pk,
            &[&wallet_pk],
        )?);
        Ok(())
    }

    fn create_ata(
        wallet_pk: &&Pubkey,
        setup_instructions: &mut Vec<Instruction>,
        mint: &Pubkey,
        token_program: &Pubkey,
    ) {
        setup_instructions.push(
            spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                &wallet_pk,
                &wallet_pk,
                &mint,
                token_program,
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edge::Edge;
    use crate::test_utils::*;
    use router_feed_lib::router_rpc_client::RouterRpcClient;
    use router_lib::dex::{
        AccountProviderView, DexEdge, DexEdgeIdentifier, DexInterface, DexSubscriptionMode, Quote,
    };
    use std::any::Any;
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use test_case::test_case;

    struct MockSwapStepInstructionBuilder {}
    struct MockDex {}
    struct MockId {}

    impl DexEdgeIdentifier for MockId {
        fn key(&self) -> Pubkey {
            todo!()
        }

        fn desc(&self) -> String {
            todo!()
        }

        fn input_mint(&self) -> Pubkey {
            todo!()
        }

        fn output_mint(&self) -> Pubkey {
            todo!()
        }

        fn accounts_needed(&self) -> usize {
            todo!()
        }

        fn as_any(&self) -> &dyn Any {
            todo!()
        }
    }

    #[async_trait::async_trait]
    impl DexInterface for MockDex {
        async fn initialize(
            _rpc: &mut RouterRpcClient,
            _options: HashMap<String, String>,
        ) -> anyhow::Result<Arc<dyn DexInterface>>
        where
            Self: Sized,
        {
            todo!()
        }

        fn name(&self) -> String {
            todo!()
        }

        fn subscription_mode(&self) -> DexSubscriptionMode {
            todo!()
        }

        fn edges_per_pk(&self) -> HashMap<Pubkey, Vec<Arc<dyn DexEdgeIdentifier>>> {
            todo!()
        }

        fn program_ids(&self) -> HashSet<Pubkey> {
            todo!()
        }

        fn load(
            &self,
            _id: &Arc<dyn DexEdgeIdentifier>,
            _chain_data: &AccountProviderView,
        ) -> anyhow::Result<Arc<dyn DexEdge>> {
            todo!()
        }

        fn quote(
            &self,
            _id: &Arc<dyn DexEdgeIdentifier>,
            _edge: &Arc<dyn DexEdge>,
            _chain_data: &AccountProviderView,
            _in_amount: u64,
        ) -> anyhow::Result<Quote> {
            todo!()
        }

        fn build_swap_ix(
            &self,
            _id: &Arc<dyn DexEdgeIdentifier>,
            _chain_data: &AccountProviderView,
            _wallet_pk: &Pubkey,
            _in_amount: u64,
            _out_amount: u64,
            _max_slippage_bps: i32,
        ) -> anyhow::Result<SwapInstruction> {
            todo!()
        }

        fn supports_exact_out(&self, _id: &Arc<dyn DexEdgeIdentifier>) -> bool {
            todo!()
        }

        fn quote_exact_out(
            &self,
            _id: &Arc<dyn DexEdgeIdentifier>,
            _edge: &Arc<dyn DexEdge>,
            _chain_data: &AccountProviderView,
            _out_amount: u64,
        ) -> anyhow::Result<Quote> {
            todo!()
        }
    }

    impl SwapStepInstructionBuilder for MockSwapStepInstructionBuilder {
        fn build_ix(
            &self,
            wallet_pk: &Pubkey,
            step: &RouteStep,
            _max_slippage_bps: i32,
            _swap_mode: SwapMode,
            _other_amount: u64,
        ) -> anyhow::Result<SwapInstruction> {
            Ok(SwapInstruction {
                instruction: Instruction {
                    program_id: Default::default(),
                    accounts: vec![],
                    data: vec![],
                },
                out_pubkey: get_associated_token_address(wallet_pk, &step.edge.output_mint),
                out_mint: step.edge.output_mint,
                in_amount_offset: 0,
                cu_estimate: None,
            })
        }
    }

    struct Token2022StepBuilder {
        wrong_output_account: bool,
    }
    impl SwapStepInstructionBuilder for Token2022StepBuilder {
        fn token_program(&self, _: &Pubkey) -> anyhow::Result<Pubkey> {
            Ok("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".parse()?)
        }
        fn mint_decimals(&self, _: &Pubkey) -> anyhow::Result<u8> {
            Ok(9)
        }
        fn build_ix(
            &self,
            wallet: &Pubkey,
            step: &RouteStep,
            _: i32,
            _: SwapMode,
            _: u64,
        ) -> anyhow::Result<SwapInstruction> {
            let program = if self.wrong_output_account {
                Token::id()
            } else {
                self.token_program(&step.edge.output_mint)?
            };
            Ok(SwapInstruction {
                instruction: Instruction {
                    program_id: Pubkey::new_unique(),
                    accounts: vec![],
                    data: 1000u64.to_le_bytes().to_vec(),
                },
                out_pubkey: get_associated_token_address_with_program_id(
                    wallet,
                    &step.edge.output_mint,
                    &program,
                ),
                out_mint: step.edge.output_mint,
                in_amount_offset: 0,
                cu_estimate: None,
            })
        }
    }

    #[test]
    fn token_2022_input_and_output_use_their_actual_program_atas() {
        let wallet = Pubkey::new_unique();
        let input = Pubkey::new_unique();
        let output = Pubkey::new_unique();
        let token_program: Pubkey = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
            .parse()
            .unwrap();
        let route = Route {
            input_mint: input,
            output_mint: output,
            in_amount: 1000,
            out_amount: 2000,
            price_impact_bps: None,
            slot: 0,
            accounts: None,
            steps: vec![RouteStep {
                edge: Arc::new(Edge {
                    input_mint: input,
                    output_mint: output,
                    dex: Arc::new(MockDex {}),
                    id: Arc::new(MockId {}),
                    accounts_needed: 1,
                    state: Default::default(),
                }),
                in_amount: 1000,
                out_amount: 2000,
                fee_amount: 0,
                fee_mint: input,
            }],
        };
        let builder = SwapInstructionsBuilderImpl::new(
            Token2022StepBuilder {
                wrong_output_account: false,
            },
            1,
        );
        let swap = builder
            .build_ixs(&wallet, &route, false, true, 100, 1900, SwapMode::ExactIn, None)
            .unwrap();
        let in_ata = get_associated_token_address_with_program_id(&wallet, &input, &token_program);
        let out_ata =
            get_associated_token_address_with_program_id(&wallet, &output, &token_program);
        assert_eq!(swap.swap_instruction.accounts[0].pubkey, in_ata);
        assert_eq!(swap.swap_instruction.accounts[1].pubkey, out_ata);
        assert_ne!(in_ata, get_associated_token_address(&wallet, &input));
        assert_eq!(swap.setup_instructions.len(), 1);
        assert!(swap.setup_instructions[0]
            .accounts
            .iter()
            .any(|meta| meta.pubkey == token_program));
        assert!(swap.setup_instructions[0]
            .accounts
            .iter()
            .any(|meta| meta.pubkey == out_ata));
        assert!(swap.cleanup_instructions.is_empty());
        let wrong = SwapInstructionsBuilderImpl::new(
            Token2022StepBuilder {
                wrong_output_account: true,
            },
            1,
        );
        assert!(wrong
            .build_ixs(&wallet, &route, false, true, 100, 1900, SwapMode::ExactIn, None)
            .is_err());
    }

    #[test]
    fn should_fail_if_there_is_no_step() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 0);
        let wallet = 0.to_pubkey();

        let ixs = builder.build_ixs(
            &wallet,
            &Route {
                input_mint: 1.to_pubkey(),
                output_mint: 2.to_pubkey(),
                in_amount: 1000,
                out_amount: 2000,
                price_impact_bps: None,
                steps: vec![],
                slot: 0,
                accounts: None,
            },
            false,
            false,
            0,
            0,
            SwapMode::ExactIn,
            None,
        );

        assert!(ixs.is_err());
    }

    #[test]
    fn should_fail_if_there_is_no_step_exact_out() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 0);
        let wallet = 0.to_pubkey();

        let ixs = builder.build_ixs(
            &wallet,
            &Route {
                input_mint: 1.to_pubkey(),
                output_mint: 2.to_pubkey(),
                in_amount: 1000,
                out_amount: 2000,
                price_impact_bps: None,
                steps: vec![],
                slot: 0,
                accounts: None,
            },
            false,
            false,
            0,
            0,
            SwapMode::ExactOut,
            None,
        );

        assert!(ixs.is_err());
    }

    #[test_case(true, false, false, 3, 1 ; "when in is SOL")]
    #[test_case(false, true, false, 1, 1 ; "when out is SOL")]
    #[test_case(false, false, false, 0, 0 ; "when none is SOL")]
    #[test_case(true, false, true, 3, 1 ; "when in is SOL exact out")]
    #[test_case(false, true, true, 1, 1 ; "when out is SOL exact out")]
    #[test_case(false, false, true, 0, 0 ; "when none is SOL exact out")]
    fn should_add_wrapping_unwrapping_ix(
        in_mint_is_sol: bool,
        out_mint_is_sol: bool,
        is_exactout: bool,
        expected_setup_len: usize,
        expected_cleanup_len: usize,
    ) {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 0);
        let wallet = 0.to_pubkey();
        let sol = Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap();

        let in_mint = if in_mint_is_sol { sol } else { 1.to_pubkey() };
        let out_mint = if out_mint_is_sol { sol } else { 2.to_pubkey() };

        let swap_mode = if is_exactout {
            SwapMode::ExactOut
        } else {
            SwapMode::ExactIn
        };

        let ixs = builder
            .build_ixs(
                &wallet,
                &Route {
                    input_mint: in_mint,
                    output_mint: out_mint,
                    in_amount: 1000,
                    out_amount: 2000,
                    price_impact_bps: None,
                    slot: 0,
                    accounts: None,
                    steps: vec![RouteStep {
                        edge: Arc::new(Edge {
                            input_mint: in_mint,
                            output_mint: out_mint,
                            dex: Arc::new(MockDex {}),
                            id: Arc::new(MockId {}),
                            accounts_needed: 1,
                            state: Default::default(),
                        }),
                        in_amount: 1000,
                        out_amount: 2000,
                        fee_amount: 0,
                        fee_mint: Default::default(),
                    }],
                },
                true,
                false,
                0,
                0,
                swap_mode,
                None,
            )
            .unwrap();

        assert_eq!(ixs.setup_instructions.len(), expected_setup_len);
        assert_eq!(ixs.cleanup_instructions.len(), expected_cleanup_len);
    }

    #[test]
    fn should_build_ixs() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 0);
        let wallet = 0.to_pubkey();

        let ixs = builder
            .build_ixs(
                &wallet,
                &Route {
                    input_mint: 1.to_pubkey(),
                    output_mint: 2.to_pubkey(),
                    in_amount: 1000,
                    out_amount: 2000,
                    price_impact_bps: None,
                    slot: 0,
                    accounts: None,
                    steps: vec![RouteStep {
                        edge: Arc::new(Edge {
                            input_mint: 1.to_pubkey(),
                            output_mint: 2.to_pubkey(),
                            accounts_needed: 1,
                            dex: Arc::new(MockDex {}),
                            id: Arc::new(MockId {}),
                            state: Default::default(),
                        }),
                        in_amount: 1000,
                        out_amount: 2000,
                        fee_amount: 0,
                        fee_mint: Default::default(),
                    }],
                },
                false,
                false,
                0,
                0,
                SwapMode::ExactIn,
                None,
            )
            .unwrap();

        assert_eq!(0, ixs.setup_instructions.len());
        assert_eq!(0, ixs.cleanup_instructions.len());
    }

    #[test]
    fn should_build_ixs_exact_out() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 0);
        let wallet = 0.to_pubkey();

        let ixs = builder
            .build_ixs(
                &wallet,
                &Route {
                    input_mint: 1.to_pubkey(),
                    output_mint: 2.to_pubkey(),
                    in_amount: 1000,
                    out_amount: 2000,
                    price_impact_bps: None,
                    slot: 0,
                    accounts: None,
                    steps: vec![RouteStep {
                        edge: Arc::new(Edge {
                            input_mint: 1.to_pubkey(),
                            output_mint: 2.to_pubkey(),
                            accounts_needed: 1,
                            dex: Arc::new(MockDex {}),
                            id: Arc::new(MockId {}),
                            state: Default::default(),
                        }),
                        in_amount: 1000,
                        out_amount: 2000,
                        fee_amount: 0,
                        fee_mint: Default::default(),
                    }],
                },
                false,
                false,
                0,
                0,
                SwapMode::ExactOut,
                None,
            )
            .unwrap();

        assert_eq!(0, ixs.setup_instructions.len());
        assert_eq!(0, ixs.cleanup_instructions.len());
    }

    fn one_hop(input_mint: Pubkey, output_mint: Pubkey) -> Route {
        Route {
            input_mint,
            output_mint,
            in_amount: 999_000,
            out_amount: 2000,
            price_impact_bps: None,
            slot: 0,
            accounts: None,
            steps: vec![RouteStep {
                edge: Arc::new(Edge {
                    input_mint,
                    output_mint,
                    dex: Arc::new(MockDex {}),
                    id: Arc::new(MockId {}),
                    accounts_needed: 1,
                    state: Default::default(),
                }),
                in_amount: 999_000,
                out_amount: 2000,
                fee_amount: 0,
                fee_mint: input_mint,
            }],
        }
    }

    fn sol() -> Pubkey {
        Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap()
    }

    #[test]
    fn input_fee_is_wrapped_with_the_swap_and_charged_before_it() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 1);
        let wallet = Pubkey::new_unique();
        let route = one_hop(sol(), Pubkey::new_unique());
        let fee = FeeLeg { side: FeeSide::Input, mint: sol(), amount: 1_000 };
        let without = builder
            .build_ixs(&wallet, &route, true, false, 50, 1990, SwapMode::ExactIn, None)
            .unwrap();
        let swap = builder
            .build_ixs(&wallet, &route, true, false, 50, 1990, SwapMode::ExactIn, Some(fee))
            .unwrap();
        let wsol = get_associated_token_address(&wallet, &sol());
        let vault = platform_fee::fee_account(&sol(), &Token::id());
        // create wSOL ATA, fund it with input plus fee, sync, create fee account, charge
        assert_eq!(swap.setup_instructions.len(), 5);
        assert_eq!(
            swap.setup_instructions[1],
            solana_program::system_instruction::transfer(&wallet, &wsol, 1_000_000)
        );
        assert!(swap.setup_instructions[3].accounts.iter().any(|m| m.pubkey == vault));
        let charge = &swap.setup_instructions[4];
        assert_eq!(charge.program_id, autobahn_executor::id());
        assert_eq!(charge.data[0], autobahn_executor::Instructions::ChargeFees as u8);
        assert_eq!(charge.data[1..9], 1_000u64.to_le_bytes());
        assert_eq!(charge.accounts[1].pubkey, wsol);
        assert_eq!(charge.accounts[1].pubkey, swap.swap_instruction.accounts[0].pubkey);
        assert_eq!(charge.accounts[2].pubkey, vault);
        assert_eq!(swap.cleanup_instructions.len(), 1);
        assert_eq!(swap.cu_estimate, without.cu_estimate + platform_fee::FEE_CU_ESTIMATE);
    }

    #[test]
    fn output_fee_is_charged_from_the_output_before_the_wsol_unwrap() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 1);
        let wallet = Pubkey::new_unique();
        let route = one_hop(Pubkey::new_unique(), sol());
        let fee = FeeLeg { side: FeeSide::Output, mint: sol(), amount: 2 };
        let swap = builder
            .build_ixs(&wallet, &route, true, false, 50, 1992, SwapMode::ExactIn, Some(fee))
            .unwrap();
        let wsol = get_associated_token_address(&wallet, &sol());
        assert_eq!(swap.cleanup_instructions.len(), 2);
        let charge = &swap.cleanup_instructions[0];
        assert_eq!(charge.program_id, autobahn_executor::id());
        assert_eq!(charge.accounts[1].pubkey, wsol);
        assert_eq!(charge.accounts[2].pubkey, platform_fee::fee_account(&sol(), &Token::id()));
        assert_eq!(swap.cleanup_instructions[1].program_id, Token::id());
        // the executor still enforces the gross minimum the caller passed
        assert_eq!(swap.swap_instruction.data[1..9], 1992u64.to_le_bytes());
    }

    #[test]
    fn token_2022_fee_is_a_checked_transfer_to_the_token_2022_fee_account() {
        let builder = SwapInstructionsBuilderImpl::new(
            Token2022StepBuilder { wrong_output_account: false },
            1,
        );
        let wallet = Pubkey::new_unique();
        let (input, output) = (Pubkey::new_unique(), Pubkey::new_unique());
        let token_program: Pubkey = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb".parse().unwrap();
        let fee = FeeLeg { side: FeeSide::Input, mint: input, amount: 999 };
        let swap = builder
            .build_ixs(&wallet, &one_hop(input, output), false, true, 100, 1900, SwapMode::ExactIn, Some(fee))
            .unwrap();
        let charge = swap.setup_instructions.last().unwrap();
        assert_eq!(charge.program_id, token_program);
        assert_eq!(charge.data, [&[12u8][..], &999u64.to_le_bytes(), &[9]].concat());
        assert_eq!(
            charge.accounts[0].pubkey,
            get_associated_token_address_with_program_id(&wallet, &input, &token_program)
        );
        assert_eq!(charge.accounts[2].pubkey, platform_fee::fee_account(&input, &token_program));
    }

    #[test]
    fn zero_fees_add_nothing_and_a_fee_on_the_wrong_mint_is_refused() {
        let builder = SwapInstructionsBuilderImpl::new(MockSwapStepInstructionBuilder {}, 1);
        let wallet = Pubkey::new_unique();
        let route = one_hop(Pubkey::new_unique(), Pubkey::new_unique());
        let zero = FeeLeg { side: FeeSide::Input, mint: route.input_mint, amount: 0 };
        let swap = builder
            .build_ixs(&wallet, &route, false, false, 0, 1, SwapMode::ExactIn, Some(zero))
            .unwrap();
        assert!(swap.setup_instructions.is_empty() && swap.cleanup_instructions.is_empty());
        let wrong = FeeLeg { side: FeeSide::Output, mint: route.input_mint, amount: 5 };
        assert!(builder
            .build_ixs(&wallet, &route, false, false, 0, 1, SwapMode::ExactIn, Some(wrong))
            .is_err());
    }

}
