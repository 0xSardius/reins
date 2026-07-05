import type { PaymentRecord } from '../types.js'

export interface LedgerQuery {
  /** Restrict to one service (origin). */
  service?: string
  /** Only records at or after this epoch-ms timestamp. */
  since?: number
}

/**
 * Where reins remembers what it has spent. Budgets, cooldowns, and payment
 * history all read from here, so the ledger must persist across process
 * restarts for guardrails to hold (use JsonlLedger or your own store in
 * production; MemoryLedger is for tests and throwaway sessions).
 *
 * Only records with status "settled" count toward budgets.
 */
export interface SpendLedger {
  record(payment: PaymentRecord): Promise<void>
  /** Sum of settled spend in normalized 6-decimal budget units. */
  totalSince(query: LedgerQuery): Promise<bigint>
  /** Count of settled payments. */
  countSince(query: LedgerQuery): Promise<number>
  /** Epoch ms of the most recent settled payment to a service. */
  lastPaymentAt(service: string): Promise<number | undefined>
  /** Full records, oldest first. */
  history(query?: LedgerQuery): Promise<PaymentRecord[]>
}

export function matches(record: PaymentRecord, query: LedgerQuery): boolean {
  if (query.service !== undefined && record.service !== query.service) return false
  if (query.since !== undefined && record.at < query.since) return false
  return true
}
