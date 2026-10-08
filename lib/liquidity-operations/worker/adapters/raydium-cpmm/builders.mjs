// Ported from the user-owned cpmm-index-composer/src/chain/builders.ts.
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, unpackAccount } from '@solana/spl-token';
import { getCreatePoolKeys, getCpmmPdaAmmConfigId, makeCreateCpmmPoolInInstruction, makeDepositCpmmInInstruction, makeWithdrawCpmmInInstruction } from '@raydium-io/raydium-sdk-v2';
import { assertNetwork, getConfigSnapshot, getMintSnapshot, getPoolSnapshot, graphPoolNode, programIds, resolveGraph, sortMints } from './rpc.mjs';
import { bn, checked, integerSqrt, quoteDeposit, quoteWithdraw, raw, transferFee } from './math.mjs';
function ata(owner, mint) {
    return getAssociatedTokenAddressSync(new PublicKey(mint.address), owner, false, new PublicKey(mint.programId));
}
function createAta(owner, mint) {
    return createAssociatedTokenAccountIdempotentInstruction(owner, ata(owner, mint), owner, new PublicKey(mint.address), new PublicKey(mint.programId));
}
async function inputAccount(ctx, owner, mint, required, instructions, wrapSol) {
    const address = ata(owner, mint), need = raw(required), accountInfo = await ctx.connection.getAccountInfo(address, 'confirmed');
    let available = 0n;
    if (accountInfo) {
        const account = unpackAccount(address, accountInfo, new PublicKey(mint.programId));
        if (!account.owner.equals(owner) || !account.mint.equals(new PublicKey(mint.address)) || !account.isInitialized || account.isFrozen)
            throw new Error(`Invalid or frozen source ATA for ${mint.address}`);
        available = account.amount;
    }
    if (available < need) {
        if (!wrapSol || mint.address !== NATIVE_MINT.toBase58() || mint.programId !== TOKEN_PROGRAM_ID.toBase58())
            throw new Error(`Insufficient ${mint.address} in wallet ATA: requires ${required} raw units, available ${available}. Fund the underlying token account first.`);
        const deficit = need - available;
        if (!accountInfo)
            instructions.push(createAta(owner, mint));
        instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: address, lamports: deficit }));
        instructions.push(createSyncNativeInstruction(address));
    }
    else if (!accountInfo) {
        instructions.push(createAta(owner, mint));
    }
    return address;
}
async function outputAccount(ctx, owner, mint, instructions) {
    const address = ata(owner, mint), accountInfo = await ctx.connection.getAccountInfo(address, 'confirmed');
    if (accountInfo) {
        const account = unpackAccount(address, accountInfo, new PublicKey(mint.programId));
        if (!account.owner.equals(owner) || !account.mint.equals(new PublicKey(mint.address)) || !account.isInitialized || account.isFrozen)
            throw new Error(`Invalid or frozen destination ATA for ${mint.address}`);
    }
    else
        instructions.push(createAta(owner, mint));
    return address;
}
function reviewAmount(mint, expectedRaw, limitRaw, direction) {
    return { mint: mint.address, decimals: mint.decimals, expectedRaw, limitRaw, direction };
}
async function finish(ctx, owner, instructions) {
    // Explicit limits only; no hidden priority fee or transaction broadcast.
    const latest = await ctx.connection.getLatestBlockhash('confirmed');
    return new Transaction({ feePayer: owner, ...latest }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...instructions);
}
function mintWarnings(mints, wrapSol = false) {
    return [
        ...mints.filter(m => m.freezeAuthority).map(m => `Issuer freeze authority remains active for ${m.address}.`),
        ...mints.flatMap(m => (m.issuerControls ?? []).map(warning => `${m.address}: ${warning}`)),
        ...mints.filter(m => m.extensions.includes(10) || m.extensions.includes(25)).map(m => `${m.address} has interest/scaled-UI metadata. Amounts shown here use raw mint decimals, not issuer-adjusted display units.`),
        ...(wrapSol ? ['Explicit SOL wrapping enabled: only a WSOL source deficit is funded. Existing WSOL accounts are never closed, and unused WSOL remains in your wallet.'] : []),
        'Network transaction fees and rent for new accounts are additional SOL costs; simulation must succeed before signing.',
    ];
}
export async function prepareCreatePool(ctx, owner, graph, nodeId, amounts) {
    await assertNetwork(ctx);
    const node = graphPoolNode(graph, nodeId), resolved = resolveGraph(ctx.network, graph).pools.find(p => p.nodeId === nodeId);
    if (!resolved)
        throw new Error('Pool is not reachable from the graph root');
    const [left, right, config] = await Promise.all([getMintSnapshot(ctx, resolved.leftMint), getMintSnapshot(ctx, resolved.rightMint), getConfigSnapshot(ctx, node.configIndex)]);
    if (config.disableCreatePool)
        throw new Error('New pools are disabled by this canonical CPMM configuration');
    const { programId, createPoolFeeAccount } = programIds(ctx.network);
    const [mintA, mintB] = sortMints(new PublicKey(left.address), new PublicKey(right.address));
    const a = mintA.toBase58() === left.address ? left : right, b = a === left ? right : left;
    const amountA = a === left ? amounts.leftRaw : amounts.rightRaw, amountB = a === left ? amounts.rightRaw : amounts.leftRaw;
    const grossA = raw(amountA, 'Initial A amount', false), grossB = raw(amountB, 'Initial B amount', false);
    const netA = grossA - transferFee(grossA, a), netB = grossB - transferFee(grossB, b);
    const supply = checked(integerSqrt(netA * netB));
    if (netA === 0n || netB === 0n || supply <= 100n)
        throw new Error('Initial liquidity must exceed the canonical 100 raw LP-unit lock after token transfer fees');
    const keys = getCreatePoolKeys({ programId, configId: getCpmmPdaAmmConfigId(programId, node.configIndex).publicKey, mintA, mintB });
    if (keys.poolId.toBase58() !== resolved.poolAddress)
        throw new Error('An explicit non-PDA pool address can only reference an existing pool; creation uses the canonical deterministic address');
    const [existing, feeInfo] = await Promise.all([ctx.connection.getAccountInfo(keys.poolId, 'confirmed'), ctx.connection.getAccountInfo(createPoolFeeAccount, 'confirmed')]);
    if (existing)
        throw new Error('Pool already exists; inspect it and add liquidity instead');
    const feeAccount = unpackAccount(createPoolFeeAccount, feeInfo, TOKEN_PROGRAM_ID);
    if (!feeAccount.isInitialized || !feeAccount.mint.equals(NATIVE_MINT) || !feeAccount.isNative)
        throw new Error('Canonical pool-creation fee receiver is invalid');
    const instructions = [];
    const userA = await inputAccount(ctx, owner, a, amountA, instructions, amounts.wrapSol ?? false);
    const userB = await inputAccount(ctx, owner, b, amountB, instructions, amounts.wrapSol ?? false);
    const userLp = getAssociatedTokenAddressSync(keys.lpMint, owner);
    // Canonical initialize creates the LP mint and LP ATA itself. Do not pre-create that ATA.
    const openTime = amounts.openTime ?? '0';
    raw(openTime, 'Opening time');
    const approvals = [a, b].flatMap(m => m.supportMintPda ? [new PublicKey(m.supportMintPda)] : []);
    const create = makeCreateCpmmPoolInInstruction(programId, owner, keys.configId, keys.authority, keys.poolId, mintA, mintB, keys.lpMint, userA, userB, userLp, keys.vaultA, keys.vaultB, createPoolFeeAccount, new PublicKey(a.programId), new PublicKey(b.programId), keys.observationId, bn(amountA), bn(amountB), bn(openTime), approvals);
    // The published SDK marks creator readonly; canonical initialize requires mutable payer.
    create.keys[0].isWritable = true;
    instructions.push(create);
    const lpMint = { address: keys.lpMint.toBase58(), decimals: 9, programId: TOKEN_PROGRAM_ID.toBase58(), supplyRaw: (supply - 100n).toString(), extensions: [], freezeAuthority: null };
    return {
        transaction: await finish(ctx, owner, instructions), signers: [], nodeUpdates: [{ nodeId, poolAddress: keys.poolId.toBase58() }],
        review: {
            action: 'create', poolAddress: keys.poolId.toBase58(), programId: programId.toBase58(),
            amounts: [reviewAmount(a, amountA, amountA, 'debit'), reviewAmount(b, amountB, amountB, 'debit'), reviewAmount(lpMint, (supply - 100n).toString(), '0', 'credit')],
            lpAmountRaw: (supply - 100n).toString(), lpMint: keys.lpMint.toBase58(), poolCreationFeeLamports: config.createPoolFeeRaw, quotedSlot: await ctx.connection.getSlot('confirmed'),
            warnings: [...mintWarnings([a, b], amounts.wrapSol), 'Initialization permanently locks 100 raw LP units. Initial LP output is an estimate; canonical initialize has no minimum-LP-output argument.', 'Initial reserve amounts establish the pool price. Verify the seed ratio before signing.'],
        },
    };
}
export async function prepareDeposit(ctx, owner, poolAddress, lpAmountRaw, options = {}) {
    const pool = await getPoolSnapshot(ctx, poolAddress), quote = quoteDeposit(pool, lpAmountRaw, options.slippageBps ?? 50);
    const maxima = quote.limitAmountsRaw.map((limit, i) => {
        const expected = raw(quote.expectedAmountsRaw[i]), desired = raw(limit), hard = options.hardMaxAmountsRaw ? raw(options.hardMaxAmountsRaw[i]) : desired;
        if (expected > hard)
            throw new Error('Deposit requirement increased beyond the approved budget; refresh the recursive plan');
        return (desired < hard ? desired : hard).toString();
    });
    const instructions = [];
    const userA = await inputAccount(ctx, owner, pool.mintA, maxima[0], instructions, options.wrapSol ?? false);
    const userB = await inputAccount(ctx, owner, pool.mintB, maxima[1], instructions, options.wrapSol ?? false);
    const userLp = await outputAccount(ctx, owner, pool.lpMint, instructions);
    const { programId } = programIds(ctx.network);
    instructions.push(makeDepositCpmmInInstruction(programId, owner, new PublicKey(pool.authority), new PublicKey(poolAddress), userLp, userA, userB, new PublicKey(pool.vaultA), new PublicKey(pool.vaultB), new PublicKey(pool.mintA.address), new PublicKey(pool.mintB.address), new PublicKey(pool.lpMint.address), bn(lpAmountRaw), bn(maxima[0]), bn(maxima[1])));
    return {
        transaction: await finish(ctx, owner, instructions), signers: [], nodeUpdates: [],
        review: { action: 'deposit', poolAddress, programId: programId.toBase58(), lpAmountRaw, lpMint: pool.lpMint.address, poolCreationFeeLamports: '0', quotedSlot: pool.slot,
            amounts: [reviewAmount(pool.mintA, quote.expectedAmountsRaw[0], maxima[0], 'debit'), reviewAmount(pool.mintB, quote.expectedAmountsRaw[1], maxima[1], 'debit'), reviewAmount(pool.lpMint, lpAmountRaw, lpAmountRaw, 'credit')], warnings: mintWarnings([pool.mintA, pool.mintB], options.wrapSol) },
    };
}
export async function prepareWithdraw(ctx, owner, poolAddress, lpAmountRaw, options = {}) {
    const pool = await getPoolSnapshot(ctx, poolAddress), quote = quoteWithdraw(pool, lpAmountRaw, options.slippageBps ?? 50);
    const minima = quote.limitAmountsRaw.map((limit, i) => {
        const expected = raw(quote.expectedAmountsRaw[i]), desired = raw(limit), hard = options.hardMinAmountsRaw ? raw(options.hardMinAmountsRaw[i]) : desired;
        if (expected < hard)
            throw new Error('Withdrawal output fell below the approved minimum; refresh the recursive plan');
        return (desired > hard ? desired : hard).toString();
    });
    const instructions = [];
    const userLp = await inputAccount(ctx, owner, pool.lpMint, lpAmountRaw, instructions, false);
    const userA = await outputAccount(ctx, owner, pool.mintA, instructions), userB = await outputAccount(ctx, owner, pool.mintB, instructions);
    const { programId } = programIds(ctx.network);
    instructions.push(makeWithdrawCpmmInInstruction(programId, owner, new PublicKey(pool.authority), new PublicKey(poolAddress), userLp, userA, userB, new PublicKey(pool.vaultA), new PublicKey(pool.vaultB), new PublicKey(pool.mintA.address), new PublicKey(pool.mintB.address), new PublicKey(pool.lpMint.address), bn(lpAmountRaw), bn(minima[0]), bn(minima[1])));
    return {
        transaction: await finish(ctx, owner, instructions), signers: [], nodeUpdates: [],
        review: { action: 'withdraw', poolAddress, programId: programId.toBase58(), lpAmountRaw, lpMint: pool.lpMint.address, poolCreationFeeLamports: '0', quotedSlot: pool.slot,
            amounts: [reviewAmount(pool.lpMint, lpAmountRaw, lpAmountRaw, 'debit'), reviewAmount(pool.mintA, quote.expectedAmountsRaw[0], minima[0], 'credit'), reviewAmount(pool.mintB, quote.expectedAmountsRaw[1], minima[1], 'credit')], warnings: mintWarnings([pool.mintA, pool.mintB]) },
    };
}
