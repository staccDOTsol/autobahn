// Quote math, account layouts, and instruction encoding come from the exact MIT
// SDK version in package-lock.json. This module never accesses an RPC endpoint.
import BN from 'bn.js';
import { Connection, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import {
  createDbcProgram, deriveDbcPoolAuthority, deriveDbcEventAuthority,
  swapQuoteExactIn, swapQuoteExactOut, getFeeMode, TradeDirection,
  getTokenProgram, DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  isRateLimiterApplied,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  unpackMint, unpackAccount, getExtensionTypes, ExtensionType, getTransferFeeConfig,
} from '@solana/spl-token';

// Anchor needs a provider to construct its coder. All accounts are supplied and
// accountsStrict prevents account resolution; no method calls this connection.
const { program } = createDbcProgram(new Connection('http://127.0.0.1:1'));
const pk = (value) => new PublicKey(value);
const bytes = (value) => Buffer.from(value, 'base64');
const u64 = (value) => {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error('Expected unsigned decimal amount');
  const number = new BN(value);
  if (number.bitLength() > 64) throw new Error('Amount exceeds u64');
  return number;
};
const decodePool = (data) => program.coder.accounts.decode('virtualPool', bytes(data));
const decodeConfig = (data) => program.coder.accounts.decode('poolConfig', bytes(data));
const accountInfo = (account) => ({
  data: bytes(account.data), owner: pk(account.owner), executable: false,
  lamports: 0, rentEpoch: 0,
});

function validateMint(address, account, expectedProgram) {
  if (!pk(account.owner).equals(expectedProgram)) throw new Error('Mint token program does not match DBC state');
  if (!expectedProgram.equals(TOKEN_PROGRAM_ID) && !expectedProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Unsupported token program');
  const mint = unpackMint(address, accountInfo(account), expectedProgram);
  if (!mint.isInitialized) throw new Error('Mint is not initialized');
  const allowed = new Set([
    ExtensionType.MetadataPointer, ExtensionType.TokenMetadata,
    ExtensionType.MintCloseAuthority, ExtensionType.TransferFeeConfig,
  ]);
  for (const extension of getExtensionTypes(mint.tlvData)) {
    if (!allowed.has(extension)) throw new Error(`Unsupported Token2022 mint extension: ${ExtensionType[extension] ?? extension}`);
  }
  const transferFee = getTransferFeeConfig(mint);
  if (transferFee && [transferFee.olderTransferFee, transferFee.newerTransferFee].some((fee) => fee.transferFeeBasisPoints !== 0 && fee.maximumFee !== 0n)) {
    throw new Error('Nonzero Token2022 transfer fees are not supported by this DBC adapter');
  }
}

function context(request) {
  const pool = decodePool(request.poolData);
  const state = pool.poolState;
  const config = decodeConfig(request.configData);
  if (state.config.toBase58() !== request.config) throw new Error('Pool/config identity mismatch');
  if (state.baseMint.toBase58() !== request.baseMint || config.quoteMint.toBase58() !== request.quoteMint) throw new Error('Pool/mint identity mismatch');
  if (state.isMigrated !== 0 || state.quoteReserve.gte(config.migrationQuoteThreshold)) throw new Error('DBC pool is graduated or migrated');
  if (![0, 1].includes(config.activationType)) throw new Error('Invalid DBC activation type');
  const point = u64(config.activationType === 0 ? request.slot : request.timestamp);
  if (point.lt(state.activationPoint)) throw new Error('DBC pool is not active yet');
  const baseProgram = getTokenProgram(state.poolType);
  const quoteProgram = getTokenProgram(config.quoteTokenFlag);
  validateMint(state.baseMint, request.baseAccount, baseProgram);
  validateMint(config.quoteMint, request.quoteAccount, quoteProgram);
  for (const [address, account, mint, tokenProgram] of [
    [state.baseVault, request.baseVaultAccount, state.baseMint, baseProgram],
    [state.quoteVault, request.quoteVaultAccount, config.quoteMint, quoteProgram],
  ]) {
    const vault = unpackAccount(address, accountInfo(account), tokenProgram);
    if (!vault.mint.equals(mint) || !vault.owner.equals(deriveDbcPoolAuthority()) || vault.isFrozen || !vault.isInitialized) throw new Error('Invalid or frozen DBC token vault');
  }
  return { pool, state, config, point, baseProgram, quoteProgram };
}

export async function handle(request) {
  switch (request.op) {
    case 'ping': return { sdk: '1.5.12' };
    case 'inspectPools': return Promise.all(request.data.map(async (data) => {
      try { return await handle({ op: 'inspectPool', data }); }
      catch (error) { return { error: error.message }; }
    }));
    case 'inspectPool': {
      const state = decodePool(request.data).poolState;
      return {
        config: state.config.toBase58(), baseMint: state.baseMint.toBase58(),
        baseVault: state.baseVault.toBase58(), quoteVault: state.quoteVault.toBase58(),
        migrated: state.isMigrated !== 0,
      };
    }
    case 'inspectConfig': return { quoteMint: decodeConfig(request.data).quoteMint.toBase58() };
    case 'validate': context(request); return { valid: true };
    case 'quote': {
      const { pool, config, point } = context(request);
      const amount = u64(request.amount);
      const quote = request.exactOut ? swapQuoteExactOut : swapQuoteExactIn;
      const result = quote(pool, config, request.baseToQuote, amount, 0, false, point, false);
      if (!result.amountLeft.isZero() || result.outputAmount.isZero()) throw new Error('DBC cannot fill the entire swap');
      const mode = getFeeMode(config.collectFeeMode, request.baseToQuote ? TradeDirection.BaseToQuote : TradeDirection.QuoteToBase, false);
      return {
        inAmount: result.includedFeeInputAmount.toString(), outAmount: result.outputAmount.toString(),
        feeAmount: result.tradingFee.add(result.protocolFee).add(result.referralFee).toString(),
        feeMint: mode.feesOnBaseToken ? request.baseMint : request.quoteMint,
      };
    }
    case 'build': {
      const { state, config, baseProgram, quoteProgram } = context(request);
      const wallet = pk(request.wallet);
      const inputMint = request.baseToQuote ? state.baseMint : config.quoteMint;
      const outputMint = request.baseToQuote ? config.quoteMint : state.baseMint;
      const inputProgram = request.baseToQuote ? baseProgram : quoteProgram;
      const outputProgram = request.baseToQuote ? quoteProgram : baseProgram;
      const input = getAssociatedTokenAddressSync(inputMint, wallet, true, inputProgram);
      const output = getAssociatedTokenAddressSync(outputMint, wallet, true, outputProgram);
      const fee = config.poolFees.baseFee;
      const needsInstructions = config.enableFirstSwapWithMinFee !== 0 || (fee.baseFeeMode === 2 && isRateLimiterApplied(
        u64(config.activationType === 0 ? request.slot : request.timestamp), state.activationPoint,
        request.baseToQuote ? TradeDirection.BaseToQuote : TradeDirection.QuoteToBase,
        fee.secondFactor, fee.thirdFactor, new BN(fee.firstFactor),
      ));
      const instruction = await program.methods.swap2({
        amount0: u64(request.amount), amount1: u64(request.minimumOut), swapMode: 0,
      }).accountsStrict({
        poolAuthority: deriveDbcPoolAuthority(), config: state.config, pool: pk(request.pool),
        inputTokenAccount: input, outputTokenAccount: output,
        baseVault: state.baseVault, quoteVault: state.quoteVault,
        baseMint: state.baseMint, quoteMint: config.quoteMint, payer: wallet,
        tokenBaseProgram: baseProgram, tokenQuoteProgram: quoteProgram,
        referralTokenAccount: null, eventAuthority: deriveDbcEventAuthority(),
        program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      }).remainingAccounts(needsInstructions ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }] : []).instruction();
      return {
        program: instruction.programId.toBase58(), data: instruction.data.toString('base64'),
        accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({ pubkey: pubkey.toBase58(), isSigner, isWritable })),
        output: output.toBase58(), outputMint: outputMint.toBase58(),
      };
    }
    default: throw new Error('Unknown DBC worker operation');
  }
}

// Exposed only to fixture tests, never through the stdin protocol.
export const testCoder = program.coder.accounts;
