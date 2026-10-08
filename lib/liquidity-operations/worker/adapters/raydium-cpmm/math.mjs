// Ported from the user-owned cpmm-index-composer/src/chain/math.ts.
import BN from 'bn.js';
export const U64_MAX = (1n << 64n) - 1n;
export function raw(value, label = 'Amount', allowZero = true) {
    if (!/^(0|[1-9][0-9]*)$/.test(value))
        throw new Error(`${label} must be an unsigned base-unit integer`);
    const n = BigInt(value);
    if (n > U64_MAX || (!allowZero && n === 0n))
        throw new Error(`${label} is outside the ${allowZero ? '0' : '1'}..u64 range`);
    return n;
}
export function bn(value) { return new BN(raw(value).toString()); }
export function checked(value) {
    if (value < 0n || value > U64_MAX)
        throw new Error('Amount exceeds the token program u64 limit');
    return value;
}
export function ceilDiv(n, d) {
    if (n < 0n || d <= 0n)
        throw new Error('Invalid unsigned ratio');
    return n / d + (n % d === 0n ? 0n : 1n);
}
export function transferFee(gross, mint) {
    if (!mint.transferFee || gross === 0n)
        return 0n;
    const rate = BigInt(mint.transferFee.basisPoints);
    if (rate < 0n || rate > 10000n)
        throw new Error('Invalid transfer fee');
    const charge = ceilDiv(gross * rate, 10000n);
    const cap = raw(mint.transferFee.maximumFeeRaw);
    return charge < cap ? charge : cap;
}
export function grossForNet(net, mint) {
    checked(net);
    if (net === 0n || !mint.transferFee || mint.transferFee.basisPoints === 0)
        return net;
    const cap = raw(mint.transferFee.maximumFeeRaw);
    const rate = BigInt(mint.transferFee.basisPoints);
    if (rate < 0n || rate > 10000n)
        throw new Error('Invalid transfer fee');
    const capped = net + cap;
    const gross = rate === 10000n ? capped : (ceilDiv(net * 10000n, 10000n - rate) < capped ? ceilDiv(net * 10000n, 10000n - rate) : capped);
    checked(gross);
    if (gross - transferFee(gross, mint) !== net)
        throw new Error('Transfer fee cannot produce the requested net amount');
    return gross;
}
export function validateSlippage(bps) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 5_000)
        throw new Error('Slippage must be an integer between 0 and 5000 basis points');
}
/** Mirrors canonical CPMM rounding: fractional amounts below one raw unit are rejected, not rounded up. */
function share(reserve, amount, supply, roundUp) {
    const n = raw(reserve) * amount;
    if (supply <= 0n)
        throw new Error('Pool LP supply is zero');
    let result = n / supply;
    if (result === 0n)
        throw new Error('LP amount is too small: each underlying leg must contain at least one raw unit');
    if (roundUp && n % supply !== 0n)
        result += 1n;
    return checked(result);
}
export function quoteDeposit(pool, lpAmountRaw, slippageBps = 50) {
    validateSlippage(slippageBps);
    if (!pool.canDeposit)
        throw new Error('Deposits are disabled for this pool');
    const amount = raw(lpAmountRaw, 'LP amount', false), supply = raw(pool.lpSupplyRaw, 'Pool LP supply', false);
    checked(supply + amount);
    const net = [share(pool.reserveARaw, amount, supply, true), share(pool.reserveBRaw, amount, supply, true)];
    const gross = [grossForNet(net[0], pool.mintA), grossForNet(net[1], pool.mintB)];
    return {
        lpAmountRaw,
        expectedAmountsRaw: gross.map(String),
        limitAmountsRaw: gross.map(n => checked(ceilDiv(n * BigInt(10_000 + slippageBps), 10000n)).toString()),
        transferFeesRaw: gross.map((n, i) => (n - net[i]).toString()),
    };
}
export function quoteWithdraw(pool, lpAmountRaw, slippageBps = 50) {
    validateSlippage(slippageBps);
    if (!pool.canWithdraw)
        throw new Error('Withdrawals are disabled for this pool');
    const amount = raw(lpAmountRaw, 'LP amount', false), supply = raw(pool.lpSupplyRaw, 'Pool LP supply', false);
    if (amount > supply)
        throw new Error('Withdrawal exceeds pool LP supply');
    const gross = [share(pool.reserveARaw, amount, supply, false), share(pool.reserveBRaw, amount, supply, false)];
    const fees = [transferFee(gross[0], pool.mintA), transferFee(gross[1], pool.mintB)];
    const net = gross.map((n, i) => n - fees[i]);
    if (net.some(n => n <= 0n))
        throw new Error('Withdrawal would be consumed entirely by token transfer fees');
    return {
        lpAmountRaw, expectedAmountsRaw: net.map(String),
        limitAmountsRaw: net.map(n => (n * BigInt(10_000 - slippageBps) / 10000n).toString()),
        transferFeesRaw: fees.map(String),
    };
}
export function integerSqrt(n) {
    if (n < 0n)
        throw new Error('Negative square root');
    if (n < 2n)
        return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + n / x) / 2n;
    }
    return x;
}
export function parseUnits(value, decimals) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
        throw new Error('Invalid mint decimals');
    if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
        throw new Error('Enter a nonnegative decimal amount');
    const [whole, fraction = ''] = value.split('.');
    if (fraction.length > decimals)
        throw new Error(`Mint supports ${decimals} decimal places`);
    return checked(BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction || '').padEnd(decimals, '0') || '0')).toString();
}
export function formatUnits(value, decimals) {
    const n = raw(value).toString().padStart(decimals + 1, '0');
    if (decimals === 0)
        return n;
    return `${n.slice(0, -decimals)}.${n.slice(-decimals)}`.replace(/\.?0+$/, '');
}
