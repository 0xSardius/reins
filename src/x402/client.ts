import type { KeyPairSigner } from '@solana/kit'
import { address } from '@solana/kit'
import { PolicyViolationError } from '../errors.js'
import type { SpendLedger } from '../ledger/index.js'
import type { PolicyEngine } from '../policy/index.js'
import { DEFAULT_RPC_URLS, getMintDecimals, normalizeNetwork, type SolanaNetwork } from '../solana.js'
import type { PaymentIntent, PaymentRecord } from '../types.js'
import { buildExactSvmTransaction } from './transaction.js'
import { parseX402Response } from './parse.js'
import {
  encodeBase64Json,
  decodeBase64Json,
  HEADER_PAYMENT_RESPONSE_V1,
  HEADER_PAYMENT_RESPONSE_V2,
  HEADER_PAYMENT_V1,
  HEADER_PAYMENT_V2,
  type SettlementResponse,
  type X402Option,
} from './types.js'

export interface X402FetchOptions {
  signer: KeyPairSigner
  policy: PolicyEngine
  ledger: SpendLedger
  /** Override RPC endpoints per network. */
  rpcUrls?: Partial<Record<SolanaNetwork, string>>
  /** Called after every payment attempt is recorded. */
  onPayment?: (record: PaymentRecord) => void
  /** The fetch to wrap. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
  /** Test/advanced hook: replace the transaction builder. */
  buildTransaction?: typeof buildExactSvmTransaction
}

/** Read the settlement header (v1 or v2) from a response, if present. */
export function readSettlement(response: Response): SettlementResponse | undefined {
  const header =
    response.headers.get(HEADER_PAYMENT_RESPONSE_V1) ??
    response.headers.get(HEADER_PAYMENT_RESPONSE_V2)
  if (!header) return undefined
  try {
    return decodeBase64Json<SettlementResponse>(header)
  } catch {
    return undefined
  }
}

/**
 * Given a 402 response, attempt an x402 payment within policy and retry the
 * request. Returns the paid response, or undefined when the challenge is not
 * an x402/Solana challenge (so other protocol handlers can take over).
 * Throws PolicyViolationError when every payable option is denied by policy.
 */
export async function payX402Challenge(
  response: Response,
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: X402FetchOptions,
): Promise<Response | undefined> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const parsed = await parseX402Response(response, url)
  if (!parsed) return undefined

  const candidates = parsed.filter(
    (option) => option.scheme === 'exact' && normalizeNetwork(option.network) !== undefined,
  )
  if (candidates.length === 0) return undefined

  const service = new URL(url).origin
  let firstDenial: { intent: PaymentIntent; rule: string; reason: string; retryAfterMs?: number } | undefined
  let chosen: { option: X402Option; intent: PaymentIntent; network: SolanaNetwork; rpcUrl: string } | undefined

  for (const option of candidates) {
    const network = normalizeNetwork(option.network) as SolanaNetwork
    const rpcUrl = options.rpcUrls?.[network] ?? DEFAULT_RPC_URLS[network]
    let decimals: number
    try {
      decimals = await getMintDecimals(address(option.asset), rpcUrl)
    } catch {
      continue // unresolvable asset — try the next option
    }
    const intent: PaymentIntent = {
      service,
      resource: option.resource || url,
      amount: BigInt(option.amount),
      asset: option.asset,
      decimals,
      network,
      payTo: option.payTo,
      protocol: 'x402',
      description: option.description,
    }
    const decision = await options.policy.check(intent)
    if (decision.allowed) {
      chosen = { option, intent, network, rpcUrl }
      break
    }
    firstDenial ??= {
      intent,
      rule: decision.rule ?? 'policy',
      reason: decision.reason ?? 'denied',
      retryAfterMs: decision.retryAfterMs,
    }
  }

  if (!chosen) {
    if (firstDenial) {
      throw new PolicyViolationError(
        firstDenial.rule,
        firstDenial.reason,
        firstDenial.intent,
        firstDenial.retryAfterMs,
      )
    }
    return undefined // no candidate had a resolvable asset
  }

  const build = options.buildTransaction ?? buildExactSvmTransaction
  const { transaction } = await build({
    signer: options.signer,
    rpcUrl: chosen.rpcUrl,
    asset: chosen.option.asset,
    payTo: chosen.option.payTo,
    amount: chosen.intent.amount,
    feePayer: chosen.option.feePayer,
    memo: chosen.option.memo,
    decimals: chosen.intent.decimals,
    allowCreateAta: chosen.option.version === 2,
  })

  const headers = new Headers(init?.headers)
  if (chosen.option.version === 1) {
    headers.set(
      HEADER_PAYMENT_V1,
      encodeBase64Json({
        x402Version: 1,
        scheme: chosen.option.scheme,
        network: chosen.option.network,
        payload: { transaction },
      }),
    )
    headers.set('Access-Control-Expose-Headers', HEADER_PAYMENT_RESPONSE_V1)
  } else {
    headers.set(
      HEADER_PAYMENT_V2,
      encodeBase64Json({
        x402Version: 2,
        accepted: chosen.option.raw,
        payload: { transaction },
      }),
    )
  }

  const baseFetch = options.fetch ?? globalThis.fetch
  const paidResponse = await baseFetch(input, { ...init, headers })

  const settlement = readSettlement(paidResponse)
  const settled = settlement ? settlement.success : paidResponse.ok
  const record: PaymentRecord = {
    at: Date.now(),
    service: chosen.intent.service,
    resource: chosen.intent.resource,
    amount: chosen.intent.amount.toString(),
    asset: chosen.intent.asset,
    decimals: chosen.intent.decimals,
    network: chosen.intent.network,
    payTo: chosen.intent.payTo,
    protocol: 'x402',
    status: settled ? 'settled' : 'failed',
    receipt: settlement?.transaction,
    description: chosen.intent.description,
  }
  await options.ledger.record(record)
  options.onPayment?.(record)

  return paidResponse
}

/**
 * Wrap a fetch so that x402 402-challenges are paid automatically — after the
 * policy engine signs off. Non-402 responses and non-x402 challenges pass
 * through untouched.
 */
export function createX402Fetch(options: X402FetchOptions): typeof globalThis.fetch {
  const baseFetch = options.fetch ?? globalThis.fetch
  return async function reinsX402Fetch(input, init) {
    const response = await baseFetch(input, init)
    if (response.status !== 402) return response
    const paid = await payX402Challenge(response, input as string | URL | Request, init, options)
    return paid ?? response
  }
}
