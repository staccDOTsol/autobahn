import { randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { compileOperation } from './transactions.mjs';
const TTL=60_000;
const copy = value => structuredClone(value);
const publicKey = value => { if(typeof value!=='string'||value.length>44) throw new Error('Invalid Solana address');return new PublicKey(value); };
const identity = line => `${line.direction}:${line.mint}`;
function quoteAmounts(quote, allowEmpty = false) {
  if(!quote||!Array.isArray(quote.amounts)||(!allowEmpty&&!quote.amounts.length)||quote.amounts.length>20) throw new Error('Adapter did not return a bounded economic quote');
  const seen=new Set();
  for(const a of quote.amounts) {
    publicKey(a.mint);
    if(!['debit','credit'].includes(a.direction)||!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>38) throw new Error('Invalid quote amount');
    for(const k of ['expectedRaw','limitRaw']) if(typeof a[k]!=='string'||!/^(0|[1-9]\d{0,38})$/.test(a[k])||BigInt(a[k])>=(1n<<128n)) throw new Error('Invalid atomic amount');
    if(seen.has(identity(a))) throw new Error('Duplicate quote amount');seen.add(identity(a));
    if(a.direction==='debit' ? BigInt(a.limitRaw)<BigInt(a.expectedRaw) : BigInt(a.limitRaw)>BigInt(a.expectedRaw)) throw new Error('Invalid quote limit');
  }
}
export function enforceApprovedBounds(approved,fresh) {
  quoteAmounts(approved,approved.operation==='initialize');quoteAmounts(fresh,approved.operation==='initialize');
  if(approved.pool!==fresh.pool||approved.position!==fresh.position||approved.amounts.length!==fresh.amounts.length) throw new Error('Operation identity changed; request a new quote');
  const current=new Map(fresh.amounts.map(a=>[identity(a),a]));
  for(const old of approved.amounts) {
    const now=current.get(identity(old));
    if(!now||now.decimals!==old.decimals) throw new Error('Operation tokens changed; request a new quote');
    if(old.direction==='debit' ? BigInt(now.expectedRaw)>BigInt(old.limitRaw) : BigInt(now.expectedRaw)<BigInt(old.limitRaw)) throw new Error('Liquidity moved outside your approved limits; request a new quote');
  }
  // The builder receives these exact limits, never newly widened slippage.
  return copy(approved);
}
export class LiquidityEngine {
  constructor({connection,adapters,now=Date.now}) {this.connection=connection;this.adapters=new Map(adapters.map(a=>[a.id,a]));this.quotes=new Map();this.now=now;}
  prune() {for(const[id,q]of this.quotes)if(q.expiresAt<=this.now())this.quotes.delete(id);}
  capabilities() {return {venues:[...this.adapters.values()].map(({id,programIds,capabilities,parameters={}})=>({id,programIds,capabilities,parameters:Object.fromEntries(capabilities.map(operation=>[operation,Array.isArray(parameters[operation])?parameters[operation]:Object.entries(parameters).map(([name,p])=>({name,label:p.description??name,...p,type:p.type==='string'?'text':p.type}))]))}))};}
  adapter(id) {const a=this.adapters.get(id);if(!a)throw new Error('Unknown liquidity venue');return a;}
  async positions(request) {
    const owner=publicKey(request.owner), adapters=request.venue?[this.adapter(request.venue)]:[...this.adapters.values()];
    if(request.pool)publicKey(request.pool);
    const results=await Promise.allSettled(adapters.map(a=>a.positions({connection:this.connection,owner,signers:new Map()},request)));
    const positions=[],errors=[];results.forEach((r,i)=>r.status==='fulfilled'?positions.push(...r.value.map(p=>({...p,id:p.id??p.position,owner:owner.toBase58(),venue:adapters[i].id}))):errors.push({venue:adapters[i].id,error:cleanError(r.reason)}));
    return {positions,errors};
  }
  async quote(input) {
    this.prune();if(this.quotes.size>=1024)throw new Error('Quote capacity reached; retry shortly');
    const request=copy(input),owner=publicKey(request.owner),adapter=this.adapter(request.venue);
    if(!adapter.capabilities.includes(request.operation))throw new Error('Operation is not supported by this venue');
    if(!['initialize','add','remove'].includes(request.operation))throw new Error('Invalid liquidity operation');
    if(!Number.isInteger(request.slippageBps)||request.slippageBps<0||request.slippageBps>1000)throw new Error('Slippage must be 0–1000 basis points');
    if(!['1','0'].includes(request.transactionVersion??'1'))throw new Error('Invalid transaction version');
    for(const k of ['pool','mintA','mintB','position'])if(request[k])publicKey(request[k]);
    for(const k of ['amountA','amountB','liquidity'])if(request[k]!==undefined&&(typeof request[k]!=='string'||!/^(0|[1-9]\d{0,38})$/.test(request[k])||BigInt(request[k])>=(1n<<128n)))throw new Error('Amounts must use atomic integer strings');
    if(request.liquidity==='0')throw new Error('Liquidity must be positive');
    if(request.parameters!==undefined&&(!request.parameters||Array.isArray(request.parameters)||typeof request.parameters!=='object'))throw new Error('Invalid operation parameters');
    request.parameters??={};
    const ctx={connection:this.connection,owner,signers:new Map()};
    const result=await adapter.quote(ctx,request);quoteAmounts(result,request.operation==='initialize');publicKey(result.pool);
    const quote={...copy(result),quoteId:randomUUID(),expiresAt:this.now()+TTL,owner:owner.toBase58(),venue:adapter.id,operation:request.operation,transactionVersion:request.transactionVersion??'1'};
    this.quotes.set(quote.quoteId,{quote,request,ctx,expiresAt:quote.expiresAt});return copy(quote);
  }
  async build(input) {
    this.prune();const saved=this.quotes.get(input.quoteId);
    if(!saved)throw new Error('Quote expired; request a new quote');
    if(publicKey(input.owner).toBase58()!==saved.quote.owner)throw new Error('Quote belongs to another wallet');
    if((input.transactionVersion??'1')!==saved.quote.transactionVersion)throw new Error('Wallet transaction version changed; request a new quote');
    const {ctx,request}=saved,adapter=this.adapter(request.venue);
    const fresh=await adapter.quote(ctx,request),approved=enforceApprovedBounds(saved.quote,fresh);
    const plan=await adapter.build(ctx,request,approved);
    if(plan.pool!==approved.pool||(plan.position&&plan.position!==approved.position))throw new Error('Builder changed operation identity');
    if(!Array.isArray(plan.transactions)||plan.transactions.length<1||plan.transactions.length>16)throw new Error('Invalid operation transaction plan');
    const lifetime=await this.connection.getLatestBlockhash('confirmed');
    const transactions=plan.transactions.map(bundle=>compileOperation(bundle,ctx.owner,lifetime,saved.quote.transactionVersion));
    return {transactions,pool:plan.pool,position:plan.position??approved.position,quote:approved};
  }
}
export function cleanError(error) {return String(error?.message??error).replace(/https?:\/\/[^\s"'<>]+/g,'[provider]').slice(0,500);}
