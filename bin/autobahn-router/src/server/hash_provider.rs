use async_trait::async_trait;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_program::hash::Hash;
use solana_sdk::commitment_config::CommitmentConfig;
use std::sync::RwLock;
use std::time::{Duration, Instant};

#[async_trait]
pub trait HashProvider {
    async fn get_latest_hash(&self) -> anyhow::Result<(Hash, u64)>;
}

pub struct RpcHashProvider {
    pub rpc_client: RpcClient,
    pub last_update: RwLock<Option<(Instant, Hash, u64)>>,
}

#[async_trait]
impl HashProvider for RpcHashProvider {
    async fn get_latest_hash(&self) -> anyhow::Result<(Hash, u64)> {
        {
            let locked = self.last_update.read().unwrap();
            if let Some((update, hash, height)) = *locked {
                if Instant::now().duration_since(update) < Duration::from_millis(500) {
                    return Ok((hash, height));
                }
            }
        }

        let (hash, height) = self.rpc_client
            .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed()).await?;
        let mut locked = self.last_update.write().unwrap();
        *locked = Some((Instant::now(), hash, height));
        Ok((hash, height))
    }
}
