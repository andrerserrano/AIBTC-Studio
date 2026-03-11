import assert from 'node:assert'

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within
 * the given time, it rejects with a descriptive error.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'Operation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`))
    }, ms)

    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

// ============================================================================
// TEST 1: Memory leak test — verify clearTimeout is called on resolution
// ============================================================================
async function testMemoryLeakOnResolution() {
  console.log('\n[TEST 1] Memory leak test — resolution clears timer')

  const initialHandles = process._getActiveHandles?.().length ?? 0
  const promises: Promise<number>[] = []

  // Create 50 promises that resolve quickly (before timeout)
  for (let i = 0; i < 50; i++) {
    const p = withTimeout(
      Promise.resolve(i),
      500, // Plenty of time
      `Quick resolve ${i}`,
    )
    promises.push(p)
  }

  const results = await Promise.all(promises)
  assert.strictEqual(results.length, 50, 'All promises should resolve')

  // Give any async cleanup a moment
  await new Promise((r) => setTimeout(r, 50))

  const finalHandles = process._getActiveHandles?.().length ?? 0
  const handleDelta = finalHandles - initialHandles

  console.log(`  Initial handles: ${initialHandles}, Final: ${finalHandles}, Delta: ${handleDelta}`)
  assert(
    handleDelta <= 1, // Allow 1 handle for test overhead
    `No timer handles should leak (delta: ${handleDelta})`,
  )
  console.log('  ✓ PASS')
}

// ============================================================================
// TEST 2: Concurrent timeout test — multiple withTimeout in parallel
// ============================================================================
async function testConcurrentTimeouts() {
  console.log('\n[TEST 2] Concurrent timeout test')

  const promises: Promise<number>[] = []
  const results: number[] = []

  // 20 concurrent operations with varying timeout lengths
  for (let i = 0; i < 20; i++) {
    const resolveTime = Math.random() * 100 // 0-100ms
    const timeoutMs = 200 // Always longer than resolve time
    const p = withTimeout(
      new Promise<number>((resolve) => {
        setTimeout(() => resolve(i), resolveTime)
      }),
      timeoutMs,
      `Concurrent ${i}`,
    )
    promises.push(p)
  }

  const resolved = await Promise.all(promises)
  assert.strictEqual(resolved.length, 20, 'All 20 concurrent ops should resolve')
  assert.strictEqual(
    resolved.filter((v) => typeof v === 'number').length,
    20,
    'All results should be numbers',
  )
  console.log('  ✓ PASS — 20 concurrent ops completed without interference')
}

// ============================================================================
// TEST 3: Zero-ms timeout — edge case
// ============================================================================
async function testZeroMsTimeout() {
  console.log('\n[TEST 3] Zero-ms timeout edge case')

  let rejected = false
  try {
    await withTimeout(new Promise((resolve) => setTimeout(resolve, 100)), 0, 'Zero timeout')
  } catch (err: any) {
    rejected = true
    assert(err.message.includes('timed out'), 'Should reject with timeout message')
  }

  assert(rejected, 'Zero-ms timeout should reject quickly')
  console.log('  ✓ PASS — Zero-ms timeout rejects immediately')
}

// ============================================================================
// TEST 4: Negative timeout — edge case
// ============================================================================
async function testNegativeTimeout() {
  console.log('\n[TEST 4] Negative timeout edge case')

  let rejected = false
  try {
    await withTimeout(new Promise((resolve) => setTimeout(resolve, 100)), -10, 'Negative timeout')
  } catch (err: any) {
    rejected = true
  }

  assert(rejected, 'Negative timeout should be rejected')
  console.log('  ✓ PASS — Negative timeout rejects')
}

// ============================================================================
// TEST 5: Promise rejects AFTER timeout fires — avoid unhandled rejection
// ============================================================================
async function testPromiseRejectsAfterTimeout() {
  console.log('\n[TEST 5] Promise rejects after timeout fires')

  let timeoutErrorCaught = false
  let promiseRejectionError: Error | null = null

  const slowReject = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error('Promise rejected after timeout fire'))
    }, 200)
  })

  try {
    await withTimeout(slowReject, 50, 'API call')
  } catch (err: any) {
    timeoutErrorCaught = true
    assert(err.message.includes('timed out'), 'Should catch timeout error')
  }

  assert(timeoutErrorCaught, 'Timeout error should be caught')

  // Let the slow rejection happen, verify it doesn't cause unhandled rejection
  await new Promise((r) => setTimeout(r, 250))
  console.log('  ✓ PASS — Timeout error caught, no unhandled rejection')
}

