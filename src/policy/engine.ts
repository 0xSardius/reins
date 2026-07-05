import { BUDGET_DECIMALS, fromAtomic, toAtomic, toBudgetUnits, type AmountLike } from '../amount.js'
import { PolicyViolationError } from '../errors.js'
import type { SpendLedger } from '../ledger/index.js'
import { USDC_MINT_DEVNET, USDC_MINT_MAINNET, type PaymentIntent } from '../types.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Networks payments are allowed on unless overridden. Mainnet is opt-in. */
export const DEFAULT_ALLOWED_NETWORKS = ['solana-devnet']

/** Assets payments are allowed in unless overridden: USDC only. */
export const DEFAULT_ALLOWED_ASSETS = [USDC_MINT_MAINNET, USDC_MINT_DEVNET]

/** Human-in-the-loop hook. Return true to approve the payment. */
export type ApprovalHandler = (intent: PaymentIntent) => boolean | Promise<boolean>

/** Guardrails applied to a single service (or as global defaults). */
export interface ServicePolicy {
  /** Max amount for a single payment, in token units (e.g. "0.10"). */
  maxPerPayment?: AmountLike
  /** Max settled spend to this service per rolling 24h, in token units. */
  dailyBudget?: AmountLike
  /** Minimum milliseconds between payments to this service. */
  cooldownMs?: number
  /** Max number of settled payments to this service per rolling 24h. */
  maxPaymentsPerDay?: number
  /** Every payment to this service requires the approval handler. */
  requireApproval?: boolean
}

export interface PolicyConfig {
  /** Baseline guardrails for every service. Per-service entries override field-by-field. */
  defaults?: ServicePolicy
  /** Per-service overrides, keyed by origin ("https://api.example.com") or hostname. */
  services?: Record<string, ServicePolicy>
  /** Max settled spend across ALL services per rolling 24h, in token units. */
  dailyBudget?: AmountLike
  /** Lifetime spend cap across all services, in token units. */
  totalBudget?: AmountLike
  /** If set, ONLY these services (origins or hostnames) may be paid. */
  allowlist?: string[]
  /** These services are never paid. Checked before the allowlist. */
  blocklist?: string[]
  /** Networks the wallet may pay on. Defaults to devnet only — mainnet is opt-in. */
  allowedNetworks?: string[]
  /** Asset mints the wallet may spend. Defaults to USDC (mainnet + devnet mints). */
  allowedAssets?: string[]
  /** Payments at or above this amount (token units) require the approval handler. */
  approvalThreshold?: AmountLike
  /** Called when a payment needs human/host approval. Absent = such payments are denied. */
  onApprovalRequired?: ApprovalHandler
}

export interface PolicyDecision {
  allowed: boolean
  /** Which rule denied the payment (e.g. "cooldown", "daily-budget"). */
  rule?: string
  reason?: string
  retryAfterMs?: number
}

/** Look up the per-service policy: exact origin key, then hostname key. */
function serviceOverrides(config: PolicyConfig, service: string): ServicePolicy {
  const services = config.services ?? {}
  const exact = services[service]
  if (exact) return exact
  const hostname = hostnameOf(service)
  return (hostname && services[hostname]) || {}
}

function hostnameOf(service: string): string | undefined {
  try {
    return new URL(service).hostname
  } catch {
    return service
  }
}

function listed(list: string[], service: string): boolean {
  const hostname = hostnameOf(service)
  return list.some((entry) => entry === service || entry === hostname)
}

/**
 * The reins policy engine. Evaluates every PaymentIntent against the
 * configured guardrails and the spend ledger before a single lamport moves.
 */
