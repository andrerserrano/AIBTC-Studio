/**
 * Batch inscribe all 5 launch cartoons to mainnet.
 *
 * Uses micro-ordinals + @scure/btc-signer for proper Ordinals protocol support.
 * Compresses each image to 400px WebP at quality 55 before inscribing.
 *
 * Each inscription gets its own UTXO on the taproot address,
 * making them individually transferable for marketplace sales.
 */
import * as btc from '@scure/btc-signer'
import { hex } from '@scure/base'
import { p2tr_ord_reveal, OutOrdinalReveal } from 'micro-ordinals'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { createWalletProvider } from '../src/crypto/wallet-provider.js'
import { getOrdinalConfig, getBtcNetwork, addressToScript } from '../src/ordinals/utils.js'

// Unspendable internal key (NUMS point) for script-only P2TR
const NUMS_KEY = new Uint8Array(32).fill(0x50)

const CARTOONS = [
  { id: 'seed-1', file: 'public/images/seed-1-composed.png', title: 'The sBTC Bridge Opens and the Agents Rush In' },
  { id: 'seed-2', file: 'public/images/seed-2-composed.png', title: 'Governance Proposal #47: Let the AI Vote' },
  { id: 'seed-3', file: 'public/images/seed-3-composed.png', title: 'Clarity Smart Contract Passes Its First Audit' },
  { id: 'cartoon-btc-agents', file: 'public/images/cartoon-btc-agents-composed.png', title: 'AI Agents Show Strong Preference for Bitcoin Over Fiat' },
  { id: 'cartoon-cafeteria', file: 'public/images/cartoon-cafeteria-composed.png', title: 'Block Lays Off Nearly Half Its Staff' },
]

function compressForInscription(pngPath: string, outputDir: string): string {
  const base = pngPath.split('/').pop()!.replace('.png', '')
  const webpPath = join(outputDir, `${base}.webp`)
  execSync(`convert "${pngPath}" -resize 400x -quality 55 "${webpPath}"`)
  const size = readFileSync(webpPath).length
  console.log(`  Compressed: ${pngPath} → ${size} bytes (${(size/1024).toFixed(1)}KB)`)
  return webpPath
}

async function fetchUtxos(address: string, mempoolApi: string) {
  const res = await fetch(`${mempoolApi}/address/${address}/utxo`)
  if (!res.ok) throw new Error(`UTXO fetch failed: ${res.status}`)
  return res.json() as Promise<Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }>>
}

async function fetchRawTx(txid: string, mempoolApi: string): Promise<string> {
  const res = await fetch(`${mempoolApi}/tx/${txid}/hex`)
  if (!res.ok) throw new Error(`Raw tx fetch failed: ${res.status}`)
  return res.text()
}

async function broadcastTx(rawHex: string, mempoolApi: string): Promise<string> {
  const res = await fetch(`${mempoolApi}/tx`, { method: 'POST', body: rawHex, headers: { 'Content-Type': 'text/plain' } })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Broadcast failed: ${err}`)
  }
  return res.text()
}

async function waitForTx(txid: string, mempoolApi: string, timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${mempoolApi}/tx/${txid}`)
      if (res.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 5000))
  }
  return false
}

async function waitForUtxo(address: string, mempoolApi: string, minSats: number, timeoutMs = 180_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const utxos = await fetchUtxos(address, mempoolApi)
    const suitable = utxos.find(u => u.value >= minSats)
    if (suitable) {
      console.log(`  Found UTXO: ${suitable.value} sats (txid: ${suitable.txid.slice(0, 16)}...)`)
      return
    }
    console.log(`  Waiting for UTXO with ≥${minSats} sats...`)
    await new Promise(r => setTimeout(r, 10_000))
  }
  throw new Error(`Timeout waiting for UTXO with ≥${minSats} sats`)
}

interface InscriptionResult {
  inscriptionId: string
  commitTxid: string
  revealTxid: string
  totalCostSat: number
  feeRate: number
}

