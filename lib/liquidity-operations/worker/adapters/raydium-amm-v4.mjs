// Canonical Raydium AMM v4 liquidity operations. The current program accepts the
// 11-account deposit/withdraw form and a 19-account Initialize2; OpenBook is no
// longer an execution dependency. Protocol source: raydium-io/raydium-amm,
// program/src/{processor,math,state}.rs (process_deposit/withdraw/calc_take_pnl).
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { AMM_V4, FEE_DESTINATION_ID, OPEN_BOOK_PROGRAM, liquidityStateV4Layout, getAssociatedPoolKeys, getLiquidityAssociatedAuthority, createPoolV4InstructionV2 } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { U64,raw,account,mint,line,checkVault,canonicalRequest,tokenAccounts,holding } from './raydium-common.mjs';
import { ceilDiv,integerSqrt,validateSlippage } from './raydium-cpmm/math.mjs';
const PROGRAM=AMM_V4;
const bn=value=>new BN(value.toString());
const u128=(buffer,offset)=>buffer.readBigUInt64LE(offset)+(buffer.readBigUInt64LE(offset+8)<<64n);
const writable=pubkey=>({pubkey:new PublicKey(pubkey),isSigner:false,isWritable:true});
const readonly=pubkey=>({...writable(pubkey),isWritable:false});
function seed(ctx,request){if(request.parameters?.poolSeed)return new PublicKey(request.parameters.poolSeed);const label='raydium-amm-v4:initialize';if(!ctx.signers.has(label))ctx.signers.set(label,Keypair.generate());return ctx.signers.get(label).publicKey;}
function keys(a,b,marketId){return getAssociatedPoolKeys({version:4,marketVersion:3,marketId,baseMint:new PublicKey(a.address),quoteMint:new PublicKey(b.address),baseDecimals:a.decimals,quoteDecimals:b.decimals,programId:PROGRAM,marketProgramId:OPEN_BOOK_PROGRAM});}
async function legacyMint(ctx,address){const m=await mint(ctx,address);if(m.programId!==TOKEN_PROGRAM_ID.toBase58())throw new Error('AMM v4 only supports legacy SPL Token mints');return m;}
// Mirrors the program's integer normalization, square root, and PNL truncation.
export function reservesAfterPnl(data,reserveA,reserveB,lastX,lastY){
 const scale=BigInt(data.systemDecimalValue.toString()),da=10n**BigInt(data.baseDecimal.toString()),db=10n**BigInt(data.quoteDecimal.toString());
 const numerator=BigInt(data.pnlNumerator.toString()),denominator=BigInt(data.pnlDenominator.toString());
 if(!scale||!denominator||numerator>denominator||reserveA<=0n||reserveB<=0n)throw new Error('Invalid AMM reserves or PNL fee');
 if(data.status.toString()==='3')return[reserveA,reserveB];
 if(reserveA*reserveB<(lastX*db/scale)*(lastY*da/scale))throw new Error('AMM PNL invariant is invalid');
 const x1=reserveB*scale/db,y1=reserveA*scale/da;if(!x1||!y1)throw new Error('AMM reserve normalization rounds to zero');
 const x2=integerSqrt(lastX*lastY*x1/y1),y2=x2*y1/x1;
 if(x2>x1||y2>y1)throw new Error('AMM PNL invariant underflow');
 const feeB=((x1-x2)*db/scale)*numerator/denominator,feeA=((y1-y2)*da/scale)*numerator/denominator;
 return feeA&&feeB?[reserveA-feeA,reserveB-feeB]:[reserveA,reserveB];
}
async function state(ctx,pool){
 const data=await account(ctx,pool,PROGRAM,'AMM v4 pool',liquidityStateV4Layout),[a,b,lp]=await Promise.all([legacyMint(ctx,data.baseMint),legacyMint(ctx,data.quoteMint),legacyMint(ctx,data.lpMint)]);
 const authority=getLiquidityAssociatedAuthority({programId:PROGRAM});
 if(data.nonce.toNumber()!==authority.nonce||a.decimals!==data.baseDecimal.toNumber()||b.decimals!==data.quoteDecimal.toNumber())throw new Error('AMM authority or mint decimals mismatch');
 const[vA,vB,target]=await Promise.all([checkVault(ctx,data.baseVault,a,authority.publicKey),checkVault(ctx,data.quoteVault,b,authority.publicKey),ctx.connection.getAccountInfo(data.targetOrders,'confirmed')]);
 if(!target||target.executable||!target.owner.equals(PROGRAM)||target.data.length!==2208||!new PublicKey(target.data.subarray(0,32)).equals(new PublicKey(pool)))throw new Error('AMM target-orders state is invalid');
 const reserves=reservesAfterPnl(data,vA.amount-BigInt(data.baseNeedTakePnl.toString()),vB.amount-BigInt(data.quoteNeedTakePnl.toString()),u128(target.data,1024),u128(target.data,1040));
 const supply=BigInt(data.lpReserve.toString());if(!supply||BigInt(lp.supplyRaw)>supply)throw new Error('AMM LP supply mismatch');
 return{data,a,b,lp,authority:authority.publicKey,reserves,supply};
}
export function quoteAmmDeposit(s,request){
 const budgets=[request.amountA,request.amountB].map(x=>x==null?null:raw(x));const bps=BigInt(request.slippageBps);let fixed=0,amount;
 if(request.liquidity)amount=ceilDiv(raw(request.liquidity)*s.reserves[0],s.supply);
 else if(budgets[0]!=null)amount=budgets[0];else if(budgets[1]!=null){fixed=1;amount=budgets[1];}else throw new Error('Provide an input token amount or target LP liquidity');
 const other=1-fixed;
 if(budgets[other]!=null){const maxOther=budgets[other]*10000n/(10000n+bps);const maxInput=maxOther*s.reserves[fixed]/s.reserves[other];if(amount>maxInput)amount=maxInput;}
 const otherExpected=ceilDiv(amount*s.reserves[other],s.reserves[fixed]),otherMax=ceilDiv(otherExpected*(10000n+bps),10000n),otherMin=otherExpected*(10000n-bps)/10000n;
 const lp=amount*s.supply/s.reserves[fixed];if(!amount||!lp||amount>U64||otherMax>U64)throw new Error('Deposit is too small or exceeds u64');
 const expected=[],limits=[];expected[fixed]=amount;limits[fixed]=amount;expected[other]=otherExpected;limits[other]=otherMax;
 return{expected,limits,lp,fixed,otherMin};
}
export const raydiumAmmV4={
 id:'raydium-amm-v4',programIds:[PROGRAM.toBase58()],capabilities:['initialize','add','remove'],
 parameters:{initialize:[{name:'poolSeed',label:'Optional pool seed address',type:'text'},{name:'openTime',label:'Opening Unix timestamp',type:'text',default:'0'},{name:'wrapSol',label:'Use native SOL for WSOL seed',type:'boolean',default:false}],add:[{name:'wrapSol',label:'Use native SOL for WSOL input',type:'boolean',default:false}],remove:[{name:'wrapSol',label:'Unwrap WSOL proceeds into SOL',type:'boolean',default:false}]},
 async positions(ctx,{pool}){if(!pool)throw new Error('Select an AMM v4 pool to list LP holdings');const s=await state(ctx,pool),response=await ctx.connection.getTokenAccountsByOwner(ctx.owner,{mint:new PublicKey(s.lp.address)},'confirmed');return response.value.flatMap(({pubkey,account})=>{const a=unpackAccount(pubkey,account,TOKEN_PROGRAM_ID);return a.amount&&a.owner.equals(ctx.owner)&&a.isInitialized&&!a.isFrozen?[{venue:this.id,pool,mintA:s.a.address,mintB:s.b.address,position:pubkey.toBase58(),mint:s.lp.address,liquidity:a.amount.toString(),decimals:s.lp.decimals}]:[];});},
 async quote(ctx,request){validateSlippage(request.slippageBps);
  if(request.operation==='initialize'){
   const[a,b]=await Promise.all([legacyMint(ctx,request.mintA),legacyMint(ctx,request.mintB)]);if(a.address===b.address)throw new Error('Pool requires distinct mints');const k=keys(a,b,seed(ctx,request));if(await ctx.connection.getAccountInfo(k.id,'confirmed'))throw new Error('Pool already exists; add liquidity instead');const amounts=[raw(request.amountA),raw(request.amountB)],supply=integerSqrt(amounts[0]*amounts[1]),locked=10n**BigInt(a.decimals);if(supply<=locked)throw new Error('Seed liquidity must exceed the permanent LP lock of one whole base-denominated LP token');
   return{pool:k.id.toBase58(),mintA:a.address,mintB:b.address,slot:await ctx.connection.getSlot('confirmed'),amounts:[line(a,amounts[0],amounts[0],'debit'),line(b,amounts[1],amounts[1],'debit'),line({address:k.lpMint.toBase58(),decimals:a.decimals},supply-locked,0,'credit')],details:{poolSeed:seed(ctx,request).toBase58(),lpMint:k.lpMint.toBase58(),liquidity:(supply-locked).toString()},warnings:['Initialization fixes the seed ratio and permanently locks one whole LP token. It has no minimum LP-output argument. Pool creation fees, rent, and network fees require additional SOL.']};
  }
  if(!['add','remove'].includes(request.operation))throw new Error('Unsupported AMM v4 operation');const s=await state(ctx,request.pool);request=canonicalRequest(request,s.a.address,s.b.address);const remove=request.operation==='remove',status=s.data.status.toNumber();if(!(remove?[1,3,4,5,6,7]:[1,4,5,6,7]).includes(status))throw new Error('AMM pool status disallows this operation');
  let expected,limits,lp,details={};if(remove){lp=raw(request.liquidity);if(lp>=s.supply||lp>BigInt(s.lp.supplyRaw))throw new Error('Withdrawal exceeds LP supply');expected=s.reserves.map(r=>r*lp/s.supply);limits=expected.map(x=>x*BigInt(10000-request.slippageBps)/10000n);if(!await holding(ctx,s.lp.address,s.lp.programId,lp))throw new Error('Wallet LP balance is insufficient');}else{const q=quoteAmmDeposit(s,request);({expected,limits,lp}=q);details={fixedSide:q.fixed,otherAmountMin:q.otherMin.toString()};}
  return{pool:request.pool,mintA:s.a.address,mintB:s.b.address,slot:await ctx.connection.getSlot('confirmed'),amounts:[line(s.a,expected[0],limits[0],remove?'credit':'debit'),line(s.b,expected[1],limits[1],remove?'credit':'debit'),line(s.lp,lp,remove?lp:0,remove?'debit':'credit')],details:{...details,liquidity:lp.toString(),lpMint:s.lp.address},warnings:remove?[]:['AMM v4 bounds input amounts and the deposit ratio; it does not accept a minimum LP-output argument.']};
 },
 async build(ctx,request,quote){
  if(request.operation==='initialize'){
   const[a,b]=await Promise.all([legacyMint(ctx,quote.mintA),legacyMint(ctx,quote.mintB)]),k=keys(a,b,new PublicKey(quote.details.poolSeed));if(k.id.toBase58()!==quote.pool)throw new Error('Pool identity changed');const amounts=quote.amounts.slice(0,2).map(x=>raw(x.limitRaw));const accounts=await tokenAccounts(ctx,[a,b],amounts,request.parameters?.wrapSol===true);const openTime=request.parameters?.openTime??'0';if(!/^(0|[1-9]\d*)$/.test(openTime)||BigInt(openTime)>U64)throw new Error('Invalid opening timestamp');
   const{instruction}=createPoolV4InstructionV2({programId:PROGRAM,ammId:k.id,ammAuthority:k.authority,ammOpenOrders:k.openOrders,lpMint:k.lpMint,coinMint:k.baseMint,pcMint:k.quoteMint,coinVault:k.baseVault,pcVault:k.quoteVault,withdrawQueue:k.withdrawQueue,ammTargetOrders:k.targetOrders,poolTempLp:k.lpVault,marketProgramId:OPEN_BOOK_PROGRAM,marketId:new PublicKey(quote.details.poolSeed),ammConfigId:k.configId,feeDestinationId:FEE_DESTINATION_ID,userWallet:ctx.owner,userCoinVault:accounts.addresses[0],userPcVault:accounts.addresses[1],userLpVault:getAssociatedTokenAddressSync(k.lpMint,ctx.owner),nonce:k.nonce,openTime:bn(openTime),coinAmount:bn(amounts[0]),pcAmount:bn(amounts[1])});
   // Remove the two ignored legacy OpenBook accounts per current Initialize2.
   instruction.keys=instruction.keys.filter((_,i)=>i!==6&&i!==15);
   return{pool:quote.pool,transactions:[{instructions:[...accounts.instructions,instruction,...accounts.cleanup],signers:accounts.signers}]};
  }
  const s=await state(ctx,quote.pool),remove=request.operation==='remove',limits=[s.a,s.b].map(m=>BigInt(quote.amounts.find(x=>x.mint===m.address).limitRaw));
  const accounts=await tokenAccounts(ctx,remove?[s.a,s.b]:[s.a,s.b,s.lp],remove?[0,0]:[...limits,0],request.parameters?.wrapSol===true);
  const lpAccount=remove?await holding(ctx,s.lp.address,s.lp.programId,BigInt(quote.details.liquidity)):accounts.addresses[2];if(!lpAccount)throw new Error('Wallet LP balance is insufficient');
  const data=Buffer.alloc(remove?25:33);data[0]=remove?4:3;
  if(remove){data.writeBigUInt64LE(BigInt(quote.details.liquidity),1);data.writeBigUInt64LE(limits[0],9);data.writeBigUInt64LE(limits[1],17);}else{data.writeBigUInt64LE(limits[0],1);data.writeBigUInt64LE(limits[1],9);data.writeBigUInt64LE(BigInt(quote.details.fixedSide),17);data.writeBigUInt64LE(BigInt(quote.details.otherAmountMin),25);}
  const metas=[readonly(TOKEN_PROGRAM_ID),writable(quote.pool),readonly(s.authority),writable(s.data.targetOrders),writable(s.lp.address),writable(s.data.baseVault),writable(s.data.quoteVault),...(remove?[writable(lpAccount),writable(accounts.addresses[0]),writable(accounts.addresses[1])]:[writable(accounts.addresses[0]),writable(accounts.addresses[1]),writable(lpAccount)]),{...readonly(ctx.owner),isSigner:true}];
  return{pool:quote.pool,transactions:[{instructions:[...accounts.instructions,new TransactionInstruction({programId:PROGRAM,keys:metas,data}),...accounts.cleanup],signers:accounts.signers}]};
 }
};
export default raydiumAmmV4;
