export interface AIBTCMetadata {
  signalId: string
  beat: string
  beatSlug: string
  headline: string
  tags?: string[]
  sources?: Array<{ url: string; title?: string }>
  signature: string
  timestamp: string
}

export interface Signal {
  id: string
  source: 'aibtc'
  type: 'headline' | 'post'
  content: string
  url: string
  author: string
  mediaUrls?: string[]
  metrics?: {
    score?: number
  }
  ingestedAt: number
  expiresAt: number
  aibtc?: AIBTCMetadata
}

export interface TopicScores {
  virality: number
  visualPotential: number
  audienceBreadth: number
  timeliness: number
  humor: number
  worldviewAlignment: number
  composite: number
}

export interface Topic {
  id: string
  signals: string[]
  summary: string
  scores: TopicScores
  safety: { passed: boolean; reason?: string }
  status: 'candidate' | 'shortlisted' | 'selected' | 'posted' | 'rejected'
  evaluatedAt: number
  quoteCandidates?: string[]
}

export interface CartoonConcept {
  id: string
  topicId: string
  visual: string
  composition: string
  caption: string
  jokeType: string
  reasoning: string
  referenceImageUrls?: string[]
}

export interface ConceptCritique {
  conceptId: string
  humor: number
  clarity: number
  shareability: number
  visualSimplicity: number
  overallScore: number
  critique: string
}

export interface Cartoon {
  id: string
  conceptId: string
  topicId: string
  type: 'flagship' | 'quickhit'
  concept: CartoonConcept
  imagePrompt: string
  variants: string[]
  selectedVariant: number
  critique: ConceptCritique
  caption: string
  createdAt: number
}

export interface Post {
  id: string
  tweetId: string
  cartoonId?: string
  text: string
  imageUrl?: string
  quotedTweetId?: string
  type: 'flagship' | 'quickhit' | 'engagement'
  postedAt: number
  engagement: {
    likes: number
    retweets: number
    replies: number
    views: number
    lastChecked: number
  }
}
