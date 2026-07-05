import { toBudgetUnits } from '../amount.js'
import type { PaymentRecord } from '../types.js'
import { matches, type LedgerQuery, type SpendLedger } from './ledger.js'

/** In-memory ledger. Guardrail state is lost on restart — use for tests. */
export class MemoryLedger implements SpendLedger {
  protected records: PaymentRecord[] = []

  async record(payment: PaymentRecord): Promise<void> {
    this.records.push(payment)
  }

  async totalSince(query: LedgerQuery): Promise<bigint> {
    let total = 0n
    for (const r of this.records) {
      if (r.status !== 'settled' || !matches(r, query)) continue
      total += toBudgetUnits(BigInt(r.amount), r.decimals)
    }
    return total
  }

  async countSince(query: LedgerQuery): Promise<number> {
    return this.records.filter((r) => r.status === 'settled' && matches(r, query)).length
  }

  async lastPaymentAt(service: string): Promise<number | undefined> {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]
      if (r && r.status === 'settled' && r.service === service) return r.at
    }
    return undefined
  }

  async history(query: LedgerQuery = {}): Promise<PaymentRecord[]> {
    return this.records.filter((r) => matches(r, query))
  }
}
