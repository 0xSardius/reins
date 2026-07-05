# reins

**The guardrailed wallet for Solana AI agents.**

Give your agent a wallet. Keep the reins.

`reins` is a lean, open-source TypeScript wallet that lets AI agents pay for
pay-per-use APIs automatically over **x402** (v1 and v2) and the
**Machine Payments Protocol (MPP)** — with every payment passing a programmable
policy engine first: per-service spend caps, daily budgets, cooldowns,
allowlists, and human-in-the-loop approvals.

```ts
import { createReinsWallet } from 'reins'

const wallet = await createReinsWallet({
  policy: {
    dailyBudget: '5.00',                     // ≤ $5/day total
    defaults: { maxPerPayment: '0.10', cooldownMs: 1_000 },
    allowlist: ['api.helpful-service.com'],
  },
})

// That's it. 402 challenges are paid automatically — within policy.
const res = await wallet.fetch('https://api.helpful-service.com/v1/answer')
```

One `fetch`. Both protocols. Zero unbounded spending.

## Why

Agents are starting to buy their own inputs — data, inference, search, RPC.
The payment rails exist (x402 settled 35M+ transactions on Solana; MPP is the
emerging HTTP-native standard), but handing an agent a raw keypair is how you
wake up to a drained wallet. `reins` is the missing middle layer: a wallet
that says *yes* fast enough for micropayments and *no* firmly enough to trust
overnight.

- **Guardrails first.** Every payment — either protocol — flows through one
  policy engine before a single lamport moves.
- **Lean.** One package, four dependencies (`@solana/kit`,
  `@solana-program/token`, `@solana-program/compute-budget`, `mppx`). No
  framework, no service, no telemetry.
- **Self-custodied.** Keys stay on your machine (env var or gitignored file).
  Nothing phones home.
- **Devnet by default.** Mainnet is an explicit opt-in, not a default footgun.

## Install

```sh
npm install reins
```

## Quickstart

```sh
npx reins init      # generate the agent keypair (.reins/agent.keypair.json)
npx reins airdrop   # devnet SOL for transaction fees
# devnet USDC: https://faucet.circle.com → Solana devnet → `npx reins address`
npx reins balance
```

Then in your agent:

```ts
import { createReinsWallet } from 'reins'

const wallet = await createReinsWallet({
  policy: {
    dailyBudget: '1.00',
    defaults: { maxPerPayment: '0.05', cooldownMs: 2_000, maxPaymentsPerDay: 50 },
  },
  onPayment: (r) => console.log(`[reins] ${r.status} ${r.amount} → ${r.service}`),
})

const res = await wallet.fetch('https://some-x402-api.example/priced-endpoint')
```

When the API answers `402 Payment Required`, reins parses the challenge
(x402 v1, x402 v2, or MPP), asks the policy engine, signs a USDC transfer with
the agent key, retries the request with the payment attached, and records the
receipt in a local ledger. If policy says no, `wallet.fetch` throws a
`PolicyViolationError` telling the agent exactly which rule blocked it — and
for cooldowns, how long to wait.

## Policy reference

Amounts are strings in token units (`'0.10'` = ten cents of USDC).

```ts
const wallet = await createReinsWallet({
  policy: {
    // Global limits
    dailyBudget: '5.00',        // rolling 24h, all services
    totalBudget: '100',         // lifetime cap
    allowlist: ['api.a.com'],   // only these services (origin or hostname)
    blocklist: ['api.b.com'],   // never these (wins over allowlist)
    allowedNetworks: ['solana-devnet'],  // add 'solana' to enable mainnet
    allowedAssets: [/* mints */],        // default: USDC (mainnet + devnet)

    // Baseline per-service limits (override per service below)
    defaults: {
      maxPerPayment: '0.10',    // single-payment cap
      dailyBudget: '1.00',      // per-service rolling 24h
      cooldownMs: 5_000,        // min gap between payments to one service
      maxPaymentsPerDay: 100,   // per-service rate limit
      requireApproval: false,   // force the approval hook for every payment
    },
    services: {
      'api.expensive.com': { maxPerPayment: '1.00', requireApproval: true },
    },

    // Human in the loop
    approvalThreshold: '0.50',  // payments ≥ this ask first
    onApprovalRequired: async (intent) => {
      // ping Slack, push notification, CLI prompt... return true to approve
      return false
    },
  },
})
```

