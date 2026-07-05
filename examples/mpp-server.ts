/**
 * Demo MPP paid API on Solana devnet.
 *
 * Charges 0.01 devnet USDC per request to GET /fact via the Machine Payments
 * Protocol using the reins `solana/charge` method: the agent pays on-chain
 * (memo-bound to the challenge) and the server verifies the confirmed
 * transaction before serving the resource.
 *
 * Run:
 *   RECIPIENT_ADDRESS=<your address> npx tsx examples/mpp-server.ts
 */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { Mppx, Request as MppRequest } from 'mppx/server'
import { solanaChargeServer, USDC_MINT_DEVNET } from '../src/index.js'

const PORT = Number(process.env.PORT ?? 4022)
const RECIPIENT = process.env.RECIPIENT_ADDRESS
if (!RECIPIENT) {
  console.error('Set RECIPIENT_ADDRESS to the Solana address that should receive payments.')
  process.exit(1)
}

const mppx = Mppx.create({
  methods: [
    solanaChargeServer({
      currency: USDC_MINT_DEVNET,
      recipient: RECIPIENT,
      network: 'solana-devnet',
    }),
  ],
  // In production set MPP_SECRET_KEY (openssl rand -base64 32); an ephemeral
  // key means outstanding challenges die with the process.
  secretKey: process.env.MPP_SECRET_KEY ?? randomBytes(32).toString('base64'),
})

mppx.onPaymentSuccess(({ receipt }) => {
  console.log(`paid: tx ${receipt.reference}`)
})

const FACTS = [
  'Solana blocks are produced roughly every 400 milliseconds.',
  'The memo program lets you attach arbitrary UTF-8 to a transaction.',
  'USDC on Solana uses 6 decimal places.',
]

const handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  if (url.pathname !== '/fact') return new Response('try GET /fact', { status: 404 })

  const result = await mppx.solana.charge({ amount: '0.01' })(request)
  if (result.status === 402) return result.challenge

  return result.withReceipt(
    Response.json({ fact: FACTS[Math.floor(Math.random() * FACTS.length)] }),
  )
}

createServer(MppRequest.toNodeListener(handler)).listen(PORT, () => {
  console.log(`MPP demo API listening on http://localhost:${PORT}/fact (0.01 devnet USDC per call)`)
})
