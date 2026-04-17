import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { LibraryEntry, Memo } from '../../types/library'

// ===== Fuzzy match =====
// Returns a score (higher = better match) or -1 if no match. Case-insensitive.
// Matches characters of `query` in order within `target`; adjacency and prefix boost the score.
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t === q) return 10000
  if (t.startsWith(q)) return 5000 + (t.length - q.length) * -1
  const idx = t.indexOf(q)
  if (idx !== -1) return 3000 - idx
  // Character-by-character fuzzy
  let score = 0
  let qi = 0
  let prevMatch = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === prevMatch + 1 ? 20 : 10
      prevMatch = ti
      qi++
    }
  }
  return qi === q.length ? score : -1
}

// ===== Item union =====
type QuickItem =
  | { kind: 'entry'; entry: LibraryEntry; score: number }
  | { kind: 'memo'; memo: Memo; score: number }

export default function QuickOpenModal() {
  const { library, openEntry } = useLibraryStore()
  const { showQuickOpen, setShowQuickOpen, setActiveMemo, setActiveReadingLogDate } = useUiStore()
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset when opened
  useEffect(() => {
    if (showQuickOpen) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [showQuickOpen])

  // Build ranked results
  const items = useMemo<QuickItem[]>(() => {
    if (!library) return []
    const q = query.trim()
    // Empty query → show recent entries + all memos
    if (!q) {
      const recentEntries = [...library.entries]
        .sort((a, b) => {
          const ta = a.lastOpenedAt || a.addedAt
          const tb = b.lastOpenedAt || b.addedAt
          return tb.localeCompare(ta)
        })
        .slice(0, 20)
        .map(entry => ({ kind: 'entry' as const, entry, score: 0 }))
      const recentMemos = [...(library.memos || [])]
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, 10)
        .map(memo => ({ kind: 'memo' as const, memo, score: 0 }))
      return [...recentEntries, ...recentMemos]
    }
    // Ranked fuzzy search across entries + memos
    const entryScored = library.entries
      .map(entry => {
        const titleScore = fuzzyScore(q, entry.title)
        const pathScore = fuzzyScore(q, entry.absPath) / 2  // path matches worth half
        const tagScore = entry.tags.some(t => fuzzyScore(q, t) > 0) ? 1000 : 0
        const score = Math.max(titleScore, pathScore) + tagScore
        return { kind: 'entry' as const, entry, score }
      })
      .filter(x => x.score > 0)
    const memoScored = (library.memos || [])
      .map(memo => {
        const titleScore = fuzzyScore(q, memo.title)
        const contentScore = memo.content.length > 0 ? fuzzyScore(q, memo.content.slice(0, 500)) / 3 : 0
        const score = Math.max(titleScore, contentScore)
        return { kind: 'memo' as const, memo, score }
      })
      .filter(x => x.score > 0)
    return [...entryScored, ...memoScored].sort((a, b) => b.score - a.score).slice(0, 40)
  }, [library, query])

  // Keep activeIdx valid when items change
  useEffect(() => {
    if (activeIdx >= items.length && items.length > 0) setActiveIdx(0)
  }, [items.length, activeIdx])

  // Scroll active item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector<HTMLDivElement>(`[data-idx="${activeIdx}"]`)
    active?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const handleSelect = useCallback((item: QuickItem) => {
    setShowQuickOpen(false)
    if (item.kind === 'entry') {
      setActiveMemo(null)
      setActiveReadingLogDate(null)
      openEntry(item.entry)
    } else {
      setActiveMemo(item.memo.id)
    }
  }, [openEntry, setActiveMemo, setActiveReadingLogDate, setShowQuickOpen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setShowQuickOpen(false); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, items.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[activeIdx]
      if (item) handleSelect(item)
      return
    }
  }, [items, activeIdx, handleSelect, setShowQuickOpen])

  if (!showQuickOpen) return null

  return (
    <div
      className="modal-overlay"
      onClick={() => setShowQuickOpen(false)}
      style={{ alignItems: 'flex-start', paddingTop: '12vh' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 560, maxWidth: '90vw',
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
          maxHeight: '70vh',
        }}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)' }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索文献或笔记... (↑↓ 选择, Enter 打开, Esc 关闭)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              width: '100%', padding: '8px 12px', border: '1px solid var(--border)',
              borderRadius: 6, fontSize: 14, outline: 'none',
              background: 'var(--bg-warm)', color: 'var(--text)',
            }}
          />
        </div>
        <div ref={listRef} style={{ overflowY: 'auto', maxHeight: '60vh' }}>
          {items.length === 0 ? (
            <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
              {query ? '无匹配结果' : '空的文献库'}
            </div>
          ) : (
            items.map((item, i) => {
              const isActive = i === activeIdx
              const title = item.kind === 'entry' ? item.entry.title : item.memo.title
              const subtitle = item.kind === 'entry'
                ? (item.entry.absPath.split(/[/\\]/).slice(-4, -1).join('/'))
                : (item.memo.content ? item.memo.content.slice(0, 80).replace(/\n/g, ' ') : '空笔记')
              const badge = item.kind === 'entry' ? '文献' : '笔记'
              const badgeColor = item.kind === 'entry' ? 'var(--accent)' : 'var(--success)'
              return (
                <div
                  key={`${item.kind}-${item.kind === 'entry' ? item.entry.id : item.memo.id}`}
                  data-idx={i}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    padding: '10px 16px', cursor: 'pointer',
                    background: isActive ? 'var(--accent-soft)' : 'transparent',
                    borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}
                >
                  <span style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 4,
                    background: isActive ? 'rgba(255,255,255,0.8)' : 'var(--bg-warm)',
                    color: badgeColor, fontWeight: 600, flexShrink: 0,
                  }}>
                    {badge}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, color: 'var(--text)', fontWeight: 500,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {title || '(无标题)'}
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--text-muted)', marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {subtitle}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
        <div style={{
          padding: '6px 16px', borderTop: '1px solid var(--border-light)',
          fontSize: 10, color: 'var(--text-muted)', textAlign: 'right',
          background: 'var(--bg-warm)',
        }}>
          {items.length > 0 && `${items.length} 个结果`}
        </div>
      </div>
    </div>
  )
}
