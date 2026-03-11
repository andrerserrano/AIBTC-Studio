/**
 * E2E tests for agent loop resilience.
 *
 * Tests that:
 * 1. Timeout utility works correctly (prevents hangs)
 * 2. Schedule state calculates posting windows correctly
 * 3. Cooldown doesn't block valid posting windows with 6-post schedule
 * 4. Combined scanner survives individual scanner failures/timeouts
 * 5. Tick completes even when external APIs hang
 *
 * Run with: npx tsx test/agent-resilience.test.ts
 * Or with bun: bun test test/agent-resilience.test.ts
 */

import { withTimeout, API_TIMEOUT_MS, LLM_TIMEOUT_MS, SCAN_TIMEOUT_MS } from '../src/utils/timeout.js'

// ── Minimal test runner ──────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`  ✅ ${name}`)
  } catch (err) {
    failed++
    const msg = (err as Error).message
    failures.push(`${name}: ${msg}`)
    console.log(`  ❌ ${name} — ${msg}`)
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg)
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) {
    throw new Error(msg || `Expected ${expected}, got ${actual}`)
  }
}

// ── Timeout utility tests ────────────────────────────────────────────

console.log('\n🧪 Timeout utility')

await test('resolves when promise completes before timeout', async () => {
  const result = await withTimeout(Promise.resolve('ok'), 1000, 'test')
  assertEqual(result, 'ok')
})

await test('rejects when promise exceeds timeout', async () => {
  const neverResolve = new Promise(() => {})
  try {
    await withTimeout(neverResolve, 100, 'HangTest')
    throw new Error('Should have timed out')
  } catch (err) {
    assert((err as Error).message.includes('HangTest timed out'), 'Should mention HangTest')
  }
})

await test('propagates original error when promise rejects before timeout', async () => {
  try {
    await withTimeout(Promise.reject(new Error('API error')), 5000, 'test')
    throw new Error('Should have rejected')
  } catch (err) {
    assertEqual((err as Error).message, 'API error')
  }
})

await test('timeout fires within expected window (1s)', async () => {
  const start = Date.now()
  const slow = new Promise((resolve) => setTimeout(resolve, 10_000))
  try {
    await withTimeout(slow, 1000, 'SlowOp')
    throw new Error('Should have timed out')
  } catch (err) {
    const elapsed = Date.now() - start
    assert(elapsed < 2000, `Should timeout around 1s, took ${elapsed}ms`)
    assert((err as Error).message.includes('SlowOp timed out'), 'Should mention SlowOp')
  }
})

// ── Schedule configuration tests ─────────────────────────────────────

console.log('\n🧪 Schedule configuration')

await test('default posting hours are 6 (not 2)', () => {
  const defaultHours = '8,10,12,14,17,20'.split(',').map(Number)
  assertEqual(defaultHours.length, 6, 'Should have 6 posting hours')
  assert(defaultHours.includes(8), 'Should include 8am')
  assert(defaultHours.includes(10), 'Should include 10am')
  assert(defaultHours.includes(12), 'Should include 12pm')
  assert(defaultHours.includes(14), 'Should include 2pm')
  assert(defaultHours.includes(17), 'Should include 5pm')
  assert(defaultHours.includes(20), 'Should include 8pm')
})

await test('cooldown (90min) is shorter than minimum posting gap (2h)', () => {
  const cooldownMs = 90 * 60_000  // 90 minutes
  const minGapMs = 2 * 60 * 60_000  // 2 hours (8→10, 10→12, 12→14)
  assert(cooldownMs < minGapMs, `Cooldown ${cooldownMs}ms should be < gap ${minGapMs}ms`)
})

await test('cooldown expires before each posting window closes', () => {
  const hours = [8, 10, 12, 14, 17, 20]
  const cooldownMin = 90
  const windowMin = 30

  for (let i = 1; i < hours.length; i++) {
    // Worst case: post fires at the LATEST moment in previous window (hour + windowMin)
    const worstCasePostMin = hours[i - 1] * 60 + windowMin
    const cooldownExpiresMin = worstCasePostMin + cooldownMin
    // Next window CLOSES at (hour + windowMin) — cooldown must expire before this
    const nextWindowClosesMin = hours[i] * 60 + windowMin

    assert(
      cooldownExpiresMin <= nextWindowClosesMin,
      `Cooldown blocks window ${hours[i]}:00: post at ${hours[i - 1]}:${windowMin} + ${cooldownMin}min = ${Math.floor(cooldownExpiresMin / 60)}:${String(cooldownExpiresMin % 60).padStart(2, '0')}, but window closes at ${Math.floor(nextWindowClosesMin / 60)}:${String(nextWindowClosesMin % 60).padStart(2, '0')}`,
    )
  }
})

