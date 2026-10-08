use anyhow::{bail, ensure, Context, Result};
use router_feed_lib::router_rpc_client::{RouterRpcClient, RouterRpcClientTrait};
use router_lib::dex::AccountProviderView;
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::{Account, ReadableAccount},
    bpf_loader, bpf_loader_deprecated,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    instruction::{AccountMeta as Meta, Instruction},
    pubkey::Pubkey,
    stake, system_program, sysvar,
};
use std::str::FromStr;

use crate::{Direction, StakePoolEdgeIdentifier, WSOL};

/// An operator supplies a reviewed executable hash. An executable flag alone is
/// not evidence that a program implements this bridge's account/data ABI.
pub struct VerifiedBridge {
    pub program: Pubkey,
    pub programdata: Option<Pubkey>,
    hash: [u8; 32],
}

impl VerifiedBridge {
    pub async fn initialize(
        rpc: &mut RouterRpcClient,
        address: &str,
        expected: &str,
    ) -> Result<Self> {
        let program = Pubkey::from_str(address).context("invalid bridge_program")?;
        ensure!(
            expected.len() == 64 && expected.bytes().all(|v| v.is_ascii_hexdigit()),
            "bridge_program_sha256 must be 64 hex characters"
        );
        let mut hash = [0u8; 32];
        for (index, byte) in hash.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&expected[index * 2..index * 2 + 2], 16)?;
        }
        let account = rpc
            .get_account(&program)
            .await?
            .context("bridge program is missing")?;
        let programdata = programdata_address(&account)?;
        let data = match programdata {
            Some(key) => Some(
                rpc.get_account(&key)
                    .await?
                    .context("bridge ProgramData is missing")?,
            ),
            None => None,
        };
        verify_program(&account, data.as_ref(), &hash)?;
        Ok(Self {
            program,
            programdata,
            hash,
        })
    }

    pub fn verify(&self, chain: &AccountProviderView) -> Result<()> {
        let program: Account = chain.account(&self.program)?.account.into();
        ensure!(
            programdata_address(&program)? == self.programdata,
            "bridge ProgramData changed"
        );
        let data = self
            .programdata
            .map(|key| chain.account(&key).map(|v| Account::from(v.account)))
            .transpose()?;
        verify_program(&program, data.as_ref(), &self.hash)
    }
}

fn programdata_address(program: &Account) -> Result<Option<Pubkey>> {
    ensure!(program.executable, "bridge program is not executable");
    if program.owner == bpf_loader_upgradeable::id() {
        match bincode::deserialize::<UpgradeableLoaderState>(&program.data)? {
            UpgradeableLoaderState::Program {
                programdata_address,
            } => Ok(Some(programdata_address)),
            _ => bail!("invalid upgradeable bridge program account"),
        }
    } else if program.owner == bpf_loader::id() || program.owner == bpf_loader_deprecated::id() {
        Ok(None)
    } else {
        bail!("unsupported bridge program loader")
    }
}

fn verify_program(
    program: &Account,
    programdata: Option<&Account>,
    expected: &[u8; 32],
) -> Result<()> {
    let upgraded = programdata_address(program)?.is_some();
    let bytes = if upgraded {
        let data = programdata.context("bridge ProgramData is missing")?;
        ensure!(
            data.owner == bpf_loader_upgradeable::id(),
            "invalid bridge ProgramData owner"
        );
        ensure!(
            matches!(
                bincode::deserialize::<UpgradeableLoaderState>(&data.data)?,
                UpgradeableLoaderState::ProgramData { .. }
            ),
            "invalid bridge ProgramData header"
        );
        data.data
            .get(UpgradeableLoaderState::size_of_programdata_metadata()..)
            .context("truncated bridge ProgramData")?
    } else {
        program.data()
    };
    ensure!(!bytes.is_empty(), "empty bridge executable");
    ensure!(
        Sha256::digest(bytes).as_slice() == expected,
        "bridge executable SHA-256 mismatch"
    );
    Ok(())
}

pub fn ata(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )
    .0
}

