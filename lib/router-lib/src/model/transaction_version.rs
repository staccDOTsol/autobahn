use serde::{Deserialize, Serialize};

/// The wire format is negotiated before quoting so route sizing matches the wallet.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub enum TransactionVersion {
    #[serde(rename = "0")]
    V0,
    #[default]
    #[serde(rename = "1")]
    V1,
}

impl TransactionVersion {
    pub fn max_size(self) -> usize {
        match self { Self::V0 => 1232, Self::V1 => 4096 }
    }
}