export class PolicyEngine {
  constructor(
    readonly config: PolicyConfig,
    readonly ledger: SpendLedger,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Evaluate an intent. Returns a decision; never throws for a denial.
   * Order: blocklist → allowlist → network → asset → per-payment cap →
   * cooldown → rate limit → service daily budget → global daily budget →
   * lifetime budget → approval.
   */
  async check(intent: PaymentIntent): Promise<PolicyDecision> {
    const config = this.config
    const policy: ServicePolicy = { ...config.defaults, ...serviceOverrides(config, intent.service) }
    const nowMs = this.now()
    const dayAgo = nowMs - DAY_MS
    const amountBudget = toBudgetUnits(intent.amount, intent.decimals)
    const display = `${fromAtomic(intent.amount, intent.decimals)} (asset ${intent.asset})`

    if (config.blocklist && listed(config.blocklist, intent.service)) {
      return deny('blocklist', `${intent.service} is blocklisted`)
    }
    if (config.allowlist && !listed(config.allowlist, intent.service)) {
      return deny('allowlist', `${intent.service} is not on the allowlist`)
    }

    const networks = config.allowedNetworks ?? DEFAULT_ALLOWED_NETWORKS
    if (!networks.includes(intent.network)) {
      return deny(
        'network',
        `network "${intent.network}" is not allowed (allowed: ${networks.join(', ')}). ` +
          `Mainnet must be explicitly enabled via allowedNetworks.`,
      )
    }

    const assets = config.allowedAssets ?? DEFAULT_ALLOWED_ASSETS
    if (!assets.includes(intent.asset)) {
      return deny('asset', `asset ${intent.asset} is not in allowedAssets`)
    }

    if (policy.maxPerPayment !== undefined) {
      const cap = toAtomic(policy.maxPerPayment, intent.decimals)
      if (intent.amount > cap) {
        return deny(
          'max-per-payment',
          `${display} exceeds the per-payment cap of ${fromAtomic(cap, intent.decimals)} for ${intent.service}`,
        )
      }
    }

    if (policy.cooldownMs !== undefined && policy.cooldownMs > 0) {
      const last = await this.ledger.lastPaymentAt(intent.service)
      if (last !== undefined) {
        const readyAt = last + policy.cooldownMs
        if (nowMs < readyAt) {
          return {
            allowed: false,
            rule: 'cooldown',
            reason: `cooldown of ${policy.cooldownMs}ms for ${intent.service} is still active`,
            retryAfterMs: readyAt - nowMs,
          }
        }
      }
    }

    if (policy.maxPaymentsPerDay !== undefined) {
      const count = await this.ledger.countSince({ service: intent.service, since: dayAgo })
      if (count >= policy.maxPaymentsPerDay) {
        return deny(
          'rate-limit',
          `${intent.service} already received ${count}/${policy.maxPaymentsPerDay} payments in the last 24h`,
        )
      }
    }

    if (policy.dailyBudget !== undefined) {
      const budget = toAtomic(policy.dailyBudget, BUDGET_DECIMALS)
      const spent = await this.ledger.totalSince({ service: intent.service, since: dayAgo })
      if (spent + amountBudget > budget) {
        return deny(
          'service-daily-budget',
          `paying ${display} would exceed the 24h budget of ${fromAtomic(budget, BUDGET_DECIMALS)} for ` +
            `${intent.service} (already spent ${fromAtomic(spent, BUDGET_DECIMALS)})`,
        )
      }
    }

    if (config.dailyBudget !== undefined) {
      const budget = toAtomic(config.dailyBudget, BUDGET_DECIMALS)
      const spent = await this.ledger.totalSince({ since: dayAgo })
      if (spent + amountBudget > budget) {
        return deny(
          'daily-budget',
          `paying ${display} would exceed the global 24h budget of ${fromAtomic(budget, BUDGET_DECIMALS)} ` +
            `(already spent ${fromAtomic(spent, BUDGET_DECIMALS)})`,
        )
      }
    }

    if (config.totalBudget !== undefined) {
      const budget = toAtomic(config.totalBudget, BUDGET_DECIMALS)
      const spent = await this.ledger.totalSince({ since: 0 })
      if (spent + amountBudget > budget) {
        return deny(
          'total-budget',
          `paying ${display} would exceed the lifetime budget of ${fromAtomic(budget, BUDGET_DECIMALS)} ` +
            `(already spent ${fromAtomic(spent, BUDGET_DECIMALS)})`,
        )
      }
    }

    let needsApproval = policy.requireApproval === true
    if (!needsApproval && config.approvalThreshold !== undefined) {
      needsApproval = amountBudget >= toAtomic(config.approvalThreshold, BUDGET_DECIMALS)
    }
    if (needsApproval) {
      if (!config.onApprovalRequired) {
        return deny(
          'approval',
          `${display} to ${intent.service} requires approval but no onApprovalRequired handler is configured`,
        )
      }
      const approved = await config.onApprovalRequired(intent)
      if (!approved) {
        return deny('approval', `payment of ${display} to ${intent.service} was not approved`)
      }
    }

    return { allowed: true }
  }

  /** Like check(), but throws PolicyViolationError on denial. */
  async authorize(intent: PaymentIntent): Promise<void> {
    const decision = await this.check(intent)
    if (!decision.allowed) {
      throw new PolicyViolationError(
        decision.rule ?? 'policy',
        decision.reason ?? 'denied',
        intent,
        decision.retryAfterMs,
      )
    }
  }
}

function deny(rule: string, reason: string): PolicyDecision {
  return { allowed: false, rule, reason }
}
