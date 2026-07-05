import { address, type Signature } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { Method, Receipt } from 'mppx'
import { toAtomic, fromAtomic } from '../amount.js'
import { DEFAULT_RPC_URLS, getRpc, type SolanaNetwork } from '../solana.js'
import { solanaChargeMethod, type SolanaChargePayload, type SolanaChargeRequest } from './method.js'

/** Minimal view of a parsed instruction from getTransaction(jsonParsed). */
interface ParsedInstruction {
  program?: string
  parsed?: { type?: string; info?: Record<string, unknown> } | string
}

export interface ParsedTransferView {
  err: unknown
  instructions: ParsedInstruction[]
}

export interface SolanaChargeServerOptions {
  /** SPL mint payments must be made in (e.g. devnet USDC). */
  currency: string
  /** Owner address that must receive the transfer (its ATA is checked). */
  recipient: string
  /** Network to verify against. Default: "solana-devnet". */
  network?: SolanaNetwork
  /** Decimals of `currency` — used to convert human amounts. Default: 6 (USDC). */
  decimals?: number
  /** Override the RPC endpoint. */
  rpcUrl?: string
  /** Test hook: replace the on-chain transaction lookup. */
  getTransaction?: (signature: string) => Promise<ParsedTransferView | null>
}

/**
 * Server-side MPP method: verifies that a `solana/charge` credential points at
 * a confirmed on-chain SPL transfer of at least the requested amount, to the
 * configured recipient's token account, memo-bound to this challenge's id.
 *
 * Amounts passed to `mppx.charge({ amount })` are in token units ("0.01" =
 * one cent of USDC), matching mppx's other methods.
 *
 * Replay protection: each transaction signature is accepted once per process.
 * For multi-instance deployments back this with a shared store.
 */
export function solanaChargeServer(options: SolanaChargeServerOptions) {
  const network = options.network ?? 'solana-devnet'
  const decimals = options.decimals ?? 6
  const rpcUrl = options.rpcUrl ?? DEFAULT_RPC_URLS[network]
  const usedSignatures = new Set<string>()

  const lookup =
    options.getTransaction ??
    (async (signature: string): Promise<ParsedTransferView | null> => {
      const rpc = getRpc(rpcUrl)
      const tx = await rpc
        .getTransaction(signature as Signature, {
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
        .send()
      if (!tx) return null
      const message = tx.transaction.message as unknown as { instructions: ParsedInstruction[] }
      return { err: tx.meta?.err ?? null, instructions: message.instructions }
    })

  return Method.toServer(solanaChargeMethod, {
    defaults: {
      currency: options.currency,
      recipient: options.recipient,
      network,
    },
    // Normalize human token-unit amounts ("0.01") to atomic wire amounts.
    request({ request }) {
      const amount = request.amount as string | number
      return { ...request, amount: toAtomic(amount, decimals).toString() }
    },
    async verify({ credential, request }) {
      const payload = credential.payload as SolanaChargePayload
      const req = request as SolanaChargeRequest
      const { signature } = payload

      if (usedSignatures.has(signature)) {
        throw new Error(`Credential replay: transaction ${signature} was already redeemed`)
      }

      const tx = await lookup(signature)
      if (!tx) throw new Error(`Transaction ${signature} not found or not confirmed`)
      if (tx.err) throw new Error(`Transaction ${signature} failed on-chain`)

      const [recipientAta] = await findAssociatedTokenPda({
        mint: address(options.currency),
        owner: address(options.recipient),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })

      const requiredAmount = BigInt(req.amount)
      const transfer = tx.instructions.find((ix) => {
        if (ix.program !== 'spl-token' || typeof ix.parsed === 'string') return false
        if (ix.parsed?.type !== 'transferChecked') return false
        const info = ix.parsed.info ?? {}
        const tokenAmount = info.tokenAmount as { amount?: string } | undefined
        return (
          info.mint === options.currency &&
          info.destination === recipientAta &&
          tokenAmount?.amount !== undefined &&
          BigInt(tokenAmount.amount) >= requiredAmount
        )
      })
      if (!transfer) {
        throw new Error(
          `Transaction ${signature} does not transfer >= ${fromAtomic(requiredAmount, decimals)} ` +
            `of ${options.currency} to ${options.recipient}`,
        )
      }

      const memoBound = tx.instructions.some(
        (ix) => ix.program === 'spl-memo' && ix.parsed === credential.challenge.id,
      )
      if (!memoBound) {
        throw new Error(
          `Transaction ${signature} is not bound to challenge ${credential.challenge.id} (memo missing)`,
        )
      }

      usedSignatures.add(signature)
      return Receipt.from({
        method: 'solana',
        reference: signature,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
}
