/** Payment protocols reins can speak. */
export type PaymentProtocol = 'x402' | 'mpp'

/**
 * A normalized payment the wallet is about to make, regardless of protocol.
 * Everything the policy engine needs to say yes or no.
 */
export interface PaymentIntent {
  /** Canonical service identifier — the origin of the resource (e.g. "https://api.example.com"). */
  service: string
  /** Full URL of the resource being paid for. */
  resource: string
  /** Amount in atomic units of the asset (e.g. 100000 = 0.10 USDC). */
  amount: bigint
  /** Asset identifier — SPL mint address on Solana. */
  asset: string
  /** Decimals of the asset (USDC = 6). */
  decimals: number
  /** Network identifier (e.g. "solana", "solana-devnet"). */
  network: string
  /** Recipient address. */
  payTo: string
  /** Which protocol produced this intent. */
  protocol: PaymentProtocol
  /** Human-readable description from the challenge, if any. */
  description?: string
}

/** Outcome states a payment can end in. */
export type PaymentStatus = 'settled' | 'failed'

/** A payment as recorded in the spend ledger. */
export interface PaymentRecord {
  /** Epoch milliseconds when the payment was made. */
  at: number
  service: string
  resource: string
  /** Atomic amount as a decimal string (JSON-safe bigint). */
  amount: string
  asset: string
  decimals: number
  network: string
  payTo: string
  protocol: PaymentProtocol
  status: PaymentStatus
  /** Transaction signature or receipt token, when available. */
  receipt?: string
  description?: string
}

/** Well-known USDC mints. */
export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
