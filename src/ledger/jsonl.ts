import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toBudgetUnits } from '../amount.js'
import type { PaymentRecord } from '../types.js'
import { matches, type LedgerQuery, type SpendLedger } from './ledger.js'

/**
 * Append-only JSONL file ledger — the default durable store.
 * One JSON record per line; corrupt/partial lines are skipped on read.
 */
export class JsonlLedger implements SpendLedger {
  private cache: PaymentRecord[] | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async record(payment: PaymentRecord): Promise<void> {
    const records = await this.load()
    records.push(payment)
    const line = JSON.stringify(payment) + '\n'
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, line, 'utf8')
    })
    await this.writeQueue
  }

  private async load(): Promise<PaymentRecord[]> {
    if (this.cache) return this.cache
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const records: PaymentRecord[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as PaymentRecord
        if (typeof parsed.at === 'number' && typeof parsed.amount === 'string') {
          records.push(parsed)
        }
      } catch {
        // skip partial/corrupt lines rather than bricking the wallet
      }
    }
    this.cache = records
    return records
  }

  async totalSince(query: LedgerQuery): Promise<bigint> {
    let total = 0n
    for (const r of await this.load()) {
      if (r.status !== 'settled' || !matches(r, query)) continue
      total += toBudgetUnits(BigInt(r.amount), r.decimals)
    }
    return total
  }

  async countSince(query: LedgerQuery): Promise<number> {
    const records = await this.load()
    return records.filter((r) => r.status === 'settled' && matches(r, query)).length
  }

  async lastPaymentAt(service: string): Promise<number | undefined> {
    const records = await this.load()
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]
      if (r && r.status === 'settled' && r.service === service) return r.at
    }
    return undefined
  }

  async history(query: LedgerQuery = {}): Promise<PaymentRecord[]> {
    const records = await this.load()
    return records.filter((r) => matches(r, query))
  }
}
