import { canonicalRequest, optional, zeroable, inferTickRange, rangePrices } from './raydium-common.mjs';
// Extends the user's solana-liquidity-engine Splash builders to all Whirlpool tick ranges.
// Uses exact-liquidity instructions: SDK 0.22 high-level openPosition uses a different
// by-token-amounts instruction and must not silently replace a reviewed LP amount.
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { Percentage, resolveOrCreateATAs } from '@orca-so/common-sdk';
import {
  WhirlpoolContext, buildWhirlpoolClient, ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_WHIRLPOOLS_CONFIG, MIN_TICK_INDEX, MAX_TICK_INDEX,
  PDAUtil, PoolUtil, TickUtil, PriceMath, TokenExtensionUtil, IGNORE_CACHE, WhirlpoolIx,
  getAllPositionAccountsByOwner, increaseLiquidityQuoteByLiquidityWithParams,
  decreaseLiquidityQuoteByLiquidityWithParams,
} from '@orca-so/whirlpools-sdk';
import BN from 'bn.js';
import Decimal from 'decimal.js';

const PROGRAM = ORCA_WHIRLPOOL_PROGRAM_ID;
const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n;
function atomic(value, label = 'Amount', maximum = U64) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || BigInt(value) > maximum) throw new Error(`${label} must be a positive atomic integer`);
  return BigInt(value);
}
function sdk(ctx) {
  const wallet = { publicKey: ctx.owner, signTransaction: async () => { throw new Error('Wallet signing is required'); }, signAllTransactions: async () => { throw new Error('Wallet signing is required'); } };
  const context = WhirlpoolContext.from(ctx.connection, wallet, undefined, undefined, { accountResolverOptions: { allowPDAOwnerAddress: false, createWrappedSolAccountMethod: 'keypair', createAtaMethod: 'createIdempotent' } }, PROGRAM);
  return { context, client: buildWhirlpoolClient(context) };
}
async function owned(ctx, address, label) {
  const account = await ctx.connection.getAccountInfo(new PublicKey(address), 'confirmed');
  if (!account || account.executable || !account.owner.equals(PROGRAM)) throw new Error(`${label} is not owned by the Whirlpool program`);
}
function slippage(request) {
  const n = request.slippageBps ?? 50;
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('Slippage must be 0–1000 basis points');
  return Percentage.fromFraction(n, 10000);
}
export function rangeForPool(data, parameters = {}) {
  const full = TickUtil.getFullRangeTickIndex(data.tickSpacing);
  const range = [parameters.tickLowerIndex ?? full[0], parameters.tickUpperIndex ?? full[1]];
  if (range.some(tick => !Number.isInteger(tick) || !TickUtil.checkTickInBounds(tick) || !TickUtil.isTickInitializable(tick, data.tickSpacing)) || range[0] >= range[1]) throw new Error('Position ticks must be ordered, in range, and aligned to the pool tick spacing');
  if (TickUtil.isFullRangeOnly(data.tickSpacing) && !TickUtil.isFullRange(data.tickSpacing, ...range)) throw new Error('This Whirlpool only permits full-range positions');
  return range;
}
// New positions only: explicit ticks are validated as-is; when both are blank the range is inferred
// from the entered amounts around the current price. Full-range-only pools and requests without
// amounts keep the full range.
export function orcaPositionRange(data, request) {
  const params = request.parameters ?? {}, lower = optional(params.tickLowerIndex), upper = optional(params.tickUpperIndex);
  if ((lower === undefined) !== (upper === undefined)) throw new Error('Provide both ticks or neither');
  if (lower !== undefined) return { range: rangeForPool(data, { tickLowerIndex: lower, tickUpperIndex: upper }), inferredRange: false, rangeWidthPct: null };
  const inferred = TickUtil.isFullRangeOnly(data.tickSpacing) ? null : inferTickRange({ sqrtPriceX64: data.sqrtPrice, tickSpacing: data.tickSpacing, minTick: MIN_TICK_INDEX, maxTick: MAX_TICK_INDEX, amountA: zeroable(request.amountA, 'amountA'), amountB: zeroable(request.amountB, 'amountB'), rangeWidthPct: params.rangeWidthPct });
  if (!inferred) return { range: rangeForPool(data), inferredRange: false, rangeWidthPct: null };
  return { range: rangeForPool(data, inferred), inferredRange: true, rangeWidthPct: inferred.rangeWidthPct };
}
async function poolState(ctx, client, address) {
  await owned(ctx, address, 'Pool');
  const pool = await client.getPool(address, IGNORE_CACHE), data = pool.getData();
  const canonical = PDAUtil.getWhirlpool(PROGRAM, data.whirlpoolsConfig, data.tokenMintA, data.tokenMintB, data.tickSpacing).publicKey;
  if (!canonical.equals(new PublicKey(address))) throw new Error('Pool address does not match its canonical mints/config/tick spacing');
  for (const [vault, mint] of [[pool.getTokenVaultAInfo(), data.tokenMintA], [pool.getTokenVaultBInfo(), data.tokenMintB]]) {
    if (!vault.mint.equals(mint) || !vault.owner.equals(canonical) || !vault.isInitialized || vault.isFrozen) throw new Error('Invalid Whirlpool vault');
  }
  return pool;
}
async function ownerPosition(ctx, client, address, pool) {
  await owned(ctx, address, 'Position');
  const position = await client.getPosition(address, IGNORE_CACHE), data = position.getData();
  if (!data.whirlpool.equals(new PublicKey(pool))) throw new Error('Position belongs to a different pool');
  if (!PDAUtil.getPosition(PROGRAM, data.positionMint).publicKey.equals(new PublicKey(address))) throw new Error('Position is not canonical');
  const tokenProgram = position.getPositionMintTokenProgramId();
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Unsupported position NFT token program');
  const response = await ctx.connection.getTokenAccountsByOwner(ctx.owner, { mint: data.positionMint }, 'confirmed');
  const holding = response.value.find(({ pubkey, account }) => {
    const token = unpackAccount(pubkey, account, tokenProgram);
    return token.owner.equals(ctx.owner) && token.mint.equals(data.positionMint) && token.amount === 1n && token.isInitialized && !token.isFrozen;
  });
  if (!holding) throw new Error('Wallet does not own the spendable position NFT');
  if (await position.getLockConfigData()) throw new Error('This position is locked');
  return { position, tokenAccount: holding.pubkey };
}
function retainedPosition(ctx, pool) {
  const name = `orca:position:${pool}`;
  if (!ctx.signers.has(name)) ctx.signers.set(name, Keypair.generate());
  return ctx.signers.get(name);
}
function quoteParams(data, range, ext, request) {
  return { tickCurrentIndex: data.tickCurrentIndex, sqrtPrice: data.sqrtPrice, tickLowerIndex: range[0], tickUpperIndex: range[1], tokenExtensionCtx: ext, slippageTolerance: slippage(request) };
}
export function fitOrcaLiquidity(params, request) {
  const quoteAt = liquidity => increaseLiquidityQuoteByLiquidityWithParams({ ...params, liquidity: new BN(liquidity.toString()) });
  if (request.liquidity) return quoteAt(atomic(request.liquidity, 'Liquidity', U128));
  const budgets = [request.amountA, request.amountB].map(x => x == null ? null : atomic(x));
  if (budgets.every(x => x === null)) throw new Error('Provide a token budget or exact liquidity');
  let lo = 1n, hi = U128, best;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n, q = quoteAt(mid);
    const amounts = [q.tokenMaxA, q.tokenMaxB].map(x => BigInt(x.toString()));
    if (amounts.every((x, i) => x <= U64 && (budgets[i] === null || x <= budgets[i]))) { best = q; lo = mid + 1n; } else hi = mid - 1n;
  }
  if (!best || best.tokenEstA.isZero() && best.tokenEstB.isZero()) throw new Error('Budget is too small or lies entirely outside the selected range');
  return best;
}
function bundle(instruction) { return { instructions: [...instruction.instructions, ...(instruction.cleanupInstructions ?? [])], signers: instruction.signers ?? [] }; }
const line = (mint, decimals, expected, limit, direction) => ({ mint: mint.toBase58(), decimals, expectedRaw: expected.toString(), limitRaw: limit.toString(), direction });
export const orca = {
  id: 'orca', programIds: [PROGRAM.toBase58()], capabilities: ['initialize', 'add', 'remove'],
  parameters: {
    initialize: [{name:'tickSpacing',label:'Orca fee-tier tick spacing',type:'number',default:64},{name:'initialPrice',label:'Initial price (token B per token A)',type:'text',required:true}],
    add: [{name:'tickLowerIndex',label:'Lower tick (advanced; inferred from amounts when blank)',type:'number'},{name:'tickUpperIndex',label:'Upper tick (advanced; inferred from amounts when blank)',type:'number'},{name:'rangeWidthPct',label:'Range width around current price (%)',type:'number',default:25,min:1,max:500}], remove: [],
  },
  async positions(ctx, { pool }) {
    const { context } = sdk(ctx);
    const result = await getAllPositionAccountsByOwner({ ctx: context, owner: ctx.owner, includesPositions: true, includesPositionsWithTokenExtensions: true, includesBundledPositions: false });
    const rows = [...result.positions, ...result.positionsWithTokenExtensions].filter(([, p]) => !pool || p.whirlpool.toBase58() === pool);
    const pools = await context.fetcher.getPools([...new Set(rows.map(([,p])=>p.whirlpool.toBase58()))], IGNORE_CACHE);
    return rows.map(([address,p])=>({venue:this.id,pool:p.whirlpool.toBase58(),mintA:pools.get(p.whirlpool.toBase58())?.tokenMintA.toBase58(),mintB:pools.get(p.whirlpool.toBase58())?.tokenMintB.toBase58(),position:address.toString(),mint:p.positionMint.toBase58(),liquidity:p.liquidity.toString(),tickLowerIndex:p.tickLowerIndex,tickUpperIndex:p.tickUpperIndex}));
  },
  async quote(ctx, request) {
    const { context, client } = sdk(ctx); slippage(request);
    if (request.operation === 'initialize') {
      const original = [new PublicKey(request.mintA), new PublicKey(request.mintB)];
      if (original[0].equals(original[1])) throw new Error('A pool requires distinct mints');
      const mints = PoolUtil.orderMints(...original).map(x => new PublicKey(x));
      const spacing = request.parameters?.tickSpacing ?? 64;
      if (!Number.isInteger(spacing) || spacing < 1 || spacing > 65535) throw new Error('tickSpacing must be a positive u16');
      let price = new Decimal(request.parameters?.initialPrice ?? 'NaN');
      if (!price.isFinite() || price.lte(0)) throw new Error('Provide a positive initialPrice in token B per token A');
      if (!original[0].equals(mints[0])) price = new Decimal(1).div(price);
      const [a, b, config, tier] = await Promise.all([
        context.fetcher.getMintInfo(mints[0], IGNORE_CACHE), context.fetcher.getMintInfo(mints[1], IGNORE_CACHE),
        context.fetcher.getConfig(ORCA_WHIRLPOOLS_CONFIG, IGNORE_CACHE),
        context.fetcher.getFeeTier(PDAUtil.getFeeTier(PROGRAM, ORCA_WHIRLPOOLS_CONFIG, spacing).publicKey, IGNORE_CACHE),
      ]);
      if (!a || !b || !config || !tier) throw new Error('Mints or the chosen Orca fee tier do not exist');
      if (!(await Promise.all(mints.map(mint => PoolUtil.isSupportedToken(context, ORCA_WHIRLPOOLS_CONFIG, mint)))).every(Boolean)) throw new Error('A mint requires an Orca token badge or has unsupported extensions');
      const tick = PriceMath.priceToInitializableTickIndex(price, a.decimals, b.decimals, spacing);
      if (!Number.isInteger(tick) || !TickUtil.checkTickInBounds(tick)) throw new Error('Initial price is outside Orca tick bounds');
      const pool = PDAUtil.getWhirlpool(PROGRAM, ORCA_WHIRLPOOLS_CONFIG, ...mints, spacing).publicKey;
      if (await ctx.connection.getAccountInfo(pool, 'confirmed')) throw new Error('Pool already exists; add liquidity instead');
      return { pool: pool.toBase58(), mintA: mints[0].toBase58(), mintB: mints[1].toBase58(), slot: await ctx.connection.getSlot('confirmed'), amounts: [], warnings: ['This initializes an empty pool. Add liquidity after this transaction confirms. Account rent and transaction fees are paid in SOL.'], details: { noTokenMovement: true, mintA: mints[0].toBase58(), mintB: mints[1].toBase58(), tickSpacing: spacing, initialTick: tick } };
    }
    if (!['add', 'remove'].includes(request.operation)) throw new Error('Unsupported Orca operation');
    const pool = await poolState(ctx, client, request.pool), data = pool.getData();
    request = canonicalRequest(request, data.tokenMintA.toBase58(), data.tokenMintB.toBase58());
    const existing = request.position ? await ownerPosition(ctx, client, request.position, request.pool) : null;
    if (request.operation === 'remove' && !existing) throw new Error('A position is required to remove liquidity');
    const chosen = existing ? { range: [existing.position.getData().tickLowerIndex, existing.position.getData().tickUpperIndex], inferredRange: false, rangeWidthPct: null } : orcaPositionRange(data, request), range = chosen.range;
    const ext = await TokenExtensionUtil.buildTokenExtensionContext(context.fetcher, data, IGNORE_CACHE);
    const params = quoteParams(data, range, ext, request), remove = request.operation === 'remove';
    let result;
    if (remove) {
      const amount = new BN(atomic(request.liquidity, 'Liquidity', U128).toString());
      if (amount.gt(existing.position.getData().liquidity)) throw new Error('Requested liquidity exceeds this position');
      result = decreaseLiquidityQuoteByLiquidityWithParams({ ...params, liquidity: amount });
    } else result = fitOrcaLiquidity(params, request);
    if ([result.tokenEstA, result.tokenEstB, remove ? result.tokenMinA : result.tokenMaxA, remove ? result.tokenMinB : result.tokenMaxB].some(x => BigInt(x.toString()) > U64)) throw new Error('Token amount exceeds u64');
    const mint = existing?.position.getData().positionMint ?? retainedPosition(ctx, request.pool).publicKey;
    const position = PDAUtil.getPosition(PROGRAM, mint).publicKey.toBase58();
    return { pool: request.pool, mintA: data.tokenMintA.toBase58(), mintB: data.tokenMintB.toBase58(), position, slot: await ctx.connection.getSlot('confirmed'), amounts: [
      line(data.tokenMintA, pool.getTokenAInfo().decimals, result.tokenEstA, remove ? result.tokenMinA : result.tokenMaxA, remove ? 'credit' : 'debit'),
      line(data.tokenMintB, pool.getTokenBInfo().decimals, result.tokenEstB, remove ? result.tokenMinB : result.tokenMaxB, remove ? 'credit' : 'debit'),
    ], details: { liquidity: result.liquidityAmount.toString(), tickLowerIndex: range[0], tickUpperIndex: range[1], inferredRange: chosen.inferredRange, rangeWidthPct: chosen.rangeWidthPct, ...rangePrices(range, data.sqrtPrice, pool.getTokenAInfo().decimals, pool.getTokenBInfo().decimals), positionMint: mint.toBase58(), newPosition: !existing }, warnings: [remove ? 'Withdrawal retains the position NFT; uncollected fees and rewards remain claimable.' : 'SOL inputs are wrapped for this operation. Position, tick-array, and token-account rent is additional.'] };
  },
  async build(ctx, request, quote) {
    const { context, client } = sdk(ctx), owner = ctx.owner;
    if (request.operation === 'initialize') {
      const d = quote.details;
      const result = await client.createPool(ORCA_WHIRLPOOLS_CONFIG, new PublicKey(d.mintA), new PublicKey(d.mintB), d.tickSpacing, d.initialTick, owner, IGNORE_CACHE);
      if (result.poolKey.toBase58() !== quote.pool) throw new Error('Pool identity changed');
      return { pool: quote.pool, transactions: [bundle(result.tx.compressIx(true))] };
    }
    const pool = await poolState(ctx, client, quote.pool), data = pool.getData(), d = quote.details;
    const remove = request.operation === 'remove';
    const existing = request.position ? await ownerPosition(ctx, client, request.position, quote.pool) : null;
    const positionMint = new PublicKey(d.positionMint), positionPda = PDAUtil.getPosition(PROGRAM, positionMint);
    if (positionPda.publicKey.toBase58() !== quote.position) throw new Error('Position identity changed');
    const ext = await TokenExtensionUtil.buildTokenExtensionContext(context.fetcher, data, IGNORE_CACHE);
    const amounts = [data.tokenMintA, data.tokenMintB].map(mint => new BN(quote.amounts.find(x => x.mint === mint.toBase58()).limitRaw));
    const atas = await resolveOrCreateATAs(ctx.connection, owner, [
      { tokenMint: data.tokenMintA, wrappedSolAmountIn: remove ? new BN(0) : amounts[0] },
      { tokenMint: data.tokenMintB, wrappedSolAmountIn: remove ? new BN(0) : amounts[1] },
    ], () => context.fetcher.getAccountRentExempt(), owner, true, false, 'keypair');
    const core = [], signers = [], cleanup = [];
    for (const ata of atas) { core.push(...ata.instructions); cleanup.unshift(...ata.cleanupInstructions); signers.push(...ata.signers); }
    const positionTokenAccount = existing?.tokenAccount ?? getAssociatedTokenAddressSync(positionMint, owner);
    if (!existing) {
      const retained = retainedPosition(ctx, quote.pool);
      if (!retained.publicKey.equals(positionMint)) throw new Error('Position signing key expired');
      const open = WhirlpoolIx.openPositionIx(context.program, { whirlpool: new PublicKey(quote.pool), owner, funder: owner, positionPda, positionMintAddress: positionMint, positionTokenAccount, tickLowerIndex: d.tickLowerIndex, tickUpperIndex: d.tickUpperIndex });
      core.push(...open.instructions); signers.push(retained, ...open.signers);
    }
    const hook = await TokenExtensionUtil.getExtraAccountMetasForTransferHookForPool(ctx.connection, ext,
      remove ? data.tokenVaultA : atas[0].address, remove ? atas[0].address : data.tokenVaultA, remove ? new PublicKey(quote.pool) : owner,
      remove ? data.tokenVaultB : atas[1].address, remove ? atas[1].address : data.tokenVaultB, remove ? new PublicKey(quote.pool) : owner);
    const params = { whirlpool: new PublicKey(quote.pool), position: positionPda.publicKey, positionAuthority: owner, positionTokenAccount,
      tokenMintA: data.tokenMintA, tokenMintB: data.tokenMintB, tokenOwnerAccountA: atas[0].address, tokenOwnerAccountB: atas[1].address,
      tokenVaultA: data.tokenVaultA, tokenVaultB: data.tokenVaultB, tokenProgramA: ext.tokenMintWithProgramA.tokenProgram, tokenProgramB: ext.tokenMintWithProgramB.tokenProgram,
      tickArrayLower: PDAUtil.getTickArrayFromTickIndex(d.tickLowerIndex, data.tickSpacing, new PublicKey(quote.pool), PROGRAM).publicKey,
      tickArrayUpper: PDAUtil.getTickArrayFromTickIndex(d.tickUpperIndex, data.tickSpacing, new PublicKey(quote.pool), PROGRAM).publicKey,
      liquidityAmount: new BN(d.liquidity), ...hook,
      ...(remove ? { tokenMinA: amounts[0], tokenMinB: amounts[1] } : { tokenMaxA: amounts[0], tokenMaxB: amounts[1] }),
    };
    const ix = (remove ? WhirlpoolIx.decreaseLiquidityV2Ix : WhirlpoolIx.increaseLiquidityV2Ix)(context.program, params);
    core.push(...ix.instructions, ...cleanup); signers.push(...ix.signers);
    const transactions = [];
    if (!existing) {
      const ticks = await pool.initTickArrayForTicks([d.tickLowerIndex, d.tickUpperIndex], owner, IGNORE_CACHE);
      if (ticks) transactions.push(bundle(ticks.compressIx(true)));
    }
    transactions.push({ instructions: core, signers });
    return { pool: quote.pool, position: quote.position, transactions };
  },
};
export default orca;
