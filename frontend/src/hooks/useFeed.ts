import { useState, useEffect, useRef } from 'react'
import type { LocalPost } from '../types'
import { SEED_POSTS } from '../data/seedPosts'

export function useFeed() {
  const [livePosts, setLivePosts] = useState<LocalPost[]>([])
  const hasLoaded = useRef(false)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/feed')
        const data: LocalPost[] = await res.json()
        setLivePosts(data)
        hasLoaded.current = true
      } catch {
        // API unavailable (e.g. static deploy) — seed posts will still show
        hasLoaded.current = true
      }
    }

    load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [])

  // Before the first API response, show seed posts only (avoids content flash)
  if (!hasLoaded.current) {
    return SEED_POSTS
  }

  // After first load: live posts first, then seed posts not already in the feed
  const liveIds = new Set(livePosts.map(p => p.id))
  const merged = [
    ...livePosts,
    ...SEED_POSTS.filter(sp => !liveIds.has(sp.id)),
  ]

  return merged
}
