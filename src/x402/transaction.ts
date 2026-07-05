import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getMintDecimals, getRpc } from '../solana.js'

const MEMO_PROGRAM_ADDRESS = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

export interface BuildExactSvmTransactionParams {
  signer: KeyPairSigner
  rpcUrl: string
  /** SPL mint of the payment asset. */
  asset: string
  /** Recipient owner address — the transfer goes to their ATA. */
  payTo: string
  /** Atomic amount; must match the requirement exactly. */
  amount: bigint
  /** Facilitator fee payer. Omitted → the agent pays its own fee. */
  feePayer?: string
  /** Optional memo for server-side correlation. */
  memo?: string
  decimals?: number
  /**
   * Whether a create-ATA instruction may be inserted when the destination
   * token account is missing. x402 v1 facilitators require TransferChecked at
   * instruction index 2, so this must be false there; v2 and MPP allow it.
   */
  allowCreateAta?: boolean
}

/**
 * Build the x402 "exact" SVM payment transaction, per the scheme spec:
 * compute-unit limit → compute-unit price → (create destination ATA if
 * missing) → TransferChecked → (memo). Partially signed by the agent;
 * base64-encoded for the payment header. When a facilitator `feePayer` is
 * given it co-signs and submits — its address never appears in instruction
 * accounts, so it can only pay the fee, not move funds.
 */
export async function buildExactSvmTransaction(
  params: BuildExactSvmTransactionParams,
): Promise<{
  transaction: string
  decimals: number
  /** The signed transaction object (fully signed when no external feePayer). */
  signed: Awaited<ReturnType<typeof partiallySignTransactionMessageWithSigners>>
}> {
  const rpc = getRpc(params.rpcUrl)
  const mint = address(params.asset)
  const owner = address(params.payTo)
  const decimals = params.decimals ?? (await getMintDecimals(mint, params.rpcUrl))

  const [sourceAta] = await findAssociatedTokenPda({
    mint,
    owner: params.signer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  const [destinationAta] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })

  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 100_000 }),
    // 1000 micro-lamports/CU — well under the spec's 5 lamports/CU ceiling.
    getSetComputeUnitPriceInstruction({ microLamports: 1_000n }),
  ]

  if (params.allowCreateAta !== false) {
    const destinationInfo = await rpc.getAccountInfo(destinationAta, { encoding: 'base64' }).send()
    if (!destinationInfo.value) {
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: params.signer,
          ata: destinationAta,
          owner,
          mint,
        }),
      )
    }
  }

  instructions.push(
    getTransferCheckedInstruction({
      source: sourceAta,
      mint,
      destination: destinationAta,
      authority: params.signer,
      amount: params.amount,
      decimals,
    }),
  )

  if (params.memo) {
    instructions.push({
      programAddress: MEMO_PROGRAM_ADDRESS,
      data: new TextEncoder().encode(params.memo),
    })
  }

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send()

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) =>
      params.feePayer
        ? setTransactionMessageFeePayer(address(params.feePayer), m)
        : setTransactionMessageFeePayerSigner(params.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )

  const signed = await partiallySignTransactionMessageWithSigners(message)
  return { transaction: getBase64EncodedWireTransaction(signed), decimals, signed }
}
