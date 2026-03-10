import { useState, useEffect } from 'react'
import type { LocalPost } from '../types'
import { SEED_POSTS } from '../data/seedPosts'

export function useFeed() {
  const [livePosts, setLivePosts] = useState<LocalPost[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/feed')
        const data: LocalPost[] = await res.json()
        setLivePosts(data)
      } catch {
        // API unavailable (e.g. static deploy) — seed posts will still show
      }
      setReady(true)
    }

    load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [])

  // Don't merge until the first fetch completes — avoids flash of seed-only content
  if (!ready) return []

  // Merge: live posts first, then seed posts that aren't already in the live feed
  const liveIds = new Set(livePosts.map(p => p.id))
  const merged = [
    ...livePosts,
    ...SEED_POSTS.filter(sp => !liveIds.has(sp.id)),
  ]

  return merged
}
