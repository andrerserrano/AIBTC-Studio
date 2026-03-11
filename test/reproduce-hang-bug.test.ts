/**
 * REPRODUCER TEST: Agent hang bug (2026-03-11)
 *
 * Root cause: Twitter API v2 search call hangs forever → Promise.allSettled
 * waits forever → tick() never completes → 8am scheduled post never fires.
 *
 * This test file:
 *   1. Simulates the ORIGINAL code (no timeouts) and proves it HANGS
 *   2. Simulates the FIXED code (with timeouts) and proves it RECOVERS
 *   3. Tests the full tick → scan → schedule pipeline with a hung API
 *
 * Run: npx tsx test/reproduce-hang-bug.test.ts
 */

import { strict as assert } from 'node:assert'

// ─── Test harness ───────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const errors: string[] = []

async function test(name: string, fn: () => Promise<void>, timeoutMs = 10_000) {
  const timer = setTimeout(() => {
    // If we hit this, the test itself hung — which is the bug!
    console.log(`  ✗ HUNG: ${name} (exceeded ${timeoutMs}ms — THIS IS THE BUG)`)
    failed++
    errors.push(`HUNG: ${name}`)
  }, timeoutMs)

  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Test timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ])
    clearTimeout(timer)
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    clearTimeout(timer)
    const msg = (err as Error).message
    if (msg.includes('timed out')) {
      console.log(`  ✗ HUNG: ${name} — ${msg}`)
    } else {
      console.log(`  ✗ FAIL: ${name} — ${msg}`)
    }
    failed++
    errors.push(`${name}: ${msg}`)
  }
}

// ─── Mock: Twitter API that hangs forever (simulates the 7:59 AM incident) ──

function createHangingTwitterSearch(): { search: () => Promise<{ tweets: any[] }> } {
  return {
    search: () => new Promise(() => {
      // Intentionally NEVER resolves or rejects.
      // This is exactly what happened at 7:59:42 AM — the Twitter v2 API
      // just stopped responding, and the promise sat there forever.
    }),
  }
}

function createSlowTwitterSearch(delayMs: number): { search: () => Promise<{ tweets: any[] }> } {
  return {
    search: () => new Promise((resolve) => {
      setTimeout(() => resolve({ tweets: [] }), delayMs)
    }),
  }
}

function createWorkingScanner(): { scan: () => Promise<any[]> } {
  return {
    scan: () => Promise.resolve([{ id: 'test-signal', source: 'test', content: 'test' }]),
  }
}

function createHangingScanner(): { scan: () => Promise<any[]> } {
  return {
    scan: () => new Promise(() => {/* never resolves */}),
  }
}

// ─── Import the actual timeout utility ──────────────────────────────────────

import { withTimeout, API_TIMEOUT_MS, SCAN_TIMEOUT_MS } from '../src/utils/timeout.js'

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 1: Prove the bug exists (ORIGINAL code behavior without timeouts)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ Part 1: Reproducing the original bug (no timeouts) ═══\n')

await test(
  'BUG REPRO: Promise.allSettled with a hanging scanner NEVER resolves',
  async () => {
    // This is the ORIGINAL combined scanner pattern from main.ts — no withTimeout.
    // If any scanner returns a promise that never resolves, allSettled waits FOREVER.
    const hangingScanner = createHangingScanner()
    const workingScanner = createWorkingScanner()

    // Race the original pattern against a 2-second deadline
    const result = await Promise.race([
      // ORIGINAL CODE (no timeout wrapper):
      Promise.allSettled([
        workingScanner.scan(),
        workingScanner.scan(),
        hangingScanner.scan(), // Twitter scanner — hangs forever
      ]),
      // Timeout detector
      new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), 2000)),
    ])

    // The original code HANGS — allSettled never returns because one promise never settles
    assert.equal(result, 'HUNG', 'Expected the original code to hang, but it resolved')
  },
)

