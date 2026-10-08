import BN from 'bn.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import { unpackMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getExtensionTypes, ExtensionType } from '@solana/spl-token';
export { BN };
export const key = value => new PublicKey(value);
export function raw(value, name = 'amount', { zero = false, bits = 64 } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value) || value.length > 80) throw new Error(`${name} must be an atomic integer string`);
  const n = new BN(value); if ((!zero && n.isZero()) || n.bitLength() > bits) throw new Error(`${name} is outside its valid range`); return n;
}
export function integer(value, name, min, max, fallback) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return n;
}
export function bps(request) { return integer(request.slippageBps, 'slippageBps', 0, 1000, 50); }
export async function mint(ctx, address, legacyOnly = false) {
  const publicKey = key(address); const info = await ctx.connection.getAccountInfo(publicKey, 'confirmed');
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error('Token mint was not found');
  if (legacyOnly && !info.owner.equals(TOKEN_PROGRAM_ID)) throw new Error('DAMM v1 supports legacy SPL Token mints only');
  const state = unpackMint(publicKey, info, info.owner);
  if (getExtensionTypes(state.tlvData).some(t => [ExtensionType.TransferHook, ExtensionType.ConfidentialTransferMint, ExtensionType.NonTransferable].includes(t))) throw new Error('This mint extension is not supported by this liquidity builder');
  return { address: publicKey, program: info.owner, decimals: state.decimals, state };
}
export async function pair(ctx, a, b, legacyOnly = false) {
  if (key(a).equals(key(b))) throw new Error('Pool requires two different mints'); return Promise.all([mint(ctx, a, legacyOnly), mint(ctx, b, legacyOnly)]);
}
export function amount(token, expected, limit, direction) { return { mint: token.address.toBase58(), decimals: token.decimals, expectedRaw: expected.toString(), limitRaw: limit.toString(), direction }; }
export function limit(quote, token, direction) {
  const found = quote.amounts.find(a => a.mint === token.address.toBase58() && a.direction === direction);
  if (!found) throw new Error('Approved quote is missing a token bound'); return raw(found.limitRaw, 'approved limit', { zero: true });
}
export const minimum = (n, slip) => n.muln(10000 - slip).divn(10000);
export const maximum = (n, slip) => n.muln(10000 + slip).addn(9999).divn(10000);
export function ephemeral(ctx, label) {
  if (!(ctx.signers instanceof Map)) throw new Error('Ephemeral signer storage is required');
  if (!ctx.signers.has(label)) ctx.signers.set(label, Keypair.generate()); return ctx.signers.get(label);
}
export function transactions(txs, signers = []) {
  return (Array.isArray(txs) ? txs : [txs]).map(tx => ({ instructions: tx.instructions, signers: signers.filter(s => tx.instructions.some(ix => ix.keys.some(k => k.isSigner && k.pubkey.equals(s.publicKey)))) }));
}
export async function assertPool(ctx, pool, program) {
  const address = key(pool); const info = await ctx.connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(key(program))) throw new Error('Pool does not belong to the selected venue'); return address;
}
export function assertMints(request, a, b) {
  if ((request.mintA && request.mintA !== a.toBase58()) || (request.mintB && request.mintB !== b.toBase58())) throw new Error('Requested mints do not match the pool token order');
}
