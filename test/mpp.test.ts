import { address } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { Credential } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import { MemoryLedger } from '../src/ledger/index.js'
import { solanaCharge, solanaChargeServer } from '../src/mpp/index.js'
import type { SolanaChargePayload } from '../src/mpp/method.js'
import { PolicyEngine, type PolicyConfig } from '../src/policy/index.js'
import { USDC_MINT_DEVNET } from '../src/types.js'

const RECIPIENT = 'J7rTnaHGYWPBB4rZzGmM1FSFfDDBQ8AhkA7Cx9EBpAdW'
const fakeSigner = { address: 'AgentAddr111111111111111111111111111111111' } as never

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chal-abc123',
    realm: 'api.example.com',
    method: 'solana' as const,
    intent: 'charge' as const,
    request: {
      amount: '10000',
      currency: USDC_MINT_DEVNET,
      recipient: RECIPIENT,
      network: 'solana-devnet',
    },
    ...overrides,
  }
}

function clientSetup(policyConfig: PolicyConfig = {}) {
  const ledger = new MemoryLedger()
  const settle = vi.fn(async () => 'FakeSignature111')
  const method = solanaCharge({
    signer: fakeSigner,
    policy: new PolicyEngine(policyConfig, ledger),
    ledger,
    settle,
  })
  return { method, ledger, settle }
}

describe('solanaCharge (MPP client)', () => {
  it('pays an allowed challenge and returns a bound credential', async () => {
    const { method, ledger, settle } = clientSetup()
    const serialized = await method.createCredential({ challenge: challenge() as never })

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        memo: 'chal-abc123',
        intent: expect.objectContaining({ amount: 10000n, protocol: 'mpp' }),
      }),
    )

    const credential = Credential.deserialize<SolanaChargePayload>(serialized)
    expect(credential.payload).toEqual({ signature: 'FakeSignature111', type: 'transaction' })
    expect(credential.challenge.id).toBe('chal-abc123')

    const history = await ledger.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      status: 'settled',
      receipt: 'FakeSignature111',
      protocol: 'mpp',
      service: 'https://api.example.com',
    })
  })

  it('denies out-of-policy challenges before any transfer', async () => {
    const { method, ledger, settle } = clientSetup({ defaults: { maxPerPayment: '0.001' } })
    await expect(
      method.createCredential({ challenge: challenge() as never }),
    ).rejects.toMatchObject({ name: 'PolicyViolationError', rule: 'max-per-payment' })
    expect(settle).not.toHaveBeenCalled()
    expect(await ledger.history()).toHaveLength(0)
  })

  it('rejects unknown networks', async () => {
    const { method } = clientSetup()
    const bad = challenge({
      request: {
        amount: '10000',
        currency: USDC_MINT_DEVNET,
        recipient: RECIPIENT,
        network: 'solana-testnet',
      },
    })
    await expect(method.createCredential({ challenge: bad as never })).rejects.toThrow(
      /Unsupported Solana network/,
    )
  })

  it('records a failed payment when settlement throws', async () => {
    const ledger = new MemoryLedger()
    const method = solanaCharge({
      signer: fakeSigner,
      policy: new PolicyEngine({}, ledger),
      ledger,
      settle: async () => {
        throw new Error('blockhash expired')
      },
    })
    await expect(method.createCredential({ challenge: challenge() as never })).rejects.toThrow(
      /MPP payment .* failed/,
    )
    const history = await ledger.history()
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('failed')
  })
})

describe('solanaChargeServer (MPP server)', () => {
  async function recipientAta(): Promise<string> {
    const [ata] = await findAssociatedTokenPda({
      mint: address(USDC_MINT_DEVNET),
      owner: address(RECIPIENT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    return ata
  }

  async function goodTx(memo = 'chal-abc123', amount = '10000') {
    return {
      err: null,
      instructions: [
        {
          program: 'spl-token',
          parsed: {
            type: 'transferChecked',
            info: {
              mint: USDC_MINT_DEVNET,
              destination: await recipientAta(),
              tokenAmount: { amount },
            },
          },
        },
        { program: 'spl-memo', parsed: memo },
      ],
    }
  }

  function server(tx: Awaited<ReturnType<typeof goodTx>> | null) {
    return solanaChargeServer({
      currency: USDC_MINT_DEVNET,
      recipient: RECIPIENT,
      getTransaction: async () => tx,
    })
  }

  function credential(signature = 'Sig111') {
    return {
      challenge: challenge(),
      payload: { signature, type: 'transaction' as const },
    }
  }

  it('normalizes human amounts to atomic in the request hook', async () => {
    const method = server(null)
    const normalized = await method.request!({
      request: {
        amount: '0.01',
        currency: USDC_MINT_DEVNET,
        recipient: RECIPIENT,
        network: 'solana-devnet',
      },
    } as never)
    expect((normalized as { amount: string }).amount).toBe('10000')
  })

  it('verifies a confirmed, memo-bound transfer and issues a receipt', async () => {
    const method = server(await goodTx())
    const receipt = await method.verify({
      credential: credential() as never,
      request: challenge().request as never,
    })
    expect(receipt).toMatchObject({ method: 'solana', status: 'success', reference: 'Sig111' })
  })

  it('rejects a transfer below the required amount', async () => {
    const method = server(await goodTx('chal-abc123', '9999'))
    await expect(
      method.verify({ credential: credential() as never, request: challenge().request as never }),
    ).rejects.toThrow(/does not transfer/)
  })

  it('rejects a transfer without the challenge memo', async () => {
    const method = server(await goodTx('some-other-challenge'))
    await expect(
      method.verify({ credential: credential() as never, request: challenge().request as never }),
    ).rejects.toThrow(/memo missing/)
  })

  it('rejects missing transactions and replays', async () => {
    const missing = server(null)
    await expect(
      missing.verify({ credential: credential() as never, request: challenge().request as never }),
    ).rejects.toThrow(/not found/)

    const replayed = server(await goodTx())
    await replayed.verify({
      credential: credential() as never,
      request: challenge().request as never,
    })
    await expect(
      replayed.verify({ credential: credential() as never, request: challenge().request as never }),
    ).rejects.toThrow(/replay/)
  })
})