async function inscribeOne(
  webpPath: string,
  feeRate: number,
  wallet: ReturnType<typeof createWalletProvider>,
  network: ReturnType<typeof getBtcNetwork>,
  mempoolApi: string,
): Promise<InscriptionResult> {
  const addresses = wallet.getAddresses()
  const imageData = readFileSync(webpPath)

  // Build inscription using micro-ordinals
  const inscription = {
    tags: { contentType: 'image/webp' },
    body: new Uint8Array(imageData),
  }
  const reveal = p2tr_ord_reveal(NUMS_KEY, [inscription])

  // Create P2TR address with inscription in script tree (using customScripts to handle binary data)
  const inscriptionPayment = btc.p2tr(NUMS_KEY, { script: reveal.script }, network, true, [OutOrdinalReveal])

  // Estimate costs
  const revealVsize = 100 + Math.ceil(imageData.length / 4)
  const revealFee = revealVsize * feeRate
  const dustLimit = 546
  const revealAmount = revealFee + dustLimit
  const commitVsize = 150
  const commitFee = commitVsize * feeRate

  // Fetch UTXOs
  const utxos = await fetchUtxos(addresses.funding, mempoolApi)
  if (utxos.length === 0) throw new Error(`No UTXOs found for ${addresses.funding}`)

  const totalNeeded = revealAmount + commitFee + dustLimit
  const utxo = utxos.find(u => u.value >= totalNeeded)
  if (!utxo) {
    throw new Error(`Insufficient funds. Need ${totalNeeded} sats, best UTXO has ${Math.max(...utxos.map(u => u.value))} sats`)
  }
  console.log(`  Using UTXO: ${utxo.txid.slice(0, 16)}... (${utxo.value} sats)`)

  // === COMMIT TX ===
  const commitTx = new btc.Transaction({ allowUnknownOutputs: true })

  commitTx.addInput({
    txid: utxo.txid,
    index: utxo.vout,
    witnessUtxo: {
      script: wallet.getFundingScript(),
      amount: BigInt(utxo.value),
    },
  })

  // Output 0: to inscription P2TR address
  commitTx.addOutput({
    script: addressToScript(inscriptionPayment.address!, network),
    amount: BigInt(revealAmount),
  })

  // Output 1: change back to funding
  const change = utxo.value - revealAmount - commitFee
  if (change > dustLimit) {
    commitTx.addOutput({
      script: addressToScript(addresses.funding, network),
      amount: BigInt(change),
    })
  }

  wallet.signTransaction(commitTx, { keyPath: 'funding' })
  commitTx.finalize()
  const commitRaw = hex.encode(commitTx.extract())
  const commitTxid = await broadcastTx(commitRaw, mempoolApi)
  console.log(`  Commit tx: ${commitTxid}`)

  // Wait for commit in mempool
  const commitSeen = await waitForTx(commitTxid, mempoolApi, 60_000)
  if (!commitSeen) console.warn('  Commit tx not seen after 60s, proceeding...')

  // === REVEAL TX ===
  const revealTx = new btc.Transaction({ allowUnknownOutputs: true, customScripts: [OutOrdinalReveal] })

  revealTx.addInput({
    txid: commitTxid,
    index: 0,
    witnessUtxo: {
      script: inscriptionPayment.script,
      amount: BigInt(revealAmount),
    },
    tapLeafScript: inscriptionPayment.tapLeafScript,
  })

  // Output: send dust to our taproot address (inscription receiver)
  revealTx.addOutput({
    script: addressToScript(addresses.taproot, network),
    amount: BigInt(dustLimit),
  })

  wallet.signTransaction(revealTx, { keyPath: 'taproot' })
  revealTx.finalize()
  const revealRaw = hex.encode(revealTx.extract())
  const revealTxid = await broadcastTx(revealRaw, mempoolApi)
  console.log(`  Reveal tx: ${revealTxid}`)

  return {
    inscriptionId: `${revealTxid}i0`,
    commitTxid,
    revealTxid,
    totalCostSat: commitFee + revealFee,
    feeRate,
  }
}

