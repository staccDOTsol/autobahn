// Bound SDK-driven RPC fanout and decoded response allocation as well as latency.
export function boundedRpcFetch({fetcher=fetch,maxBytes=16*1024*1024,concurrency=8,timeoutMs=15_000}={}) {
  let active=0;const waiting=[];
  const acquire=()=>new Promise((resolve,reject)=>{
    if(active<concurrency){active++;resolve();return;}
    if(waiting.length>=128){reject(new Error('Liquidity RPC queue is full'));return;}
    waiting.push(resolve);
  });
  const release=()=>{const next=waiting.shift();if(next)next();else active--;};
  return async(input,init={})=>{
    await acquire();
    try {
      const signal=AbortSignal.timeout(timeoutMs);
      const response=await fetcher(input,{...init,signal:init.signal?AbortSignal.any([init.signal,signal]):signal});
      if(Number(response.headers.get('content-length')??0)>maxBytes){await response.body?.cancel();throw new Error('Liquidity RPC response exceeds the account-read limit');}
      const reader=response.body?.getReader();if(!reader)return response;
      let length=0;const chunks=[];
      while(true){const{done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes){await reader.cancel();throw new Error('Liquidity RPC response exceeds the account-read limit');}chunks.push(value);}
      return new Response(Buffer.concat(chunks,length),{status:response.status,headers:{'content-type':'application/json'}});
    } finally {release();}
  };
}
