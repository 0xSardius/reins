import type { Address, KeyPairSigner } from '@solana/kit'
import { address } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { BUDGET_DECIMALS, fromAtomic, toAtomic, type AmountLike } from './amount.js'
import { loadSigner, DEFAULT_KEYPAIR_PATH } from './keys.js'
import { JsonlLedger, type SpendLedger } from './ledger/index.js'
import { PaymentError, PolicyViolationError } from './errors.js'
import { createMppClient, isMppChallenge } from './mpp/index.js'
import { PolicyEngine, type PolicyConfig } from './policy/index.js'
import { DEFAULT_RPC_URLS, getRpc, type SolanaNetwork } from './solana.js'
import {
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  type PaymentRecord,
} from './types.js'
import { createX402Fetch } from './x402/index.js'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ReinsWalletOptions {
  /** Spending guardrails. Empty = devnet-only USDC with no caps (fine for testing). */
  policy?: PolicyConfig
  /** Bring your own signer; otherwise keys load from env/file (see loadSigner). */
  signer?: KeyPairSigner
  /** Env var to read the secret key from. Default: REINS_SECRET_KEY. */
  envVar?: string
  /** Keypair file path. Default: .reins/agent.keypair.json */
  keypairPath?: string
  /** Spend ledger. A string is a JSONL file path. Default: .reins/ledger.jsonl */
  ledger?: SpendLedger | string
  /** Override RPC endpoints per network. */
  rpcUrls?: Partial<Record<SolanaNetwork, string>>
  /** Observability hook — fires after every recorded payment attempt. */
  onPayment?: (record: PaymentRecord) => void
  /** The fetch to wrap. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
}

export interface ServiceSpend {
  service: string
  spent24h: string
  payments24h: number
  lastPaymentAt?: number
}

export interface WalletStatus {
  address: Address
  /** Token units spent in the last rolling 24h across all services. */
  spent24h: string
  /** Token units spent since the ledger began. */
  spentTotal: string
  /** Remaining global daily budget in token units, if one is configured. */
  remainingDaily?: string
  /** Remaining lifetime budget in token units, if one is configured. */
  remainingTotal?: string
  services: ServiceSpend[]
}

export interface WalletBalances {
  /** Lamports. */
  sol: bigint
  /** Atomic USDC (6 decimals). */
  usdc: bigint
}

export interface ReinsWallet {
  address: Address
  signer: KeyPairSigner
  /**
   * Payment-aware fetch: handles x402 (v1+v2) and MPP challenges on Solana,
   * with every payment passing the policy engine first. Non-402 traffic and
   * challenges reins can't pay flow through untouched.
   */
  fetch: typeof globalThis.fetch
  policy: PolicyEngine
  ledger: SpendLedger
  status(): Promise<WalletStatus>
  history(query?: { service?: string; since?: number }): Promise<PaymentRecord[]>
  balances(network?: SolanaNetwork): Promise<WalletBalances>
}

/**
 * Create a reins wallet: a guardrailed, self-custodied Solana wallet for AI
 * agents that pays x402 and MPP pay-per-use services automatically.
 */
export async function createReinsWallet(options: ReinsWalletOptions = {}): Promise<ReinsWallet> {
  const signer = await loadSigner({
    signer: options.signer,
    envVar: options.envVar,
    keypairPath: options.keypairPath ?? DEFAULT_KEYPAIR_PATH,
  })

  const ledger: SpendLedger =
    typeof options.ledger === 'string'
      ? new JsonlLedger(options.ledger)
      : options.ledger ?? new JsonlLedger('.reins/ledger.jsonl')

  const policy = new PolicyEngine(options.policy ?? {}, ledger)

  // Compose: base fetch → MPP handler → x402 handler. Each layer only acts on
  // challenges it recognizes and passes everything else through.
  const baseFetch = options.fetch ?? globalThis.fetch
  const mppClient = createMppClient({
    signer,
    policy,
    ledger,
    rpcUrls: options.rpcUrls,
    onPayment: options.onPayment,
    fetch: baseFetch,
  })

  const mppAwareFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, init)
    if (response.status !== 402 || !isMppChallenge(response)) return response
    let credential: string
    try {
      credential = await mppClient.createCredential(response)
    } catch (error) {
      // Policy denials and settlement failures must surface to the caller;
      // anything else (e.g. only non-Solana methods offered) passes through.
      if (error instanceof PolicyViolationError || error instanceof PaymentError) throw error
      return response
    }
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Payment ${credential}`)
    return baseFetch(input, { ...init, headers })
  }

  const paidFetch = createX402Fetch({
    signer,
    policy,
    ledger,
    rpcUrls: options.rpcUrls,
    onPayment: options.onPayment,
    fetch: mppAwareFetch,
  })

  async function status(): Promise<WalletStatus> {
    const since = Date.now() - DAY_MS
    const [spent24h, spentTotal, records] = await Promise.all([
      ledger.totalSince({ since }),
      ledger.totalSince({ since: 0 }),
      ledger.history({ since }),
    ])

    const perService = new Map<string, { spent: bigint; count: number; last?: number }>()
    for (const record of records) {
      if (record.status !== 'settled') continue
      const entry = perService.get(record.service) ?? { spent: 0n, count: 0 }
      entry.spent += BigInt(record.amount)
      entry.count += 1
      entry.last = Math.max(entry.last ?? 0, record.at)
      perService.set(record.service, entry)
    }

    const config = policy.config
    const remaining = (budget: AmountLike | undefined, spent: bigint): string | undefined => {
      if (budget === undefined) return undefined
      const left = toAtomic(budget, BUDGET_DECIMALS) - spent
      return fromAtomic(left > 0n ? left : 0n, BUDGET_DECIMALS)
    }

    return {
      address: signer.address,
      spent24h: fromAtomic(spent24h, BUDGET_DECIMALS),
      spentTotal: fromAtomic(spentTotal, BUDGET_DECIMALS),
      remainingDaily: remaining(config.dailyBudget, spent24h),
      remainingTotal: remaining(config.totalBudget, spentTotal),
      services: [...perService.entries()].map(([service, entry]) => ({
        service,
        spent24h: fromAtomic(entry.spent, BUDGET_DECIMALS),
        payments24h: entry.count,
        lastPaymentAt: entry.last,
      })),
    }
  }

  async function balances(network: SolanaNetwork = 'solana-devnet'): Promise<WalletBalances> {
    const rpc = getRpc(options.rpcUrls?.[network] ?? DEFAULT_RPC_URLS[network])
    const mint = network === 'solana' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET

    const [{ value: sol }, usdc] = await Promise.all([
      rpc.getBalance(signer.address).send(),
      (async () => {
        const [ata] = await findAssociatedTokenPda({
          mint: address(mint),
          owner: signer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        try {
          const { value } = await rpc.getTokenAccountBalance(ata).send()
          return BigInt(value.amount)
        } catch {
          return 0n // no token account yet
        }
      })(),
    ])

    return { sol, usdc }
  }

  return {
    address: signer.address,
    signer,
    fetch: paidFetch,
    policy,
    ledger,
    status,
    history: (query) => ledger.history(query),
    balances,
  }
}
