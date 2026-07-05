import { describe, expect, it, vi } from 'vitest'
import { createX402Fetch, type X402FetchOptions } from '../src/x402/index.js'
import {
  decodeBase64Json,
  encodeBase64Json,
  HEADER_PAYMENT_REQUIRED_V2,
  HEADER_PAYMENT_RESPONSE_V1,
  HEADER_PAYMENT_V1,
  HEADER_PAYMENT_V2,
} from '../src/x402/types.js'
import { MemoryLedger } from '../src/ledger/index.js'
import { PolicyEngine, type PolicyConfig } from '../src/policy/index.js'
import { USDC_MINT_DEVNET } from '../src/types.js'

const URL_UNDER_TEST = 'https://api.example.com/v1/data'
const PAY_TO = 'J7rTnaHGYWPBB4rZzGmM1FSFfDDBQ8AhkA7Cx9EBpAdW'
const FEE_PAYER = 'EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd'

const V1_REQUIREMENT = {
  scheme: 'exact',
  network: 'solana-devnet',
  maxAmountRequired: '10000', // 0.01 USDC
  resource: URL_UNDER_TEST,
  description: 'One data lookup',
  mimeType: 'application/json',
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  asset: USDC_MINT_DEVNET,
  extra: { feePayer: FEE_PAYER },
}

const V2_REQUIREMENT = {
  scheme: 'exact',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  amount: '10000',
  asset: USDC_MINT_DEVNET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { feePayer: FEE_PAYER, memo: 'order-42' },
}

function v1Challenge() {
  return new Response(
    JSON.stringify({ x402Version: 1, error: 'payment required', accepts: [V1_REQUIREMENT] }),
    { status: 402, headers: { 'content-type': 'application/json' } },
  )
}

function v2Challenge() {
  return new Response('payment required', {
    status: 402,
    headers: {
      [HEADER_PAYMENT_REQUIRED_V2]: encodeBase64Json({
        x402Version: 2,
        accepts: [V2_REQUIREMENT],
        resource: { url: URL_UNDER_TEST },
      }),
    },
  })
}

const fakeSigner = { address: 'AgentAddr111111111111111111111111111111111' } as never

function setup(policyConfig: PolicyConfig = {}, responses: Response[] = []) {
  const ledger = new MemoryLedger()
  const queue = [...responses]
  const fetchMock = vi.fn(async (_input?: unknown, _init?: RequestInit) => {
    const next = queue.shift()
    if (!next) throw new Error('fetch mock queue empty')
    return next
  })
  const buildTransaction = vi.fn(async () => ({ transaction: 'ZmFrZS10eA==', decimals: 6 }))
  const options: X402FetchOptions = {
    signer: fakeSigner,
    policy: new PolicyEngine(policyConfig, ledger),
    ledger,
    fetch: fetchMock as never,
    buildTransaction: buildTransaction as never,
  }
  return { ledger, fetchMock, buildTransaction, wrapped: createX402Fetch(options) }
}

describe('createX402Fetch', () => {
  it('passes non-402 responses through untouched', async () => {
    const ok = new Response('hello', { status: 200 })
    const { wrapped, fetchMock } = setup({}, [ok])
    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('pays a v1 challenge and records a settled payment', async () => {
    const settlement = encodeBase64Json({
      success: true,
      transaction: 'SigOfSettledTx',
      network: 'solana-devnet',
    })
    const paid = new Response('the goods', {
      status: 200,
      headers: { [HEADER_PAYMENT_RESPONSE_V1]: settlement },
    })
    const { wrapped, fetchMock, buildTransaction, ledger } = setup({}, [v1Challenge(), paid])

    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('the goods')

    // second fetch call carried the X-PAYMENT header
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const header = new Headers(retryInit.headers).get(HEADER_PAYMENT_V1)!
    const decoded = decodeBase64Json<Record<string, unknown>>(header)
    expect(decoded.x402Version).toBe(1)
    expect(decoded.scheme).toBe('exact')
    expect(decoded.network).toBe('solana-devnet')
    expect((decoded.payload as Record<string, unknown>).transaction).toBe('ZmFrZS10eA==')

    // builder got the facilitator fee payer and exact amount
    expect(buildTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ feePayer: FEE_PAYER, amount: 10000n, payTo: PAY_TO }),
    )

    const history = await ledger.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      status: 'settled',
      receipt: 'SigOfSettledTx',
      amount: '10000',
      protocol: 'x402',
      service: 'https://api.example.com',
    })
  })

  it('pays a v2 header challenge with PAYMENT-SIGNATURE and echoes accepted', async () => {
    const paid = new Response('ok', { status: 200 })
    const { wrapped, fetchMock, buildTransaction } = setup({}, [v2Challenge(), paid])

    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(200)

    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    const header = new Headers(retryInit.headers).get(HEADER_PAYMENT_V2)!
    const decoded = decodeBase64Json<Record<string, unknown>>(header)
    expect(decoded.x402Version).toBe(2)
    expect(decoded.accepted).toEqual(V2_REQUIREMENT)

    // memo from extra flows into the transaction builder
    expect(buildTransaction).toHaveBeenCalledWith(expect.objectContaining({ memo: 'order-42' }))
  })

  it('throws PolicyViolationError when policy denies, without paying', async () => {
    const { wrapped, fetchMock } = setup({ defaults: { maxPerPayment: '0.001' } }, [v1Challenge()])
    await expect(wrapped(URL_UNDER_TEST)).rejects.toMatchObject({
      name: 'PolicyViolationError',
      rule: 'max-per-payment',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry happened
  })

  it('returns the original 402 for non-x402 challenges', async () => {
    const mppStyle = new Response('payment required', {
      status: 402,
      headers: { 'www-authenticate': 'Payment realm="api.example.com"' },
    })
    const { wrapped } = setup({}, [mppStyle])
    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(402)
  })

  it('returns the original 402 when only non-Solana networks are offered', async () => {
    const evmOnly = new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [{ ...V1_REQUIREMENT, network: 'base', asset: '0xUSDC' }],
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    )
    const { wrapped } = setup({}, [evmOnly])
    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(402)
  })

  it('records a failed payment when the retry is rejected', async () => {
    const rejected = new Response('still no', { status: 402 })
    const { wrapped, ledger } = setup({}, [v1Challenge(), rejected])
    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(402)
    const history = await ledger.history()
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('failed')
  })

  it('skips a denied option and pays an allowed one', async () => {
    const twoOptions = new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [
          { ...V1_REQUIREMENT, network: 'solana', maxAmountRequired: '5000' }, // mainnet — denied by default
          V1_REQUIREMENT, // devnet — allowed
        ],
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    )
    const paid = new Response('ok', { status: 200 })
    const { wrapped, buildTransaction } = setup({}, [twoOptions, paid])
    const res = await wrapped(URL_UNDER_TEST)
    expect(res.status).toBe(200)
    expect(buildTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000n }))
  })
})
