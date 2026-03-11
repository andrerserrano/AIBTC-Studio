/**
 * Content hash inscription for lightweight on-chain provenance.
 *
 * Instead of inscribing the full image (expensive), this module inscribes a
 * small JSON payload containing the SHA-256 hash of the canonical image plus
 * metadata. This provides:
 *
 *   1. Timestamped proof that the content existed at inscription time
 *   2. A contentHash key for matching when batch-inscribing full images later
 *   3. Dramatically lower costs (~$0.50-1.00 vs $15-40 for full images)
 *
 * The inscription payload is a JSON object stored as `application/json`:
 *   {
 *     "v": 1,
 *     "type": "aibtc-content-hash",
 *     "contentHash": "sha256:<hex>",
 *     "cardId": "<cartoon-uuid>",
 *     "timestamp": "<ISO-8601>"
 *   }
 *
 * To verify: re-hash the canonical image and compare against contentHash.
 * To batch inscribe later: match full-image inscriptions to cards via contentHash.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { estimateFees } from './estimate-fees.js'
import { inscribe } from './inscribe.js'
import { isDuplicateHash, appendHashLog, type HashInscriptionLogEntry } from './logger.js'
import { getOrdinalConfig, satToUsd } from './utils.js'
import type { WalletProvider } from '../crypto/wallet-provider.js'

/** The JSON payload inscribed on-chain */
export interface ContentHashPayload {
  /** Schema version */
  v: 1
  /** Discriminator for AIBTC content hash inscriptions */
  type: 'aibtc-content-hash'
  /** SHA-256 hex digest prefixed with "sha256:" */
  contentHash: string
  /** Cartoon UUID — links back to the card in our data store */
  cardId: string
  /** ISO-8601 creation timestamp */
  timestamp: string
}

export interface InscribeHashResult {
  inscriptionId: string
  commitTxid: string
  revealTxid: string
  costSat: number
  costUSD: number
  feeRate: number
  contentHash: string
  payloadSize: number
  network: string
  explorerUrl: string
  /** Ready to embed in Cartoon.contentHashProvenance */
  contentHashProvenance: {
    contentHash: string
    inscriptionId: string
    commitTxid: string
    revealTxid: string
    costSat: number
    costUSD: number
    feeRate: number
    network: string
    inscribedAt: string
  }
}

export interface InscribeHashOptions {
  /** The cartoon/card UUID for linking */
  cardId: string
  /** Skip fee and duplicate checks */
  force?: boolean
  /** Log what would happen without inscribing */
  dryRun?: boolean
  /** WalletProvider for secure signing (required) */
  walletProvider: WalletProvider
}

/**
 * Compute SHA-256 hash of a file (the canonical, full-res image).
 * This hash becomes the permanent matching key between the lightweight
 * hash inscription and any future full-image inscription.
 */
