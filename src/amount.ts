/**
 * Amount helpers. Policy amounts are written in whole-token units
 * ("0.10" = ten cents of USDC); on-chain math uses atomic bigints.
 */

/** A human-friendly amount: "0.10", 0.1, or an atomic bigint. */
export type AmountLike = string | number | bigint

/**
 * Parse a whole-token amount into atomic units.
 * Strings and numbers are interpreted in token units ("0.10" USDC → 100000n).
 * Bigints are assumed to already be atomic and pass through unchanged.
 */
export function toAtomic(amount: AmountLike, decimals: number): bigint {
  if (typeof amount === 'bigint') return amount
  const text = typeof amount === 'number' ? amount.toFixed(decimals) : amount.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Invalid amount "${amount}" — expected a non-negative decimal like "0.10"`)
  }
  const [whole = '0', fractionRaw = ''] = text.split('.')
  if (fractionRaw.length > decimals) {
    const excess = fractionRaw.slice(decimals)
    if (/[1-9]/.test(excess)) {
      throw new Error(`Amount "${text}" has more than ${decimals} decimal places`)
    }
  }
  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || '0')
}

/** Format atomic units as a whole-token decimal string (100000n, 6 → "0.1"). */
export function fromAtomic(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/**
 * Budgets are tracked in normalized 6-decimal "budget units" so payments in
 * assets with different decimals sum coherently. With the default USDC-only
 * policy this is exact; for other stables it assumes ~$1 peg (documented).
 */
export const BUDGET_DECIMALS = 6

export function toBudgetUnits(amount: bigint, decimals: number): bigint {
  if (decimals === BUDGET_DECIMALS) return amount
  if (decimals > BUDGET_DECIMALS) return amount / 10n ** BigInt(decimals - BUDGET_DECIMALS)
  return amount * 10n ** BigInt(BUDGET_DECIMALS - decimals)
}
