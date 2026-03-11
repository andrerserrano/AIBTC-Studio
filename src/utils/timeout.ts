/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within
 * the given time, it rejects with a descriptive error.
 *
 * CRITICAL: This prevents the agent loop from hanging indefinitely when
 * external APIs (Twitter, RSS feeds, AIBTC.news) stop responding.
 */
export function withTimeout<T>(
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

/** Default timeout for external API calls (30 seconds) */
export const API_TIMEOUT_MS = 30_000

/** Timeout for LLM calls which can be slower (60 seconds) */
export const LLM_TIMEOUT_MS = 60_000

/** Timeout for the entire scan phase (2 minutes) — prevents full tick hang */
export const SCAN_TIMEOUT_MS = 120_000
