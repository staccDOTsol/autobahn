import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedRpcFetch} from '../rpc.mjs';
test('RPC rejects declared and streamed oversized responses and releases the permit',async()=>{
 let calls=0;
 const fetcher=boundedRpcFetch({concurrency:1,maxBytes:10,fetcher:async()=>++calls===1?new Response('too large',{headers:{'content-length':'100'}}):calls===2?new Response('01234567890'):new Response('{}')});
 await assert.rejects(()=>fetcher('https://rpc.invalid'),/limit/);
 await assert.rejects(()=>fetcher('https://rpc.invalid'),/limit/);
 assert.deepEqual(await(await fetcher('https://rpc.invalid')).json(),{});
});
test('SDK fanout respects concurrency and propagates provider status',async()=>{
 let active=0,max=0;
 const f=boundedRpcFetch({concurrency:2,fetcher:async()=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,2));active--;return new Response('{}',{status:429});}});
 const responses=await Promise.all(Array.from({length:8},()=>f('https://rpc.invalid')));
 assert.equal(max,2);assert.ok(responses.every(r=>r.status===429));
});
