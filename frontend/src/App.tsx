import { useState } from 'react'
import { useConsoleStream } from './hooks/useConsoleStream'
import { useFeed } from './hooks/useFeed'
import { Header } from './components/Header'
import { Monologue } from './components/Monologue'
import { Feed } from './components/Feed'
import { Sidebar } from './components/Sidebar'
import { Legal } from './components/Legal'

type Tab = 'console' | 'feed'

const TABS: { id: Tab; label: string; sublabel: string }[] = [
  { id: 'console', label: 'The Brain', sublabel: 'Live thoughts' },
  { id: 'feed', label: 'Gallery', sublabel: 'Published work' },
]

export default function App() {
  const [page, setPage] = useState<'main' | 'legal'>(() =>
    window.location.pathname === '/legal' ? 'legal' : 'main'
  )

  if (page === 'legal') {
    return <Legal onBack={() => { window.history.pushState({}, '', '/'); setPage('main') }} />
  }

  const { entries, agentState, connected, shortlist, stats } = useConsoleStream({})
  const posts = useFeed()
  const params = new URLSearchParams(window.location.search)
  const viewEverything = params.get('view_everything') === 'true'
  const [tab, setTab] = useState<Tab>('console')
  const [compareMode, setCompareMode] = useState(() => params.get('opengallery') === 'true')

  if (viewEverything) {
    return (
      <div className="h-screen flex flex-col bg-paper">
        <Header state={agentState} connected={connected} />

        <div className="flex-1 grid grid-cols-[1fr_1fr_400px] min-h-0">
          {/* The Brain */}
          <div className="min-h-0 overflow-hidden border-r-[2px] border-ink">
            <div className="sticky top-0 z-10 glass-panel border-b-[2px] border-ink px-4 py-2">
              <div className="flex items-center gap-2">
                <div className="w-[3px] h-4 bg-cobalt rounded-full" />
                <span className="font-cartoon text-[16px] font-bold text-ink">The Brain</span>
                <span className="font-mono text-[9px] text-ink-faint uppercase tracking-wider">Live thoughts</span>
              </div>
            </div>
            <Monologue entries={entries} compareMode={false} onToggleCompare={() => {}} />
          </div>

          {/* Gallery */}
          <div className="min-h-0 overflow-hidden border-r-[2px] border-ink">
            <Feed posts={posts} streamMode />
          </div>

          {/* Sidebar */}
          <div className="min-h-0 overflow-y-auto">
            <Sidebar stats={stats} shortlist={shortlist} agentState={agentState} postCount={posts.length} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      <Header state={agentState} connected={connected} />

      {/* Section navigation */}
      <nav className="bg-paper-bright border-b-[2px] border-ink px-6 sm:px-10">
        <div className="flex items-stretch gap-0">
          {TABS.map(({ id, label, sublabel }) => {
            const isActive = tab === id
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative px-5 sm:px-7 py-3 transition-all group ${
                  isActive ? '' : 'hover:bg-paper-warm/50'
                }`}
              >
                {/* Active indicator — thick ink underline */}
                {isActive && (
                  <div className="absolute bottom-0 left-2 right-2 h-[4px] bg-vermillion" style={{ borderRadius: '255px 15px 225px 15px/15px 225px 15px 255px' }} />
                )}

                <div className="flex items-center gap-2">
                  <span className={`font-cartoon text-[20px] font-bold transition-colors ${
                    isActive ? 'text-ink' : 'text-ink-muted group-hover:text-ink-light'
                  }`}>
                    {label}
                  </span>

                  {id === 'feed' && posts.length > 0 && (
                    <span className="font-mono text-[9px] font-bold text-paper-bright bg-vermillion px-1.5 py-0.5 rounded-full leading-none">
                      {posts.length}
                    </span>
                  )}
                </div>

                <span className={`block font-mono text-[11px] font-medium uppercase tracking-wider mt-0.5 transition-colors ${
                  isActive ? 'text-ink-muted' : 'text-ink-faint'
                }`}>
                  {sublabel}
                </span>
              </button>
            )
          })}
        </div>
      </nav>

      {/* Main content area */}
      <div className={`flex-1 layout-grid grid min-h-0 ${
        compareMode && tab === 'console'
          ? 'grid-cols-[1fr_1fr_400px]'
          : 'grid-cols-[1fr_400px]'
      }`}>
        <main className="min-h-0 overflow-hidden border-r-[2px] border-ink">
          {tab === 'console' && <Monologue entries={entries} compareMode={compareMode} onToggleCompare={() => setCompareMode(!compareMode)} />}
          {tab === 'feed' && <Feed posts={posts} />}
        </main>
        {compareMode && tab === 'console' && (
          <div className="min-h-0 overflow-hidden border-r-[2px] border-ink">
            <Feed posts={posts} />
          </div>
        )}
        <div className="sidebar-panel">
          <Sidebar stats={stats} shortlist={shortlist} agentState={agentState} postCount={posts.length} />
        </div>
      </div>
    </div>
  )
}
