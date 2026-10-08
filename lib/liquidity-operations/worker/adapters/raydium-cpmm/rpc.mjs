// Ported from the user-owned cpmm-index-composer/src/chain/rpc.ts.
import { Buffer } from 'buffer';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, unpackAccount, getExtensionTypes, getTransferFeeConfig, getEpochFee, ExtensionType, getTransferHook, getDefaultAccountState, getPausableConfig, getPermanentDelegate, getScaledUiAmountConfig, AccountState } from '@solana/spl-token';
import { CREATE_CPMM_POOL_PROGRAM, CREATE_CPMM_POOL_FEE_ACC, DEVNET_PROGRAM_ID, CpmmConfigInfoLayout, CpmmPoolInfoLayout, getCpmmPdaAmmConfigId, getCreatePoolKeys, getPdaPoolAuthority } from '@raydium-io/raydium-sdk-v2';
import { raw } from './math.mjs';
export function programIds(network) {
    return network === 'mainnet'
        ? { programId: CREATE_CPMM_POOL_PROGRAM, createPoolFeeAccount: CREATE_CPMM_POOL_FEE_ACC }
        : { programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, createPoolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC };
}
const GENESIS = {
    mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};
const networkCache = new WeakMap();
export async function assertNetwork(ctx) {
    let promise = networkCache.get(ctx.connection);
    if (!promise) {
        promise = ctx.connection.getGenesisHash();
        networkCache.set(ctx.connection, promise);
        promise.catch(() => networkCache.delete(ctx.connection));
    }
    if (await promise !== GENESIS[ctx.network])
        throw new Error(`RPC network does not match selected ${ctx.network}`);
}
const POOL_DISC = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const CONFIG_DISC = Buffer.from([218, 244, 33, 104, 203, 203, 43, 111]);
const OBS_DISC = Buffer.from([122, 174, 197, 53, 129, 9, 165, 132]);
const SUPPORT_DISC = Buffer.from([134, 40, 183, 79, 12, 112, 162, 53]);
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');
function bytesEqual(a, b) { return a.length === b.length && a.every((byte, i) => byte === b[i]); }
function owned(info, owner, discriminator, minimum, label) {
    if (!info)
        throw new Error(`${label} does not exist on the selected network`);
    if (!info.owner.equals(owner) || info.executable || info.data.length < minimum || !bytesEqual(info.data.subarray(0, 8), discriminator))
        throw new Error(`${label} is not a valid canonical Raydium CPMM account`);
    return info;
}
function same(a, b, label) {
    if (!a.equals(b))
        throw new Error(`${label} does not match canonical pool state`);
}
function decodeClock(info) {
    if (!info || info.executable || !info.owner.equals(SYSVAR_OWNER) || info.data.length !== 40)
        throw new Error('RPC Clock sysvar is missing or invalid');
    const epoch = info.data.readBigUInt64LE(16), timestamp = info.data.readBigInt64LE(32);
    if (timestamp < 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('RPC Clock timestamp is out of range');
    return { epoch, unixTimestamp: Number(timestamp) };
}
export function sortMints(left, right) {
    if (left.equals(right))
        throw new Error('A CPMM node requires two distinct mint addresses');
    return Buffer.compare(left.toBuffer(), right.toBuffer()) < 0 ? [left, right] : [right, left];
}
const SUPPORTED_EXTENSIONS = new Set([
    ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer, ExtensionType.TokenMetadata,
    ExtensionType.InterestBearingConfig, ExtensionType.ScaledUiAmountConfig,
]);
export function supportMintAddress(network, mint) {
    return PublicKey.findProgramAddressSync([Buffer.from('support_mint'), mint.toBuffer()], programIds(network).programId);
}
export function validateSupportMint(network, mint, info) {
    if (!info)
        return undefined;
    const [address, bump] = supportMintAddress(network, mint);
    const account = owned(info, programIds(network).programId, SUPPORT_DISC, 105, 'Supported-mint approval');
    if (account.data[8] !== bump || !bytesEqual(account.data.subarray(9, 41), mint.toBytes()))
        throw new Error('Supported-mint approval does not match mint/PDA bump');
    return address.toBase58();
}
export function decodeMint(address, info, epoch, supportMintPda, chainTime) {
    if (!info)
        throw new Error(`Mint ${address.toBase58()} does not exist`);
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))
        throw new Error(`Mint ${address.toBase58()} has an unsupported program owner`);
    const mint = unpackMint(address, info, info.owner);
    if (!mint.isInitialized)
        throw new Error(`Mint ${address.toBase58()} is not initialized`);
    const extensions = getExtensionTypes(mint.tlvData);
    const unsupported = extensions.filter(e => !SUPPORTED_EXTENSIONS.has(e));
    if (unsupported.length && !supportMintPda)
        throw new Error(`Mint ${address.toBase58()} requires a canonical support_mint approval for Token-2022 extensions: ${unsupported.map(e => ExtensionType[e] ?? e).join(', ')}`);
    const hook = getTransferHook(mint), defaultState = getDefaultAccountState(mint), pausable = getPausableConfig(mint), delegate = getPermanentDelegate(mint), scaled = getScaledUiAmountConfig(mint);
    if (scaled && (chainTime === undefined || !Number.isSafeInteger(chainTime)))
        throw new Error('Scaled-UI mint decoding requires a verified cluster Clock timestamp');
    if (hook && !hook.programId.equals(PublicKey.default))
        throw new Error(`Mint ${address} has an active transfer-hook program. Canonical CPMM does not forward hook accounts.`);
    if (defaultState?.state === AccountState.Frozen)
        throw new Error(`Mint ${address} creates frozen token accounts; canonical pool/ATA initialization cannot make these transferable.`);
    if (pausable?.paused)
        throw new Error(`Mint ${address} is currently paused by its issuer.`);
    if (extensions.includes(ExtensionType.NonTransferable))
        throw new Error(`Mint ${address} is non-transferable and cannot fund a CPMM vault.`);
    const config = getTransferFeeConfig(mint), fee = config ? getEpochFee(config, epoch) : undefined;
    return {
        address: address.toBase58(), decimals: mint.decimals, programId: info.owner.toBase58(), supplyRaw: mint.supply.toString(), extensions,
        freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
        ...(supportMintPda ? { supportMintPda } : {}),
        ...(scaled ? { uiMultiplier: (BigInt(chainTime) >= scaled.newMultiplierEffectiveTimestamp ? scaled.newMultiplier : scaled.multiplier).toString(), scaledUi: { multiplier: scaled.multiplier.toString(), newMultiplier: scaled.newMultiplier.toString(), effectiveTimestamp: scaled.newMultiplierEffectiveTimestamp.toString() } } : {}),
        issuerControls: [
            ...(delegate && !delegate.delegate.equals(PublicKey.default) ? [`Permanent delegate ${delegate.delegate} may transfer or burn holdings.`] : []),
            ...(hook && !hook.authority.equals(PublicKey.default) ? [`Transfer-hook authority ${hook.authority} can activate a transfer hook later.`] : []),
            ...(pausable && !pausable.authority.equals(PublicKey.default) ? [`Pause authority ${pausable.authority} can pause transfers later.`] : []),
        ],
        ...(fee ? { transferFee: { basisPoints: fee.transferFeeBasisPoints, maximumFeeRaw: fee.maximumFee.toString(), epoch: epoch.toString() } } : {}),
    };
}
export async function getMintSnapshot(ctx, address) {
    await assertNetwork(ctx);
    const key = new PublicKey(address);
    const accounts = await ctx.connection.getMultipleAccountsInfoAndContext([key, supportMintAddress(ctx.network, key)[0], SYSVAR_CLOCK_PUBKEY], 'confirmed');
    const clock = decodeClock(accounts.value[2]);
    return decodeMint(key, accounts.value[0], clock.epoch, validateSupportMint(ctx.network, key, accounts.value[1]), clock.unixTimestamp);
}
export function decodeConfig(ctx, address, info) {
    const { programId } = programIds(ctx.network);
    const state = CpmmConfigInfoLayout.decode(owned(info, programId, CONFIG_DISC, CpmmConfigInfoLayout.span, 'Pool configuration').data);
    same(getCpmmPdaAmmConfigId(programId, state.index).publicKey, address, 'Config PDA');
    const rates = [state.tradeFeeRate, state.protocolFeeRate, state.fundFeeRate, state.creatorFeeRate].map(x => BigInt(x.toString()));
    if (rates.some(x => x < 0n || x > 1000000n) || rates[1] + rates[2] > 1000000n)
        throw new Error('Configuration contains invalid fee rates');
    return {
        address: address.toBase58(), index: state.index, disableCreatePool: state.disableCreatePool,
        createPoolFeeRaw: state.createPoolFee.toString(), tradeFeeRate: state.tradeFeeRate.toString(), protocolFeeRate: state.protocolFeeRate.toString(),
        fundFeeRate: state.fundFeeRate.toString(), creatorFeeRate: state.creatorFeeRate.toString(),
    };
}
export async function getConfigSnapshot(ctx, index) {
    await assertNetwork(ctx);
    if (!Number.isInteger(index) || index < 0 || index > 65535)
        throw new Error('Config index must be 0..65535');
    const key = getCpmmPdaAmmConfigId(programIds(ctx.network).programId, index).publicKey;
    return decodeConfig(ctx, key, await ctx.connection.getAccountInfo(key, 'confirmed'));
}
/** RPC servers cap getMultipleAccounts at 100 keys. Keep all graph reads within that bound. */
async function readAccounts(ctx, keys, minContextSlot) {
    const unique = [...new Map([...keys, SYSVAR_CLOCK_PUBKEY].map(key => [key.toBase58(), key])).values()];
    const values = new Map();
    let slot = minContextSlot ?? 0;
    for (let offset = 0; offset < unique.length; offset += 100) {
        const chunk = unique.slice(offset, offset + 100);
        const result = await ctx.connection.getMultipleAccountsInfoAndContext(chunk, { commitment: 'confirmed', ...(minContextSlot ? { minContextSlot } : {}) });
        slot = Math.max(slot, result.context.slot);
        chunk.forEach((key, i) => values.set(key.toBase58(), result.value[i]));
    }
    return { values, slot };
}
function poolKeys(network, key, hint) {
    return [key, hint.configId, hint.mintA, hint.mintB, hint.mintLp, hint.vaultA, hint.vaultB, hint.observationId, supportMintAddress(network, hint.mintA)[0], supportMintAddress(network, hint.mintB)[0]];
}
function decodePool(ctx, address, keys, accounts, epoch, chainTime) {
    const key = new PublicKey(address), { programId } = programIds(ctx.network);
    const state = CpmmPoolInfoLayout.decode(owned(accounts.value[0], programId, POOL_DISC, CpmmPoolInfoLayout.span, 'Pool').data);
    [state.configId, state.mintA, state.mintB, state.mintLp, state.vaultA, state.vaultB, state.observationId].forEach((v, i) => same(v, keys[i + 1], 'Pool identity changed during read'));
    const canonical = getCreatePoolKeys({ programId, poolId: key, configId: state.configId, mintA: state.mintA, mintB: state.mintB });
    same(state.mintA, sortMints(state.mintA, state.mintB)[0], 'Mint order');
    same(state.mintLp, canonical.lpMint, 'LP mint PDA');
    same(state.vaultA, canonical.vaultA, 'Vault A PDA');
    same(state.vaultB, canonical.vaultB, 'Vault B PDA');
    same(state.observationId, canonical.observationId, 'Observation PDA');
    const authority = getPdaPoolAuthority(programId);
    if (state.bump !== authority.nonce)
        throw new Error('Pool authority bump does not match canonical PDA');
    const config = decodeConfig(ctx, state.configId, accounts.value[1]);
    const mintA = decodeMint(state.mintA, accounts.value[2], epoch, validateSupportMint(ctx.network, state.mintA, accounts.value[8]), chainTime);
    const mintB = decodeMint(state.mintB, accounts.value[3], epoch, validateSupportMint(ctx.network, state.mintB, accounts.value[9]), chainTime);
    const lpMint = decodeMint(state.mintLp, accounts.value[4], epoch, undefined, chainTime);
    same(state.mintProgramA, new PublicKey(mintA.programId), 'Mint A program');
    same(state.mintProgramB, new PublicKey(mintB.programId), 'Mint B program');
    if (state.mintDecimalA !== mintA.decimals || state.mintDecimalB !== mintB.decimals || state.lpDecimals !== lpMint.decimals)
        throw new Error('Mint decimals do not match pool state');
    if (lpMint.programId !== TOKEN_PROGRAM_ID.toBase58())
        throw new Error('Canonical CPMM LP mint must use the legacy SPL Token program');
    const lpState = unpackMint(state.mintLp, accounts.value[4], TOKEN_PROGRAM_ID);
    if (!lpState.mintAuthority?.equals(authority.publicKey) || lpState.freezeAuthority)
        throw new Error('Unexpected LP mint authority');
    const vaultA = unpackAccount(state.vaultA, accounts.value[5], new PublicKey(mintA.programId));
    const vaultB = unpackAccount(state.vaultB, accounts.value[6], new PublicKey(mintB.programId));
    same(vaultA.mint, state.mintA, 'Vault A mint');
    same(vaultB.mint, state.mintB, 'Vault B mint');
    same(vaultA.owner, authority.publicKey, 'Vault A authority');
    same(vaultB.owner, authority.publicKey, 'Vault B authority');
    if (vaultA.isFrozen || vaultB.isFrozen || !vaultA.isInitialized || !vaultB.isInitialized)
        throw new Error('Pool vault is frozen or uninitialized');
    const observation = owned(accounts.value[7], programId, OBS_DISC, 51, 'Observation');
    // ObservationState: discriminator(8), initialized(bool), observation_index(u16), pool_id(32).
    same(new PublicKey(observation.data.subarray(11, 43)), key, 'Observation pool');
    const protocolFeesRaw = [state.protocolFeesMintA.toString(), state.protocolFeesMintB.toString()];
    const fundFeesRaw = [state.fundFeesMintA.toString(), state.fundFeesMintB.toString()];
    const creatorFeesRaw = [state.creatorFeesMintA.toString(), state.creatorFeesMintB.toString()];
    const balances = [vaultA.amount, vaultB.amount];
    const reserves = balances.map((balance, i) => balance - raw(protocolFeesRaw[i]) - raw(fundFeesRaw[i]) - raw(creatorFeesRaw[i]));
    if (reserves.some(n => n <= 0n))
        throw new Error('Pool has no usable reserves after excluding all accrued fees');
    const supply = raw(state.lpAmount.toString(), 'Pool LP supply', false);
    if (raw(lpMint.supplyRaw) > supply)
        throw new Error('LP mint supply exceeds pool-account LP supply');
    return {
        address, config, mintA, mintB, lpMint, vaultA: state.vaultA.toBase58(), vaultB: state.vaultB.toBase58(), authority: authority.publicKey.toBase58(), observationId: state.observationId.toBase58(),
        lpSupplyRaw: supply.toString(), reserveARaw: reserves[0].toString(), reserveBRaw: reserves[1].toString(), protocolFeesRaw, fundFeesRaw, creatorFeesRaw,
        status: state.status, openTime: state.openTime.toString(), slot: accounts.context.slot, epoch: epoch.toString(),
        canDeposit: (state.status & 1) === 0, canWithdraw: (state.status & 2) === 0, canSwap: (state.status & 4) === 0 && BigInt(chainTime) >= BigInt(state.openTime.toString()),
    };
}
async function readPools(ctx, addresses, initial) {
    await assertNetwork(ctx);
    const { programId } = programIds(ctx.network);
    const first = initial ?? await readAccounts(ctx, addresses.map(address => new PublicKey(address)));
    const result = new Map(), keys = new Map();
    for (const address of addresses) {
        try {
            const hint = CpmmPoolInfoLayout.decode(owned(first.values.get(address) ?? null, programId, POOL_DISC, CpmmPoolInfoLayout.span, 'Pool').data);
            keys.set(address, poolKeys(ctx.network, new PublicKey(address), hint));
        }
        catch (error) {
            result.set(address, error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (!keys.size)
        return result;
    const accounts = await readAccounts(ctx, [...keys.values()].flat(), first.slot);
    const clock = decodeClock(accounts.values.get(SYSVAR_CLOCK_PUBKEY.toBase58()) ?? null);
    for (const [address, poolAccountKeys] of keys) {
        try {
            result.set(address, decodePool(ctx, address, poolAccountKeys, { value: poolAccountKeys.map(key => accounts.values.get(key.toBase58()) ?? null), context: { slot: accounts.slot } }, clock.epoch, clock.unixTimestamp));
        }
        catch (error) {
            result.set(address, error instanceof Error ? error : new Error(String(error)));
        }
    }
    return result;
}
export async function getPoolSnapshot(ctx, address) {
    const result = (await readPools(ctx, [address])).get(address);
    if (!result)
        throw new Error('Pool snapshot unavailable');
    if (result instanceof Error)
        throw result;
    return result;
}
export function resolveGraph(network, graph) {
    if (graph.version !== 1)
        throw new Error('Unsupported graph format');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    if (nodes.size !== graph.nodes.length)
        throw new Error('Duplicate graph node IDs');
    const visiting = new Set(), minted = new Map(), pools = [], addresses = new Map();
    const { programId } = programIds(network);
    const visit = (id) => {
        if (visiting.has(id))
            throw new Error(`Graph cycle at ${id}`);
        const known = minted.get(id);
        if (known)
            return known;
        const node = nodes.get(id);
        if (!node)
            throw new Error(`Unknown node ${id}`);
        if (node.kind === 'token') {
            const mint = new PublicKey(node.mint).toBase58();
            minted.set(id, mint);
            return mint;
        }
        if (!Number.isInteger(node.configIndex) || node.configIndex < 0 || node.configIndex > 65535)
            throw new Error(`Invalid config index for ${id}`);
        visiting.add(id);
        const leftMint = visit(node.left), rightMint = visit(node.right);
        visiting.delete(id);
        const [mintA, mintB] = sortMints(new PublicKey(leftMint), new PublicKey(rightMint));
        const configId = getCpmmPdaAmmConfigId(programId, node.configIndex).publicKey;
        const keys = getCreatePoolKeys({ programId, configId, mintA, mintB, ...(node.poolAddress ? { poolId: new PublicKey(node.poolAddress) } : {}) });
        const poolAddress = keys.poolId.toBase58();
        const alias = addresses.get(poolAddress);
        if (alias)
            throw new Error(`Nodes ${alias} and ${id} resolve to the same canonical pool. Reference one shared node ID instead.`);
        addresses.set(poolAddress, id);
        const lpMint = keys.lpMint.toBase58();
        minted.set(id, lpMint);
        pools.push({ nodeId: id, poolAddress, lpMint, leftMint, rightMint, mintA: mintA.toBase58(), mintB: mintB.toBase58(), configIndex: node.configIndex, exists: false });
        return lpMint;
    };
    const rootMint = visit(graph.root);
    return { rootMint, pools, buildOrder: pools.map(p => p.nodeId) };
}
export async function inspectGraph(ctx, graph) {
    await assertNetwork(ctx);
    const resolved = resolveGraph(ctx.network, graph), mints = {};
    const poolMintSet = new Set(resolved.pools.map(p => p.lpMint));
    const leaves = [...new Set([resolved.rootMint, ...resolved.pools.flatMap(p => [p.leftMint, p.rightMint])].filter(mint => !poolMintSet.has(mint)))];
    const { programId } = programIds(ctx.network);
    const configKeys = new Map(resolved.pools.map(pool => [pool.configIndex, getCpmmPdaAmmConfigId(programId, pool.configIndex).publicKey]));
    const accounts = await readAccounts(ctx, [
        ...leaves.flatMap(address => { const key = new PublicKey(address); return [key, supportMintAddress(ctx.network, key)[0]]; }),
        ...resolved.pools.map(pool => new PublicKey(pool.poolAddress)), ...configKeys.values(),
    ]);
    const clock = decodeClock(accounts.values.get(SYSVAR_CLOCK_PUBKEY.toBase58()) ?? null);
    for (const address of leaves) {
        const key = new PublicKey(address), approval = accounts.values.get(supportMintAddress(ctx.network, key)[0].toBase58()) ?? null;
        mints[address] = decodeMint(key, accounts.values.get(address) ?? null, clock.epoch, validateSupportMint(ctx.network, key, approval), clock.unixTimestamp);
    }
    const existing = resolved.pools.filter(pool => accounts.values.get(pool.poolAddress));
    const snapshots = await readPools(ctx, existing.map(pool => pool.poolAddress), accounts);
    let slot = accounts.slot;
    for (const pool of resolved.pools) {
        try {
            const configKey = configKeys.get(pool.configIndex);
            pool.config = decodeConfig(ctx, configKey, accounts.values.get(configKey.toBase58()) ?? null);
            pool.exists = !!accounts.values.get(pool.poolAddress);
            if (pool.exists) {
                const snapshot = snapshots.get(pool.poolAddress);
                if (snapshot instanceof Error)
                    throw snapshot;
                if (!snapshot)
                    throw new Error('Pool snapshot unavailable');
                if (snapshot.mintA.address !== pool.mintA || snapshot.mintB.address !== pool.mintB || snapshot.lpMint.address !== pool.lpMint || snapshot.config.index !== pool.configIndex)
                    throw new Error('Existing pool does not match graph mints/config');
                pool.snapshot = snapshot;
                slot = Math.max(slot, snapshot.slot);
                for (const mint of [snapshot.mintA, snapshot.mintB, snapshot.lpMint])
                    mints[mint.address] = mint;
            }
            else {
                // Canonical initialize hardcodes LP decimals to nine, even before this mint exists.
                mints[pool.lpMint] = { address: pool.lpMint, decimals: 9, programId: TOKEN_PROGRAM_ID.toBase58(), supplyRaw: '0', extensions: [], freezeAuthority: null };
            }
        }
        catch (error) {
            pool.error = error instanceof Error ? error.message : String(error);
        }
    }
    return { ...resolved, mints, slot };
}
export function graphPoolNode(graph, id) {
    const node = graph.nodes.find(n => n.id === id);
    if (!node || node.kind !== 'pool')
        throw new Error('Select a CPMM node');
    return node;
}