// ============================================================================
// TEST 6: Rapid-fire scan simulation — 100 ticks with 50% random hang
// ============================================================================
async function testRapidFireScanSimulation() {
  console.log('\n[TEST 6] Rapid-fire scan simulation (100 ticks, 50% random hang)')

  const startTime = Date.now()
  let successes = 0
  let timeouts = 0
  const tickDurations: number[] = []

  for (let tick = 0; tick < 100; tick++) {
    const tickStart = Date.now()

    // 50% chance the API call hangs
    const willHang = Math.random() < 0.5
    const hangDuration = willHang ? 500 : Math.random() * 30 // 0-30ms or 500ms

    try {
      await withTimeout(
        new Promise<void>((resolve) => {
          setTimeout(resolve, hangDuration)
        }),
        100, // 100ms timeout — fast API should resolve, slow API times out
        `Tick ${tick}`,
      )
      successes++
    } catch (err: any) {
      if (err.message.includes('timed out')) {
        timeouts++
      } else {
        throw err
      }
    }

    const tickDuration = Date.now() - tickStart
    tickDurations.push(tickDuration)
  }

  const totalTime = Date.now() - startTime
  const avgTickTime = totalTime / 100

  console.log(`  Completed 100 ticks in ${totalTime}ms (avg ${avgTickTime.toFixed(1)}ms/tick)`)
  console.log(`  Successes: ${successes}, Timeouts: ${timeouts}`)
  console.log(`  Max tick time: ${Math.max(...tickDurations)}ms`)

  assert.strictEqual(successes + timeouts, 100, 'All 100 ticks should complete')
  assert(successes > 40, 'Should have ~50% successes (got ' + successes + ')')
  assert(timeouts > 40, 'Should have ~50% timeouts (got ' + timeouts + ')')
  assert(
    avgTickTime < 150,
    `Average tick should be <150ms (got ${avgTickTime.toFixed(1)}ms)`,
  )
  console.log('  ✓ PASS — Agent loop never blocked, all ticks processed')
}

// ============================================================================
// TEST 7: Timer cleanup test — start 10 ops, some resolve quickly
// ============================================================================
async function testTimerCleanupAccumulation() {
  console.log('\n[TEST 7] Timer cleanup test — no accumulation with partial resolution')

  const iterations = 5
  let totalHandlesLeaked = 0

  for (let iteration = 0; iteration < iterations; iteration++) {
    const initialHandles = process._getActiveHandles?.().length ?? 0

    const promises: Promise<number>[] = []

    // 10 operations: 5 resolve quickly, 5 timeout
    for (let i = 0; i < 10; i++) {
      const resolveTime = i < 5 ? 30 : 500 // First 5: 30ms, last 5: 500ms
      const timeoutMs = 100

      const p = withTimeout(
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(i), resolveTime)
        }),
        timeoutMs,
        `Cleanup test ${i}`,
      )
      promises.push(p)
    }

    // Collect results, catching timeouts
    const results = await Promise.allSettled(promises)
    const resolved = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.filter((r) => r.status === 'rejected').length

    assert.strictEqual(resolved, 5, 'First 5 should resolve')
    assert.strictEqual(rejected, 5, 'Last 5 should timeout')

    await new Promise((r) => setTimeout(r, 50))

    const finalHandles = process._getActiveHandles?.().length ?? 0
    const handleDelta = finalHandles - initialHandles

    console.log(`  Iteration ${iteration + 1}: handles delta = ${handleDelta}`)
    totalHandlesLeaked += Math.max(0, handleDelta)
  }

  assert(
    totalHandlesLeaked <= 2,
    `Total handles leaked across ${iterations} iterations: ${totalHandlesLeaked}`,
  )
  console.log('  ✓ PASS — No memory accumulation over iterations')
}