Denial rules, in evaluation order: `blocklist` → `allowlist` → `network` →
`asset` → `max-per-payment` → `cooldown` → `rate-limit` →
`service-daily-budget` → `daily-budget` → `total-budget` → `approval`.

Budgets only count **settled** payments, tracked in a durable JSONL ledger
(`.reins/ledger.jsonl` by default) so restarts don't reset your limits.

## How payments work

**x402** (v1 body / v2 `PAYMENT-REQUIRED` header): reins builds the exact-SVM
transaction per spec — compute budget, `TransferChecked` to the recipient's
USDC token account, optional memo — partially signs it (the facilitator pays
the network fee when one is offered via `extra.feePayer`), and retries with
the `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2) header. Settlement receipts
from `X-PAYMENT-RESPONSE` / `PAYMENT-RESPONSE` land in the ledger.

**MPP**: reins ships a `solana/charge` method built on
[mppx](https://github.com/wevm/mppx) primitives. The agent settles the SPL
transfer itself with the challenge id embedded as an on-chain memo — binding
the payment to that exact challenge — then presents the transaction signature
as its credential. The server side (also included: `solanaChargeServer`)
verifies the confirmed transfer, amount, recipient, and memo before serving.

```ts
// Monetize your own API with MPP + Solana:
import { Mppx } from 'mppx/server'
import { solanaChargeServer, USDC_MINT_DEVNET } from 'reins'

const mppx = Mppx.create({
  methods: [solanaChargeServer({ currency: USDC_MINT_DEVNET, recipient: YOUR_ADDRESS })],
  secretKey: process.env.MPP_SECRET_KEY!,
})
// then in a route: mppx.solana.charge({ amount: '0.01' })(request)
```

Only need one protocol? `reins/x402` and `reins/mpp` are importable on their
own (`createX402Fetch`, `createMppFetch`).

## CLI

```
reins init                      generate the agent keypair
reins address                   print the agent address
reins balance [--mainnet]       SOL + USDC balances
reins airdrop                   request devnet SOL
reins status                    spend summary (24h + lifetime, by service)
reins history [--service S] [--limit N]
```

## Examples

Two runnable demo servers and an agent, all on devnet:

```sh
RECIPIENT_ADDRESS=<you> npx tsx examples/x402-server.ts   # x402 via x402.org facilitator
RECIPIENT_ADDRESS=<you> npx tsx examples/mpp-server.ts    # MPP with on-chain verification
npx tsx examples/agent.ts                                 # pays both, shows guardrails firing
```

## Security notes

- The agent key is a **hot key**. Fund it like a prepaid card, not a vault —
  budgets bound the blast radius of a compromised or misbehaving agent.
- Keys load from `REINS_SECRET_KEY` or the gitignored keypair file; reins
  never transmits them. The x402 fee-payer co-signing model means a
  facilitator can pay your network fee but can never move your funds (its
  address never appears in instruction accounts).
- Mainnet, non-USDC assets, and every new service are opt-in by policy.
- Treat data returned by paid APIs as untrusted input to your agent.

## Status & roadmap

Early but tested (54 unit/integration tests, wire format validated against the
production x402.org facilitator). Roadmap: session/streaming payments (MPP
`session` intent, x402 `upto`), a shared replay store for multi-instance MPP
servers, Token-2022 assets, and a Solana Pay bridge. Issues and PRs welcome.

## License

MIT
