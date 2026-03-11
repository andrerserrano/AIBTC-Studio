/**
 * Pipeline stage: Inscriber
 *
 * Wraps the ordinals inscription engine for use inside the AIBTC-Media pipeline.
 * Supports two inscription modes:
 *
 *   1. Content Hash (default) — inscribes a small JSON payload with the SHA-256
 *      hash of the canonical image. Cheap (~$0.50-1.00), provides on-chain
 *      provenance immediately. Full images can be batch-inscribed later.
 *
 *   2. Full Image (legacy) — inscribes a compressed WebP thumbnail of the image.
 *      More expensive but stores the actual image on-chain.
 *
 * Both modes are NON-BLOCKING — if inscription fails or fees are too high, the
 * cartoon still gets posted. Provenance is simply undefined in that case.
 *
 * Security: Uses WalletProvider for all signing operations. In TEE mode
 * (EigenCloud EigenCompute), private keys never leave the enclave.
 */
import { EventBus } from '../console/events.js'
import { inscribeImage, type InscribeImageResult } from '../ordinals/index.js'
import { inscribeContentHash, type InscribeHashResult } from '../ordinals/inscribe-hash.js'
import { getOrdinalConfig } from '../ordinals/utils.js'
import type { WalletProvider } from '../crypto/wallet-provider.js'
import type { ContentHashProvenance } from '../types.js'

export interface Provenance {
  inscriptionId: string
  commitTxid: string
  revealTxid: string
  costSat: number
  costUSD: number
  feeRate: number
  network: string
}

export class Inscriber {
  private enabled: boolean

  constructor(
    private events: EventBus,
    private walletProvider?: WalletProvider,
  ) {
    const config = getOrdinalConfig()
    this.enabled = config.inscriptionEnabled && !!walletProvider

    if (this.enabled) {
      const addresses = walletProvider!.getAddresses()
      this.events.monologue(
        `Ordinals inscriber active on ${config.network} ` +
        `(${walletProvider!.mode} mode). ` +
        `Funding: ${addresses.funding.slice(0, 12)}... ` +
        `Max fee: ${config.maxFeeRate} sat/vB, max cost: $${config.maxCostUSD}`
      )
    } else {
      this.events.monologue('Ordinals inscriber disabled (no wallet or INSCRIPTION_ENABLED=false)')
    }
  }

  /**
   * Inscribe a content hash of the composed image onto Bitcoin.
   * This is the lightweight, cost-effective provenance method.
   *
   * Returns ContentHashProvenance on success, undefined on failure/skip.
   * This method NEVER throws — inscription failure should not prevent posting.
   *
   * @param composedImagePath - Path to the canonical composed image (the one uploaded to R2)
   * @param cardId - The cartoon UUID for linking
   */
  async inscribeHash(composedImagePath: string, cardId: string): Promise<ContentHashProvenance | undefined> {
    if (!this.enabled || !this.walletProvider) return undefined

    try {
      this.events.monologue('Inscribing content hash onto Bitcoin...')

      const result = await inscribeContentHash(composedImagePath, {
        cardId,
        walletProvider: this.walletProvider,
      })

      if (!result) {
        this.events.monologue('Hash inscription skipped (fees too high, duplicate, or disabled)')
        return undefined
      }

      this.events.monologue(
        `₿ Content hash inscribed! ${result.inscriptionId.slice(0, 12)}... ` +
        `Hash: sha256:${result.contentHash.slice(0, 12)}... ` +
        `Cost: ${result.costSat} sats (~$${result.costUSD}). ` +
        `Reveal: ${result.explorerUrl}`
      )

      return result.contentHashProvenance

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.events.monologue(`Hash inscription failed (non-blocking): ${msg}`)
      console.error('[inscriber] Hash inscription error:', err)
      return undefined
    }
  }

  /**
   * Attempt to inscribe the composed cartoon image onto Bitcoin (full image).
   * Returns provenance data on success, undefined on failure/skip.
   *
   * This is the legacy full-image inscription method. Consider using
   * inscribeHash() for cost-effective provenance, and batch-inscribing
   * full images later.
   *
   * This method NEVER throws — inscription failure should not prevent posting.
   */
  async inscribe(composedImagePath: string): Promise<Provenance | undefined> {
    if (!this.enabled || !this.walletProvider) return undefined

    try {
      this.events.monologue('Inscribing cartoon onto Bitcoin...')

      const result = await inscribeImage(composedImagePath, {
        walletProvider: this.walletProvider,
      })

      if (!result) {
        this.events.monologue('Inscription skipped (fees too high, duplicate, or disabled)')
        return undefined
      }

      this.events.monologue(
        `₿ Inscribed! ${result.inscriptionId.slice(0, 12)}... ` +
        `Cost: ${result.costSat} sats (~$${result.costUSD}). ` +
        `Reveal: ${result.explorerUrl}`
      )

      return result.provenance

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.events.monologue(`Inscription failed (non-blocking): ${msg}`)
      console.error('[inscriber] Error:', err)
      return undefined
    }
  }

  /**
   * Check if inscription is currently enabled and configured.
   */
  isEnabled(): boolean {
    return this.enabled
  }
}