export function hashFile(filePath: string): string {
  const data = readFileSync(filePath)
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Inscribe a content hash onto Bitcoin.
 *
 * @param canonicalImagePath - Path to the canonical (full-res, uncompressed) image.
 *   IMPORTANT: Always hash the same file. If this file is later re-encoded or
 *   resized, the hash won't match. Use the composed image straight from the
 *   Composer stage — the one uploaded to R2.
 * @param options - Configuration options
 * @returns InscribeHashResult with provenance data, or null if skipped
 */
export async function inscribeContentHash(
  canonicalImagePath: string,
  options: InscribeHashOptions,
): Promise<InscribeHashResult | null> {
  const config = getOrdinalConfig()

  if (!config.inscriptionEnabled && !options.force) {
    console.log('[ordinals:hash] Inscription disabled via INSCRIPTION_ENABLED=false')
    return null
  }

  if (!options.walletProvider) {
    console.warn('[ordinals:hash] No WalletProvider configured — skipping')
    return null
  }

  // Step 1: Hash the canonical image
  const contentHash = hashFile(canonicalImagePath)
  console.log(`[ordinals:hash] SHA-256: ${contentHash.slice(0, 16)}... (${canonicalImagePath})`)

  // Step 2: Check for duplicate hash inscription
  if (!options.force) {
    const existing = isDuplicateHash(contentHash)
    if (existing) {
      console.log(`[ordinals:hash] Already inscribed: ${existing.inscriptionId}`)
      return null
    }
  }

  // Step 3: Build the JSON payload
  const payload: ContentHashPayload = {
    v: 1,
    type: 'aibtc-content-hash',
    contentHash: `sha256:${contentHash}`,
    cardId: options.cardId,
    timestamp: new Date().toISOString(),
  }
  const payloadJson = JSON.stringify(payload)
  const payloadBytes = Buffer.from(payloadJson, 'utf-8')
  console.log(`[ordinals:hash] Payload: ${payloadBytes.length} bytes`)

  // Step 4: Check fees
  const feeEstimate = await estimateFees(payloadBytes.length)
  console.log(`[ordinals:hash] Fee estimate: ${feeEstimate.estimatedFee} sats (~$${feeEstimate.estimatedUSD}) at ${feeEstimate.feeRate} sat/vB`)

  if (!feeEstimate.withinBudget && !options.force) {
    console.log(`[ordinals:hash] Fees too high (${feeEstimate.feeRate} sat/vB > max ${config.maxFeeRate}, or $${feeEstimate.estimatedUSD} > max $${config.maxCostUSD})`)
    return null
  }

  if (options.dryRun) {
    console.log(`[ordinals:hash] DRY RUN — would inscribe ${payloadBytes.length} bytes at ${feeEstimate.feeRate} sat/vB`)
    return null
  }

  // Step 5: Write payload to temp file for the inscription engine
  const tmpDir = join(config.dataDir, 'tmp')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  const tmpPath = join(tmpDir, `hash-${contentHash.slice(0, 12)}.json`)
  writeFileSync(tmpPath, payloadJson)

  // Step 6: Inscribe (commit + reveal)
  console.log(`[ordinals:hash] Inscribing content hash on ${config.network}...`)
  const result = await inscribe({
    filePath: tmpPath,
    contentType: 'application/json',
    feeRate: feeEstimate.feeRate,
    network: config.network,
    walletProvider: options.walletProvider,
  })

  const costUSD = Number(satToUsd(result.totalCostSat).toFixed(2))
  const explorer = config.network === 'testnet'
    ? 'https://mempool.space/testnet4'
    : 'https://mempool.space'

  // Step 7: Log the inscription
  const inscribedAt = new Date().toISOString()
  const logEntry: HashInscriptionLogEntry = {
    contentHash,
    cardId: options.cardId,
    inscriptionId: result.inscriptionId,
    commitTxid: result.commitTxid,
    revealTxid: result.revealTxid,
    costSat: result.totalCostSat,
    costUSD,
    feeRate: result.feeRate,
    payloadSize: payloadBytes.length,
    network: config.network,
    timestamp: inscribedAt,
    canonicalImagePath,
  }
  appendHashLog(logEntry)

  // Clean up temp file
  try { unlinkSync(tmpPath) } catch {}

  console.log(`[ordinals:hash] ✓ Hash inscribed: ${result.inscriptionId}`)
  console.log(`[ordinals:hash]   Content hash: sha256:${contentHash.slice(0, 16)}...`)
  console.log(`[ordinals:hash]   Cost: ${result.totalCostSat} sats (~$${costUSD})`)
  console.log(`[ordinals:hash]   Reveal: ${explorer}/tx/${result.revealTxid}`)

  const contentHashProvenance = {
    contentHash,
    inscriptionId: result.inscriptionId,
    commitTxid: result.commitTxid,
    revealTxid: result.revealTxid,
    costSat: result.totalCostSat,
    costUSD,
    feeRate: result.feeRate,
    network: config.network,
    inscribedAt,
  }

  return {
    inscriptionId: result.inscriptionId,
    commitTxid: result.commitTxid,
    revealTxid: result.revealTxid,
    costSat: result.totalCostSat,
    costUSD,
    feeRate: result.feeRate,
    contentHash,
    payloadSize: payloadBytes.length,
    network: config.network,
    explorerUrl: `${explorer}/tx/${result.revealTxid}`,
    contentHashProvenance,
  }
}
