use serde_derive::{Deserialize, Serialize};
use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

#[serde_with::serde_as]
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwapResponse {
    pub transaction_version: super::transaction_version::TransactionVersion,
    #[serde_as(as = "serde_with::base64::Base64")]
    pub swap_transaction: Vec<u8>,
    pub last_valid_block_height: u64,
    #[serde(rename = "prioritizationFeeLamports")]
    pub priorization_fee_lamports: u64,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwapIxResponse {
    #[serde(default)]
    pub transaction_version: super::transaction_version::TransactionVersion,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_config: Option<TransactionConfig>,
    pub token_ledger_instruction: Option<InstructionResponse>,
    pub compute_budget_instructions: Option<Vec<InstructionResponse>>,
    pub setup_instructions: Option<Vec<InstructionResponse>>,
    pub swap_instruction: InstructionResponse,
    pub cleanup_instructions: Option<Vec<InstructionResponse>>,
    pub address_lookup_table_addresses: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransactionConfig {
    pub compute_unit_limit: u32,
    pub loaded_accounts_data_size_limit: u32,
    pub priority_fee_lamports: u64,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstructionResponse {
    pub program_id: String,
    pub data: Option<String>,
    pub accounts: Option<Vec<AccountMeta>>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountMeta {
    pub pubkey: String,
    pub is_signer: Option<bool>,
    pub is_writable: Option<bool>,
}

impl InstructionResponse {
    pub fn from_ix(instruction: Instruction) -> anyhow::Result<InstructionResponse> {
        Ok(Self {
            program_id: instruction.program_id.to_string(),
            data: Some(base64::encode(instruction.data)),
            accounts: Some(
                instruction
                    .accounts
                    .into_iter()
                    .map(|x| AccountMeta {
                        pubkey: x.pubkey.to_string(),
                        is_signer: Some(x.is_signer),
                        is_writable: Some(x.is_writable),
                    })
                    .collect(),
            ),
        })
    }

    pub fn to_ix(&self) -> anyhow::Result<Instruction> {
        self.try_into()
    }
}

impl TryFrom<&InstructionResponse> for solana_sdk::instruction::Instruction {
    type Error = anyhow::Error;
    fn try_from(m: &InstructionResponse) -> Result<Self, Self::Error> {
        Ok(Self {
            program_id: Pubkey::from_str(&m.program_id)?,
            data: m.data.as_ref().map(base64::decode).unwrap_or(Ok(vec![]))?,
            accounts: m
                .accounts
                .as_ref()
                .map(|accs| {
                    accs.iter()
                        .map(|a| a.try_into())
                        .collect::<anyhow::Result<Vec<solana_sdk::instruction::AccountMeta>>>()
                })
                .unwrap_or(Ok(vec![]))?,
        })
    }
}

impl TryFrom<&AccountMeta> for solana_sdk::instruction::AccountMeta {
    type Error = anyhow::Error;
    fn try_from(m: &AccountMeta) -> Result<Self, Self::Error> {
        Ok(Self {
            pubkey: Pubkey::from_str(&m.pubkey)?,
            is_signer: m.is_signer.unwrap_or(false),
            is_writable: m.is_writable.unwrap_or(false),
        })
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    #[test]
    fn swap_wire_is_base64_and_reports_actual_version_and_expiry() {
        let response = SwapResponse {
            transaction_version: super::super::transaction_version::TransactionVersion::V1,
            swap_transaction: vec![0x81, 1, 0, 0],
            last_valid_block_height: 123,
            priorization_fee_lamports: 42,
        };
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["swapTransaction"], "gQEAAA==");
        assert_eq!(json["transactionVersion"], "1");
        assert_eq!(json["lastValidBlockHeight"], 123);
        assert_eq!(json["prioritizationFeeLamports"], 42);
    }
}