/// Exact engine tags 34/35 and account order from the pinned router.rs source
/// recorded in PROVENANCE.md. No stake-pool-native SOL instruction is mislabeled
/// as a WSOL edge: this bridge unwraps/rewraps inside the single edge CPI.
pub fn instruction(
    bridge: Pubkey,
    edge: &StakePoolEdgeIdentifier,
    wallet: Pubkey,
    amount: u64,
    minimum: u64,
) -> Result<Instruction> {
    ensure!(
        amount > 0 && minimum > 0,
        "stake-pool amounts must be positive"
    );
    let lst_account = ata(&wallet, &edge.mint, &edge.token_program);
    ensure!(
        edge.direction != Direction::Mint || lst_account != edge.manager_fee,
        "stake-pool mint destination cannot be the manager fee account"
    );
    let wsol_account = ata(&wallet, &WSOL, &spl_token::id());
    let withdraw =
        Pubkey::find_program_address(&[edge.pool.as_ref(), b"withdraw"], &edge.pool_program).0;
    let mut data = vec![match edge.direction {
        Direction::Mint => 34,
        Direction::Redeem => 35,
    }];
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&minimum.to_le_bytes());
    let r = |key| Meta::new_readonly(key, false);
    let w = |key| Meta::new(key, false);
    let accounts = match edge.direction {
        Direction::Mint => {
            let sol = Pubkey::find_program_address(&[b"sol", wallet.as_ref()], &bridge).0;
            let wrapped =
                Pubkey::find_program_address(&[b"wsol", wallet.as_ref(), WSOL.as_ref()], &bridge).0;
            vec![
                Meta::new(wallet, true),
                Meta::new_readonly(wallet, true),
                w(wsol_account),
                w(lst_account),
                r(WSOL),
                w(edge.mint),
                w(edge.manager_fee),
                r(spl_token::id()),
                r(edge.token_program),
                r(system_program::id()),
                r(edge.pool_program),
                w(edge.pool),
                r(withdraw),
                w(edge.reserve),
                w(edge.manager_fee),
                w(sol),
                w(wrapped),
            ]
        }
        Direction::Redeem => vec![
            Meta::new_readonly(wallet, true),
            w(lst_account),
            w(wsol_account),
            r(WSOL),
            w(edge.mint),
            r(edge.token_program),
            r(spl_token::id()),
            r(edge.pool_program),
            w(edge.pool),
            r(withdraw),
            w(edge.reserve),
            w(edge.manager_fee),
            r(sysvar::clock::id()),
            r(sysvar::stake_history::id()),
            r(stake::program::id()),
        ],
    };
    Ok(Instruction {
        program_id: bridge,
        accounts,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(direction: Direction) -> StakePoolEdgeIdentifier {
        StakePoolEdgeIdentifier {
            pool: Pubkey::new_unique(),
            pool_program: crate::POOL_PROGRAMS[1],
            mint: Pubkey::new_unique(),
            token_program: spl_token_2022::id(),
            reserve: Pubkey::new_unique(),
            manager_fee: Pubkey::new_unique(),
            direction,
        }
    }

    #[test]
    fn mint_uses_exact_wsol_source_and_token_2022_destination() {
        let edge = edge(Direction::Mint);
        let program = Pubkey::new_unique();
        let wallet = Pubkey::new_unique();
        let amount = 9_007_199_254_740_993;
        let ix = instruction(program, &edge, wallet, amount, 123).unwrap();
        assert_eq!(ix.program_id, program);
        assert_eq!(ix.data.len(), 17);
        assert_eq!(ix.data[0], 34);
        assert_eq!(
            u64::from_le_bytes(ix.data[1..9].try_into().unwrap()),
            amount
        );
        assert_eq!(u64::from_le_bytes(ix.data[9..17].try_into().unwrap()), 123);
        assert_eq!(ix.accounts.len(), 17);
        assert_eq!(ix.accounts[0], Meta::new(wallet, true));
        assert_eq!(ix.accounts[1], Meta::new_readonly(wallet, true));
        assert_eq!(ix.accounts[2].pubkey, ata(&wallet, &WSOL, &spl_token::id()));
        assert_eq!(
            ix.accounts[3].pubkey,
            ata(&wallet, &edge.mint, &spl_token_2022::id())
        );
        assert_ne!(
            ix.accounts[3].pubkey,
            ata(&wallet, &edge.mint, &spl_token::id())
        );
        assert_eq!(ix.accounts[7].pubkey, spl_token::id());
        assert_eq!(ix.accounts[8].pubkey, spl_token_2022::id());
        assert_eq!(ix.accounts[10].pubkey, edge.pool_program);
        assert_eq!(ix.accounts[11].pubkey, edge.pool);
        assert_eq!(ix.accounts[13].pubkey, edge.reserve);
        assert_eq!(ix.accounts[6].pubkey, edge.manager_fee);
        assert_eq!(ix.accounts[14].pubkey, edge.manager_fee);
        assert_eq!(
            ix.accounts[15].pubkey,
            Pubkey::find_program_address(&[b"sol", wallet.as_ref()], &program).0
        );
        assert_eq!(
            ix.accounts[16].pubkey,
            Pubkey::find_program_address(&[b"wsol", wallet.as_ref(), WSOL.as_ref()], &program).0
        );
    }

    #[test]
    fn redeem_patches_only_input_preserving_minimum_for_multihop_executor() {
        let edge = edge(Direction::Redeem);
        let wallet = Pubkey::new_unique();
        let mut ix = instruction(Pubkey::new_unique(), &edge, wallet, 1000, 900).unwrap();
        assert_eq!(ix.accounts.len(), 15);
        assert_eq!(ix.accounts[0], Meta::new_readonly(wallet, true));
        assert_eq!(
            ix.accounts[1].pubkey,
            ata(&wallet, &edge.mint, &edge.token_program)
        );
        assert_eq!(ix.accounts[2].pubkey, ata(&wallet, &WSOL, &spl_token::id()));
        assert_eq!(ix.accounts[7].pubkey, edge.pool_program);
        assert_eq!(ix.accounts[8].pubkey, edge.pool);
        assert_eq!(ix.accounts[10].pubkey, edge.reserve);
        assert_eq!(ix.accounts[12].pubkey, sysvar::clock::id());
        assert_eq!(ix.accounts[13].pubkey, sysvar::stake_history::id());
        assert_eq!(ix.accounts[14].pubkey, stake::program::id());
        // Autobahn substitutes an intermediate edge's actual output here.
        ix.data[1..9].copy_from_slice(&1100u64.to_le_bytes());
        assert_eq!(ix.data[0], 35);
        assert_eq!(u64::from_le_bytes(ix.data[1..9].try_into().unwrap()), 1100);
        assert_eq!(u64::from_le_bytes(ix.data[9..17].try_into().unwrap()), 900);
    }

    #[test]
    fn no_zero_minimum_or_aliasing_fee_destination_can_be_built() {
        let mut edge = edge(Direction::Mint);
        let wallet = Pubkey::new_unique();
        let program = Pubkey::new_unique();
        assert!(instruction(program, &edge, wallet, 1, 0).is_err());
        assert!(instruction(program, &edge, wallet, 0, 1).is_err());
        edge.manager_fee = ata(&wallet, &edge.mint, &edge.token_program);
        assert!(instruction(program, &edge, wallet, 100, 1).is_err());
    }

    #[test]
    fn executable_flag_does_not_bypass_hash_or_loader_validation() {
        let bytes = vec![1, 2, 3, 4];
        let hash: [u8; 32] = Sha256::digest(&bytes).into();
        let mut program = Account {
            data: bytes,
            executable: true,
            owner: bpf_loader::id(),
            ..Account::default()
        };
        assert!(verify_program(&program, None, &hash).is_ok());
        program.data[0] ^= 1;
        assert!(verify_program(&program, None, &hash).is_err());
        program.owner = Pubkey::new_unique();
        assert!(verify_program(&program, None, &hash).is_err());
    }

    #[test]
    fn upgradeable_hash_covers_executable_bytes_not_upgrade_metadata() {
        let data_address = Pubkey::new_unique();
        let program = Account {
            executable: true,
            owner: bpf_loader_upgradeable::id(),
            data: bincode::serialize(&UpgradeableLoaderState::Program {
                programdata_address: data_address,
            })
            .unwrap(),
            ..Account::default()
        };
        let mut bytes = bincode::serialize(&UpgradeableLoaderState::ProgramData {
            slot: 1,
            upgrade_authority_address: Some(Pubkey::new_unique()),
        })
        .unwrap();
        bytes.extend([1, 2, 3, 4]);
        let mut data = Account {
            owner: bpf_loader_upgradeable::id(),
            data: bytes,
            ..Account::default()
        };
        let hash = Sha256::digest([1, 2, 3, 4]).into();
        assert!(verify_program(&program, None, &hash).is_err());
        assert!(verify_program(&program, Some(&data), &hash).is_ok());
        *data.data.last_mut().unwrap() = 5;
        assert!(verify_program(&program, Some(&data), &hash).is_err());
    }
}
