import { Method, z } from 'mppx'

/**
 * The reins Solana charge method for the Machine Payments Protocol.
 *
 * Wire shape:
 * - challenge request: { amount (atomic string), currency (SPL mint),
 *   recipient (owner address), network? ("solana" | "solana-devnet") }
 * - credential payload: { signature (tx signature), type: "transaction" }
 *
 * The client settles the SPL transfer itself (it pays the SOL fee) and embeds
 * the challenge id as a memo, binding the on-chain payment to this exact
 * challenge. The server verifies the confirmed transaction against the
 * challenge before serving the resource.
 */
export const solanaChargeMethod = Method.from({
  name: 'solana',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({
        signature: z.string(),
        type: z.literal('transaction'),
      }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      network: z.optional(z.string()),
    }),
  },
})

export type SolanaChargeRequest = {
  amount: string
  currency: string
  recipient: string
  network?: string | undefined
}

export type SolanaChargePayload = {
  signature: string
  type: 'transaction'
}
