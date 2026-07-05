/**
 * Demo agent: pays for x402 and MPP services on devnet with full guardrails.
 *
 * Setup (once):
 *   npx reins init      # creates .reins/agent.keypair.json
 *   npx reins airdrop   # devnet SOL for fees
 *   # devnet USDC: https://faucet.circle.com (Solana devnet, send to `npx reins address`)
 *
 * Then start one or both demo servers in other terminals and run:
 *   npx tsx examples/agent.ts
 */
import { createReinsWallet } from '../src/index.js'

const wallet = await createReinsWallet({
  policy: {
    // The agent may spend at most 0.50 USDC/day overall...
    dailyBudget: '0.50',
    // ...never more than 0.05 in a single payment...
    defaults: {
      maxPerPayment: '0.05',
      // ...at most once every 2 seconds per service...
      cooldownMs: 2_000,
      // ...and at most 20 times per service per day.
      maxPaymentsPerDay: 20,
    },
    // Only these services may be paid at all.
    allowlist: ['localhost', '127.0.0.1'],
    // Anything at or above 0.05 USDC needs a human (here: auto-approve with a log).
    approvalThreshold: '0.05',
    onApprovalRequired: (intent) => {
      console.log(`[approval] ${intent.service} wants ${intent.amount} atomic — approving`)
      return true
    },
  },
  onPayment: (record) => {
    console.log(
      `[payment] ${record.status}: ${record.protocol} → ${record.service} (${record.amount} atomic)` +
        (record.receipt ? ` tx=${record.receipt}` : ''),
    )
  },
})

console.log(`agent address: ${wallet.address}`)
const { sol, usdc } = await wallet.balances()
console.log(`balances: ${sol} lamports, ${usdc} atomic USDC`)
if (usdc === 0n) {
  console.warn('No devnet USDC — fund via https://faucet.circle.com before paying.')
}

// x402: the wallet sees the 402, checks policy, signs the USDC transfer,
// retries with the X-PAYMENT header — one line for the agent developer.
try {
  const res = await wallet.fetch('http://localhost:4021/quote')
  console.log('x402 endpoint:', res.status, await res.text())
} catch (error) {
  console.log('x402 endpoint:', (error as Error).message)
}

// MPP: same wallet, same guardrails, different protocol on the wire.
try {
  const res = await wallet.fetch('http://localhost:4022/fact')
  console.log('MPP endpoint:', res.status, await res.text())
} catch (error) {
  console.log('MPP endpoint:', (error as Error).message)
}

// The cooldown guardrail in action — this immediate second call is denied.
try {
  await wallet.fetch('http://localhost:4021/quote')
} catch (error) {
  console.log('second call (expect cooldown denial):', (error as Error).message)
}

console.log('status:', JSON.stringify(await wallet.status(), null, 2))
