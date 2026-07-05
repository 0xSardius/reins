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

/**
 * A fetch that pays MPP `solana/charge` challenges automatically — after the
 * policy engine signs off. Does NOT polyfill globalThis.fetch.
 */
export function createMppFetch(options: MppFetchOptions): typeof globalThis.fetch {
  const mppx = Mppx.create({
    methods: [solanaCharge(options)],
    polyfill: false,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return mppx.fetch as typeof globalThis.fetch
}
