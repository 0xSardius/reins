/**
 * Demo x402 (v1) paid API on Solana devnet.
 *
 * Charges 0.01 devnet USDC per request to GET /quote, settled through the
 * free x402.org facilitator (no API key needed).
 *
 * Run:
 *   RECIPIENT_ADDRESS=<your address> npx tsx examples/x402-server.ts
 */
import { createServer } from 'node:http'
import { USDC_MINT_DEVNET } from '../src/index.js'
import {
  decodeBase64Json,
  encodeBase64Json,
  HEADER_PAYMENT_RESPONSE_V1,
  HEADER_PAYMENT_V1,
  type RequirementV1,
  type SettlementResponse,
} from '../src/x402/types.js'

const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator'
const PORT = Number(process.env.PORT ?? 4021)
const RECIPIENT = process.env.RECIPIENT_ADDRESS
if (!RECIPIENT) {
  console.error('Set RECIPIENT_ADDRESS to the Solana address that should receive payments.')
  console.error('Tip: use the server operator wallet, not the agent wallet.')
  process.exit(1)
}

/** Ask the facilitator which fee payer to use for solana-devnet. */
async function facilitatorFeePayer(): Promise<string | undefined> {
  try {
    const res = await fetch(`${FACILITATOR}/supported`)
    const { kinds } = (await res.json()) as {
      kinds: { scheme: string; network: string; extra?: { feePayer?: string } }[]
    }
    return kinds.find((k) => k.scheme === 'exact' && k.network === 'solana-devnet')?.extra?.feePayer
  } catch {
    return undefined
  }
}

const feePayer = await facilitatorFeePayer()
console.log(`facilitator: ${FACILITATOR} (feePayer: ${feePayer ?? 'none — agent pays its own fee'})`)

function requirementFor(resource: string): RequirementV1 {
  return {
    scheme: 'exact',
    network: 'solana-devnet',
    maxAmountRequired: '10000', // 0.01 USDC
    resource,
    description: 'One inspirational quote',
    mimeType: 'application/json',
    payTo: RECIPIENT!,
    maxTimeoutSeconds: 60,
    asset: USDC_MINT_DEVNET,
    ...(feePayer ? { extra: { feePayer } } : {}),
  }
}

const QUOTES = [
  'The best way to predict the future is to invent it.',
  'Simplicity is the ultimate sophistication.',
  'Make it work, make it right, make it fast.',
]

const server = createServer(async (req, res) => {
  const url = `http://localhost:${PORT}${req.url ?? '/'}`
  if (!req.url?.startsWith('/quote')) {
    res.writeHead(404).end('try GET /quote')
    return
  }

  const requirement = requirementFor(url)
  const paymentHeader = req.headers[HEADER_PAYMENT_V1.toLowerCase()]

  if (!paymentHeader || typeof paymentHeader !== 'string') {
    res
      .writeHead(402, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({ x402Version: 1, error: 'payment required', accepts: [requirement] }),
      )
    return
  }

  // Verify, then settle through the facilitator.
  const paymentPayload = decodeBase64Json(paymentHeader)
  const facilitatorBody = JSON.stringify({
    x402Version: 1,
    paymentPayload,
    paymentRequirements: requirement,
  })
  const post = (path: string) =>
    fetch(`${FACILITATOR}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: facilitatorBody,
    })

  const verify = (await (await post('/verify')).json()) as { isValid: boolean; invalidReason?: string }
  if (!verify.isValid) {
    res
      .writeHead(402, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({ x402Version: 1, error: verify.invalidReason, accepts: [requirement] }),
      )
    return
  }

  const settle = (await (await post('/settle')).json()) as SettlementResponse
  if (!settle.success) {
    res
      .writeHead(402, { 'content-type': 'application/json' })
      .end(JSON.stringify({ x402Version: 1, error: settle.errorReason, accepts: [requirement] }))
    return
  }

  console.log(`paid: ${settle.payer} → ${settle.transaction}`)
  res
    .writeHead(200, {
      'content-type': 'application/json',
      [HEADER_PAYMENT_RESPONSE_V1]: encodeBase64Json(settle),
    })
    .end(JSON.stringify({ quote: QUOTES[Math.floor(Math.random() * QUOTES.length)] }))
})

server.listen(PORT, () => {
  console.log(`x402 demo API listening on http://localhost:${PORT}/quote (0.01 devnet USDC per call)`)
})
