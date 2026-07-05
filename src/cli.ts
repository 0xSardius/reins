#!/usr/bin/env node
/**
 * reins CLI — manage the agent wallet from the terminal.
 *
 *   reins init                       generate the agent keypair
 *   reins address                    print the agent address
 *   reins balance [--mainnet]        SOL + USDC balances
 *   reins airdrop                    request 1 SOL from the devnet faucet
 *   reins status                     spend summary (rolling 24h + lifetime)
 *   reins history [--service S] [--limit N]
 */
import { lamports } from '@solana/kit'
import { fromAtomic, BUDGET_DECIMALS } from './amount.js'
import { DEFAULT_KEYPAIR_PATH, generateAgentKeypair, loadSigner } from './keys.js'
import { JsonlLedger } from './ledger/index.js'
import { DEFAULT_RPC_URLS, getRpc, type SolanaNetwork } from './solana.js'
import { createReinsWallet } from './wallet.js'

const LEDGER_PATH = '.reins/ledger.jsonl'

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

function network(args: string[]): SolanaNetwork {
  return args.includes('--mainnet') ? 'solana' : 'solana-devnet'
}

async function main() {
  const [, , command = 'help', ...args] = process.argv

  switch (command) {
    case 'init': {
      const { signer, path } = await generateAgentKeypair(DEFAULT_KEYPAIR_PATH)
      console.log('Agent wallet created.')
      console.log(`  address: ${signer.address}`)
      console.log(`  keypair: ${path}  (keep this out of source control)`)
      console.log('')
      console.log('Next steps:')
      console.log('  1. Fund SOL for fees:   npx reins airdrop        (devnet)')
      console.log('  2. Fund devnet USDC:    https://faucet.circle.com (choose Solana devnet)')
      console.log('  3. Check balances:      npx reins balance')
      break
    }

    case 'address': {
      const signer = await loadSigner()
      console.log(signer.address)
      break
    }

    case 'balance': {
      const net = network(args)
      const wallet = await createReinsWallet({ ledger: LEDGER_PATH })
      const { sol, usdc } = await wallet.balances(net)
      console.log(`network: ${net}`)
      console.log(`address: ${wallet.address}`)
      console.log(`SOL:     ${fromAtomic(sol, 9)}`)
      console.log(`USDC:    ${fromAtomic(usdc, 6)}`)
      break
    }

    case 'airdrop': {
      const signer = await loadSigner()
      const rpc = getRpc(DEFAULT_RPC_URLS['solana-devnet'])
      console.log(`Requesting 1 SOL airdrop for ${signer.address} on devnet...`)
      const signature = await rpc.requestAirdrop(signer.address, lamports(1_000_000_000n)).send()
      console.log(`Airdrop requested: ${signature}`)
      console.log('Run "npx reins balance" in a few seconds to confirm.')
      break
    }

    case 'status': {
      const signer = await loadSigner()
      const ledger = new JsonlLedger(LEDGER_PATH)
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000
      const [spent24h, spentTotal, count24h, records] = await Promise.all([
        ledger.totalSince({ since: dayAgo }),
        ledger.totalSince({ since: 0 }),
        ledger.countSince({ since: dayAgo }),
        ledger.history({ since: dayAgo }),
      ])
      console.log(`address:      ${signer.address}`)
      console.log(`spent (24h):  ${fromAtomic(spent24h, BUDGET_DECIMALS)} USDC over ${count24h} payments`)
      console.log(`spent (all):  ${fromAtomic(spentTotal, BUDGET_DECIMALS)} USDC`)
      const services = new Map<string, bigint>()
      for (const r of records) {
        if (r.status !== 'settled') continue
        services.set(r.service, (services.get(r.service) ?? 0n) + BigInt(r.amount))
      }
      if (services.size > 0) {
        console.log('by service (24h):')
        for (const [service, amount] of services) {
          console.log(`  ${service}  ${fromAtomic(amount, BUDGET_DECIMALS)} USDC`)
        }
      }
      break
    }

    case 'history': {
      const ledger = new JsonlLedger(LEDGER_PATH)
      const service = flag(args, 'service')
      const limit = Number(flag(args, 'limit') ?? 20)
      const records = await ledger.history(service ? { service } : {})
      for (const r of records.slice(-limit)) {
        const when = new Date(r.at).toISOString()
        const amount = fromAtomic(BigInt(r.amount), r.decimals)
        const receipt = r.receipt ? `  tx=${r.receipt}` : ''
        console.log(`${when}  ${r.status.padEnd(7)}  ${amount} USDC  ${r.protocol}  ${r.service}${receipt}`)
      }
      if (records.length === 0) console.log('No payments recorded yet.')
      break
    }

    default: {
      console.log('reins — the guardrailed wallet for Solana AI agents')
      console.log('')
      console.log('Usage:')
      console.log('  reins init                      generate the agent keypair')
      console.log('  reins address                   print the agent address')
      console.log('  reins balance [--mainnet]       SOL + USDC balances')
      console.log('  reins airdrop                   request devnet SOL')
      console.log('  reins status                    spend summary')
      console.log('  reins history [--service S] [--limit N]')
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
