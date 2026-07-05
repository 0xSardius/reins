import { createSolanaRpc, type Address, type Rpc, type SolanaRpcApi } from '@solana/kit'
import { fetchMint } from '@solana-program/token'
import { USDC_MINT_DEVNET, USDC_MINT_MAINNET } from './types.js'

/** Normalized Solana network names (matching x402 v1 strings). */
export type SolanaNetwork = 'solana' | 'solana-devnet'

/** Maps every known x402 network identifier (v1 + v2 CAIP-2 forms) to a normalized name. */
const NETWORK_ALIASES: Record<string, SolanaNetwork> = {
  solana: 'solana',
  'solana-devnet': 'solana-devnet',
  // CAIP-2 genesis-hash forms (x402 v2)
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
  // CAIP-2 aliases seen in the migration guide
  'solana:mainnet': 'solana',
  'solana:devnet': 'solana-devnet',
}

/** Normalize any x402 network string to 'solana' | 'solana-devnet', or undefined if not Solana. */
export function normalizeNetwork(network: string): SolanaNetwork | undefined {
  return NETWORK_ALIASES[network]
}

export const DEFAULT_RPC_URLS: Record<SolanaNetwork, string> = {
  solana: 'https://api.mainnet-beta.solana.com',
  'solana-devnet': 'https://api.devnet.solana.com',
}

const rpcCache = new Map<string, Rpc<SolanaRpcApi>>()

export function getRpc(url: string): Rpc<SolanaRpcApi> {
  let rpc = rpcCache.get(url)
  if (!rpc) {
    rpc = createSolanaRpc(url)
    rpcCache.set(url, rpc)
  }
  return rpc
}

/**
 * Send a base64 wire transaction and poll until it reaches `confirmed`
 * commitment. Polling (vs websockets) keeps short-lived agent processes lean.
 */
export async function sendAndConfirm(
  rpcUrl: string,
  wireTransaction: string,
  { timeoutMs = 45_000, pollMs = 1_000 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const rpc = getRpc(rpcUrl)
  const signature = await rpc
    .sendTransaction(wireTransaction as Parameters<typeof rpc.sendTransaction>[0], {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status) {
      if (status.err) {
        throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`)
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return signature
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`Timed out waiting for confirmation of ${signature}`)
}

const decimalsCache = new Map<string, number>([
  [USDC_MINT_MAINNET, 6],
  [USDC_MINT_DEVNET, 6],
])

/** Decimals for a mint — well-known USDC mints resolve without an RPC call. */
export async function getMintDecimals(mint: Address, rpcUrl?: string): Promise<number> {
  const cached = decimalsCache.get(mint)
  if (cached !== undefined) return cached
  if (!rpcUrl) throw new Error(`Unknown mint ${mint} and no RPC URL to look it up`)
  const account = await fetchMint(getRpc(rpcUrl), mint)
  decimalsCache.set(mint, account.data.decimals)
  return account.data.decimals
}
