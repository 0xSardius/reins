import { buildExactSvmTransaction } from '../x402/transaction.js'

/**
 * Build and fully sign a USDC transfer for the MPP charge flow. Unlike the
 * x402 path there is no facilitator: the agent is its own fee payer, so the
 * returned transaction is fully signed and ready to send.
 */
export async function buildSignedTransfer(params: {
  signer: Parameters<typeof buildExactSvmTransaction>[0]['signer']
  rpcUrl: string
  asset: string
  payTo: string
  amount: bigint
  decimals: number
  /** Challenge id — embedded as a memo to bind the payment to the challenge. */
  memo: string
}) {
  return buildExactSvmTransaction(params)
}
