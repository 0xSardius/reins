# Checkpoint — reins

Updated: 2026-07-05

## What this project is

**reins** — open-source guardrailed wallet for Solana AI agents. Pays x402
(v1+v2) and MPP pay-per-use services automatically with a policy engine in
front of every payment (per-service caps, daily budgets, cooldowns, allow/block
lists, approval hooks). Package name `reins` (verified available on npm).

## State: MVP complete ✅

All planned phases done and committed (7 commits on `main`):

1. Scaffold: package.json (subpath exports + `reins` bin), tsup, vitest, MIT.
2. Policy engine (`src/policy/engine.ts`) + spend ledger (Memory + JSONL) — budgets count settled payments only, rolling 24h windows.
3. Keystore (`src/keys.ts`): env `REINS_SECRET_KEY` or `.reins/agent.keypair.json` (Solana CLI format), WebCrypto Ed25519 keygen.
4. x402 client (`src/x402/`): v1 body + v2 `PAYMENT-REQUIRED` header parsing, exact-SVM tx builder (@solana/kit, CU limit → CU price → [create ATA, v2 only] → TransferChecked → memo), facilitator feePayer partial signing, `X-PAYMENT`/`PAYMENT-SIGNATURE` retry, settlement recording.
5. MPP (`src/mpp/`): custom `solana/charge` method on mppx primitives. Client settles transfer with challenge-id memo binding; `solanaChargeServer` verifies on-chain (amount/recipient-ATA/memo, replay set). mppx 0.8.5 has NO built-in Solana method — ours fills that gap.
6. Unified wallet (`src/wallet.ts`): `createReinsWallet()` → guarded `fetch` composing x402 + MPP (MPP detected via `WWW-Authenticate: Payment`, credential sent as `Authorization: Payment <cred>`), `status()`, `balances()`, `history()`.
7. CLI (`src/cli.ts`): init/address/balance/airdrop/status/history — smoke-tested against live devnet RPC.
8. Examples: `examples/x402-server.ts` (x402.org facilitator), `examples/mpp-server.ts`, `examples/agent.ts`.

**Verification:** 54 tests green (`npm test`), `tsc --noEmit` clean, `npm run build` (tsup) clean. E2E vs production x402.org facilitator: wire format ACCEPTED (progressed from `no_transfer_instruction` → `transaction_simulation_failed`, which is correct for an unfunded wallet).

## Key technical facts (hard-won)

- `@solana/kit` pinned to ^6.5 (not 7.x): `@solana-program/*` peers require ^6.x.
- x402 v1 facilitators expect TransferChecked at instruction index 2 — create-ATA allowed only in v2 (`allowCreateAta` param).
- x402 network strings: v1 `solana`/`solana-devnet`; v2 CAIP-2 `solana:5eykt4...`(mainnet)/`solana:EtWTRA...`(devnet) — normalized in `src/solana.ts`.
- Free devnet facilitator: `https://x402.org/facilitator` (verify/settle/supported; feePayer from /supported).
- mppx server needs ≥32-byte secretKey; mppx client fetch THROWS on non-MPP 402s (why wallet.ts detects protocol itself instead of chaining mppx.fetch).
- Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 dp).

## Not done / next steps

- [ ] Fund a devnet wallet with USDC (https://faucet.circle.com — manual) and run the full settled-payment happy path end to end.
- [ ] Publish to npm (`npm publish` — name `reins` was free as of 2026-07-02).
- [ ] Create GitHub repo + push (no remote configured yet).
- [ ] Roadmap: MPP session intent / x402 `upto` streaming, shared replay store, Token-2022, CI (GitHub Actions: test + typecheck).
- [ ] Consider `docs/` site or expanded examples (LangChain/Vercel AI SDK tool wrappers).

## How to resume

```sh
npm install && npm test && npx tsc --noEmit   # should all pass
RECIPIENT_ADDRESS=<addr> npx tsx examples/x402-server.ts  # terminal 1
RECIPIENT_ADDRESS=<addr> npx tsx examples/mpp-server.ts   # terminal 2
npx tsx examples/agent.ts                                 # terminal 3
```

Local dev artifacts intentionally gitignored: `.reins/` (agent keypair + ledger), `dist/`.
