import { describe, expect, it } from 'vitest'
import { fromAtomic, toAtomic, toBudgetUnits } from '../src/amount.js'

describe('toAtomic', () => {
  it('parses decimal strings in token units', () => {
    expect(toAtomic('0.10', 6)).toBe(100000n)
    expect(toAtomic('1', 6)).toBe(1000000n)
    expect(toAtomic('0.000001', 6)).toBe(1n)
    expect(toAtomic('12.5', 6)).toBe(12500000n)
  })

  it('parses numbers', () => {
    expect(toAtomic(0.25, 6)).toBe(250000n)
    expect(toAtomic(3, 6)).toBe(3000000n)
  })

  it('passes bigints through as atomic', () => {
    expect(toAtomic(123n, 6)).toBe(123n)
  })

  it('rejects negative and malformed amounts', () => {
    expect(() => toAtomic('-1', 6)).toThrow()
    expect(() => toAtomic('1.2.3', 6)).toThrow()
    expect(() => toAtomic('abc', 6)).toThrow()
  })

  it('rejects amounts with excess significant decimals', () => {
    expect(() => toAtomic('0.0000001', 6)).toThrow()
    expect(toAtomic('0.1000000', 6)).toBe(100000n) // trailing zeros ok
  })
})

describe('fromAtomic', () => {
  it('formats atomic amounts', () => {
    expect(fromAtomic(100000n, 6)).toBe('0.1')
    expect(fromAtomic(1000000n, 6)).toBe('1')
    expect(fromAtomic(1n, 6)).toBe('0.000001')
    expect(fromAtomic(0n, 6)).toBe('0')
  })
})

describe('toBudgetUnits', () => {
  it('normalizes across decimals', () => {
    expect(toBudgetUnits(100000n, 6)).toBe(100000n)
    expect(toBudgetUnits(100n, 2)).toBe(1000000n)
    expect(toBudgetUnits(1000000000n, 9)).toBe(1000000n)
  })
})
