import type { PaymentIntent } from './types.js'

/** Thrown when the policy engine denies a payment. The request is NOT retried. */
export class PolicyViolationError extends Error {
  readonly rule: string
  readonly intent: PaymentIntent
  /** For cooldown denials: how long until the payment would be allowed. */
  readonly retryAfterMs?: number

  constructor(rule: string, message: string, intent: PaymentIntent, retryAfterMs?: number) {
    super(`Payment blocked by policy [${rule}]: ${message}`)
    this.name = 'PolicyViolationError'
    this.rule = rule
    this.intent = intent
    this.retryAfterMs = retryAfterMs
  }
}

/** Thrown when a payment was attempted but failed to build, sign, or settle. */
export class PaymentError extends Error {
  readonly intent?: PaymentIntent

  constructor(message: string, intent?: PaymentIntent, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PaymentError'
    this.intent = intent
  }
}
