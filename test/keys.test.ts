import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateAgentKeypair, loadSigner } from '../src/keys.js'

describe('keys', () => {
  let dir: string
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    delete process.env.REINS_TEST_KEY
  })

  it('generates a Solana-CLI-compatible keypair and reloads it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reins-keys-'))
    const path = join(dir, 'agent.keypair.json')

    const { signer, path: written } = await generateAgentKeypair(path)
    expect(written).toContain('agent.keypair.json')
    expect(signer.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)

    const stored = JSON.parse(await readFile(path, 'utf8')) as number[]
    expect(stored).toHaveLength(64)

    const reloaded = await loadSigner({ keypairPath: path })
    expect(reloaded.address).toBe(signer.address)
  })

  it('refuses to overwrite an existing keypair', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reins-keys-'))
    const path = join(dir, 'agent.keypair.json')
    await generateAgentKeypair(path)
    await expect(generateAgentKeypair(path)).rejects.toThrow(/Refusing to overwrite/)
  })

  it('loads a key from an env var (JSON array format)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reins-keys-'))
    const path = join(dir, 'agent.keypair.json')
    const { signer } = await generateAgentKeypair(path)

    process.env.REINS_TEST_KEY = await readFile(path, 'utf8')
    const fromEnv = await loadSigner({ envVar: 'REINS_TEST_KEY' })
    expect(fromEnv.address).toBe(signer.address)
  })

  it('throws a setup hint when no key exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reins-keys-'))
    await expect(
      loadSigner({ keypairPath: join(dir, 'missing.json'), envVar: 'REINS_TEST_KEY' }),
    ).rejects.toThrow(/npx reins init/)
  })
})
