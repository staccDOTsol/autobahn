import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { handle, testCoder } from '../engine.mjs';

const fixture = JSON.parse(readFileSync(new URL('./bread-mainnet.json', import.meta.url)));
function request(overrides = {}) {
  const f = fixture;
  const clock = Buffer.from(f.accounts['SysvarC1ock11111111111111111111111111111111'].data, 'base64');
  return structuredClone({
    op: 'quote', pool: f.pool, config: f.config,
    poolData: f.accounts[f.pool].data, configData: f.accounts[f.config].data,
    baseMint: f.baseMint, quoteMint: f.quoteMint,
    baseAccount: f.accounts[f.baseMint], quoteAccount: f.accounts[f.quoteMint],
    baseVaultAccount: f.accounts[f.baseVault], quoteVaultAccount: f.accounts[f.quoteVault],
    slot: clock.readBigUInt64LE(0).toString(), timestamp: clock.readBigInt64LE(32).toString(),
    baseToQuote: false, amount: '1000000', ...overrides,
  });
}
async function modifyPool(change) {
  const req = request();
  const state = testCoder.decode('virtualPool', Buffer.from(req.poolData, 'base64'));
  change(state.poolState);
  req.poolData = (await testCoder.encode('virtualPool', state)).toString('base64');
  return req;
}

test('captured BREAD/CRUMBS pool: actual curve quotes both directions and fees', async () => {
  assert.deepEqual(await handle(request()), {
    inAmount: '1000000', outAmount: '17553844', feeAmount: '10022', feeMint: fixture.quoteMint,
  });
  assert.deepEqual(await handle(request({ baseToQuote: true })), {
    inAmount: '1000000', outAmount: '55830', feeAmount: '566', feeMint: fixture.quoteMint,
  });
});

test('larger trade uses the curve, not constant spot multiplication', async () => {
  const small = await handle(request());
  const large = await handle(request({ amount: '100000000000' }));
  assert(BigInt(large.outAmount) < BigInt(small.outAmount) * 100000n);
  const inverse = await handle(request({ exactOut: true, amount: large.outAmount }));
  const execution = await handle(request({ amount: inverse.inAmount }));
  assert(BigInt(execution.outAmount) >= BigInt(large.outAmount));
  assert(BigInt(inverse.inAmount) <= 100000000000n);
});

test('recursive synthetic child consumes exact parent output with BREAD as quote', async () => {
  // Synthetic identity change only. Actual public curve bytes and official math
  // are used; this does not claim a second mainnet pool exists.
  const parent = await handle(request());
  const child = request({ amount: parent.outAmount, baseMint: fixture.quoteMint, quoteMint: fixture.baseMint });
  const state = testCoder.decode('virtualPool', Buffer.from(child.poolData, 'base64'));
  state.poolState.baseMint = new PublicKey(child.baseMint);
  child.poolData = (await testCoder.encode('virtualPool', state)).toString('base64');
  // quoteMint is the first field after the config discriminator in the SDK IDL.
  const cfg = Buffer.from(child.configData, 'base64');
  new PublicKey(child.quoteMint).toBuffer().copy(cfg, 8);
  child.configData = cfg.toString('base64');
  [child.quoteAccount, child.baseAccount] = [child.baseAccount, child.quoteAccount];
  const vault = Buffer.from(child.quoteVaultAccount.data, 'base64');
  new PublicKey(child.quoteMint).toBuffer().copy(vault, 0);
  child.quoteVaultAccount.data = vault.toString('base64');
  const baseVault = Buffer.from(child.baseVaultAccount.data, 'base64');
  new PublicKey(child.baseMint).toBuffer().copy(baseVault, 0);
  child.baseVaultAccount.data = baseVault.toString('base64');
  const result = await handle(child);
  assert.equal(result.inAmount, parent.outAmount);
  assert(BigInt(result.outAmount) > 0n);
  assert.equal(result.feeMint, fixture.baseMint);
});

test('swap2 bytes and directional accounts preserve executor input offset and min-out', async () => {
  for (const baseToQuote of [false, true]) {
    const wallet = new PublicKey('11111111111111111111111111111111');
    const result = await handle(request({ op: 'build', baseToQuote, wallet: wallet.toBase58(), minimumOut: '1234' }));
    const data = Buffer.from(result.data, 'base64');
    assert.deepEqual([...data.subarray(0, 8)], [65, 75, 63, 76, 235, 91, 91, 136]);
    assert.equal(data.readBigUInt64LE(8), 1000000n);
    assert.equal(data.readBigUInt64LE(16), 1234n);
    assert.equal(data[24], 0); // SDK ExactIn
    const outputMint = new PublicKey(baseToQuote ? fixture.quoteMint : fixture.baseMint);
    assert.equal(result.output, getAssociatedTokenAddressSync(outputMint, wallet, true, TOKEN_PROGRAM_ID).toBase58());
    assert.equal(result.accounts[2].pubkey, fixture.pool);
    assert.deepEqual(result.accounts.filter((a) => a.isSigner).map((a) => a.pubkey), [wallet.toBase58()]);
  }
});

test('graduated, migrated, and not-yet-active pools fail closed', async () => {
  await assert.rejects(handle(await modifyPool((state) => { state.isMigrated = 1; })), /graduated or migrated/);
  await assert.rejects(handle(await modifyPool((state) => { state.quoteReserve = new BN('18446744073709551615'); })), /graduated or migrated/);
  await assert.rejects(handle(await modifyPool((state) => { state.activationPoint = new BN('18446744073709551615'); })), /not active/);
});

test('malformed/foreign accounts, frozen vaults, zero and overflowing amounts reject', async () => {
  await assert.rejects(handle(request({ poolData: 'AA==' })));
  await assert.rejects(handle(request({ config: fixture.baseMint })), /identity mismatch/);
  await assert.rejects(handle(request({ amount: '0' })), /zero/);
  await assert.rejects(handle(request({ amount: '18446744073709551616' })), /u64/);
  const wrongOwner = request(); wrongOwner.baseAccount.owner = fixture.baseMint;
  await assert.rejects(handle(wrongOwner), /token program/);
  const frozen = request();
  const vault = Buffer.from(frozen.baseVaultAccount.data, 'base64'); vault[108] = 2;
  frozen.baseVaultAccount.data = vault.toString('base64');
  await assert.rejects(handle(frozen), /frozen/);
});
