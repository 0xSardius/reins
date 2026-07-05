import { Mppx } from 'mppx/client'
import { solanaCharge, type SolanaChargeClientOptions } from './client.js'

export { solanaChargeMethod, type SolanaChargeRequest, type SolanaChargePayload } from './method.js'
export { solanaCharge, type SolanaChargeClientOptions } from './client.js'
export {
  solanaChargeServer,
  type SolanaChargeServerOptions,
  type ParsedTransferView,
} from './server.js'

export interface MppFetchOptions extends SolanaChargeClientOptions {
  /** The fetch to wrap. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch
}

export interface MppClient {
  /** Payment-aware fetch that handles MPP 402 challenges end to end. */
  fetch: typeof globalThis.fetch
  /** Create a serialized credential for a 402 challenge response. */
  createCredential: (response: Response) => Promise<string>
}

/** An mppx client configured with the guarded reins solana/charge method. */
export function createMppClient(options: MppFetchOptions): MppClient {
  const mppx = Mppx.create({
    methods: [solanaCharge(options)],
    polyfill: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return {
    fetch: mppx.fetch as typeof globalThis.fetch,
    createCredential: (response) => mppx.createCredential(response),
  }
}

/** True when a 402 response carries an MPP `Payment` challenge. */
export function isMppChallenge(response: Response): boolean {
  const header = response.headers.get('www-authenticate')
  return header !== null && /(^|,)\s*Payment\s/i.test(header)
}

/**
 * A fetch that pays MPP `solana/charge` challenges automatically — after the
 * policy engine signs off. Does NOT polyfill globalThis.fetch.
 */
export function createMppFetch(options: MppFetchOptions): typeof globalThis.fetch {
  return createMppClient(options).fetch as typeof globalThis.fetch
}