await test(
  'BUG REPRO: Twitter search with no timeout causes fetchTweets to hang',
  async () => {
    const hangingApi = createHangingTwitterSearch()

    // Simulate the original fetchTweets() loop without timeout:
    //   for (const query of queries) {
    //     const searchResult = await this.readProvider.search(query, 'Top')  ← HANGS
    //   }
    const result = await Promise.race([
      hangingApi.search(), // No timeout, hangs forever
      new Promise<'HUNG'>((resolve) => setTimeout(() => resolve('HUNG'), 2000)),
    ])

    assert.equal(result, 'HUNG', 'Expected the API call to hang, but it resolved')
  },
)

await test(
  'BUG REPRO: Hanging scan blocks tick() from reaching schedule check',
  async () => {
    // Simulates the full tick() flow. The scan phase hangs, so the schedule
    // check (which would trigger the 8am post) is NEVER reached.
    let scanPhaseCompleted = false
    let scheduleCheckReached = false

    // Simulated tick() with ORIGINAL code (no timeouts)
    const tick = async () => {
      // Phase 1: Scan (this is where it hangs)
      const hangingScanner = createHangingScanner()
      await Promise.allSettled([hangingScanner.scan()]) // HANGS HERE
      scanPhaseCompleted = true

      // Phase 2: Schedule check (NEVER REACHED)
      scheduleCheckReached = true
    }

    await Promise.race([
      tick(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ])

    assert.equal(scanPhaseCompleted, false, 'Scan phase should NOT have completed')
    assert.equal(scheduleCheckReached, false, 'Schedule check should NOT have been reached')
  },
)

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 2: Prove the fix works (WITH timeouts)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ Part 2: Verifying the fix (with timeouts) ═══\n')

await test(
  'FIX: withTimeout rejects a hanging promise within the deadline',
  async () => {
    const hangingPromise = new Promise<string>(() => {/* never resolves */})
    const start = Date.now()

    try {
      await withTimeout(hangingPromise, 500, 'Test operation')
      assert.fail('Should have thrown a timeout error')
    } catch (err) {
      const elapsed = Date.now() - start
      assert.ok(elapsed >= 450 && elapsed < 1000, `Timeout fired in ${elapsed}ms, expected ~500ms`)
      assert.ok((err as Error).message.includes('timed out'), `Error message: ${(err as Error).message}`)
      assert.ok((err as Error).message.includes('Test operation'), 'Should include the label')
    }
  },
)

await test(
  'FIX: withTimeout passes through a fast-resolving promise unchanged',
  async () => {
    const fastPromise = Promise.resolve('hello')
    const result = await withTimeout(fastPromise, 5000, 'Fast op')
    assert.equal(result, 'hello')
  },
)

await test(
  'FIX: withTimeout passes through rejections unchanged',
  async () => {
    const failingPromise = Promise.reject(new Error('API error'))

    try {
      await withTimeout(failingPromise, 5000, 'Failing op')
      assert.fail('Should have thrown')
    } catch (err) {
      assert.equal((err as Error).message, 'API error')
    }
  },
)

await test(
  'FIX: Combined scanner with timeout recovers when Twitter hangs',
  async () => {
    // This is the FIXED combined scanner from main.ts — wraps allSettled with withTimeout
    const hangingScanner = createHangingScanner()
    const workingScanner = createWorkingScanner()

    const FAST_TIMEOUT = 1000 // Use shorter timeout for testing

    const results = await withTimeout(
      Promise.allSettled([
        workingScanner.scan(),
        workingScanner.scan(),
        hangingScanner.scan(), // Still hangs, but timeout catches it
      ]),
      FAST_TIMEOUT,
      'Combined scanner',
    ).catch((err) => {
      // Timeout fires — the combined scanner returns what it can
      return 'TIMEOUT_CAUGHT' as const
    })

    // The fix catches the timeout, allowing the agent to continue
    assert.equal(results, 'TIMEOUT_CAUGHT', 'Timeout should have been caught')
  },
)

await test(
  'FIX: Individual API timeout prevents a single query from blocking fetchTweets',
  async () => {
    const hangingApi = createHangingTwitterSearch()

    const FAST_API_TIMEOUT = 500

    // FIXED fetchTweets wraps each API call with withTimeout
    try {
      await withTimeout(
        hangingApi.search(),
        FAST_API_TIMEOUT,
        'Twitter search "Bitcoin AI agents"',
      )
      assert.fail('Should have timed out')
    } catch (err) {
      assert.ok((err as Error).message.includes('timed out'))
      assert.ok((err as Error).message.includes('Twitter search'))
    }
  },
)

await test(
  'FIX: tick() reaches schedule check even when Twitter API hangs',
  async () => {
    let scanPhaseCompleted = false
    let scheduleCheckReached = false

    const FAST_TIMEOUT = 500

    // Simulated tick() with FIXED code (with timeouts)
    const tick = async () => {
      // Phase 1: Scan (with timeout — recovers from hang)
      const hangingScanner = createHangingScanner()
      const workingScanner = createWorkingScanner()

      try {
        await withTimeout(
          Promise.allSettled([
            workingScanner.scan(),
            hangingScanner.scan(), // Hangs, but timeout catches it
          ]),
          FAST_TIMEOUT,
          'Combined scanner',
        )
        scanPhaseCompleted = true
      } catch {
        // Timeout fired — scan phase "failed" but tick continues
        scanPhaseCompleted = true // We got past the scan
      }

      // Phase 2: Schedule check — NOW REACHABLE!
      scheduleCheckReached = true
    }

    await tick()

    assert.equal(scanPhaseCompleted, true, 'Scan phase should have completed (via timeout)')
    assert.equal(scheduleCheckReached, true, 'Schedule check should have been reached!')
  },
)

// ═══════════════════════════════════════════════════════════════════════════════
//  PART 3: Full pipeline simulation — tick with multiple scanners
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══ Part 3: Full pipeline simulation ═══\n')

await test(
  'PIPELINE: Only healthy scanners contribute signals when one hangs',
  async () => {
    const FAST_TIMEOUT = 1000
    const signals: any[] = []

    // Simulate the fixed combined scanner with mixed health
    const scanners = [
      createWorkingScanner(),    // AIBTC — works
      createWorkingScanner(),    // BTC Mag — works
      createHangingScanner(),    // Twitter — hangs
    ]

    // The fix: wrap with timeout, then collect results from settled promises
    // Since allSettled itself hangs (one promise never settles), the outer
    // timeout catches it. But we want the better fix — individual timeouts.
    for (const scanner of scanners) {
      try {
        const result = await withTimeout(scanner.scan(), FAST_TIMEOUT, 'Scanner')
        signals.push(...result)
      } catch {
        // Individual scanner timed out — continue with others
      }
    }

    // Working scanners contributed their signals
    assert.ok(signals.length >= 2, `Expected >= 2 signals, got ${signals.length}`)
  },
)

await test(
  'PIPELINE: Slow (but not hanging) API calls succeed within timeout',
  async () => {
    const slowApi = createSlowTwitterSearch(200) // 200ms response

    // With a 2s timeout, the slow API should succeed
    const result = await withTimeout(
      slowApi.search(),
      2000,
      'Slow Twitter search',
    )

    assert.ok(result.tweets !== undefined, 'Should have received tweet results')
    assert.equal(result.tweets.length, 0, 'Empty results from mock')
  },
)

await test(
  'PIPELINE: Extremely slow API call gets timed out correctly',
  async () => {
    const verySlowApi = createSlowTwitterSearch(5000) // 5 second response

    const start = Date.now()
    try {
      await withTimeout(verySlowApi.search(), 500, 'Very slow search')
      assert.fail('Should have timed out')
    } catch (err) {
      const elapsed = Date.now() - start
      assert.ok(elapsed < 1000, `Timeout should fire in ~500ms, took ${elapsed}ms`)
      assert.ok((err as Error).message.includes('timed out'))
    }
  },
)

await test(
  'PIPELINE: Multiple sequential queries — one hang does not block the rest',
  async () => {
    // Simulates fetchTweets() iterating over search queries where query #2 hangs
    const queries = [
      { query: 'Bitcoin AI agents', api: createSlowTwitterSearch(100) },
      { query: 'BTC AI', api: createHangingTwitterSearch() },     // HANGS
      { query: 'agent economy', api: createSlowTwitterSearch(100) },
    ]

    const FAST_TIMEOUT = 500
    const results: Array<{ query: string; status: 'ok' | 'timeout' }> = []

    for (const { query, api } of queries) {
      try {
        await withTimeout(api.search(), FAST_TIMEOUT, `Search "${query}"`)
        results.push({ query, status: 'ok' })
      } catch {
        results.push({ query, status: 'timeout' })
      }
    }

    // Query 1 and 3 succeed, query 2 times out
    assert.equal(results.length, 3, 'All queries should have been attempted')
    assert.equal(results[0].status, 'ok', 'Query 1 should succeed')
    assert.equal(results[1].status, 'timeout', 'Query 2 should timeout')
    assert.equal(results[2].status, 'ok', 'Query 3 should succeed')
  },
  5000,
)

await test(
  'CONFIG: Schedule cooldown (90min) allows 6 posts per day',
  async () => {
    // With posting hours [8,10,12,14,17,20] and 90min cooldown:
    // Post at 8:00 → cooldown until 9:30 → window 10:00±30 starts at 9:30 ✓
    // Post at 10:00 → cooldown until 11:30 → window 12:00±30 starts at 11:30 ✓
    // etc.
    const postingHours = [8, 10, 12, 14, 17, 20]
    const cooldownMin = 90
    const windowMin = 30

    for (let i = 0; i < postingHours.length - 1; i++) {
      const postHour = postingHours[i]
      const nextHour = postingHours[i + 1]

      // Worst case: post at end of window (hour + windowMin)
      const worstCasePostMin = postHour * 60 + windowMin
      const cooldownExpiresMin = worstCasePostMin + cooldownMin
      const nextWindowClosesMin = nextHour * 60 + windowMin

      assert.ok(
        cooldownExpiresMin <= nextWindowClosesMin,
        `Cooldown from ${postHour}:${windowMin} (expires ${Math.floor(cooldownExpiresMin / 60)}:${cooldownExpiresMin % 60}) ` +
        `blocks next window ${nextHour}:00±${windowMin} (closes ${Math.floor(nextWindowClosesMin / 60)}:${nextWindowClosesMin % 60})`
      )
    }
  },
)

await test(
  'CONFIG: Old 4h cooldown would block 3+ posting windows (proving the bug)',
  async () => {
    const postingHours = [8, 10, 12, 14, 17, 20]
    const oldCooldownMin = 4 * 60 // 4 hours = 240 min
    const windowMin = 30
    let blocked = 0

    for (let i = 0; i < postingHours.length - 1; i++) {
      const postMin = postingHours[i] * 60
      const cooldownExpiresMin = postMin + oldCooldownMin
      const nextWindowOpensMin = postingHours[i + 1] * 60 - windowMin

      if (cooldownExpiresMin > nextWindowOpensMin) {
        blocked++
      }
    }

    assert.ok(blocked >= 3, `Old 4h cooldown blocks ${blocked} windows (expected >= 3)`)
  },
)

// ═══════════════════════════════════════════════════════════════════════════════
//  Results
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`)
if (errors.length > 0) {
  console.log(`\nFailures:`)
  for (const err of errors) console.log(`  • ${err}`)
}
console.log(`${'═'.repeat(60)}\n`)

process.exit(failed > 0 ? 1 : 0)
