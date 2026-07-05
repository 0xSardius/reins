/**
 * x402 wire types. Reins speaks both protocol versions:
 *  - v1: requirements in the 402 JSON body, payment in the X-PAYMENT header
 *  - v2: requirements in the PAYMENT-REQUIRED header, payment in PAYMENT-SIGNATURE
 */

export const HEADER_PAYMENT_V1 = 'X-PAYMENT'
export const HEADER_PAYMENT_RESPONSE_V1 = 'X-PAYMENT-RESPONSE'
export const HEADER_PAYMENT_REQUIRED_V2 = 'PAYMENT-REQUIRED'
export const HEADER_PAYMENT_V2 = 'PAYMENT-SIGNATURE'
export const HEADER_PAYMENT_RESPONSE_V2 = 'PAYMENT-RESPONSE'

/** x402 v1 payment requirements (one entry of `accepts`). */
export interface RequirementV1 {
  scheme: string
  network: string
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  outputSchema?: Record<string, unknown>
  extra?: Record<string, unknown>
}

/** x402 v2 payment requirements (one entry of `accepts`). */
export interface RequirementV2 {
  scheme: string
  network: string
  amount: string
  asset: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

export interface PaymentRequiredV1 {
  x402Version: 1
  error?: string
  accepts: RequirementV1[]
}

export interface PaymentRequiredV2 {
  x402Version: 2
  error?: string
  accepts: RequirementV2[]
  resource?: { url: string; description?: string; mimeType?: string }
}

/** A version-agnostic view of one payment option, used internally. */
export interface X402Option {
  version: 1 | 2
  scheme: string
  /** Original network string from the challenge (echoed back in the payment header). */
  network: string
  /** Atomic amount as a string. */
  amount: string
  asset: string
  payTo: string
  resource: string
  description?: string
  /** Facilitator fee payer address, when the server delegates fees. */
  feePayer?: string
  /** Server-requested memo for correlation. */
  memo?: string
  /** The raw requirement object (echoed as `accepted` in v2 payment headers). */
  raw: RequirementV1 | RequirementV2
}

/** Settlement details from X-PAYMENT-RESPONSE / PAYMENT-RESPONSE. */
export interface SettlementResponse {
  success: boolean
  transaction?: string
  network?: string
  payer?: string
  errorReason?: string
}

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

export function decodeBase64Json<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as T
}
