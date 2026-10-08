use std::{io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use axum::{extract::Query, routing::{get,post}, Json, Router};
use super::errors::AppError;

struct Process { child: Child, input: ChildStdin, output: mpsc::Receiver<std::io::Result<String>> }
impl Drop for Process { fn drop(&mut self) { let _=self.child.kill();let _=self.child.wait(); } }
#[derive(Default)]
struct Operations { process: Mutex<Option<Process>> }
impl Operations {
    fn call(&self, method:&str, data:Value)->Result<Value> {
        let mut guard=self.process.lock().map_err(|_|anyhow::anyhow!("Liquidity worker lock failed"))?;
        if guard.is_none() {
            let path=std::env::var("LIQUIDITY_WORKER_PATH").unwrap_or_else(|_|concat!(env!("CARGO_MANIFEST_DIR"),"/../../lib/liquidity-operations/worker/worker.mjs").to_owned());
            let mut child=Command::new("node").arg(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().context("Liquidity SDK worker could not start")?;
            let input=child.stdin.take().context("Liquidity worker input unavailable")?;
            let output=child.stdout.take().context("Liquidity worker output unavailable")?;
            let (sender,receiver)=mpsc::sync_channel(1);
            std::thread::spawn(move|| { let mut reader=BufReader::new(output); loop {let mut line=String::new(); match reader.read_line(&mut line) {Ok(0)=>break,Ok(_) if line.len()<=1024*1024=>{if sender.send(Ok(line)).is_err(){break;}},_=>{let _=sender.send(Err(std::io::Error::new(std::io::ErrorKind::InvalidData,"Liquidity worker response invalid")));break;}}} });
            *guard=Some(Process{child,input,output:receiver});
        }
        let request=serde_json::to_vec(&json!({"id":1,"method":method,"data":data}))?;
        anyhow::ensure!(request.len()<=64*1024,"Liquidity request too large");
        let result=(||->Result<Value>{let process=guard.as_mut().context("Liquidity worker unavailable")?;process.input.write_all(&request)?;process.input.write_all(b"\n")?;process.input.flush()?;
            let line=process.output.recv_timeout(Duration::from_secs(60)).context("Liquidity SDK request timed out")??;
            let response:Value=serde_json::from_str(&line)?;
            anyhow::ensure!(response["id"]==1,"Unexpected liquidity response");
            Ok(response)
        })();
        let response=match result { Ok(response)=>response,Err(error)=>{*guard=None;return Err(error);} };
        if let Some(error)=response["error"].as_str(){anyhow::bail!("{error}");}
        response.get("result").cloned().context("Liquidity result missing")
    }
}
async fn request(engine:Arc<Operations>, permit:Arc<tokio::sync::Semaphore>,method:&'static str,data:Value)->Result<Json<Value>,AppError> {
    let _permit=permit.try_acquire_owned().map_err(|_|anyhow::anyhow!("Liquidity service busy; retry shortly"))?;
    let result=tokio::task::spawn_blocking(move||engine.call(method,data)).await.map_err(|_|anyhow::anyhow!("Liquidity worker task failed"))??;
    Ok(Json(result))
}
pub fn routes()->Router {
    let engine=Arc::new(Operations::default());let slots=Arc::new(tokio::sync::Semaphore::new(4));
    let a=engine.clone();let s=slots.clone();
    let router=Router::new().route("/liquidity/capabilities",get(move||request(a,s,"capabilities",json!({}))));
    let a=engine.clone();let s=slots.clone();
    let router=router.route("/liquidity/positions",get(move|Query(data):Query<std::collections::HashMap<String,String>>|request(a,s,"positions",json!(data))));
    let a=engine.clone();let s=slots.clone();
    router.route("/liquidity/quote",post(move|Json(data):Json<Value>|request(a,s,"quote",data)))
        .route("/liquidity/build",post(move|Json(data):Json<Value>|request(engine,slots,"build",data)))
}
