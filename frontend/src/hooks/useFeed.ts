import { useState, useEffect } from 'react'
import type { LocalPost } from '../types'
import { SEED_POSTS } from '../data/seedPosts'

export function useFeed() {
  const [livePosts, setLivePosts] = useState<LocalPost[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let first = true

    async function load() {
      try {
        const res = await fetch('/api/feed')
        const data: LocalPost[] = await res.json()
        setLivePosts(data)
      } catch {
        // API unavailable (e.g. static deploy) — seed posts will still show
      } finally {
        if (first) {
          first = false
          setLoading(false)
        }
      }
    }

    load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [])

  // Merge: live posts first, then seed posts that aren't already in the live feed
  const liveIds = new Set(livePosts.map(p => p.id))
  const merged = [
    ...livePosts,
    ...SEED_POSTS.filter(sp => !liveIds.has(sp.id)),
  ]

  return { posts: merged, loading }
}
