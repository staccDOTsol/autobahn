use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

struct Process {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<std::io::Result<String>>,
}

#[cfg(test)]
mod shared_worker_tests {
    use super::*;
    #[test]
    fn discovery_snapshots_share_the_official_sdk_worker() {
        let first = Engine::shared(None, None).expect("installed official DBC SDK worker");
        let second = Engine::shared(None, None).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(second.call(json!({"op":"ping"})).unwrap()["sdk"], "1.5.12");
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Persistent offline SDK process. Calls serialize through a mutex; a timeout
/// kills the child so an old response cannot be mistaken for a later quote.
pub(crate) struct Engine {
    process: Mutex<Option<Process>>,
    path: String,
    node: String,
}

impl Engine {
    /// Incremental discovery keeps several small adapter snapshots. They share
    /// one serialized SDK process for each configured worker, rather than one
    /// Node heap per newly requested mint. Failed calls still reset that process.
    pub(crate) fn shared(path: Option<String>, node: Option<String>) -> Result<Arc<Self>> {
        static ENGINES: OnceLock<Mutex<HashMap<(String, String), Weak<Engine>>>> = OnceLock::new();
        let path = path
            .or_else(|| std::env::var("DBC_WORKER_PATH").ok())
            .unwrap_or_else(|| {
                concat!(env!("CARGO_MANIFEST_DIR"), "/worker/worker.mjs").to_owned()
            });
        let node = node.unwrap_or_else(|| "node".to_owned());
        let key = (path.clone(), node.clone());
        let mut engines = ENGINES
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| anyhow::anyhow!("DBC engine registry lock poisoned"))?;
        if let Some(engine) = engines.get(&key).and_then(Weak::upgrade) {
            return Ok(engine);
        }
        engines.retain(|_, engine| engine.strong_count() > 0);
        let engine = Arc::new(Self::new(Some(path), Some(node))?);
        engines.insert(key, Arc::downgrade(&engine));
        Ok(engine)
    }
    pub(crate) fn new(path: Option<String>, node: Option<String>) -> Result<Self> {
        let engine = Self {
            process: Mutex::new(None),
            path: path
                .or_else(|| std::env::var("DBC_WORKER_PATH").ok())
                .unwrap_or_else(|| {
                    concat!(env!("CARGO_MANIFEST_DIR"), "/worker/worker.mjs").to_owned()
                }),
            node: node.unwrap_or_else(|| "node".to_owned()),
        };
        let response = engine.call(json!({"op": "ping"}))?;
        anyhow::ensure!(
            response["sdk"] == "1.5.12",
            "Unsupported DBC SDK worker version"
        );
        Ok(engine)
    }

    fn spawn(&self) -> Result<Process> {
        let mut child = Command::new(&self.node)
            .arg(&self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context(
                "Start DBC SDK worker; install Node22 and run npm ci in lib/dex-meteora-dbc/worker",
            )?;
        let input = child.stdin.take().context("DBC worker stdin")?;
        let output = child.stdout.take().context("DBC worker stdout")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = String::new();
                let result = reader.read_line(&mut line);
                if matches!(result, Ok(0)) {
                    break;
                }
                let result = result.and_then(|_| {
                    if line.len() > 128 * 1024 {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "DBC response too large",
                        ))
                    } else {
                        Ok(line)
                    }
                });
                if sender.send(result).is_err() {
                    break;
                }
            }
        });
        Ok(Process {
            child,
            input,
            output: receiver,
        })
    }

    pub(crate) fn call(&self, request: Value) -> Result<Value> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| anyhow::anyhow!("DBC worker lock poisoned"))?;
        if process.is_none() {
            *process = Some(self.spawn()?);
        }
        let serialized = serde_json::to_vec(&request)?;
        anyhow::ensure!(serialized.len() <= 128 * 1024, "DBC request too large");
        let run = || -> Result<Value> {
            let child = process.as_mut().context("DBC worker missing")?;
            child.input.write_all(&serialized)?;
            child.input.write_all(b"\n")?;
            child.input.flush()?;
            let line = child
                .output
                .recv_timeout(Duration::from_secs(5))
                .context("DBC worker timed out or stopped")??;
            Ok(serde_json::from_str(&line).context("Invalid DBC worker response")?)
        }();
        let response = match run {
            Ok(response) => response,
            Err(error) => {
                *process = None;
                return Err(error);
            }
        };
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            bail!("DBC: {error}");
        }
        response
            .get("result")
            .cloned()
            .context("Missing DBC worker result")
    }
}
