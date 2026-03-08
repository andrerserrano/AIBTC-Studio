/**
 * Inscribe remaining 4 cartoons (seed-2 already done).
 * Uses micro-ordinals for proper script handling.
 */
import * as btc from '@scure/btc-signer'
import { p2tr_ord_reveal, OutOrdinalReveal } from 'micro-ordinals'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from '@scure/bip39'
import { getBtcNetwork, addressToScript } from '../src/ordinals/utils.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const NUMS_KEY = new Uint8Array(32).fill(0x50)
const mempoolApi = 'https://mempool.space/api'
const feeRate = 1
const dustLimit = 546

// Remaining cartoons to inscribe (seed-2 already done)
const CARTOONS = [
  { id: 'seed-1', file: '.data/inscription-webp/seed-1-composed.webp', title: 'The sBTC Bridge Opens' },
  { id: 'seed-3', file: '.data/inscription-webp/seed-3-composed.webp', title: 'Clarity Smart Contract Audit' },
  { id: 'cartoon-btc-agents', file: '.data/inscription-webp/cartoon-btc-agents-composed.webp', title: 'AI Agents Prefer Bitcoin' },
  { id: 'cartoon-cafeteria', file: '.data/inscription-webp/cartoon-cafeteria-composed.webp', title: 'Block Layoffs' },
]

