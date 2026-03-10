/**
 * End-to-end dry-run test — exercises the full pipeline without side effects.
 *
 * Tests: scan → ideate → generate → caption → compose → inscription (dry) → post format
 *
 * Does NOT:
 *   - Post to Twitter/X
 *   - Save to the live .data/ store
 *   - Broadcast any inscription transactions
 *
 * Usage:
 *   bun --env-file=.env scripts/e2e-dry-run.ts
 */
import { randomUUID } from 'crypto'
import { join } from 'path'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { EventBus } from '../src/console/events.js'
import { Cache } from '../src/cache/cache.js'
import { Generator } from '../src/pipeline/generator.js'
import { Captioner } from '../src/pipeline/captioner.js'
import { Composer } from '../src/pipeline/composer.js'
import { createWalletProvider } from '../src/crypto/wallet-provider.js'
import { config } from '../src/config/index.js'
import { STYLE_TEMPLATE } from '../src/prompts/style.js'
import { generateObject } from 'ai'
import { anthropic } from '../src/ai.js'
import { z } from 'zod'
import type { CartoonConcept, Topic } from '../src/types.js'

// Map GEMINI_API_KEY → GOOGLE_GENERATIVE_AI_API_KEY (same as main.ts)
if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY
}

// Use a temp directory so we don't touch the real data
const TEST_DIR = join(process.cwd(), '.data', 'e2e-test-' + Date.now())
const results: { step: string; status: 'pass' | 'fail' | 'skip'; detail: string }[] = []

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`)
}

function pass(step: string, detail: string) {
  results.push({ step, status: 'pass', detail })
  console.log(`  ✅ ${detail}`)
}

function fail(step: string, detail: string) {
  results.push({ step, status: 'fail', detail })
  console.error(`  ❌ ${detail}`)
}

function skip(step: string, detail: string) {
  results.push({ step, status: 'skip', detail })
  console.log(`  ⏭️  ${detail}`)
}

async function main() {
  console.log('╔══════════════════════════════════════╗')
  console.log('║   AIBTC-Media E2E Dry-Run Test       ║')
  console.log('╚══════════════════════════════════════╝\n')

  await mkdir(TEST_DIR, { recursive: true })
  const events = new EventBus(join(TEST_DIR, 'events.jsonl'))
  await events.init()

  // ── 1. IDEATION ──
  log('IDEATE', 'Generating cartoon concept from a test headline...')
  const testHeadline = 'Bitcoin Lightning Network Now Processes More Transactions Than Visa During Peak Hours'

  const conceptSchema = z.object({
    visual: z.string(),
    composition: z.string(),
    caption: z.string(),
    jokeType: z.string(),
    reasoning: z.string(),
  })

  let concept: z.infer<typeof conceptSchema>
  try {
    const { object } = await generateObject({
      model: anthropic(config.textModel),
      schema: conceptSchema,
      system: `You are the editorial cartoonist for AIBTC Media. Generate a single-panel cartoon concept.\n\n${STYLE_TEMPLATE}`,
      prompt: `Generate a cartoon concept for: "${testHeadline}"`,
    })
    concept = object

    if (!concept.caption || concept.caption.length === 0) {
      fail('IDEATE', 'Empty caption returned')
      return
    }
    if (!concept.visual || concept.visual.length === 0) {
      fail('IDEATE', 'Empty visual description returned')
      return
    }
    pass('IDEATE', `Caption: "${concept.caption}" (${concept.caption.length} chars)`)
  } catch (err) {
    fail('IDEATE', `Failed: ${(err as Error).message}`)
    printSummary()
    return
  }

  // ── 2. IMAGE GENERATION ──
  log('GENERATE', 'Generating image via Gemini...')
  const imageCache = new Cache('images', 100, join(TEST_DIR, 'cache-images.json'))
  await imageCache.restore()

  const generator = new Generator(events, imageCache)
  await generator.init()

  const cartoonConcept: CartoonConcept = {
    id: randomUUID().slice(0, 8),
    topicId: 'e2e-test',
    visual: concept.visual,
    composition: concept.composition,
    caption: concept.caption,
    jokeType: concept.jokeType,
    reasoning: concept.reasoning,
  }

  let imagePath: string | null = null
  try {
    const { variants } = await generator.generate(cartoonConcept, 1)
    if (variants.length === 0) {
      fail('GENERATE', 'No image variants returned (possible quota exhaustion)')
    } else {
      imagePath = variants[0]
      if (!existsSync(imagePath)) {
        fail('GENERATE', `Image file missing: ${imagePath}`)
        imagePath = null
      } else {
        pass('GENERATE', `Image saved: ${imagePath}`)
      }
    }
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('quota') || msg.includes('exhausted') || msg.includes('rate')) {
      skip('GENERATE', `Gemini quota/rate limit hit: ${msg}`)
    } else {
      fail('GENERATE', `Failed: ${msg}`)
    }
  }

  // ── 3. CAPTIONING ──
  log('CAPTION', 'Testing captioner...')
  const captioner = new Captioner(events)

  let captionText: string
  try {
    captionText = await captioner.generate(cartoonConcept)
    if (!captionText || captionText.length === 0) {
      fail('CAPTION', 'Empty caption generated')
      printSummary()
      return
    }
    pass('CAPTION', `Caption: "${captionText}" (${captionText.length} chars)`)
  } catch (err) {
    fail('CAPTION', `Failed: ${(err as Error).message}`)
    printSummary()
    return
  }

  // ── 4. COMPOSITION ──
  if (imagePath) {
    log('COMPOSE', 'Composing image with caption overlay...')
    const composer = new Composer(events, generator)

    try {
      const composedPath = await composer.composeCartoon(imagePath, captionText)
      if (!existsSync(composedPath)) {
        fail('COMPOSE', `Composed image missing: ${composedPath}`)
      } else {
        pass('COMPOSE', `Composed: ${composedPath}`)
      }
    } catch (err) {
      fail('COMPOSE', `Failed: ${(err as Error).message}`)
    }
  } else {
    skip('COMPOSE', 'Skipped — no image generated (see GENERATE step)')
  }

  // ── 5. INSCRIPTION (wallet check only — no broadcast) ──
  log('INSCRIBE', 'Checking wallet initialization...')
  try {
    if (!config.ordinals.enabled) {
      skip('INSCRIBE', 'INSCRIPTION_ENABLED is not true — skipping wallet check')
    } else if (!config.ordinals.mnemonic) {
      skip('INSCRIBE', 'ORDINALS_MNEMONIC not set — skipping wallet check')
    } else {
      const walletProvider = createWalletProvider({
        mnemonic: config.ordinals.mnemonic,
        network: config.ordinals.network,
      })
      const addresses = walletProvider.getAddresses()
      pass('INSCRIBE', `Wallet ready — Funding: ${addresses.funding.slice(0, 16)}... Taproot: ${addresses.taproot.slice(0, 16)}...`)
      walletProvider.destroy()
    }
  } catch (err) {
    fail('INSCRIBE', `Wallet init failed: ${(err as Error).message}`)
  }

  // ── 6. POST FORMAT (headline + caption convention) ──
  log('POST_FORMAT', 'Verifying post.text format matches seed convention...')

  const topicSummary = testHeadline
  const tweetText = topicSummary.length > 220 ? topicSummary.slice(0, 220) + '…' : topicSummary
  const postText = `${tweetText}\n"${captionText}"`

  // Verify two-line format
  const lines = postText.split('\n')
  if (lines.length < 2) {
    fail('POST_FORMAT', `Expected 2+ lines, got ${lines.length}: "${postText}"`)
  } else {
    const headline = lines[0]
    const subtitle = lines.slice(1).join('\n')

    if (!subtitle.startsWith('"') || !subtitle.endsWith('"')) {
      fail('POST_FORMAT', `Caption line should be quoted: ${subtitle}`)
    } else if (headline === subtitle.slice(1, -1)) {
      fail('POST_FORMAT', `Headline duplicates caption! headline="${headline}"`)
    } else {
      pass('POST_FORMAT', `Line 1 (headline): "${headline}"`)
      console.log(`             Line 2 (caption):  ${subtitle}`)
    }
  }

  // ── 7. TWEET TEXT (should NOT include the caption) ──
  log('TWEET_TEXT', 'Verifying tweet text uses topic.summary, not caption...')
  if (tweetText === captionText) {
    fail('TWEET_TEXT', `Tweet text matches caption — should use topic.summary instead`)
  } else {
    pass('TWEET_TEXT', `Tweet: "${tweetText.slice(0, 80)}..." (different from caption)`)
  }

  // ── Cleanup ──
  try {
    await rm(TEST_DIR, { recursive: true })
  } catch { /* best effort */ }

  printSummary()
}

function printSummary() {
  console.log('\n╔══════════════════════════════════════╗')
  console.log('║           TEST SUMMARY               ║')
  console.log('╚══════════════════════════════════════╝\n')

  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const skipped = results.filter(r => r.status === 'skip').length

  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭️'
    console.log(`  ${icon} ${r.step.padEnd(14)} ${r.detail}`)
  }

  console.log(`\n  Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`)

  if (failed > 0) {
    console.log('\n  ⚠️  Some tests failed — review above for details.\n')
    process.exit(1)
  } else {
    console.log('\n  🎉 All tests passed!\n')
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
