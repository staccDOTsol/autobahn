import { canonicalRequest } from './raydium-common.mjs';
import { PublicKey, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { getCreatePoolKeys, getCpmmPdaAmmConfigId, CREATE_CPMM_POOL_PROGRAM } from '@raydium-io/raydium-sdk-v2';
import { getPoolSnapshot, getMintSnapshot, getConfigSnapshot, sortMints, assertNetwork } from './raydium-cpmm/rpc.mjs';
import { raw, checked, integerSqrt, transferFee, quoteDeposit, quoteWithdraw, validateSlippage } from './raydium-cpmm/math.mjs';
import { prepareCreatePool, prepareDeposit, prepareWithdraw } from './raydium-cpmm/builders.mjs';

const chain = ctx => ({ connection: ctx.connection, network: 'mainnet' });
const line = (mint, expectedRaw, limitRaw, direction) => ({ mint: mint.address, decimals: mint.decimals, expectedRaw: String(expectedRaw), limitRaw: String(limitRaw), direction });
function configIndex(request) {
  const index = request.parameters?.configIndex ?? 0;
  if (!Number.isInteger(index) || index < 0 || index > 65535) throw new Error('configIndex must be a u16 integer');
  return index;
}
function graph(request) {
  return { version: 1, name: 'Liquidity operation', root: 'pool', nodes: [
    { id: 'a', kind: 'token', mint: request.mintA, symbol: 'A', color: '' },
    { id: 'b', kind: 'token', mint: request.mintB, symbol: 'B', color: '' },
    { id: 'pool', kind: 'pool', label: 'Pool', left: 'a', right: 'b', configIndex: configIndex(request) },
  ] };
}
export function liquidityForBudgets(pool, request) {
  if (request.liquidity != null) return raw(request.liquidity, 'LP liquidity', false).toString();
  const budgets = [request.amountA, request.amountB].map(value => value == null ? null : raw(value, 'Deposit budget', false));
  if (budgets.every(value => value === null)) throw new Error('Provide liquidity (raw LP units), amountA or amountB');
  const supply = raw(pool.lpSupplyRaw, 'LP supply', false);
  const reserves = [raw(pool.reserveARaw, 'A reserve', false), raw(pool.reserveBRaw, 'B reserve', false)];
  let upper = (1n << 64n) - 1n - supply;
  for (let i = 0; i < 2; i++) if (budgets[i] !== null) upper = upper < budgets[i] * supply / reserves[i] ? upper : budgets[i] * supply / reserves[i];
  let lo = 1n, hi = upper, best = 0n;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    let quote;
    try { quote = quoteDeposit(pool, mid.toString(), request.slippageBps ?? 50); }
    catch (error) {
      if (String(error.message).includes('too small')) { lo = mid + 1n; continue; }
      throw error;
    }
    if (quote.limitAmountsRaw.every((amount, i) => budgets[i] === null || BigInt(amount) <= budgets[i])) { best = mid; lo = mid + 1n; }
    else hi = mid - 1n;
  }
  if (!best) throw new Error('Deposit budget is too small after fees and slippage');
  return best.toString();
}
export const raydiumCpmm = {
  id: 'raydium-cpmm',
  programIds: [CREATE_CPMM_POOL_PROGRAM.toBase58()],
  capabilities: ['initialize', 'add', 'remove'],
  parameters: {
    initialize: [{name:'configIndex',label:'Fee configuration index',type:'number',default:0},{name:'openTime',label:'Opening Unix timestamp',type:'text',default:'0'},{name:'wrapSol',label:'Use native SOL for WSOL input',type:'boolean',default:false}],
    add: [{name:'wrapSol',label:'Use native SOL for WSOL input',type:'boolean',default:false}], remove: [],
  },
  async positions(ctx, { owner, pool }) {
    if (!pool) throw new Error('A CPMM pool is required to list its LP holdings');
    const state = await getPoolSnapshot(chain(ctx), pool);
    const ownerKey = new PublicKey(owner ?? ctx.owner);
    const token = new PublicKey(state.lpMint.address);
    const response = await ctx.connection.getTokenAccountsByOwner(ownerKey, { mint: token }, 'confirmed');
    return response.value.flatMap(({ pubkey, account }) => {
      const value = unpackAccount(pubkey, account, TOKEN_PROGRAM_ID);
      if (!value.amount || !value.owner.equals(ownerKey) || !value.mint.equals(token)) return [];
      return [{ venue: this.id, pool, mintA: state.mintA.address, mintB: state.mintB.address, position: pubkey.toBase58(), mint: token.toBase58(), decimals: state.lpMint.decimals,
        liquidity: value.amount.toString(), frozen: value.isFrozen,
        canonicalAta: pubkey.equals(getAssociatedTokenAddressSync(token, ownerKey)) }];
    });
  },
  async quote(ctx, request) {
    validateSlippage(request.slippageBps ?? 50);
    const context = chain(ctx);
    await assertNetwork(context);
    if (request.operation === 'initialize') {
      const [left, right, config] = await Promise.all([
        getMintSnapshot(context, request.mintA), getMintSnapshot(context, request.mintB), getConfigSnapshot(context, configIndex(request)),
      ]);
      if (config.disableCreatePool) throw new Error('Pool creation is disabled for this CPMM configuration');
      const [a, b] = sortMints(new PublicKey(left.address), new PublicKey(right.address));
      const first = a.toBase58() === left.address;
      const mintA = first ? left : right, mintB = first ? right : left;
      const amountA = raw(first ? request.amountA : request.amountB, 'Initial A amount', false);
      const amountB = raw(first ? request.amountB : request.amountA, 'Initial B amount', false);
      const supply = checked(integerSqrt((amountA - transferFee(amountA, mintA)) * (amountB - transferFee(amountB, mintB))));
      if (supply <= 100n) throw new Error('Seed liquidity must exceed the 100 raw LP-unit permanent lock');
      const keys = getCreatePoolKeys({ programId: CREATE_CPMM_POOL_PROGRAM, configId: getCpmmPdaAmmConfigId(CREATE_CPMM_POOL_PROGRAM, configIndex(request)).publicKey, mintA: a, mintB: b });
      if (await ctx.connection.getAccountInfo(keys.poolId, 'confirmed')) throw new Error('Pool already exists; use add liquidity');
      return { pool: keys.poolId.toBase58(), mintA: mintA.address, mintB: mintB.address, slot: await ctx.connection.getSlot('confirmed'), amounts: [
        line(mintA, amountA, amountA, 'debit'), line(mintB, amountB, amountB, 'debit'),
        { mint: keys.lpMint.toBase58(), decimals: 9, expectedRaw: (supply - 100n).toString(), limitRaw: '0', direction: 'credit' },
      ], warnings: ['Initialization permanently locks 100 raw LP units; the instruction has no minimum LP-output argument.', 'The seed ratio sets the initial pool price. Network fees and account rent are additional SOL costs.'],
      details: { lpMint: keys.lpMint.toBase58(), liquidity: (supply - 100n).toString(), poolCreationFeeLamports: config.createPoolFeeRaw } };
    }
    if (!['add', 'remove'].includes(request.operation)) throw new Error('Unsupported CPMM operation');
    const pool = await getPoolSnapshot(context, request.pool);
    request = canonicalRequest(request, pool.mintA.address, pool.mintB.address);
    const liquidity = request.operation === 'add' ? liquidityForBudgets(pool, request) : raw(request.liquidity, 'LP liquidity', false).toString();
    const quote = (request.operation === 'add' ? quoteDeposit : quoteWithdraw)(pool, liquidity, request.slippageBps ?? 50);
    const credit = request.operation === 'remove';
    return { pool: request.pool, mintA: pool.mintA.address, mintB: pool.mintB.address, slot: pool.slot, amounts: [
      line(pool.mintA, quote.expectedAmountsRaw[0], quote.limitAmountsRaw[0], credit ? 'credit' : 'debit'),
      line(pool.mintB, quote.expectedAmountsRaw[1], quote.limitAmountsRaw[1], credit ? 'credit' : 'debit'),
      line(pool.lpMint, liquidity, liquidity, credit ? 'debit' : 'credit'),
    ], details: { liquidity, lpMint: pool.lpMint.address, transferFeesRaw: quote.transferFeesRaw }, warnings: [] };
  },
  async build(ctx, request, quote) {
    const context = chain(ctx), owner = new PublicKey(ctx.owner);
    let prepared;
    if (request.operation === 'initialize') {
      prepared = await prepareCreatePool(context, owner, graph(request), 'pool', { leftRaw: request.amountA, rightRaw: request.amountB,
        openTime: request.parameters?.openTime ?? '0', wrapSol: request.parameters?.wrapSol === true });
    } else {
      const pool = await getPoolSnapshot(context, request.pool);
      const limits = [pool.mintA.address, pool.mintB.address].map(mint => {
        const item = quote.amounts.find(item => item.mint === mint);
        if (!item) throw new Error('Reviewed quote is missing a pool asset');
        return item.limitRaw;
      });
      if (request.operation === 'add') prepared = await prepareDeposit(context, owner, request.pool, quote.details.liquidity,
        { slippageBps: request.slippageBps ?? 50, hardMaxAmountsRaw: limits, wrapSol: request.parameters?.wrapSol === true });
      else if (request.operation === 'remove') prepared = await prepareWithdraw(context, owner, request.pool, quote.details.liquidity,
        { slippageBps: request.slippageBps ?? 50, hardMinAmountsRaw: limits });
      else throw new Error('Unsupported CPMM operation');
    }
    if (prepared.review.poolAddress !== quote.pool) throw new Error('Pool changed since review');
    return { pool: quote.pool, transactions: [{ instructions: prepared.transaction.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)), signers: prepared.signers }] };
  },
};
export default raydiumCpmm;
