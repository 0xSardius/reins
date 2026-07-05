import type { KeyPairSigner } from '@solana/kit'
import { address, getSignatureFromTransaction } from '@solana/kit'
import { Credential, Method } from 'mppx'
import { PaymentError } from '../errors.js'
import type { SpendLedger } from '../ledger/index.js'
import type { PolicyEngine } from '../policy/index.js'
import {
  DEFAULT_RPC_URLS,
  getMintDecimals,
  normalizeNetwork,
  sendAndConfirm,
  type SolanaNetwork,
} from '../solana.js'
import type { PaymentIntent, PaymentRecord } from '../types.js'
import { buildSignedTransfer } from './transfer.js'
import { solanaChargeMethod, type SolanaChargeRequest } from './method.js'

export interface SolanaChargeClientOptions {
  signer: KeyPairSigner
  policy: PolicyEngine
  ledger: SpendLedger
  rpcUrls?: Partial<Record<SolanaNetwork, string>>
  onPayment?: (record: PaymentRecord) => void
  /** Test/advanced hook: replaces build+send+confirm; must return the tx signature. */
  settle?: (params: {
    signer: KeyPairSigner
    rpcUrl: string
    intent: PaymentIntent
    memo: string
  }) => Promise<string>
}

async function defaultSettle(params: {
  signer: KeyPairSigner
  rpcUrl: string
  intent: PaymentIntent
  memo: string
}): Promise<string> {
  const { transaction, signed } = await buildSignedTransfer({
    signer: params.signer,
    rpcUrl: params.rpcUrl,
    asset: params.intent.asset,
    payTo: params.intent.payTo,
    amount: params.intent.amount,
    decimals: params.intent.decimals,
    memo: params.memo,
  })
  const signature = getSignatureFromTransaction(signed)
  await sendAndConfirm(params.rpcUrl, transaction)
  return signature
}

/**
 * Client-side MPP method: pays `solana/charge` challenges with a policy check
 * in front of every transfer. Plug into `Mppx.create({ methods: [...] })` or
 * use the ready-made `createMppFetch`.
 */
export function solanaCharge(options: SolanaChargeClientOptions) {
  return Method.toClient(solanaChargeMethod, {
    async createCredential({ challenge }) {
      const request = challenge.request as SolanaChargeRequest
      const network = normalizeNetwork(request.network ?? 'solana-devnet')
      if (!network) {
        throw new PaymentError(`Unsupported Solana network "${request.network}" in MPP challenge`)
      }
      const rpcUrl = options.rpcUrls?.[network] ?? DEFAULT_RPC_URLS[network]
      const decimals = await getMintDecimals(address(request.currency), rpcUrl)
      const service = challenge.realm.includes('://') ? challenge.realm : `https://${challenge.realm}`

      const intent: PaymentIntent = {
        service,
        resource: service,
        amount: BigInt(request.amount),
        asset: request.currency,
        decimals,
        network,
        payTo: request.recipient,
        protocol: 'mpp',
        description: challenge.description,
      }

      // Guardrails first — throws PolicyViolationError on denial.
      await options.policy.authorize(intent)

      const settle = options.settle ?? defaultSettle
      let signature: string
      try {
        signature = await settle({ signer: options.signer, rpcUrl, intent, memo: challenge.id })
      } catch (error) {
        const record: PaymentRecord = { ...toRecord(intent), status: 'failed' }
        await options.ledger.record(record)
        options.onPayment?.(record)
        throw new PaymentError(`MPP payment to ${intent.service} failed`, intent, { cause: error })
      }

      const record: PaymentRecord = { ...toRecord(intent), status: 'settled', receipt: signature }
      await options.ledger.record(record)
      options.onPayment?.(record)

      return Credential.serialize(
        Credential.from({
          challenge,
          payload: { signature, type: 'transaction' },
        }),
      )
    },
  })
}

function toRecord(intent: PaymentIntent): Omit<PaymentRecord, 'status'> {
  return {
    at: Date.now(),
    service: intent.service,
    resource: intent.resource,
    amount: intent.amount.toString(),
    asset: intent.asset,
    decimals: intent.decimals,
    network: intent.network,
    payTo: intent.payTo,
    protocol: 'mpp',
    description: intent.description,
  }
}