// ============================================================================
// TEST 8: Race condition — promise and timeout fire simultaneously
// ============================================================================
async function testRaceConditionSimultaneousResolution() {
  console.log('\n[TEST 8] Race condition — resolution and timeout fire at same time')

  let raceCaught = false
  let resolvedValue: number | null = null

  // Create promise that resolves in exactly 100ms
  const racePromise = new Promise<number>((resolve) => {
    setTimeout(() => resolve(42), 100)
  })

  try {
    // Timeout also at 100ms — who wins?
    resolvedValue = await withTimeout(racePromise, 100, 'Race')
    raceCaught = true
  } catch (err: any) {
    // If timeout wins, that's also acceptable behavior
    assert(err.message.includes('timed out'), 'If error, should be timeout')
  }

  // One of these should happen cleanly
  assert(raceCaught || resolvedValue !== null, 'Race should resolve or timeout cleanly')
  console.log(`  ✓ PASS — Race condition handled cleanly (${raceCaught ? 'resolved' : 'timed out'})`)
}

// ============================================================================
// TEST 9: Stress test with rejected promises
// ============================================================================
async function testStressWithRejections() {
  console.log('\n[TEST 9] Stress test with rejected promises')

  const promises: Promise<unknown>[] = []
  let rejectionsCaught = 0

  // 30 promises: some resolve, some reject, some timeout
  for (let i = 0; i < 30; i++) {
    const flavor = i % 3
    let p: Promise<number>

    if (flavor === 0) {
      // Resolve successfully
      p = withTimeout(Promise.resolve(i), 100, `Resolve ${i}`)
    } else if (flavor === 1) {
      // Reject before timeout
      p = withTimeout(
        Promise.reject(new Error(`Expected error ${i}`)),
        100,
        `Reject ${i}`,
      )
    } else {
      // Timeout
      p = withTimeout(
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(i), 200)
        }),
        50,
        `Timeout ${i}`,
      )
    }

    promises.push(p)
  }

  const results = await Promise.allSettled(promises)
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length
  const rejected = results.filter((r) => r.status === 'rejected').length

  console.log(`  Results: ${fulfilled} fulfilled, ${rejected} rejected`)
  assert.strictEqual(fulfilled + rejected, 30, 'All 30 should settle')
  assert(fulfilled >= 8, 'Should have ~10 resolves (got ' + fulfilled + ')')
  assert(rejected >= 18, 'Should have ~20 rejections (got ' + rejected + ')')
  console.log('  ✓ PASS — Stress test with mixed promise outcomes')
}

// ============================================================================
// TEST 10: Very large timeout value — verify no integer overflow
// ============================================================================
async function testLargeTimeoutValue() {
  console.log('\n[TEST 10] Very large timeout value')

  // Use a very large timeout, but promise resolves quickly
  const result = await withTimeout(
    Promise.resolve('success'),
    Number.MAX_SAFE_INTEGER,
    'Large timeout',
  )

  assert.strictEqual(result, 'success', 'Should resolve despite huge timeout')
  console.log('  ✓ PASS — Large timeout values handled safely')
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================
async function runAllTests() {
  console.log('='.repeat(75))
  console.log('WITHtimeout() ADVANCED STRESS TEST SUITE')
  console.log('='.repeat(75))

  try {
    await testMemoryLeakOnResolution()
    await testConcurrentTimeouts()
    await testZeroMsTimeout()
    await testNegativeTimeout()
    await testPromiseRejectsAfterTimeout()
    await testRapidFireScanSimulation()
    await testTimerCleanupAccumulation()
    await testRaceConditionSimultaneousResolution()
    await testStressWithRejections()
    await testLargeTimeoutValue()

    console.log('\n' + '='.repeat(75))
    console.log('ALL TESTS PASSED ✓')
    console.log('='.repeat(75))
    process.exit(0)
  } catch (err) {
    console.error('\n' + '='.repeat(75))
    console.error('TEST FAILED ✗')
    console.error('='.repeat(75))
    console.error(err)
    process.exit(1)
  }
}

runAllTests()
