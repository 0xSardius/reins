/**
 * reins — the guardrailed wallet for Solana AI agents.
 *
 * Pay for x402 and MPP pay-per-use services automatically, with per-service
 * spend caps, daily budgets, cooldowns, and human-in-the-loop approvals.
 */
export {
  createReinsWallet,
  type ReinsWallet,
  type ReinsWalletOptions,
  type WalletStatus,
  type WalletBalances,
  type ServiceSpend,
} from './wallet.js'

export {
  PolicyEngine,
  DEFAULT_ALLOWED_NETWORKS,
  DEFAULT_ALLOWED_ASSETS,
  type PolicyConfig,
  type ServicePolicy,
  type PolicyDecision,
  type ApprovalHandler,
} from './policy/index.js'

export { MemoryLedger, JsonlLedger, type SpendLedger, type LedgerQuery } from './ledger/index.js'

export { loadSigner, generateAgentKeypair, SECRET_KEY_ENV, DEFAULT_KEYPAIR_PATH } from './keys.js'

export { PolicyViolationError, PaymentError } from './errors.js'

export { toAtomic, fromAtomic, type AmountLike } from './amount.js'

export { normalizeNetwork, DEFAULT_RPC_URLS, type SolanaNetwork } from './solana.js'

export {
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
  type PaymentIntent,
  type PaymentRecord,
  type PaymentProtocol,
  type PaymentStatus,
} from './types.js'

export { createX402Fetch, payX402Challenge, type X402FetchOptions } from './x402/index.js'

export {
  createMppFetch,
  createMppClient,
  isMppChallenge,
  solanaCharge,
  solanaChargeServer,
  solanaChargeMethod,
  type MppFetchOptions,
  type SolanaChargeClientOptions,
  type SolanaChargeServerOptions,
} from './mpp/index.js'
