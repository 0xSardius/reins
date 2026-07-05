import {
  decodeBase64Json,
  HEADER_PAYMENT_REQUIRED_V2,
  type PaymentRequiredV1,
  type PaymentRequiredV2,
  type RequirementV1,
  type RequirementV2,
  type X402Option,
} from './types.js'

function optionFromV1(req: RequirementV1): X402Option {
  return {
    version: 1,
    scheme: req.scheme,
    network: req.network,
    amount: req.maxAmountRequired,
    asset: req.asset,
    payTo: req.payTo,
    resource: req.resource,
    description: req.description,
    feePayer: typeof req.extra?.feePayer === 'string' ? req.extra.feePayer : undefined,
    memo: typeof req.extra?.memo === 'string' ? req.extra.memo : undefined,
    raw: req,
  }
}

function optionFromV2(req: RequirementV2, resourceUrl: string): X402Option {
  return {
    version: 2,
    scheme: req.scheme,
    network: req.network,
    amount: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    resource: resourceUrl,
    feePayer: typeof req.extra?.feePayer === 'string' ? req.extra.feePayer : undefined,
    memo: typeof req.extra?.memo === 'string' ? req.extra.memo : undefined,
    raw: req,
  }
}

/**
 * Extract x402 payment options from a 402 response, handling both protocol
 * versions. Returns undefined when the response is not an x402 challenge
 * (e.g. it's an MPP challenge, or a plain 402).
 *
 * Does not consume the response body of `response` — callers can still read it.
 */
export async function parseX402Response(
  response: Response,
  requestUrl: string,
): Promise<X402Option[] | undefined> {
  // v2: PAYMENT-REQUIRED header
  const v2Header = response.headers.get(HEADER_PAYMENT_REQUIRED_V2)
  if (v2Header) {
    try {
      const parsed = decodeBase64Json<PaymentRequiredV2>(v2Header)
      if (parsed.x402Version === 2 && Array.isArray(parsed.accepts)) {
        const resourceUrl = parsed.resource?.url ?? requestUrl
        return parsed.accepts.map((req) => optionFromV2(req, resourceUrl))
      }
    } catch {
      // fall through to body parsing
    }
  }

  // v1 (and v2-in-body fallback): JSON body with x402Version + accepts
  try {
    const body = (await response.clone().json()) as PaymentRequiredV1 | PaymentRequiredV2
    if (!body || !Array.isArray((body as PaymentRequiredV1).accepts)) return undefined
    if (body.x402Version === 1) {
      return (body as PaymentRequiredV1).accepts.map(optionFromV1)
    }
    if (body.x402Version === 2) {
      const v2 = body as PaymentRequiredV2
      const resourceUrl = v2.resource?.url ?? requestUrl
      return v2.accepts.map((req) => optionFromV2(req, resourceUrl))
    }
  } catch {
    // not JSON — not x402
  }
  return undefined
}