async function main() {
  console.log('=== AIBTC Media — Batch Inscription (Mainnet) ===\n')

  const wallet = createWalletProvider({ network: 'mainnet' })
  const addresses = wallet.getAddresses()
  const network = getBtcNetwork('mainnet')
  const mempoolApi = getOrdinalConfig().mempoolApi

  console.log(`Funding: ${addresses.funding}`)
  console.log(`Taproot: ${addresses.taproot}`)
  console.log(`Network: mainnet\n`)

  // Compress images
  const tmpDir = '.data/inscription-webp'
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

  console.log('--- Compressing images ---')
  const compressed: Array<{ id: string; title: string; webpPath: string; sizeBytes: number }> = []
  for (const cartoon of CARTOONS) {
    const webpPath = compressForInscription(cartoon.file, tmpDir)
    const sizeBytes = readFileSync(webpPath).length
    compressed.push({ id: cartoon.id, title: cartoon.title, webpPath, sizeBytes })
  }

  // Estimate costs
  const feeRate = 1
  let totalEstimate = 0
  console.log('\n--- Cost estimates ---')
  for (const c of compressed) {
    const cost = 150 * feeRate + (100 + Math.ceil(c.sizeBytes / 4)) * feeRate + 546
    totalEstimate += cost
    console.log(`  ${c.id}: ${c.sizeBytes} bytes → ~${cost} sats`)
  }
  console.log(`  TOTAL: ~${totalEstimate} sats`)

  // Check funding
  const balRes = await fetch(`${mempoolApi}/address/${addresses.funding}`)
  const bal = await balRes.json() as any
  const available = bal.chain_stats.funded_txo_sum - bal.chain_stats.spent_txo_sum + bal.mempool_stats.funded_txo_sum - bal.mempool_stats.spent_txo_sum
  console.log(`\nWallet: ${available} sats available`)
  if (available < totalEstimate) {
    console.error(`❌ Need ${totalEstimate} sats, have ${available}`)
    process.exit(1)
  }
  console.log(`✅ Sufficient (${available - totalEstimate} sats buffer)\n`)

  // Inscribe sequentially
  const results: Array<{ id: string; title: string; result: InscriptionResult }> = []

  for (let i = 0; i < compressed.length; i++) {
    const c = compressed[i]
    console.log(`\n=== [${i+1}/${compressed.length}] ${c.title} ===`)
    console.log(`  File: ${c.webpPath} (${c.sizeBytes} bytes)`)

    if (i > 0) {
      const needed = 150 * feeRate + (100 + Math.ceil(c.sizeBytes / 4)) * feeRate + 546 * 2
      await waitForUtxo(addresses.funding, mempoolApi, needed)
    }

    try {
      const result = await inscribeOne(c.webpPath, feeRate, wallet, network, mempoolApi)
      results.push({ id: c.id, title: c.title, result })
      console.log(`  ✅ Inscription ID: ${result.inscriptionId}`)
      console.log(`     Cost: ${result.totalCostSat} sats`)

      if (i < compressed.length - 1) {
        console.log(`  Waiting 15s for propagation...`)
        await new Promise(r => setTimeout(r, 15_000))
      }
    } catch (err) {
      console.error(`  ❌ Failed: ${err}`)
      break
    }
  }

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    network: 'mainnet',
    feeRate,
    fundingAddress: addresses.funding,
    taprootAddress: addresses.taproot,
    inscriptions: results.map(r => ({
      id: r.id,
      title: r.title,
      inscriptionId: r.result.inscriptionId,
      commitTxid: r.result.commitTxid,
      revealTxid: r.result.revealTxid,
      costSats: r.result.totalCostSat,
    })),
  }
  writeFileSync('.data/inscription-results.json', JSON.stringify(output, null, 2))

  // Summary
  console.log(`\n\n=== INSCRIPTION SUMMARY ===`)
  console.log(`Inscribed: ${results.length}/${compressed.length}`)
  console.log(`Total cost: ${results.reduce((s, r) => s + r.result.totalCostSat, 0)} sats`)
  console.log(`\nEach inscription is on its own UTXO at: ${addresses.taproot}`)
  for (const r of results) {
    console.log(`\n  ${r.id}: ${r.result.inscriptionId}`)
    console.log(`    https://ordinals.com/inscription/${r.result.inscriptionId}`)
    console.log(`    https://mempool.space/tx/${r.result.revealTxid}`)
  }

  wallet.destroy()
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
