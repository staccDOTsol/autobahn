//! SIMD-0385 wire encoder. The router's venue SDKs retain their account-layout
//! compatible Solana version; only transaction serialization is version-specific.
//! https://solana.com/docs/core/transactions/versioned-transactions
use solana_sdk::{hash::Hash, instruction::Instruction, message::Message, pubkey::Pubkey};

pub const MAX_LOADED_ACCOUNT_BYTES: u32 = 64 * 1024 * 1024;

pub fn compile_unsigned(
    payer: &Pubkey,
    instructions: &[Instruction],
    blockhash: &Hash,
    compute_units: u32,
    priority_fee_lamports: u64,
) -> anyhow::Result<(Vec<u8>, usize)> {
    anyhow::ensure!((1..=1_400_000).contains(&compute_units), "Invalid compute unit limit");
    anyhow::ensure!(!instructions.is_empty() && instructions.len() <= 64, "V1 instruction limit exceeded");
    anyhow::ensure!(instructions.iter().all(|ix| ix.program_id != solana_sdk::compute_budget::id()),
        "V1 resource limits must use message config");
    // Legacy compilation supplies the canonical account ordering and index map.
    // No legacy message or signature framing is serialized into the V1 wire.
    let message = Message::new_with_blockhash(instructions, Some(payer), blockhash);
    let header = message.header;
    anyhow::ensure!(header.num_required_signatures == 1 && header.num_readonly_signed_accounts == 0,
        "Swap must require only the writable wallet signer");
    anyhow::ensure!(message.account_keys.len() <= 64, "V1 account limit exceeded");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&[0x81, header.num_required_signatures,
        header.num_readonly_signed_accounts, header.num_readonly_unsigned_accounts]);
    // Fee occupies bits 0 AND 1; CU and loaded account size occupy bits 2 and 3.
    bytes.extend_from_slice(&0x0fu32.to_le_bytes());
    bytes.extend_from_slice(blockhash.as_ref());
    bytes.extend_from_slice(&[message.instructions.len() as u8, message.account_keys.len() as u8]);
    for address in &message.account_keys { bytes.extend_from_slice(address.as_ref()); }
    bytes.extend_from_slice(&priority_fee_lamports.to_le_bytes());
    bytes.extend_from_slice(&compute_units.to_le_bytes());
    bytes.extend_from_slice(&MAX_LOADED_ACCOUNT_BYTES.to_le_bytes());
    // All fixed headers precede all variable payloads (unlike V0).
    for ix in &message.instructions {
        let accounts = u8::try_from(ix.accounts.len())?;
        let data_len = u16::try_from(ix.data.len())?;
        bytes.extend_from_slice(&[ix.program_id_index, accounts]);
        bytes.extend_from_slice(&data_len.to_le_bytes());
    }
    for ix in &message.instructions {
        bytes.extend_from_slice(&ix.accounts);
        bytes.extend_from_slice(&ix.data);
    }
    // Wallet signs every preceding byte, including the 0x81 prefix.
    bytes.extend_from_slice(&[0; 64]);
    Ok((bytes, message.account_keys.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::{instruction::AccountMeta, system_instruction};

    #[test]
    fn v1_transfer_has_explicit_resources_and_trailing_signature() {
        let payer = Pubkey::new_from_array([1; 32]);
        let recipient = Pubkey::new_from_array([2; 32]);
        let hash = Hash::new_from_array([3; 32]);
        let ix = system_instruction::transfer(&payer, &recipient, 42);
        let (bytes, accounts) = compile_unsigned(&payer, &[ix], &hash, 200_000, 5_000).unwrap();
        assert_eq!(accounts, 3);
        assert_eq!(&bytes[..8], &[0x81, 1, 0, 1, 15, 0, 0, 0]);
        assert_eq!(&bytes[8..40], &[3; 32]);
        assert_eq!(&bytes[40..42], &[1, 3]);
        assert_eq!(&bytes[42..74], &[1; 32]);
        assert_eq!(&bytes[74..106], &[2; 32]);
        assert_eq!(&bytes[138..146], &5000u64.to_le_bytes());
        assert_eq!(&bytes[146..150], &200_000u32.to_le_bytes());
        assert_eq!(&bytes[150..154], &MAX_LOADED_ACCOUNT_BYTES.to_le_bytes());
        assert_eq!(&bytes[154..160], &[2, 2, 12, 0, 0, 1]);
        assert_eq!(&bytes[160..164], &2u32.to_le_bytes());
        assert_eq!(&bytes[164..172], &42u64.to_le_bytes());
        assert_eq!(&bytes[172..], &[0; 64]);
    }

    #[test]
    fn v1_holds_large_instructions_and_rejects_unexpected_signers() {
        let payer = Pubkey::new_unique();
        let program = Pubkey::new_unique();
        let mut ix = Instruction { program_id: program, accounts: vec![], data: vec![42; 1500] };
        let (bytes, _) = compile_unsigned(&payer, &[ix.clone()], &Hash::default(), 100_000, 0).unwrap();
        assert!(bytes.len() > 1232 && bytes.len() < 4096);
        ix.accounts.push(AccountMeta::new(Pubkey::new_unique(), true));
        assert!(compile_unsigned(&payer, &[ix], &Hash::default(), 100_000, 0).is_err());
    }

    #[test]
    fn v1_rejects_missing_resources_and_compute_budget_instructions() {
        let payer = Pubkey::new_unique();
        let ix = system_instruction::transfer(&payer, &Pubkey::new_unique(), 1);
        assert!(compile_unsigned(&payer, &[ix], &Hash::default(), 0, 0).is_err());
        let ix = solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(100);
        assert!(compile_unsigned(&payer, &[ix], &Hash::default(), 100, 0).is_err());
    }
}
