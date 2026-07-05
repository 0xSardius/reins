import { describe, expect, it, vi } from 'vitest'
import { createReinsWallet } from '../src/index.js'
import { MemoryLedger } from '../src/ledger/index.js'
import { USDC_MINT_DEVNET, type PaymentRecord } from '../src/types.js'
import { generateAgentKeypair } from '../src/keys.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function testSigner() {
  const dir = await mkdtemp(join(tmpdir(), 'reins-wallet-'))
  const { signer } = await generateAgentKeypair(join(dir, 'k.json'))
  await rm(dir, { recursive: true, force: true })
  return signer
}

function settledRecord(at: number, amount: string, service: string): PaymentRecord {
  return {
    at,
    service,
    resource: `${service}/r`,
    amount,
    asset: USDC_MINT_DEVNET,
    decimals: 6,
    network: 'solana-devnet',
    payTo: 'J7rTnaHGYWPBB4rZzGmM1FSFfDDBQ8AhkA7Cx9EBpAdW',
    protocol: 'x402',
    status: 'settled',
  }
}

describe('createReinsWallet', () => {
  it('passes ordinary traffic through and exposes the signer address', async () => {
    const signer = await testSigner()
    const fetchMock = vi.fn(async () => new Response('plain', { status: 200 }))
    const wallet = await createReinsWallet({
      signer,
      ledger: new MemoryLedger(),
      fetch: fetchMock as never,
    })
    expect(wallet.address).toBe(signer.address)
    const res = await wallet.fetch('https://api.example.com/free')
    expect(await res.text()).toBe('plain')
  })

  it('routes x402 challenges through policy (denial throws before payment)', async () => {
    const signer = await testSigner()
    const challenge = {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana-devnet',
          maxAmountRequired: '10000',
          resource: 'https://api.example.com/paid',
          description: '',
          mimeType: 'application/json',
          payTo: 'J7rTnaHGYWPBB4rZzGmM1FSFfDDBQ8AhkA7Cx9EBpAdW',
          maxTimeoutSeconds: 60,
          asset: USDC_MINT_DEVNET,
        },
      ],
    }
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(challenge), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const wallet = await createReinsWallet({
      signer,
      ledger: new MemoryLedger(),
      policy: { defaults: { maxPerPayment: '0.001' } },
      fetch: fetchMock as never,
    })
    await expect(wallet.fetch('https://api.example.com/paid')).rejects.toMatchObject({
      name: 'PolicyViolationError',
      rule: 'max-per-payment',
    })
  })

  it('reports spend status against configured budgets', async () => {
    const signer = await testSigner()
    const ledger = new MemoryLedger()
    const now = Date.now()
    await ledger.record(settledRecord(now - 1000, '100000', 'https://a.example')) // 0.10
    await ledger.record(settledRecord(now - 2000, '50000', 'https://b.example')) // 0.05
    await ledger.record(settledRecord(now - 48 * 3600 * 1000, '200000', 'https://a.example')) // old

    const wallet = await createReinsWallet({
      signer,
      ledger,
      policy: { dailyBudget: '1.00', totalBudget: '10' },
    })
    const status = await wallet.status()
    expect(status.spent24h).toBe('0.15')
    expect(status.spentTotal).toBe('0.35')
    expect(status.remainingDaily).toBe('0.85')
    expect(status.remainingTotal).toBe('9.65')
    expect(status.services).toHaveLength(2)
    const a = status.services.find((s) => s.service === 'https://a.example')
    expect(a).toMatchObject({ spent24h: '0.1', payments24h: 1 })
  })
})
