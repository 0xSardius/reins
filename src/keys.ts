import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getBase58Encoder,
  type KeyPairSigner,
} from '@solana/kit'

/** Default env var holding the agent's secret key. */
export const SECRET_KEY_ENV = 'REINS_SECRET_KEY'

/** Default on-disk keypair location (gitignored by the reins scaffold). */
export const DEFAULT_KEYPAIR_PATH = '.reins/agent.keypair.json'

export interface LoadSignerOptions {
  /** An already-constructed signer takes precedence over everything else. */
  signer?: KeyPairSigner
  /** Env var name to read the secret key from. Default: REINS_SECRET_KEY. */
  envVar?: string
  /** Path to a Solana-CLI-compatible keypair JSON file. Default: .reins/agent.keypair.json. */
  keypairPath?: string
}

function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
      throw new Error('Secret key JSON must be an array of numbers')
    }
    return new Uint8Array(parsed as number[])
  }
  // base58-encoded 64-byte secret key
  return new Uint8Array(getBase58Encoder().encode(trimmed))
}

/**
 * Load the agent's signing key. Resolution order:
 * 1. an explicit `signer`
 * 2. the secret key env var (JSON array or base58, 64 bytes)
 * 3. the keypair file (Solana CLI format)
 *
 * Throws with setup instructions if no key is found.
 */
export async function loadSigner(options: LoadSignerOptions = {}): Promise<KeyPairSigner> {
  if (options.signer) return options.signer

  const envVar = options.envVar ?? SECRET_KEY_ENV
  const fromEnv = process.env[envVar]
  if (fromEnv) {
    return await createKeyPairSignerFromBytes(parseSecretKey(fromEnv))
  }

  const path = resolve(options.keypairPath ?? DEFAULT_KEYPAIR_PATH)
  try {
    const text = await readFile(path, 'utf8')
    return await createKeyPairSignerFromBytes(parseSecretKey(text))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  throw new Error(
    `No agent key found. Set ${envVar}, or run "npx reins init" to generate a keypair at ${path}. ` +
      `Keep the key out of source control.`,
  )
}

/**
 * Generate a new agent keypair and write it to disk in Solana CLI format
 * (JSON array of 64 bytes: 32-byte seed + 32-byte public key).
 * Refuses to overwrite an existing file.
 */
export async function generateAgentKeypair(
  keypairPath: string = DEFAULT_KEYPAIR_PATH,
): Promise<{ signer: KeyPairSigner; path: string }> {
  const path = resolve(keypairPath)
  try {
    await readFile(path, 'utf8')
    throw new Error(`Refusing to overwrite existing keypair at ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Generate an extractable keypair so we can persist the seed.
  const cryptoKeyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', cryptoKeyPair.privateKey))
  // PKCS#8 Ed25519: the last 32 bytes are the raw seed.
  const seed = pkcs8.slice(pkcs8.length - 32)

  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', cryptoKeyPair.publicKey),
  )
  const fullSecret = new Uint8Array(64)
  fullSecret.set(seed, 0)
  fullSecret.set(publicKeyBytes, 32)

  const signer = await createKeyPairSignerFromBytes(fullSecret)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(Array.from(fullSecret)), { mode: 0o600 })

  return { signer, path }
}

/** Convert an address to its raw 32 bytes. */
export function addressBytes(address: KeyPairSigner['address']): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(address))
}
