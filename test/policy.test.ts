import { describe, expect, it } from 'vitest'
import { MemoryLedger } from '../src/ledger/index.js'
import { PolicyEngine, type PolicyConfig } from '../src/policy/index.js'
import { USDC_MINT_DEVNET, type PaymentIntent, type PaymentRecord } from '../src/types.js'

const SERVICE = 'https://api.example.com'

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    service: SERVICE,
    resource: `${SERVICE}/v1/thing`,
    amount: 100000n, // 0.10 USDC
    asset: USDC_MINT_DEVNET,
    decimals: 6,
    network: 'solana-devnet',
    payTo: 'BobsAddress11111111111111111111111111111111',
    protocol: 'x402',
    ...overrides,
  }
}

function settled(at: number, amount: bigint, service = SERVICE): PaymentRecord {
  return {
    at,
    service,
    resource: `${service}/v1/thing`,
    amount: amount.toString(),
    asset: USDC_MINT_DEVNET,
    decimals: 6,
    network: 'solana-devnet',
    payTo: 'BobsAddress11111111111111111111111111111111',
    protocol: 'x402',
    status: 'settled',
  }
}

function engine(config: PolicyConfig, now = () => 1_000_000_000_000) {
  const ledger = new MemoryLedger()
  return { engine: new PolicyEngine(config, ledger, now), ledger }
}

describe('PolicyEngine', () => {
  it('allows a payment with an empty config on devnet', async () => {
    const { engine: e } = engine({})
    expect(await e.check(intent())).toEqual({ allowed: true })
  })

  it('denies mainnet by default', async () => {
    const { engine: e } = engine({})
    const decision = await e.check(intent({ network: 'solana' }))
    expect(decision.allowed).toBe(false)
    expect(decision.rule).toBe('network')
  })

  it('allows mainnet when opted in', async () => {
    const { engine: e } = engine({ allowedNetworks: ['solana'] })
    expect((await e.check(intent({ network: 'solana' }))).allowed).toBe(true)
  })

  it('denies unknown assets', async () => {
    const { engine: e } = engine({})
    const decision = await e.check(intent({ asset: 'SomeRandomMint1111111111111111111111111111' }))
    expect(decision.rule).toBe('asset')
  })

  it('enforces the blocklist over the allowlist', async () => {
    const { engine: e } = engine({ allowlist: [SERVICE], blocklist: ['api.example.com'] })
    const decision = await e.check(intent())
    expect(decision.rule).toBe('blocklist')
  })

  it('enforces the allowlist by origin or hostname', async () => {
    const { engine: e } = engine({ allowlist: ['api.example.com'] })
    expect((await e.check(intent())).allowed).toBe(true)
    const denied = await e.check(intent({ service: 'https://evil.example.net' }))
    expect(denied.rule).toBe('allowlist')
  })

  it('enforces per-payment caps from defaults', async () => {
    const { engine: e } = engine({ defaults: { maxPerPayment: '0.05' } })
    const decision = await e.check(intent()) // 0.10 > 0.05
    expect(decision.rule).toBe('max-per-payment')
  })

  it('lets per-service policy override defaults', async () => {
    const { engine: e } = engine({
      defaults: { maxPerPayment: '0.05' },
      services: { 'api.example.com': { maxPerPayment: '0.50' } },
    })
    expect((await e.check(intent())).allowed).toBe(true)
  })

  it('enforces cooldowns with retryAfterMs', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ defaults: { cooldownMs: 60_000 } }, () => now)
    await ledger.record(settled(now - 10_000, 100000n))
    const decision = await e.check(intent())
    expect(decision.rule).toBe('cooldown')
    expect(decision.retryAfterMs).toBe(50_000)
  })

  it('allows again after the cooldown expires', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ defaults: { cooldownMs: 60_000 } }, () => now)
    await ledger.record(settled(now - 61_000, 100000n))
    expect((await e.check(intent())).allowed).toBe(true)
  })

  it('enforces maxPaymentsPerDay', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ defaults: { maxPaymentsPerDay: 2 } }, () => now)
    await ledger.record(settled(now - 1000, 100000n))
    await ledger.record(settled(now - 2000, 100000n))
    const decision = await e.check(intent())
    expect(decision.rule).toBe('rate-limit')
  })

  it('enforces the per-service daily budget', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine(
      { services: { 'api.example.com': { dailyBudget: '0.25' } } },
      () => now,
    )
    await ledger.record(settled(now - 1000, 200000n)) // 0.20 spent
    const decision = await e.check(intent()) // +0.10 → 0.30 > 0.25
    expect(decision.rule).toBe('service-daily-budget')
  })

  it('ignores spend older than 24h for daily budgets', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ dailyBudget: '0.25' }, () => now)
    await ledger.record(settled(now - 25 * 60 * 60 * 1000, 200000n))
    expect((await e.check(intent())).allowed).toBe(true)
  })

  it('enforces the global daily budget across services', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ dailyBudget: '0.25' }, () => now)
    await ledger.record(settled(now - 1000, 200000n, 'https://other.example.org'))
    const decision = await e.check(intent())
    expect(decision.rule).toBe('daily-budget')
  })

  it('enforces the lifetime budget', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ totalBudget: '0.25' }, () => now)
    await ledger.record(settled(now - 48 * 60 * 60 * 1000, 200000n))
    const decision = await e.check(intent())
    expect(decision.rule).toBe('total-budget')
  })

  it('does not count failed payments toward budgets', async () => {
    const now = 1_000_000_000_000
    const { engine: e, ledger } = engine({ dailyBudget: '0.25' }, () => now)
    await ledger.record({ ...settled(now - 1000, 200000n), status: 'failed' })
    expect((await e.check(intent())).allowed).toBe(true)
  })

  it('requires approval above the threshold and denies without a handler', async () => {
    const { engine: e } = engine({ approvalThreshold: '0.05' })
    const decision = await e.check(intent())
    expect(decision.rule).toBe('approval')
  })

  it('asks the approval handler and honors its answer', async () => {
    const seen: string[] = []
    const config: PolicyConfig = {
      approvalThreshold: '0.05',
      onApprovalRequired: async (i) => {
        seen.push(i.service)
        return true
      },
    }
    const { engine: e } = engine(config)
    expect((await e.check(intent())).allowed).toBe(true)
    expect(seen).toEqual([SERVICE])

    const { engine: denied } = engine({ ...config, onApprovalRequired: async () => false })
    expect((await denied.check(intent())).rule).toBe('approval')
  })

  it('skips approval below the threshold', async () => {
    const { engine: e } = engine({ approvalThreshold: '0.50' })
    expect((await e.check(intent())).allowed).toBe(true)
  })

  it('authorize() throws PolicyViolationError with the rule', async () => {
    const { engine: e } = engine({ defaults: { maxPerPayment: '0.01' } })
    await expect(e.authorize(intent())).rejects.toMatchObject({
      name: 'PolicyViolationError',
      rule: 'max-per-payment',
    })
  })
})