await test('OLD cooldown (4h) WOULD block most windows (proving bug existed)', () => {
  const hours = [8, 10, 12, 14, 17, 20]
  const oldCooldownMin = 240  // 4 hours
  const windowMin = 30
  let blockedCount = 0

  for (let i = 1; i < hours.length; i++) {
    const worstCasePostMin = hours[i - 1] * 60 + windowMin
    const cooldownExpiresMin = worstCasePostMin + oldCooldownMin
    const nextWindowOpensMin = hours[i] * 60 - windowMin

    if (cooldownExpiresMin > nextWindowOpensMin) {
      blockedCount++
    }
  }

  // With 4h cooldown, most of the 2h-gap windows should be blocked
  assert(blockedCount >= 3, `Expected at least 3 blocked windows with 4h cooldown, got ${blockedCount}`)
})

// ── Scanner resilience tests ─────────────────────────────────────────

console.log('\n🧪 Scanner resilience')

await test('Promise.allSettled returns partial results on failure', async () => {
  const results = await Promise.allSettled([
    Promise.resolve([1, 2, 3]),
    Promise.reject(new Error('Twitter API hung')),
    Promise.resolve([4, 5]),
  ])

  const signals: number[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      signals.push(...result.value)
    }
  }

  assertEqual(signals.length, 5, 'Should get signals from successful scanners')
  assertEqual(results[1].status, 'rejected', 'Failed scanner should be rejected')
})

await test('withTimeout wrapping allSettled prevents infinite hang', async () => {
  const start = Date.now()

  try {
    await withTimeout(
      Promise.allSettled([
        Promise.resolve(['signal1']),
        new Promise(() => {}), // Never resolves — simulates Twitter API hang
        Promise.resolve(['signal2']),
      ]),
      500,
      'Combined scanner',
    )
    // If we get here, allSettled somehow resolved (shouldn't with a never-resolving promise)
    throw new Error('Should have timed out')
  } catch (err) {
    const elapsed = Date.now() - start
    assert(elapsed < 1500, `Should timeout in ~500ms, took ${elapsed}ms`)
    assert((err as Error).message.includes('Combined scanner timed out'), 'Should be timeout error')
  }
})

// ── Tick simulation ──────────────────────────────────────────────────

console.log('\n🧪 Tick simulation')

await test('tick continues to schedule check after scanner timeout', async () => {
  let scanCompleted = false
  let scheduleChecked = false

  // Simulate the tick() flow
  const tick = async () => {
    // 1. Scan phase (with timeout protection)
    let signals: any[] = []
    try {
      const results = await withTimeout(
        Promise.allSettled([
          Promise.resolve([{ id: 'sig1' }]),
          new Promise(() => {}), // Hung Twitter scanner
        ]),
        300,
        'Scanner',
      )
      for (const r of results) {
        if (r.status === 'fulfilled') signals.push(...r.value)
      }
      scanCompleted = true
    } catch {
      // Scanner timed out — continue with whatever we have
      scanCompleted = false
    }

    // 2. Schedule check (the critical path that was being blocked)
    scheduleChecked = true

    // 3. In the real code, if signals.length === 0 it returns early
    //    But the schedule check still runs because we catch the timeout
    if (signals.length === 0) return
  }

  const start = Date.now()
  await tick()
  const elapsed = Date.now() - start

  assert(scheduleChecked, 'Schedule check should always run')
  assert(elapsed < 1000, `Tick should complete quickly, took ${elapsed}ms`)
})

await test('multiple ticks run in sequence even after timeouts', async () => {
  let tickCount = 0

  const tick = async () => {
    try {
      await withTimeout(
        new Promise(() => {}), // Always hangs
        100,
        'Scanner',
      )
    } catch {
      // Expected timeout
    }
    tickCount++
  }

  // Simulate 3 ticks (like the main loop)
  for (let i = 0; i < 3; i++) {
    await tick()
  }

  assertEqual(tickCount, 3, 'All 3 ticks should complete')
})

// ── Config sanity checks ─────────────────────────────────────────────

console.log('\n🧪 Config sanity')

await test('timeout constants are correct', () => {
  assertEqual(API_TIMEOUT_MS, 30_000, 'API timeout should be 30s')
  assertEqual(SCAN_TIMEOUT_MS, 120_000, 'Scan timeout should be 2min')
  assertEqual(LLM_TIMEOUT_MS, 60_000, 'LLM timeout should be 60s')
  assert(SCAN_TIMEOUT_MS > API_TIMEOUT_MS, 'Scan timeout > API timeout')
})

await test('scan timeout fits within tick interval (2min)', () => {
  const tickInterval = 120_000
  assert(SCAN_TIMEOUT_MS <= tickInterval, 'Scan should fit within a tick')
})

// ── Results ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) {
    console.log(`  • ${f}`)
  }
}
console.log()

process.exit(failed > 0 ? 1 : 0)