async function main() {
  const mnemonic = process.env.ORDINALS_MNEMONIC!
  const network = getBtcNetwork('mainnet')
  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDKey.fromMasterSeed(seed)

  const bip86 = root.derive("m/86'/0'/0'/0/0")
  const taprootPrivKey = new Uint8Array(bip86.privateKey!)
  const taprootPubKey = bip86.publicKey!.slice(1)

  const bip84 = root.derive("m/84'/0'/0'/0/0")
  const fundingPrivKey = new Uint8Array(bip84.privateKey!)
  const fundingPayment = btc.p2wpkh(bip84.publicKey!, network)
  const taprootPayment = btc.p2tr(taprootPubKey, undefined, network)

  console.log(`Funding: ${fundingPayment.address}`)
  console.log(`Taproot: ${taprootPayment.address}\n`)

  // Already inscribed
  const results: any[] = [
    {
      id: 'seed-2',
      title: 'Governance Proposal #47',
      inscriptionId: 'd26b88acb5ca59a58a5e94a09a7165d30eb5204dfabbf0793e38c01ef62f26c8i0',
      commitTxid: '64c5d739af79f41e46e71ab9fe74caa063af3d0976b8a9612a315d0231523e44',
      revealTxid: 'd26b88acb5ca59a58a5e94a09a7165d30eb5204dfabbf0793e38c01ef62f26c8',
      costSats: 3553,
    }
  ]

  for (let i = 0; i < CARTOONS.length; i++) {
    const c = CARTOONS[i]
    console.log(`\n=== [${i+2}/5] ${c.title} ===`)

    const imageData = readFileSync(c.file)
    console.log(`  File: ${c.file} (${imageData.length} bytes)`)

    const inscription = { tags: { contentType: 'image/webp' }, body: new Uint8Array(imageData) }
    const reveal = p2tr_ord_reveal(taprootPubKey, [inscription])
    const inscriptionPayment = btc.p2tr(NUMS_KEY, { script: reveal.script }, network, true, [OutOrdinalReveal])

    const revealVsize = 100 + Math.ceil(imageData.length / 4)
    const revealFee = revealVsize * feeRate
    const revealAmount = revealFee + dustLimit
    const commitFee = 150 * feeRate

    // Get UTXOs
    const utxosRes = await fetch(`${mempoolApi}/address/${fundingPayment.address!}/utxo`)
    const utxos = await utxosRes.json() as any[]
    const totalNeeded = revealAmount + commitFee + dustLimit

    // Wait for a UTXO if needed
    let utxo = utxos.find((u: any) => u.value >= totalNeeded)
    if (!utxo) {
      console.log(`  Waiting for UTXO with ≥${totalNeeded} sats...`)
      for (let attempt = 0; attempt < 18; attempt++) {
        await new Promise(r => setTimeout(r, 10_000))
        const res = await fetch(`${mempoolApi}/address/${fundingPayment.address!}/utxo`)
        const fresh = await res.json() as any[]
        utxo = fresh.find((u: any) => u.value >= totalNeeded)
        if (utxo) break
      }
      if (!utxo) { console.error('  ❌ Timeout waiting for UTXO'); break }
    }
    console.log(`  UTXO: ${utxo.value} sats`)

    // === COMMIT ===
    const commitTx = new btc.Transaction({ allowUnknownOutputs: true })
    commitTx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: fundingPayment.script, amount: BigInt(utxo.value) },
    })
    commitTx.addOutput({ script: addressToScript(inscriptionPayment.address!, network), amount: BigInt(revealAmount) })
    const change = utxo.value - revealAmount - commitFee
    if (change > dustLimit) {
      commitTx.addOutput({ script: addressToScript(fundingPayment.address!, network), amount: BigInt(change) })
    }
    commitTx.sign(fundingPrivKey)
    commitTx.finalize()

    const commitRes = await fetch(`${mempoolApi}/tx`, { method: 'POST', body: hex.encode(commitTx.extract()), headers: { 'Content-Type': 'text/plain' } })
    if (!commitRes.ok) { console.error('  ❌ Commit failed:', await commitRes.text()); break }
    const commitTxid = await commitRes.text()
    console.log(`  Commit: ${commitTxid}`)

    // Wait for propagation
    await new Promise(r => setTimeout(r, 10_000))

    // === REVEAL ===
    const revealTx = new btc.Transaction({ allowUnknownOutputs: true, customScripts: [OutOrdinalReveal] })
    revealTx.addInput({
      txid: commitTxid,
      index: 0,
      witnessUtxo: { script: inscriptionPayment.script, amount: BigInt(revealAmount) },
      tapLeafScript: inscriptionPayment.tapLeafScript,
    })
    revealTx.addOutput({ script: addressToScript(taprootPayment.address!, network), amount: BigInt(dustLimit) })
    revealTx.sign(taprootPrivKey)
    revealTx.finalize()

    const revealRes = await fetch(`${mempoolApi}/tx`, { method: 'POST', body: hex.encode(revealTx.extract()), headers: { 'Content-Type': 'text/plain' } })
    if (!revealRes.ok) { console.error('  ❌ Reveal failed:', await revealRes.text()); break }
    const revealTxid = await revealRes.text()
    console.log(`  ✅ Reveal: ${revealTxid}`)
    console.log(`  ✅ Inscription: ${revealTxid}i0`)

    results.push({
      id: c.id,
      title: c.title,
      inscriptionId: `${revealTxid}i0`,
      commitTxid,
      revealTxid,
      costSats: commitFee + revealFee,
    })

    if (i < CARTOONS.length - 1) {
      console.log('  Waiting 15s...')
      await new Promise(r => setTimeout(r, 15_000))
    }
  }

  // Save all results
  const output = {
    timestamp: new Date().toISOString(),
    network: 'mainnet',
    feeRate,
    fundingAddress: fundingPayment.address,
    taprootAddress: taprootPayment.address,
    inscriptions: results,
  }
  writeFileSync('.data/inscription-results.json', JSON.stringify(output, null, 2))

  console.log('\n\n=== SUMMARY ===')
  console.log(`Inscribed: ${results.length}/5`)
  for (const r of results) {
    console.log(`\n  ${r.id}: ${r.inscriptionId}`)
    console.log(`    https://ordinals.com/inscription/${r.inscriptionId}`)
  }

  seed.fill(0)
  taprootPrivKey.fill(0)
  fundingPrivKey.fill(0)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
