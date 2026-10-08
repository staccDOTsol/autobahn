// Account fixtures adapted from user-owned cpmm-index-composer; local unit tests only.
import { Buffer } from 'buffer';
import { createHash } from 'node:crypto';
import BN from 'bn.js';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { AccountLayout, AccountState, MintLayout, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TransferHookLayout, ExtensionType } from '@solana/spl-token';
import { CpmmConfigInfoLayout, CpmmPoolInfoLayout, getCpmmPdaAmmConfigId, getCreatePoolKeys, getPdaPoolAuthority } from '@raydium-io/raydium-sdk-v2';
import { programIds, supportMintAddress } from '../adapters/raydium-cpmm/rpc.mjs';
export const disc = (name) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
export const key = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
export function info(owner, data) { return { owner, data, lamports: 10_000_000, executable: false, rentEpoch: 0 }; }
export function mintInfo(authority, decimals, supply, token2022 = false, hookProgram = PublicKey.default) {
    const data = Buffer.alloc(token2022 ? 166 + 4 + 64 : MintLayout.span);
    MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: authority, supply, decimals, isInitialized: true, freezeAuthorityOption: token2022 ? 1 : 0, freezeAuthority: authority }, data);
    if (token2022) {
        data[165] = 1;
        data.writeUInt16LE(ExtensionType.TransferHook, 166);
        data.writeUInt16LE(64, 168);
        TransferHookLayout.encode({ authority, programId: hookProgram }, data, 170);
    }
    return info(token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, data);
}
export function tokenInfo(mint, owner, amount, programId = TOKEN_PROGRAM_ID) {
    const data = Buffer.alloc(AccountLayout.span), isNative = mint.equals(NATIVE_MINT);
    AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: AccountState.Initialized, isNativeOption: isNative ? 1 : 0, isNative: isNative ? 2039280n : 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    return info(programId, data);
}
export function fixture({ exists = true, supported = false, native = false } = {}) {
    const network = 'mainnet', ids = programIds(network), owner = key(30), accounts = new Map();
    const clock = Buffer.alloc(40);
    clock.writeBigUInt64LE(500n, 0);
    clock.writeBigUInt64LE(800n, 16);
    clock.writeBigInt64LE(1800000000n, 32);
    accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), info(new PublicKey('Sysvar1111111111111111111111111111111111111'), clock));
    const unsorted = [native ? NATIVE_MINT : key(1), key(2)];
    const [mintA, mintB] = unsorted.sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
    const token2022 = (mint) => supported && !mint.equals(NATIVE_MINT);
    const configKey = getCpmmPdaAmmConfigId(ids.programId, 0);
    const keys = getCreatePoolKeys({ programId: ids.programId, configId: configKey.publicKey, mintA, mintB });
    const configData = Buffer.alloc(CpmmConfigInfoLayout.span), config = CpmmConfigInfoLayout.decode(configData);
    Object.assign(config, { bump: configKey.nonce, index: 0, protocolFeeRate: new BN(120000), tradeFeeRate: new BN(2500), fundFeeRate: new BN(40000), createPoolFee: new BN(150000000), creatorFeeRate: new BN(0), creatorFeeShareRate: new BN(0), protocolOwner: key(7), fundOwner: key(8), disableCreatePool: false });
    CpmmConfigInfoLayout.encode(config, configData);
    disc('AmmConfig').copy(configData);
    accounts.set(configKey.publicKey.toBase58(), info(ids.programId, configData));
    const putMint = (mint, decimals) => {
        accounts.set(mint.toBase58(), mintInfo(key(7), decimals, 100000000000n, token2022(mint)));
        if (token2022(mint)) {
            const [approval, bump] = supportMintAddress(network, mint), data = Buffer.alloc(105);
            disc('SupportMintAssociated').copy(data);
            data[8] = bump;
            mint.toBuffer().copy(data, 9);
            accounts.set(approval.toBase58(), info(ids.programId, data));
        }
        const program = token2022(mint) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        accounts.set(getAssociatedTokenAddressSync(mint, owner, false, program).toBase58(), tokenInfo(mint, owner, 10000000n, program));
    };
    putMint(mintA, mintA.equals(NATIVE_MINT) ? 9 : 6);
    putMint(mintB, 9);
    accounts.set(ids.createPoolFeeAccount.toBase58(), tokenInfo(NATIVE_MINT, key(9), 100000000n));
    const poolData = Buffer.alloc(CpmmPoolInfoLayout.span), pool = CpmmPoolInfoLayout.decode(poolData);
    Object.assign(pool, { bump: getPdaPoolAuthority(ids.programId).nonce, configId: configKey.publicKey, poolCreator: owner, mintA, mintB, mintLp: keys.lpMint, vaultA: keys.vaultA, vaultB: keys.vaultB, observationId: keys.observationId, mintProgramA: token2022(mintA) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, mintProgramB: token2022(mintB) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, lpDecimals: 9, mintDecimalA: mintA.equals(NATIVE_MINT) ? 9 : 6, mintDecimalB: 9, lpAmount: new BN(10000), protocolFeesMintA: new BN(1), fundFeesMintA: new BN(2), creatorFeesMintA: new BN(3), protocolFeesMintB: new BN(2), fundFeesMintB: new BN(4), creatorFeesMintB: new BN(6), openTime: new BN(0), epoch: new BN(800) });
    const savePool = () => { CpmmPoolInfoLayout.encode(pool, poolData); disc('PoolState').copy(poolData); accounts.set(keys.poolId.toBase58(), info(ids.programId, poolData)); };
    if (exists) {
        savePool();
        accounts.set(keys.lpMint.toBase58(), mintInfo(keys.authority, 9, 9900n));
        accounts.set(keys.vaultA.toBase58(), tokenInfo(mintA, keys.authority, 100006n, pool.mintProgramA));
        accounts.set(keys.vaultB.toBase58(), tokenInfo(mintB, keys.authority, 200012n, pool.mintProgramB));
        const observation = Buffer.alloc(51);
        disc('ObservationState').copy(observation);
        keys.poolId.toBuffer().copy(observation, 11);
        accounts.set(keys.observationId.toBase58(), info(ids.programId, observation));
        accounts.set(getAssociatedTokenAddressSync(keys.lpMint, owner).toBase58(), tokenInfo(keys.lpMint, owner, 5000n));
    }
    const batches = [];
    const rpc = {
        getGenesisHash: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getAccountInfo: async (address) => accounts.get(address.toBase58()) ?? null,
        getMultipleAccountsInfoAndContext: async (addresses) => { batches.push(addresses.length); if (addresses.length > 100)
            throw new Error('RPC batch exceeds100'); return { context: { slot: 500 }, value: addresses.map(address => accounts.get(address.toBase58()) ?? null) }; },
        getEpochInfo: async () => ({ epoch: 800 }), getBlockTime: async () => 1_800_000_000,
        getLatestBlockhash: async () => ({ blockhash: key(99).toBase58(), lastValidBlockHeight: 99999 }),
        getSlot: async () => 500,
    };
    const ctx = { network, connection: rpc };
    const graph = { version: 1, name: 'Fixture', root: 'pool', nodes: [{ id: 'left', kind: 'token', mint: mintA.toBase58(), symbol: 'A', color: '#aaa' }, { id: 'right', kind: 'token', mint: mintB.toBase58(), symbol: 'B', color: '#bbb' }, { id: 'pool', kind: 'pool', label: 'A/B', left: 'left', right: 'right', configIndex: 0 }] };
    return { ctx, owner, keys, accounts, graph, mintA, mintB, pool, savePool, config, configData, batches };
}
