import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlLedger, MemoryLedger } from '../src/ledger/index.js'
import { USDC_MINT_DEVNET, type PaymentRecord } from '../src/types.js'

function record(at: number, amount: bigint, service = 'https://a.example'): PaymentRecord {
  return {
    at,
    service,
    resource: `${service}/r`,
    amount: amount.toString(),
    asset: USDC_MINT_DEVNET,
    decimals: 6,
    network: 'solana-devnet',
    payTo: 'Recipient1111111111111111111111111111111111',
    protocol: 'x402',
    status: 'settled',
  }
}

describe('MemoryLedger', () => {
  it('sums, counts, and filters by service and time', async () => {
    const ledger = new MemoryLedger()
    await ledger.record(record(1000, 100n))
    await ledger.record(record(2000, 200n))
    await ledger.record(record(3000, 400n, 'https://b.example'))

    expect(await ledger.totalSince({ since: 0 })).toBe(700n)
    expect(await ledger.totalSince({ since: 1500 })).toBe(600n)
    expect(await ledger.totalSince({ service: 'https://a.example', since: 0 })).toBe(300n)
    expect(await ledger.countSince({ since: 0 })).toBe(3)
    expect(await ledger.lastPaymentAt('https://a.example')).toBe(2000)
    expect(await ledger.lastPaymentAt('https://c.example')).toBeUndefined()
  })
})

describe('JsonlLedger', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('persists records across instances', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reins-ledger-'))
    const path = join(dir, 'nested', 'ledger.jsonl')

    const first = new JsonlLedger(path)
    await first.record(record(1000, 100n))
    await first.record(record(2000, 200n))

    const second = new JsonlLedger(path)
    expect(await second.totalSince({ since: 0 })).toBe(300n)
    expect(await second.lastPaymentAt('https://a.example')).toBe(2000)
    expect((await second.history()).length).toBe(2)
  })

  it('skips corrupt lines instead of failing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reins-ledger-'))
    const path = join(dir, 'ledger.jsonl')
    const ledger = new JsonlLedger(path)
    await ledger.record(record(1000, 100n))

    const { appendFile } = await import('node:fs/promises')
    await appendFile(path, 'not json\n{"partial":\n', 'utf8')

    const reread = new JsonlLedger(path)
    expect(await reread.countSince({ since: 0 })).toBe(1)
  })
})
