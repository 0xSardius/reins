# Checkpoint — reins

Updated: 2026-07-06 (pre-restart checkpoint)

## What this project is

**reins** — open-source guardrailed wallet for Solana AI agents. Pays x402
(v1+v2) and MPP pay-per-use services automatically with a policy engine in
front of every payment (per-service caps, daily budgets, cooldowns, allow/block
lists, approval hooks). npm package name `reins` (still available as of
2026-07-05, NOT yet published).

## State: MVP complete, repo public, publish pending

- Repo: https://github.com/0xSardius/reins (remote `origin`, branch `main`, all work pushed)
- Verification: 54 tests green (`npm test`), `tsc --noEmit` clean, `npm run build` clean, `npm pack --dry-run` clean (51 kB, dist+README+LICENSE only).
- E2E: wire format ACCEPTED by production x402.org facilitator; only failed at simulation because wallet is unfunded (expected).
- Landing page: `docs/index.html` (GitHub Pages-ready) + artifact https://claude.ai/code/artifact/19610f5b-3242-4fde-9cc1-99e3707a876b — both have GitHub/npm links.
- package.json has repository/homepage/bugs/author fields.

## Immediate next steps (blocked on user)

1. **Enable GitHub Pages**: repo Settings → Pages → Deploy from branch → `main` + `/docs` → site at https://0xsardius.github.io/reins/ (gh CLI not installed locally; `winget install GitHub.cli` would allow doing it via API).
2. **Publish to npm**: `npm login` (was ENEEDAUTH), then `npm publish` from repo root. Re-verify name still free first: `npm view reins version` should 404.
3. **Fund devnet USDC** (~$1) via https://faucet.circle.com → address from `npx reins address`, then run the full settled happy path:
   - terminal 1: `RECIPIENT_ADDRESS=<addr> npx tsx examples/x402-server.ts`
   - terminal 2: `RECIPIENT_ADDRESS=<addr> npx tsx examples/mpp-server.ts`
   - terminal 3: `npx tsx examples/agent.ts`
   (Local dev keypair lives in gitignored `.reins/agent.keypair.json`, address `9AHT67RmsQsnm14qD3tRg3d6UMNUkoCfDVkXSaZpQY7J` — devnet only, ok to refund/regenerate.)

## Architecture map (src/)

- `policy/engine.ts` — PolicyEngine; rule order: blocklist → allowlist → network → asset → max-per-payment → cooldown → rate-limit → service-daily-budget → daily-budget → total-budget → approval. Budgets = settled payments only, rolling 24h.
- `ledger/` — SpendLedger interface; JsonlLedger (default `.reins/ledger.jsonl`) + MemoryLedger.
- `keys.ts` — env `REINS_SECRET_KEY` or `.reins/agent.keypair.json` (Solana CLI format).
- `x402/` — parse (v1 body / v2 PAYMENT-REQUIRED header), tx builder (spec order; create-ATA only on v2 — v1 facilitators need TransferChecked at index 2), guarded fetch, settlement recording.
- `mpp/` — custom `solana/charge` mppx method (client settles USDC transfer with challenge-id memo; server verifier checks amount/recipient-ATA/memo + replay set). mppx has no built-in Solana method.
- `wallet.ts` — `createReinsWallet()`: unified fetch (detects MPP via `WWW-Authenticate: Payment`, x402 otherwise; mppx fetch throws on foreign 402s so we do our own detection), status/balances/history.
- `cli.ts` — init/address/balance/airdrop/status/history.

## Key technical facts (hard-won)

- `@solana/kit` pinned ^6.5 (peer deps of `@solana-program/*` don't support 7.x yet).
- x402 networks: v1 `solana`/`solana-devnet`; v2 CAIP-2 `solana:5eykt4...`/`solana:EtWTRA...` — normalized in `src/solana.ts`.
- Free devnet facilitator `https://x402.org/facilitator`; feePayer comes from GET /supported.
- mppx server secretKey must be ≥32 bytes.
- Devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 dp).

## Roadmap (post-publish)

MPP session / x402 `upto` streaming; shared replay store; Token-2022; CI
(GitHub Actions test+typecheck); agent-framework tool wrappers (LangChain,
Vercel AI SDK).
