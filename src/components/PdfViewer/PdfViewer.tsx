import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import Markdown from 'react-markdown'
const ReactMarkdown = Markdown  // alias for compatibility

// 2026-04-28 · "你上次在 X 读过这本"提示去重 — 模块级 Set 记录本次会话内
//   "用户已经查看过本文献注释"的 entryId。切出再切入这本时:
//   - 在 Set 内 → 跳过提示(用户已经看过注释,不需要再 nudge)
//   - 不在 Set 内 → 仍然弹(用户开了但没看注释,提示仍然有用)
//   入 Set 时机:用户点击"查看注释"按钮、或点击任意注释 marker(setActiveAnnotation
//   被触发)。app 重启后清零。
const rereadingViewedThisSession = new Set<string>()
import remarkMath from 'remark-math'
import { KATEX_FORGIVING as rehypeKatex } from '../../utils/markdownConfig'
import { v4 as uuid } from 'uuid'
import 'react-pdf/dist/esm/Page/TextLayer.css'
import 'react-pdf/dist/esm/Page/AnnotationLayer.css'
import 'katex/dist/katex.min.css'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import { cleanOcrText } from './cleanOcrText'
import { collectTextNodes } from './highlights'
import TranslateModal, { type TranslateModalProps } from './TranslateModal'
import { useTranslationJobsStore } from '../../store/translationJobsStore'
// PERF-R8#7 · 共享 AI provider 配置 cache,免每个组件 mount 单独 IPC
import { fetchAiConfig, subscribeAiConfig } from '../../utils/aiConfigCache'
// BUG-FIX R8#8 · localStorage 数字读 NaN 防御
import { readNumber } from '../../utils/safeStorageRead'

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

// cleanOcrText and highlight utils are now in separate files

// ===== Append Annotation List (warm theme, grouped by page, with cross-entry support) =====
import type { Annotation } from '../../types/library'

interface OtherEntryAnns { entryId: string; entryTitle: string; annotations: Annotation[] }

function AnnotationListItems({ annotations, onSelect, label }: {
  annotations: Annotation[], onSelect: (ann: Annotation) => void, label?: string
}) {
  const grouped = new Map<number, Annotation[]>()
  for (const ann of annotations) {
    const page = ann.anchor.pageNumber || 0
    if (!grouped.has(page)) grouped.set(page, [])
    grouped.get(page)!.push(ann)
  }
  return (<>
    {[...grouped.keys()].sort((a, b) => a - b).map(page => (
      <div key={`${label || ''}-${page}`}>
        <div style={{
          padding: '4px 12px 2px', fontSize: 10, fontWeight: 600,
          color: 'var(--text-muted)', position: 'sticky', top: 0, background: 'var(--bg)',
        }}>
          {label ? `${label} · ` : ''}第 {page} 页
        </div>
        {grouped.get(page)!.map(ann => (
          <div
            key={ann.id}
            onClick={() => onSelect(ann)}
            style={{
              padding: '6px 12px', cursor: 'pointer', fontSize: 12,
              color: 'var(--text)', borderLeft: '3px solid transparent', transition: 'all 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-soft)'; e.currentTarget.style.borderLeftColor = 'var(--accent)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderLeftColor = 'transparent' }}
          >
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 11 }}>
              「{ann.anchor.selectedText.substring(0, 35)}{ann.anchor.selectedText.length > 35 ? '...' : ''}」
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
              {ann.historyChain.length} 条记录
            </div>
          </div>
        ))}
      </div>
    ))}
  </>)
}

function AppendAnnotationList({ annotations, otherEntries, onAppend, onAppendOther, onBack }: {
  annotations: Annotation[]
  otherEntries: OtherEntryAnns[]
  onAppend: (id: string) => void
  onAppendOther: (entryId: string, annotationId: string) => void
  onBack: () => void
}) {
  const [search, setSearch] = useState('')
  const [othersExpanded, setOthersExpanded] = useState(false)

  const allCount = annotations.length + otherEntries.reduce((s, e) => s + e.annotations.length, 0)

  const filtered = search.trim()
    ? annotations.filter(a => a.anchor.selectedText.includes(search.trim()))
    : annotations

  const filteredOthers = search.trim()
    ? otherEntries.map(e => ({ ...e, annotations: e.annotations.filter(a => a.anchor.selectedText.includes(search.trim())) })).filter(e => e.annotations.length > 0)
    : otherEntries

  return (
    <div
      className="append-annotation-popup"
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)',
        marginTop: 6, zIndex: 210,
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 10, boxShadow: '0 6px 24px rgba(60,50,30,0.15)',
        width: 300, maxHeight: 380, display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: '1px solid var(--border-light)', flexShrink: 0,
      }}>
        <button onClick={onBack} style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
          color: 'var(--text-muted)', display: 'flex', alignItems: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>追加到注释</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({allCount})</span>
      </div>

      {/* Search */}
      {allCount > 5 && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索注释文本..." autoFocus
            style={{
              width: '100%', padding: '5px 8px', fontSize: 11,
              border: '1px solid var(--border-light)', borderRadius: 5,
              outline: 'none', background: 'var(--bg-warm)', color: 'var(--text)',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-light)')}
          />
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {/* Current entry */}
        {filtered.length > 0 ? (
          <AnnotationListItems annotations={filtered} onSelect={ann => onAppend(ann.id)} />
        ) : annotations.length === 0 ? (
          <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>本文献暂无注释</div>
        ) : search.trim() ? (
          <div style={{ padding: '12px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>本文献无匹配</div>
        ) : null}

        {/* Other entries — expandable */}
        {otherEntries.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 4 }}>
            <div
              onClick={() => setOthersExpanded(!othersExpanded)}
              style={{
                padding: '8px 12px', fontSize: 11, fontWeight: 600,
                color: 'var(--text-muted)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ transform: othersExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              其他文献的注释
              <span style={{ fontWeight: 400 }}>({otherEntries.reduce((s, e) => s + e.annotations.length, 0)})</span>
            </div>
            {othersExpanded && (
              <div>
                {(search.trim() ? filteredOthers : otherEntries).map(other => (
                  <div key={other.entryId}>
                    <div style={{
                      padding: '4px 12px 2px', fontSize: 10, fontWeight: 600,
                      color: 'var(--accent)', opacity: 0.8,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {other.entryTitle}
                    </div>
                    <AnnotationListItems
                      annotations={other.annotations}
                      onSelect={ann => onAppendOther(other.entryId, ann.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ===== DOM text highlighting utilities =====
// Position-aware overlap resolution: when two targets cover the same chars,
// the LATER target (higher index in `targets`) wins. Older target's
// non-overlapping portions still wrap normally, so partial overlap renders
// as 2 spans (old-prefix + new) and full containment as 3 (prefix + new + suffix).
// The caller should append new marks at the end of `targets` so they win.

function findAndWrapAll(
  container: HTMLElement,
  targets: Array<{ text: string; id: string }>,
  wrapFn: (target: { text: string; id: string }) => HTMLElement,
  skipClass?: string,
) {
  // === Phase 1: build flat string + char→DOM map (one pass, before any wrap) ===
  const textNodes = collectTextNodes(container)
  const charMap: Array<{ ni: number; offset: number }> = []
  let flat = ''
  for (let ni = 0; ni < textNodes.length; ni++) {
    const node = textNodes[ni]
    if (skipClass && (node.parentNode as HTMLElement)?.classList?.contains(skipClass)) continue
    const raw = node.textContent || ''
    for (let ri = 0; ri < raw.length; ri++) {
      if (/\s/.test(raw[ri])) continue
      charMap.push({ ni, offset: ri })
      flat += raw[ri]
    }
  }
  if (charMap.length === 0) return

  // === Phase 2: locate each target's [start, end) in the flat string ===
  type Range = { target: { text: string; id: string }; start: number; end: number; idx: number }
  const ranges: Range[] = []
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const searchText = target.text.replace(/\s+/g, '').trim()
    if (searchText.length < 2) continue
    const flatIdx = flat.indexOf(searchText)
    if (flatIdx === -1) continue
    ranges.push({ target, start: flatIdx, end: flatIdx + searchText.length, idx: i })
  }

  // === Phase 3: subtract LATER ranges from each older range ===
  // For each range r, compute visible sub-intervals = [r.start, r.end) minus
  // the union of all ranges with idx > r.idx.
  type WrapTask = { target: { text: string; id: string }; start: number; end: number }
  const tasks: WrapTask[] = []
  for (const r of ranges) {
    let intervals: Array<[number, number]> = [[r.start, r.end]]
    for (const other of ranges) {
      if (other.idx <= r.idx) continue
      const next: Array<[number, number]> = []
      for (const [a, b] of intervals) {
        if (other.end <= a || other.start >= b) {
          next.push([a, b])
        } else {
          if (other.start > a) next.push([a, other.start])
          if (other.end < b) next.push([other.end, b])
        }
      }
      intervals = next
      if (intervals.length === 0) break
    }
    for (const [a, b] of intervals) {
      if (b > a) tasks.push({ target: r.target, start: a, end: b })
    }
  }
  if (tasks.length === 0) return

  // === Phase 4: wrap tasks right-to-left so leftward charMap stays valid ===
  tasks.sort((a, b) => b.start - a.start)

  for (const task of tasks) {
    const segments: Array<{ node: Text; startOffset: number; endOffset: number }> = []
    let currentNi = -1, segStart = 0, segEnd = 0
    for (let fi = task.start; fi < task.end; fi++) {
      const cm = charMap[fi]
      if (cm.ni !== currentNi) {
        if (currentNi >= 0) segments.push({ node: textNodes[currentNi], startOffset: segStart, endOffset: segEnd + 1 })
        currentNi = cm.ni
        segStart = cm.offset
      }
      segEnd = cm.offset
    }
    if (currentNi >= 0) segments.push({ node: textNodes[currentNi], startOffset: segStart, endOffset: segEnd + 1 })
    if (segments.length === 0) continue

    try {
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si]
        if (!seg.node.isConnected) continue
        const parent = seg.node.parentNode
        if (!parent) continue
        const raw = seg.node.textContent || ''
        const before = raw.substring(0, seg.startOffset)
        const match = raw.substring(seg.startOffset, seg.endOffset)
        const after = raw.substring(seg.endOffset)

        const wrapper = wrapFn(task.target)
        wrapper.textContent = match

        if (after) parent.insertBefore(document.createTextNode(after), seg.node.nextSibling)
        parent.insertBefore(wrapper, seg.node.nextSibling)
        if (before) { seg.node.textContent = before } else { parent.removeChild(seg.node) }
      }
    } catch { /* DOM changed mid-wrap, skip */ }
  }
}

function useAnnotationHighlights(
  containerRef: React.RefObject<HTMLDivElement | null>,
  annotations: Array<{ id: string; selectedText: string }>,
  onAnnotationClick: (id: string) => void,
  deps: unknown[]
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function applyHighlights() {
      try {
        // Remove old markers
        container!.querySelectorAll('.ocr-ann-marker, .ocr-ann-underline').forEach(el => {
          try {
            if (el.classList.contains('ocr-ann-underline')) {
              const parent = el.parentNode
              if (parent) {
                while (el.firstChild) parent.insertBefore(el.firstChild, el)
                parent.removeChild(el)
              }
            } else { el.parentNode?.removeChild(el) }
          } catch {}
        })
        try { container!.normalize() } catch {}
        if (annotations.length === 0) return

        const targets = annotations
          .filter(a => a.selectedText && a.selectedText.length >= 4)
          .sort((a, b) => b.selectedText.length - a.selectedText.length)
          .map(a => ({ text: a.selectedText, id: a.id }))

        findAndWrapAll(container!, targets, (target) => {
          // Insert marker dot before the underline
          const marker = document.createElement('span')
          marker.className = 'ocr-ann-marker'
          marker.title = '已注释 · 点击查看'
          marker.dataset.annotationId = target.id
          marker.onclick = (ev) => { ev.stopPropagation(); onAnnotationClick(target.id) }

          // We'll insert the marker separately after wrapping
          const underline = document.createElement('span')
          underline.className = 'ocr-ann-underline'
          underline.dataset.annotationId = target.id

          // Hack: attach marker to underline so we can insert it after
          ;(underline as any).__marker = marker
          return underline
        }, 'ocr-ann-underline')

        // Insert markers before each underline
        container!.querySelectorAll('.ocr-ann-underline').forEach(el => {
          const marker = (el as any).__marker
          if (marker && el.parentNode) {
            try { el.parentNode.insertBefore(marker, el) } catch {}
          }
        })
      } catch {}
    }

    const raf = requestAnimationFrame(() => applyHighlights())
    return () => cancelAnimationFrame(raf)
  }, deps)
}

// ===== Search highlight: wraps every occurrence of the query term in a .sj-search-hit span =====
// Auto-scrolls to the first match. Doesn't collide with annotation highlights (uses skipClass).
function useSearchHighlight(
  containerRef: React.RefObject<HTMLDivElement | null>,
  query: string | null | undefined,
  deps: unknown[]
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function clearOld() {
      try {
        container!.querySelectorAll('.sj-search-hit').forEach(el => {
          const parent = el.parentNode
          if (parent) {
            while (el.firstChild) parent.insertBefore(el.firstChild, el)
            parent.removeChild(el)
          }
        })
        container!.normalize()
      } catch {}
    }

    const q = (query || '').trim()
    if (!q || q.length < 2) { clearOld(); return }

    const raf = requestAnimationFrame(() => {
      clearOld()
      try {
        findAndWrapAll(container, [{ text: q }], () => {
          const span = document.createElement('span')
          span.className = 'sj-search-hit'
          return span
        }, 'sj-search-hit')

        // Scroll the first hit into view (centered if possible)
        const first = container.querySelector('.sj-search-hit') as HTMLElement | null
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } catch {}
    })
    return () => {
      cancelAnimationFrame(raf)
      // Don't clearOld on cleanup — next effect run handles it. Clearing here causes flicker.
    }
  }, deps)
}

// ===== PDF Outline list (recursive) =====
// Renders the PDF's internal table-of-contents as a collapsible tree.
// Each leaf is clickable; dest resolution and scroll live in the parent.
interface OutlineItem { title: string; dest: any; items?: OutlineItem[] }
function PdfOutlineList({ items, depth, onItemClick }: {
  items: OutlineItem[]
  depth: number
  onItemClick: (item: OutlineItem) => void
}) {
  return (
    <>
      {items.map((item, i) => (
        <PdfOutlineNode key={`${depth}-${i}-${item.title}`} item={item} depth={depth} onItemClick={onItemClick} />
      ))}
    </>
  )
}

function PdfOutlineNode({ item, depth, onItemClick }: {
  item: OutlineItem
  depth: number
  onItemClick: (item: OutlineItem) => void
}) {
  // Default-expand the first 2 levels; deeper ones start collapsed to reduce noise
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = Array.isArray(item.items) && item.items.length > 0

  return (
    <div>
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 4,
          padding: '4px 8px', paddingLeft: 8 + depth * 12,
          fontSize: 12, color: 'var(--text)',
          cursor: 'pointer', lineHeight: 1.4,
          borderRadius: 3,
        }}
        onClick={() => onItemClick(item)}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        {hasChildren ? (
          <span
            style={{ color: 'var(--text-muted)', fontSize: 10, width: 10, flexShrink: 0, marginTop: 2 }}
            onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
            title={expanded ? '折叠' : '展开'}
          >
            {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.title}>
          {item.title}
        </span>
      </div>
      {hasChildren && expanded && item.items && (
        <PdfOutlineList items={item.items} depth={depth + 1} onItemClick={onItemClick} />
      )}
    </div>
  )
}

// OCR Content component with per-page sections and markdown rendering
function OcrContent({ text, annotations, onAnnotationClick, activeSelectionText, marks, onRemoveMark, searchHighlight }: {
  text: string
  annotations: Array<{ id: string; selectedText: string }>
  onAnnotationClick: (id: string) => void
  activeSelectionText?: string
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onRemoveMark?: (id: string) => void
  searchHighlight?: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cleaned = useMemo(() => cleanOcrText(text), [text])
  const [markMenu, setMarkMenu] = useState<{ x: number; y: number; markId: string; markType: string } | null>(null)

  // Split by page markers if present: "=== 第 N 页 ==="
  const hasPageMarkers = /=== 第 \d+ 页 ===/.test(cleaned)
  const sections = hasPageMarkers
    ? cleaned.split(/\n*=== 第 \d+ 页 ===\n*/).filter(Boolean)
    : [cleaned]

  // Highlight annotations after render
  useAnnotationHighlights(containerRef, annotations, onAnnotationClick, [cleaned, annotations])
  // Search highlight + auto-scroll to first hit
  useSearchHighlight(containerRef, searchHighlight, [cleaned, searchHighlight])

  // Render marks (underline/bold) after annotations
  useEffect(() => {
    const container = containerRef.current
    if (!container || !marks || marks.length === 0) return

    // Remove old marks
    container.querySelectorAll('.ocr-mark').forEach(el => {
      try {
        const parent = el.parentNode
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el)
          parent.removeChild(el)
        }
      } catch {}
    })
    try { container.normalize() } catch {}

    const targets = marks.map(m => ({ text: m.selectedText, id: m.id, type: m.type, color: m.color }))

    findAndWrapAll(container, targets, (target) => {
      const t = target as typeof targets[number]
      const span = document.createElement('span')
      span.className = t.type === 'bold'
        ? 'ocr-mark mark-bold'
        : `ocr-mark mark-underline-${t.color || 'yellow'}`
      span.dataset.markId = t.id
      span.dataset.markType = t.type
      return span
    }, 'ocr-mark')

    // Right-click on marks — use coordinate hit-test since marks have pointer-events: none
    const handleMarkContext = (e: MouseEvent) => {
      const markEls = container.querySelectorAll('.ocr-mark[data-mark-id]')
      for (const el of markEls) {
        const rect = el.getBoundingClientRect()
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          const markEl = el as HTMLElement
          e.preventDefault()
          e.stopPropagation()
          setMarkMenu({ x: e.clientX, y: e.clientY, markId: markEl.dataset.markId!, markType: markEl.dataset.markType || '' })
          return
        }
      }
    }
    container.addEventListener('contextmenu', handleMarkContext)
    return () => container.removeEventListener('contextmenu', handleMarkContext)
  }, [marks, cleaned])

  // Highlight active selection text
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Remove old active highlights
    container.querySelectorAll('.ocr-active-sel').forEach(el => {
      try {
        const parent = el.parentNode
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el)
          parent.removeChild(el)
        }
      } catch {}
    })
    try { container.normalize() } catch {}

    if (!activeSelectionText || activeSelectionText.length < 2) return

    const searchText = activeSelectionText.replace(/\s+/g, ' ').trim()
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!node.parentNode || !node.isConnected) continue
      if ((node.parentNode as HTMLElement).classList?.contains('ocr-active-sel')) continue
      const nodeText = (node.textContent || '').replace(/\s+/g, ' ')
      const idx = nodeText.indexOf(searchText)
      if (idx === -1) continue

      try {
        const before = (node.textContent || '').substring(0, idx)
        const match = (node.textContent || '').substring(idx, idx + activeSelectionText.length)
        const after = (node.textContent || '').substring(idx + activeSelectionText.length)
        const span = document.createElement('span')
        span.className = 'ocr-active-sel'
        span.textContent = match
        const parent = node.parentNode!
        if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling)
        parent.insertBefore(span, node.nextSibling)
        if (before) node.textContent = before
        else parent.removeChild(node)
      } catch {}
      break
    }
  }, [activeSelectionText, cleaned])

  return (
    <div className="ocr-markdown-content" ref={containerRef}>
      {sections.map((pageText, i) => (
        <div key={i} data-page-number={i + 1} style={{ marginBottom: 28 }}>
          {sections.length > 1 && (
            <div style={{
              // Was #bbb / #eee hardcoded — fine in light mode, too bright in
              // dark mode (#eee border becomes a glaring white bar). Theme vars
              // keep the "page break marker" subtle in both themes.
              fontSize: 12, color: 'var(--text-muted)', marginBottom: 10,
              paddingBottom: 6, borderBottom: '1px solid var(--border-light)',
              fontFamily: '-apple-system, "Microsoft YaHei", sans-serif',
              userSelect: 'none', opacity: 0.6,
            }}>
              — 第 {i + 1} 页 —
            </div>
          )}
          <Markdown
            remarkPlugins={[remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              img: ({ src, alt }) => {
                // Hide bbox image references
                if (src && (src.includes('bbox') || src.includes('page='))) return null
                return <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: 4, margin: '8px 0' }} />
              }
            }}
          >
            {pageText.trim()}
          </Markdown>
        </div>
      ))}

      {/* Mark right-click menu */}
      {markMenu && (
        <div
          style={{
            position: 'fixed', left: markMenu.x, top: markMenu.y, zIndex: 1000,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '4px 0', minWidth: 120,
          }}
          onMouseLeave={() => setMarkMenu(null)}
        >
          <div
            onClick={() => {
              onRemoveMark?.(markMenu.markId)
              setMarkMenu(null)
            }}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {markMenu.markType === 'bold' ? '取消高亮' : '取消划线'}
          </div>
        </div>
      )}
    </div>
  )
}

// HTML viewer: uses iframe for proper rendering + postMessage for text selection + annotation highlights
function HtmlViewer({
  absPath, onTextSelect, annotations,
  fontSize = 16, fontWeight = 400, colorDepth = 80,
  bgHue = 38, bgSat = 55, bgLight = 92,
  onToolbarShow,
}: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
  annotations?: Array<{ id: string; selectedText: string }>
  // Typography controls from parent toolbar — mirror EPUB/DOCX behavior.
  fontSize?: number
  fontWeight?: number
  colorDepth?: number
  bgHue?: number
  bgSat?: number
  bgLight?: number
  // Toolbar bridge: iframe → parent. Replaces the old "auto open annotation
  // panel" behavior (onTextSelect(sel)) with the PDF-style "show floating
  // toolbar, user clicks to open panel".
  onToolbarShow?: (x: number, y: number, text: string) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Listen for selection messages from iframe. Two types:
  //   'text-selection' — fires on mouseup inside iframe with coords+text
  //   (we no longer auto-populate onTextSelect; the toolbar click handler
  //   does that via setTextSelection.)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'text-selection') return
      if (!e.data.text) return
      const iframeRect = iframeRef.current?.getBoundingClientRect()
      const x = (iframeRect?.left || 0) + (e.data.x || 0)
      const y = (iframeRect?.top || 0) + (e.data.y || 0)
      onToolbarShow?.(x, y, e.data.text)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onToolbarShow])

  // Load HTML and inject selection script + annotation highlights
  useEffect(() => {
    if (!iframeRef.current) return
    window.electronAPI.readFileBuffer(absPath).then(buf => {
      const decoder = new TextDecoder('utf-8')
      let html = decoder.decode(buf)

      // Build annotation highlight data
      const annTexts = (annotations || []).map(a => a.selectedText).filter(t => t.length >= 2)
      const annHighlightJS = annTexts.length > 0 ? `
var annTexts = ${JSON.stringify(annTexts)};
function highlightAnnotations() {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  var textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  annTexts.forEach(function(searchText) {
    textNodes.forEach(function(node) {
      var idx = node.textContent.indexOf(searchText);
      if (idx >= 0 && node.parentNode && !node.parentNode.classList?.contains('sj-ann-hl')) {
        var range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + searchText.length);
        var span = document.createElement('span');
        span.className = 'sj-ann-hl';
        span.style.cssText = 'background: rgba(200,149,108,0.2); border-bottom: 2px solid rgba(200,149,108,0.5); border-radius: 2px;';
        range.surroundContents(span);
      }
    });
  });
}
setTimeout(highlightAnnotations, 200);
` : ''

      // Reading typography & selection bridge — injected into iframe <body>.
      // Script posts { type, text, x, y } on mouseup so the parent can place
      // the floating toolbar next to the highlighted range (same pattern as
      // EPUB's rendition.on('selected') bridge).
      const textColor = bgLight < 50
        ? `hsl(40, 15%, ${60 + (100 - colorDepth) / 3}%)`
        : `hsl(30, 20%, ${100 - colorDepth}%)`
      const bgColor = `hsl(${bgHue}, ${bgSat}%, ${bgLight}%)`
      const typographyStyle = `
<style id="sj-html-typography">
  html, body {
    background: ${bgColor} !important;
    color: ${textColor} !important;
    font-size: ${fontSize}px !important;
    font-weight: ${fontWeight} !important;
    line-height: 1.9 !important;
    font-family: "Noto Serif SC", "Source Han Serif", Georgia, serif !important;
  }
  body { max-width: 860px; margin: 0 auto; padding: 32px 48px; }
  ::selection { background: rgba(200, 149, 108, 0.35); }
  img { max-width: 100%; height: auto; }
</style>`
      const selectionScript = `
<script>
document.addEventListener('mouseup', function() {
  var sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    var text = sel.toString().trim();
    if (text && text.length >= 2) {
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      window.parent.postMessage({
        type: 'text-selection',
        text: text,
        x: rect.left + rect.width / 2,
        y: rect.bottom + 6
      }, '*');
    }
  }
});
${annHighlightJS}
</script>`

      if (html.includes('</head>')) {
        html = html.replace('</head>', typographyStyle + '</head>')
      } else if (html.includes('<body')) {
        html = html.replace('<body', typographyStyle + '<body')
      } else {
        html = typographyStyle + html
      }

      if (html.includes('</body>')) {
        html = html.replace('</body>', selectionScript + '</body>')
      } else {
        html += selectionScript
      }

      iframeRef.current!.srcdoc = html
    }).catch(() => {
      if (iframeRef.current) iframeRef.current.srcdoc = '<p>无法加载文件</p>'
    })
  }, [absPath, annotations, fontSize, fontWeight, colorDepth, bgHue, bgSat, bgLight])

  return (
    <iframe
      ref={iframeRef}
      style={{ width: '100%', height: '100%', border: 'none', background: 'var(--bg)' }}
      sandbox="allow-scripts allow-same-origin"
    />
  )
}

// EPUB viewer using epub.js.
//
// Annotation highlighting: epub.js renders each chapter in a per-section
// iframe. To underline annotations we:
//   1. Inject our highlight CSS into each iframe's <head> on first render
//   2. Walk the iframe's body text nodes, wrapping matches with
//      .ocr-ann-underline + a clickable .ocr-ann-marker dot
//   3. Re-apply when annotations change — we cache each iframe's Contents
//      object so we can reach it again after the user has navigated.
// This is conceptually the same as DocxViewer's useAnnotationHighlights but
// has to run inside a foreign document, so we use the refactored
// findAndWrapAll that respects Node.ownerDocument.
function EpubViewer({
  absPath, onTextSelect, annotations, onAnnotationClick,
  marks, onRemoveMark,
  fontSize = 17, fontWeight = 400, colorDepth = 80,
  bgHue = 38, bgSat = 55, bgLight = 92,
  onToolbarShow,
}: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
  annotations?: Array<{ id: string; selectedText: string }>
  onAnnotationClick?: (id: string) => void
  // Inline marks (高光 + 6-color underline), same shape as DocxViewer
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onRemoveMark?: (id: string) => void
  // Reading typography + background color — forwarded from PdfViewer's top
  // toolbar so EPUB matches OCR/DOCX/TXT behavior.
  fontSize?: number
  fontWeight?: number
  colorDepth?: number
  bgHue?: number
  bgSat?: number
  bgLight?: number
  // Floating toolbar trigger — when user selects text inside the iframe,
  // translate coords to parent document and ask parent to show its toolbar.
  onToolbarShow?: (x: number, y: number, text: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<any>(null)
  const renditionRef = useRef<any>(null)
  // Latest rendered section's Contents objects, keyed by cfiBase. Each Contents
  // exposes .document (the iframe Document) + .window. When annotations change,
  // we iterate this map and re-apply highlights to every known section so
  // marks survive scrolling between chapters.
  const contentsMapRef = useRef<Map<string, any>>(new Map())
  // Navigation state: TOC (chapter list) + current chapter label for the bar.
  const [toc, setToc] = useState<Array<{ label: string; href: string }>>([])
  const tocRef = useRef<Array<{ label: string; href: string }>>([])
  tocRef.current = toc
  const [currentChapter, setCurrentChapter] = useState<string>('')
  const [progressPct, setProgressPct] = useState<number>(0)
  // Track load state so we can show a clear message if the epub failed to load
  // (past symptom: "只看到封面" — usually because flow:'scrolled-doc' never
  //  advanced past the first spine item).
  const [loadErr, setLoadErr] = useState<string | null>(null)

  // Keep the latest annotation list + click handler in refs so the
  // applyHighlights closure (wired into rendition events) always sees the
  // freshest data without needing to re-register event listeners.
  const annsRef = useRef(annotations || [])
  annsRef.current = annotations || []
  const onClickRef = useRef(onAnnotationClick)
  onClickRef.current = onAnnotationClick
  const marksRef = useRef(marks || [])
  marksRef.current = marks || []
  const onRemoveMarkRef = useRef(onRemoveMark)
  onRemoveMarkRef.current = onRemoveMark
  // Floating menu shown when the user right-clicks a mark span inside the
  // iframe. Coords are translated to the parent document so the menu sits
  // under the actual cursor position.
  const [markMenu, setMarkMenu] = useState<{ x: number; y: number; markId: string; markType: string } | null>(null)
  // Same trick for typography props — refs let us read latest values from
  // inside the rendition.on('rendered') closure without re-registering.
  const styleRef = useRef({ fontSize, fontWeight, colorDepth, bgHue, bgSat, bgLight })
  styleRef.current = { fontSize, fontWeight, colorDepth, bgHue, bgSat, bgLight }
  const onToolbarRef = useRef(onToolbarShow)
  onToolbarRef.current = onToolbarShow

  // Compute the body text color from background lightness — matches the
  // formula used by OCR / DOCX viewers so EPUB feels consistent.
  const computeTextColor = () => {
    const { colorDepth: cd, bgLight: bl } = styleRef.current
    return bl < 50
      ? `hsl(40, 15%, ${60 + (100 - cd) / 3}%)`
      : `hsl(30, 20%, ${100 - cd}%)`
  }

  // Apply / re-apply annotation underlines and marker dots inside one
  // iframe's document. Idempotent: clears any prior wrap before redoing the
  // pass, so updates don't accumulate stale spans.
  const applyHighlights = (contents: any) => {
    const doc = contents?.document as Document | undefined
    if (!doc || !doc.body) return

    // Inject / refresh the reading-layout + highlight stylesheet inside the
    // iframe. Re-runs every applyHighlights call so font size / weight /
    // background updates from the parent toolbar take effect immediately.
    // `!important` on the layout rules beats the EPUB's own CSS (many books
    // set body { margin: 0; max-width: none } which would otherwise win).
    let style = doc.getElementById('sj-epub-highlight-style') as HTMLStyleElement | null
    if (!style) {
      style = doc.createElement('style') as HTMLStyleElement
      style.id = 'sj-epub-highlight-style'
      doc.head.appendChild(style)
    }
    const { fontSize: fs, fontWeight: fw, bgHue: bh, bgSat: bsa, bgLight: bl } = styleRef.current
    const textColor = computeTextColor()
    const bgColor = `hsl(${bh}, ${bsa}%, ${bl}%)`
    style.textContent = `
      html, body { box-sizing: border-box !important; background: ${bgColor} !important; }
      body {
        max-width: 860px !important;
        margin: 0 auto !important;
        padding: 40px 56px !important;
        font-family: "Noto Serif SC", "Source Han Serif", Georgia, serif !important;
        line-height: 1.9 !important;
        font-size: ${fs}px !important;
        font-weight: ${fw} !important;
        color: ${textColor} !important;
        text-align: justify !important;
      }
      p { margin: 0 0 1em 0 !important; text-indent: 2em !important; }
      h1, h2, h3 {
        font-family: -apple-system, "Microsoft YaHei", sans-serif !important;
        text-align: center !important;
        text-indent: 0 !important;
        margin: 1.6em 0 1em !important;
        color: ${textColor} !important;
      }
      img { max-width: 100% !important; height: auto !important; display: block !important; margin: 1em auto !important; }
      ::selection { background: rgba(200, 149, 108, 0.35); }
      /* 6-color underline marks + bold highlight, kept in sync with globals.css */
      .mark-underline-yellow { text-decoration: underline; text-decoration-color: #FFD43B; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .mark-underline-red    { text-decoration: underline; text-decoration-color: #FF6B6B; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .mark-underline-green  { text-decoration: underline; text-decoration-color: #51CF66; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .mark-underline-blue   { text-decoration: underline; text-decoration-color: #339AF0; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .mark-underline-purple { text-decoration: underline; text-decoration-color: #CC5DE8; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .mark-underline-orange { text-decoration: underline; text-decoration-color: #FF922B; text-decoration-thickness: 1px; text-underline-offset: 3px; }
      .mark-bold { background: rgba(255,212,59,0.25); border-radius: 2px; }
      /* pointer-events: auto so right-click removal works; marks keep text selectable */
      .ocr-mark { cursor: text; }
      .ocr-ann-underline {
        text-decoration: underline;
        text-decoration-color: rgba(200,149,108,0.5);
        text-decoration-thickness: 1px;
        text-underline-offset: 3px;
        pointer-events: none;
        border-radius: 2px;
      }
      .ocr-ann-marker {
        display: inline-block;
        width: 6px; height: 6px;
        background: #C8956C;
        border-radius: 50%;
        margin: 0 3px 0 1px;
        vertical-align: middle;
        cursor: pointer;
        opacity: 0.7;
        transition: opacity 0.15s, transform 0.15s;
        position: relative;
        top: -1px;
      }
      .ocr-ann-marker:hover { opacity: 1; transform: scale(1.5); }
    `

    // Clear previous annotation + mark spans — unwrap underlines, remove markers.
    doc.body.querySelectorAll('.ocr-ann-underline, .ocr-ann-marker, .ocr-mark').forEach(el => {
      try {
        const parent = el.parentNode
        if (!parent) return
        if (el.classList.contains('ocr-ann-marker')) { parent.removeChild(el); return }
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
      } catch {}
    })
    try { doc.body.normalize() } catch {}

    // Render inline marks (bold + 6-color underlines) same way DocxViewer does,
    // but inside the iframe document.
    const mks = marksRef.current
    if (mks.length) {
      const markTargets = mks.map(m => ({ text: m.selectedText, id: m.id, type: m.type, color: m.color }))
      findAndWrapAll(doc.body, markTargets, (target) => {
        const t = target as typeof markTargets[number]
        const span = doc.createElement('span')
        span.className = t.type === 'bold' ? 'ocr-mark mark-bold' : `ocr-mark mark-underline-${t.color || 'yellow'}`
        ;(span as any).dataset.markId = t.id
        ;(span as any).dataset.markType = t.type
        return span
      }, 'ocr-mark')
      // Right-click a mark inside the iframe opens the mark menu (parent doc
      // floating div). Translate iframe coords to parent coords so the menu
      // appears under the real cursor position.
      const iframeEl: HTMLIFrameElement | null =
        (contents as any).iframe || (doc.defaultView?.frameElement as HTMLIFrameElement | null)
      doc.body.oncontextmenu = (e: Event) => {
        const me = e as MouseEvent
        const target = me.target as HTMLElement | null
        const span = target?.closest?.('.ocr-mark[data-mark-id]') as HTMLElement | null
        if (!span) return
        e.preventDefault()
        const iframeRect = iframeEl?.getBoundingClientRect() || { left: 0, top: 0 }
        setMarkMenu({
          x: iframeRect.left + me.clientX,
          y: iframeRect.top + me.clientY,
          markId: span.dataset.markId || '',
          markType: span.dataset.markType || '',
        })
      }
    }

    const anns = annsRef.current
    if (!anns.length) return

    const targets = anns.map(a => ({ text: a.selectedText, id: a.id }))
    findAndWrapAll(doc.body, targets, (target) => {
      const span = doc.createElement('span')
      span.className = 'ocr-ann-underline'
      ;(span as any).dataset.annId = (target as any).id
      return span
    }, 'ocr-ann-underline')

    // Insert a clickable dot marker right before the first underline span of
    // each distinct annotation. pointerEvents:none on the underline keeps text
    // selection intact, so the marker is the only "click to open" surface.
    const highlighted = doc.body.querySelectorAll('.ocr-ann-underline[data-ann-id]')
    const seen = new Set<string>()
    highlighted.forEach(el => {
      const annId = (el as HTMLElement).dataset.annId
      if (!annId || seen.has(annId)) return
      seen.add(annId)
      const marker = doc.createElement('span')
      marker.className = 'ocr-ann-marker'
      ;(marker as any).dataset.annId = annId
      marker.addEventListener('click', (e) => {
        e.stopPropagation()
        onClickRef.current?.(annId)
      })
      el.parentNode?.insertBefore(marker, el)
    })
  }

  // Re-apply whenever annotations OR typography props change. Iterate all
  // iframes we've seen so far. New sections rendered later will apply on
  // their own 'rendered' event with the latest values via styleRef.
  useEffect(() => {
    for (const contents of contentsMapRef.current.values()) {
      applyHighlights(contents)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, marks, fontSize, fontWeight, colorDepth, bgHue, bgSat, bgLight])

  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    async function loadEpub() {
      const ePub = (await import('epubjs')).default
      const buf = await window.electronAPI.readFileBuffer(absPath)
      const book = ePub(buf.buffer)
      bookRef.current = book

      if (destroyed || !containerRef.current) return

      // flow: 'scrolled' renders all spine items in one continuous scroll area
      // so封面之后用户直接滚动就能看到正文。scrolled-doc 只渲染当前 section，
      // 在没有导航 UI 的情况下会表现为"只看到封面，翻不动"。
      // manager: 'continuous' 让 epub.js 按需懒加载相邻 sections，不会一次性
      // 把整本书灌进 DOM（内存安全）。
      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'scrolled',
        manager: 'continuous',
        allowScriptedContent: true,
      })
      renditionRef.current = rendition

      // Reading layout: body centered with comfortable reading width.
      // max-width 760 → 860 gives Chinese prose more breathing room in wide
      // viewports without losing legibility (optimal 45-75 CJK chars / line).
      // padding block 40/56 makes chapter headings breathe at the top.
      rendition.themes.default({
        'html': { 'height': '100%' },
        'body': {
          'font-family': '"Noto Serif SC", "Source Han Serif", Georgia, serif',
          'line-height': '1.9',
          'max-width': '860px',
          'margin': '0 auto',
          'padding': '40px 56px',
          'text-align': 'justify',
          'color': '#3D3529',
          'font-size': '17px',
        },
        'h1,h2,h3': {
          'font-family': '-apple-system, "Microsoft YaHei", sans-serif',
          'text-align': 'center',
          'margin-top': '1.6em',
          'margin-bottom': '1em',
        },
        'p': { 'margin': '0 0 1em 0', 'text-indent': '2em' },
        'img': { 'max-width': '100%', 'height': 'auto', 'margin': '1em auto', 'display': 'block' },
      })

      // Capture text selection inside iframe and surface it ONLY to the
      // floating toolbar. We deliberately do NOT setTextSelection here —
      // doing that would auto-open the annotation panel the instant the user
      // highlights text, which was the legacy EPUB behavior. The new
      // contract (matching PDF/OCR/DOCX) is: selecting just shows the
      // toolbar; the annotation side-panel only opens when the user clicks
      // the toolbar's "注释" button.
      rendition.on('selected', (_cfiRange: string, contents: any) => {
        const win = contents?.window as Window | undefined
        const sel = win?.getSelection()
        if (!sel || sel.rangeCount === 0) return
        const text = sel.toString().trim()
        if (!text || text.length < 2) return

        try {
          const range = sel.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          // contents.iframe gives the iframe element; fall back to searching
          // the container for it if not exposed.
          const iframeEl: HTMLIFrameElement | null =
            contents.iframe || (contents.document?.defaultView?.frameElement as HTMLIFrameElement | null)
          const iframeRect = iframeEl?.getBoundingClientRect() || { left: 0, top: 0 }
          const x = iframeRect.left + rect.left + rect.width / 2
          const y = iframeRect.top + rect.bottom + 6
          onToolbarRef.current?.(x, y, text)
        } catch (err) {
          console.warn('[epub] toolbar bridge failed', err)
        }
      })

      // After each section renders (or re-renders), cache its Contents object
      // and paint annotation highlights. For scrolled-doc flow, multiple
      // sections may be live at once — getContents() returns them all.
      // Track min rendered spine idx + scroll height so we can detect prepend
      // (upward continuous load) and compensate scrollTop. Without this, when
      // the user scrolls up past a section boundary, epub.js prepends the
      // previous chapter and scrollTop stays at its small value — so the
      // content the user was reading jumps downward = "闪回下来".
      let minRenderedIdx = Infinity
      let lastContainerHeight = 0
      rendition.on('rendered', (section: any) => {
        try {
          const list = rendition.getContents() as any[]
          list.forEach((c) => {
            if (c?.cfiBase) contentsMapRef.current.set(c.cfiBase, c)
            applyHighlights(c)
          })
          // Update chapter label from the spine item's nearest TOC entry
          if (section?.href) {
            const match = book.navigation?.get(section.href)
            if (match?.label) setCurrentChapter(match.label.trim())
          }
          // Prepend compensation
          const scrollEl = containerRef.current
          if (scrollEl && typeof section?.index === 'number') {
            const newHeight = scrollEl.scrollHeight
            const prepended = section.index < minRenderedIdx && lastContainerHeight > 0
            if (prepended) {
              const delta = newHeight - lastContainerHeight
              if (delta > 0) scrollEl.scrollTop += delta
            }
            if (section.index < minRenderedIdx) minRenderedIdx = section.index
            lastContainerHeight = newHeight
          }
        } catch (err) {
          console.error('[epub] highlight pass failed', err)
        }
      })

      // Debounced save of current CFI so reopening the book resumes here.
      let cfiSaveTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleCfiSave = (cfi: string) => {
        if (cfiSaveTimer) clearTimeout(cfiSaveTimer)
        cfiSaveTimer = setTimeout(() => {
          useLibraryStore.getState().updatePdfMeta(meta => ({ ...meta, lastReadCfi: cfi })).catch(() => {})
        }, 1500)
      }

      // Track reading progress + chapter label + current "page" (= TOC idx)
      // on every relocate.
      //
      // Why TOC idx and not spine idx: books have cover / copyright /
      // preface entries in their spine before "第一章", so using spine
      // index would label real chapter 1 as "第 4 章" or so. Matching
      // current href against the flat TOC gives the user-visible numbering.
      rendition.on('relocated', (location: any) => {
        try {
          // Persist CFI for resume-on-reopen
          const curCfi = location?.start?.cfi
          if (typeof curCfi === 'string' && curCfi) scheduleCfiSave(curCfi)
          if (location?.start?.percentage !== undefined) {
            setProgressPct(Math.round(location.start.percentage * 100))
          }
          const href: string | undefined = location?.start?.href
          if (!href) return
          const match = book.navigation?.get(href)
          if (match?.label) setCurrentChapter(match.label.trim())

          const flat = tocRef.current
          // Normalize: drop #fragment so "ch3.xhtml#s2" matches "ch3.xhtml".
          const cur = href.split('#')[0]
          let idx = flat.findIndex(t => t.href.split('#')[0] === cur)
          // Fallback: prefix match (some EPUBs have nested paths that
          // startWith the TOC base).
          if (idx < 0) idx = flat.findIndex(t => cur.endsWith(t.href.split('#')[0]) || t.href.endsWith(cur))
          if (idx >= 0) {
            useUiStore.getState().setCurrentVisiblePage(idx + 1)
            return
          }
          // Still no match: fall back to spine idx (better than nothing)
          const spineIdx = location?.start?.index
          if (typeof spineIdx === 'number' && spineIdx >= 0) {
            useUiStore.getState().setCurrentVisiblePage(spineIdx + 1)
          }
        } catch {}
      })

      // Resume from last saved CFI if any (set by relocated handler last
      // session). Falls back to opening at the spine's first item.
      const savedCfi = useLibraryStore.getState().currentPdfMeta?.lastReadCfi
      try {
        await rendition.display(savedCfi || undefined)
      } catch {
        await rendition.display()
      }

      // Generate the locations index so location.start.percentage works
      // (without this, progressPct stays 0%). 1500 chars per location is
      // a reasonable balance between progress granularity and load time.
      // Done in background so book display isn't blocked; relocated events
      // fired before generation completes will simply lack percentage.
      ;(async () => {
        try {
          await book.locations.generate(1500)
          // Trigger a synthetic relocate so progressPct updates immediately
          // for the current position.
          const cur = rendition.currentLocation()
          const pct = (cur as any)?.start?.percentage
          if (typeof pct === 'number') setProgressPct(Math.round(pct * 100))
        } catch (err) {
          console.warn('[epub] locations.generate failed', err)
        }
      })()

      // Load table of contents for the nav dropdown. book.loaded.navigation
      // resolves once the NCX / nav.xhtml is parsed.
      try {
        const nav = await book.loaded.navigation
        const flat: Array<{ label: string; href: string }> = []
        const walk = (items: any[]) => {
          for (const it of items) {
            if (it?.label && it?.href) flat.push({ label: it.label.trim(), href: it.href })
            if (it?.subitems?.length) walk(it.subitems)
          }
        }
        walk((nav as any)?.toc || [])
        if (!destroyed) {
          setToc(flat)
          // Publish TOC labels to uiStore so AnnotationPanel's group headers
          // can say "第一章 好吃嘴" instead of "第 3 章" (which was actually
          // spine idx 3, i.e. raw position including cover/preface).
          useUiStore.getState().setCurrentDocTocLabels(flat.map(f => f.label))
        }
      } catch (err) {
        console.warn('[epub] TOC load failed', err)
      }
    }

    loadEpub().catch(err => {
      console.error('[epub] Load error:', err)
      setLoadErr(err?.message || String(err))
    })

    return () => {
      destroyed = true
      contentsMapRef.current.clear()
      if (renditionRef.current) try { renditionRef.current.destroy() } catch {}
      if (bookRef.current) try { bookRef.current.destroy() } catch {}
      // Clear TOC labels so AnnotationPanel doesn't show stale chapter names
      // if the user switches to a PDF/DOCX after an EPUB.
      useUiStore.getState().setCurrentDocTocLabels(null)
    }
  }, [absPath, onTextSelect])

  // Layout-change resize: when annotation panel / sidebar toggles, the
  // container width changes but epub.js doesn't auto-detect it and leaves
  // a blank strip on the right. Triggered after a 350 ms delay so CSS
  // transitions have settled, then call rendition.resize() with no args
  // (epub.js reads container dimensions itself). The earlier ResizeObserver
  // approach fired too often and fought with epub.js internal layout,
  // producing a blank page; this debounced listen-to-state approach is
  // gentler.
  const annotationPanelCollapsed = useUiStore(s => s.annotationPanelCollapsed)
  const sidebarCollapsed = useUiStore(s => s.sidebarCollapsed)
  const rightPanel = useUiStore(s => s.rightPanel)
  useEffect(() => {
    const t = setTimeout(() => {
      const r = renditionRef.current
      const el = containerRef.current
      if (!r) return
      try {
        if (el?.clientWidth && el?.clientHeight) {
          r.resize(el.clientWidth, el.clientHeight)
        } else {
          r.resize()
        }
      } catch (err) { console.warn('[epub] resize failed', err) }
      // Nudge epub.js internal window-resize listeners. overflow-anchor on
      // the container keeps reading position pinned, so we no longer need
      // the heavy display(cfi) round-trip.
      try { window.dispatchEvent(new Event('resize')) } catch {}
    }, 200)
    return () => clearTimeout(t)
  }, [annotationPanelCollapsed, sidebarCollapsed, rightPanel])

  // Container-width ResizeObserver: catches user dragging the annotation
  // panel divider (which doesn't change uiStore state, so the toggling
  // effect doesn't fire). Short debounce — long values made dragging feel
  // unresponsive ("拖完还要等 0.5 秒才动"). 150ms strikes a balance: brief
  // pause after the user stops moving, then reflow.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let lastW = el.clientWidth
    let timer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (Math.abs(w - lastW) < 5) return  // ignore tiny noise
      lastW = w
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const r = renditionRef.current
        if (!r) return
        try { r.resize(el.clientWidth, el.clientHeight) } catch {}
        try { window.dispatchEvent(new Event('resize')) } catch {}
      }, 150)
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (timer) clearTimeout(timer) }
  }, [])

  // Keyboard: ← previous chapter · → next chapter. Attached at the wrapper
  // level so focus inside the iframe doesn't need to bubble for it to work
  // — we use capture phase on window to catch it regardless of focus target.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      const r = renditionRef.current
      if (!r) return
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { r.next(); e.preventDefault() }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { r.prev(); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const gotoHref = (href: string) => {
    try { renditionRef.current?.display(href) } catch (err) { console.error('[epub] goto failed', err) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: 'var(--bg)' }}>
      {/* Top nav bar — chapter dropdown + prev/next + progress */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', borderBottom: '1px solid var(--border-light)',
        background: 'var(--bg-warm)', fontSize: 12, flexShrink: 0,
      }}>
        <button
          onClick={() => renditionRef.current?.prev()}
          title="上一章（←）"
          style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', cursor: 'pointer' }}
        >← 上一章</button>
        <button
          onClick={() => renditionRef.current?.next()}
          title="下一章（→）"
          style={{ padding: '3px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', cursor: 'pointer' }}
        >下一章 →</button>
        {toc.length > 0 && (
          <select
            value=""
            onChange={e => { if (e.target.value) gotoHref(e.target.value) }}
            title="跳转到章节"
            style={{ fontSize: 11, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', maxWidth: 260 }}
          >
            <option value="">目录（{toc.length} 章）…</option>
            {toc.map((t, i) => (
              <option key={i} value={t.href}>{t.label}</option>
            ))}
          </select>
        )}
        <span style={{ flex: 1, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {currentChapter || (loadErr ? `加载失败：${loadErr}` : '—')}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{progressPct}%</span>
      </div>
      {/* Book content. overflow-anchor:auto lets the browser keep the
          currently-visible content pinned when epub.js prepends a previous
          section above (fixes "向上翻闪回下来"). */}
      <div ref={containerRef} style={{ flex: 1, width: '100%', overflow: 'auto', overflowAnchor: 'auto', background: 'var(--bg)' }} />
      {/* Mark remove menu — floats at translated cursor position */}
      {markMenu && (
        <div style={{
          position: 'fixed', left: markMenu.x, top: markMenu.y, zIndex: 1000,
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)', padding: 4, minWidth: 120,
        }}
          onMouseLeave={() => setMarkMenu(null)}
        >
          <button
            onClick={() => {
              onRemoveMarkRef.current?.(markMenu.markId)
              setMarkMenu(null)
            }}
            style={{ padding: '6px 12px', fontSize: 12, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text)', width: '100%', textAlign: 'left', borderRadius: 4 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeaveCapture={e => (e.currentTarget.style.background = 'none')}
          >
            {markMenu.markType === 'bold' ? '取消高亮' : '取消划线'}
          </button>
          <button
            onClick={() => setMarkMenu(null)}
            style={{ padding: '6px 12px', fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', width: '100%', textAlign: 'left', borderRadius: 4 }}
          >
            关闭
          </button>
        </div>
      )}
    </div>
  )
}

// DOCX viewer: convert to HTML using mammoth
function DocxViewer({ absPath, onTextSelect, annotations, marks, onAnnotationClick, onRemoveMark, activeSelectionText, searchHighlight }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
  annotations?: Array<{ id: string; selectedText: string }>
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onAnnotationClick?: (id: string) => void
  onRemoveMark?: (id: string) => void
  activeSelectionText?: string
  searchHighlight?: string | null
}) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [markMenu, setMarkMenu] = useState<{ x: number; y: number; markId: string; markType: string } | null>(null)

  useEffect(() => {
    async function convert() {
      try {
        const mammoth = await import('mammoth')
        const buf = await window.electronAPI.readFileBuffer(absPath)
        const result = await mammoth.convertToHtml({ arrayBuffer: buf.buffer })
        setHtml(result.value)
      } catch (err: any) {
        setError(err.message)
      }
    }
    convert()
  }, [absPath])

  // Highlight annotations
  useAnnotationHighlights(containerRef, annotations || [], onAnnotationClick || (() => {}), [html, annotations])
  // Search highlight
  useSearchHighlight(containerRef, searchHighlight, [html, searchHighlight])

  // Render marks
  useEffect(() => {
    const container = containerRef.current
    if (!container || !marks || marks.length === 0) return
    container.querySelectorAll('.ocr-mark').forEach(el => {
      try { const p = el.parentNode; if (p) { while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el) } } catch {}
    })
    try { container.normalize() } catch {}
    const targets = marks.map(m => ({ text: m.selectedText, id: m.id, type: m.type, color: m.color }))
    findAndWrapAll(container, targets, (target) => {
      const t = target as typeof targets[number]
      const span = document.createElement('span')
      span.className = t.type === 'bold' ? 'ocr-mark mark-bold' : `ocr-mark mark-underline-${t.color || 'yellow'}`
      span.dataset.markId = t.id; span.dataset.markType = t.type
      return span
    }, 'ocr-mark')
    const handleCtx = (e: MouseEvent) => {
      container.querySelectorAll('.ocr-mark[data-mark-id]').forEach(el => {
        const r = el.getBoundingClientRect()
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          e.preventDefault(); e.stopPropagation()
          setMarkMenu({ x: e.clientX, y: e.clientY, markId: (el as HTMLElement).dataset.markId!, markType: (el as HTMLElement).dataset.markType || '' })
        }
      })
    }
    container.addEventListener('contextmenu', handleCtx)
    return () => container.removeEventListener('contextmenu', handleCtx)
  }, [marks, html])

  if (error) return <div className="empty-state"><span>DOCX 解析失败：{error}</span></div>
  if (!html) return <div className="empty-state"><span className="loading-spinner" /><span>正在转换 DOCX...</span></div>

  return (
    <>
      <div ref={containerRef}
        style={{
          maxWidth: 'min(95%, 1400px)', margin: '0 auto',
          padding: '32px clamp(28px, 4vw, 72px) 80px',
          fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit',
          lineHeight: 2, fontFamily: 'var(--font-serif)', position: 'relative',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {markMenu && (
        <div style={{ position: 'fixed', left: markMenu.x, top: markMenu.y, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 100, padding: 4 }}>
          <button onClick={() => { onRemoveMark?.(markMenu.markId); setMarkMenu(null) }}
            style={{ padding: '4px 12px', fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger)', width: '100%', textAlign: 'left' }}>
            取消{markMenu.markType === 'bold' ? '加粗' : '划线'}
          </button>
          <button onClick={() => setMarkMenu(null)} style={{ padding: '4px 12px', fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', width: '100%', textAlign: 'left' }}>关闭</button>
        </div>
      )}
    </>
  )
}

// Simple text file reader
function TextFileContent({ absPath, annotations, onAnnotationClick, marks, onRemoveMark, activeSelectionText, fontSize, fontWeight, color, searchHighlight }: {
  absPath: string
  annotations?: Array<{ id: string; selectedText: string }>
  onAnnotationClick?: (id: string) => void
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onRemoveMark?: (id: string) => void
  activeSelectionText?: string
  fontSize?: number
  fontWeight?: number
  color?: string
  searchHighlight?: string | null
}) {
  const [text, setText] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [markMenu, setMarkMenu] = useState<{ x: number; y: number; markId: string; markType: string } | null>(null)

  useEffect(() => {
    window.electronAPI.readFileBuffer(absPath).then(buf => {
      const decoder = new TextDecoder('utf-8')
      setText(decoder.decode(buf))
    }).catch(() => setText('无法读取文件'))
  }, [absPath])

  // Highlight annotations
  useAnnotationHighlights(containerRef, annotations || [], onAnnotationClick || (() => {}), [text, annotations])
  // Search highlight
  useSearchHighlight(containerRef, searchHighlight, [text, searchHighlight])

  // Render marks (underline/bold)
  useEffect(() => {
    const container = containerRef.current
    if (!container || !marks || marks.length === 0) return

    container.querySelectorAll('.ocr-mark').forEach(el => {
      try {
        const parent = el.parentNode
        if (parent) { while (el.firstChild) parent.insertBefore(el.firstChild, el); parent.removeChild(el) }
      } catch {}
    })
    try { container.normalize() } catch {}

    const targets = marks.map(m => ({ text: m.selectedText, id: m.id, type: m.type, color: m.color }))
    findAndWrapAll(container, targets, (target) => {
      const t = target as typeof targets[number]
      const span = document.createElement('span')
      span.className = t.type === 'bold' ? 'ocr-mark mark-bold' : `ocr-mark mark-underline-${t.color || 'yellow'}`
      span.dataset.markId = t.id
      span.dataset.markType = t.type
      return span
    }, 'ocr-mark')

    const handleMarkContext = (e: MouseEvent) => {
      const markEls = container.querySelectorAll('.ocr-mark[data-mark-id]')
      for (const el of markEls) {
        const rect = el.getBoundingClientRect()
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
          e.preventDefault(); e.stopPropagation()
          setMarkMenu({ x: e.clientX, y: e.clientY, markId: (el as HTMLElement).dataset.markId!, markType: (el as HTMLElement).dataset.markType || '' })
          return
        }
      }
    }
    container.addEventListener('contextmenu', handleMarkContext)
    return () => container.removeEventListener('contextmenu', handleMarkContext)
  }, [marks, text])

  // Highlight active selection
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.querySelectorAll('.active-selection-highlight').forEach(el => {
      const parent = el.parentNode
      if (parent) { while (el.firstChild) parent.insertBefore(el.firstChild, el); parent.removeChild(el) }
    })
    if (!activeSelectionText) return
    try { container.normalize() } catch {}
    findAndWrapAll(container, [{ text: activeSelectionText }], () => {
      const span = document.createElement('span')
      span.className = 'active-selection-highlight'
      span.style.cssText = 'background: rgba(200, 149, 108, 0.25); border-radius: 2px;'
      return span
    })
  }, [activeSelectionText, text])

  if (!text) return <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
  return (
    <div ref={containerRef} className="ocr-markdown-content" style={{
      fontSize: fontSize ?? 16,
      fontWeight: fontWeight ?? 400,
      lineHeight: 2,
      position: 'relative',
      color: color || undefined,
    }}>
      <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{text}</Markdown>
      {markMenu && (
        <div style={{ position: 'fixed', left: markMenu.x, top: markMenu.y, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 100, padding: 4 }}>
          <button onClick={() => { onRemoveMark?.(markMenu.markId); setMarkMenu(null) }}
            style={{ padding: '4px 12px', fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--danger)', width: '100%', textAlign: 'left' }}>
            取消{markMenu.markType === 'bold' ? '加粗' : '划线'}
          </button>
          <button onClick={() => setMarkMenu(null)} style={{ padding: '4px 12px', fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', width: '100%', textAlign: 'left' }}>关闭</button>
        </div>
      )}
    </div>
  )
}


// ===== ImmersiveOcrReader / ImmersiveAnnotationBox 已删(2026-04-28 CLEAN · 沉浸式阅读下线) =====
// 原本 ~400 行的两个 dormant 组件,toggle 入口早已移除 → 永远 unreachable,一并清掉。

type ViewMode = 'pdf' | 'ocr'

// Viewport-aware PDF page. When `inRange` is false we render a minimal
// placeholder div (keeps the wrapper mounted so IntersectionObserver still
// fires as the user scrolls near it) and skip react-pdf's <Page> entirely.
// This is the key fix for big-PDF lag: a 500-page document used to mount
// 500 <Page> canvases on load; now only ~5 mount at a time.
function LazyPdfPage({
  pageNum, scale, inRange, onVisible,
}: {
  pageNum: number
  scale: number
  inRange: boolean
  onVisible: (pageNum: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Widen-mounted observer: 400px rootMargin expands the preload range as the
  // user scrolls close. Note: "current page" for AnnotationPanel's page-group
  // auto-expansion is tracked by a separate scroll listener on the PdfViewer's
  // scroll container (see useCurrentVisiblePage hook) because a 0.5-threshold
  // observer fails for pages taller than the viewport.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const wideIo = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) onVisible(pageNum)
      }
    }, { rootMargin: '400px 0px' })
    wideIo.observe(el)
    return () => wideIo.disconnect()
  }, [pageNum, onVisible])

  // Placeholder keeps roughly the same height as a real page so scrollbar
  // doesn't jump when pages materialize. 800 * scale ~= typical A4 at 100%.
  const phHeight = 800 * scale
  return (
    <div
      ref={ref}
      className="pdf-page-wrapper"
      data-page-number={pageNum}
      style={{ position: 'relative', minHeight: inRange ? undefined : phHeight }}
    >
      <div style={{
        position: 'absolute', top: 4, right: 8, fontSize: 11,
        color: '#999', background: 'rgba(255,255,255,0.85)', padding: '2px 8px',
        borderRadius: 4, zIndex: 5,
      }}>
        {pageNum}
      </div>
      {inRange ? (
        <Page
          pageNumber={pageNum}
          scale={scale}
          renderTextLayer={true}
          renderAnnotationLayer={false}
          loading={
            <div style={{ width: 600 * scale, height: phHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
              第 {pageNum} 页...
            </div>
          }
          onLoadError={(err) => console.warn(`[pdf] page ${pageNum} load error`, err)}
          onRenderError={(err) => console.warn(`[pdf] page ${pageNum} render error`, err)}
        />
      ) : (
        <div style={{ width: 600 * scale, height: phHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12, background: 'rgba(0,0,0,0.02)' }}>
          第 {pageNum} 页（滚动到此自动加载）
        </div>
      )}
    </div>
  )
}

export default function PdfViewer() {
  // PERF-R8#4 · zustand 全量解构 → selector 订阅(对照 PERF-R7#1 在 App.tsx 做的)。
  //   原:`const { ... 4 fields } = useLibraryStore()` + `const { ... 9 fields } = useUiStore()`
  //   两次全量订阅,任何 store 字段变化都让 PdfViewer 重渲(currentVisiblePage / scrollPos
  //   等高频字段会刷得很多次)。改成 13 个独立 selector 后只对真正用到的字段订阅。
  const currentEntry = useLibraryStore(s => s.currentEntry)
  const currentPdfMeta = useLibraryStore(s => s.currentPdfMeta)
  const updatePdfMeta = useLibraryStore(s => s.updatePdfMeta)
  const updateEntry = useLibraryStore(s => s.updateEntry)
  const textSelection = useUiStore(s => s.textSelection)
  const setTextSelection = useUiStore(s => s.setTextSelection)
  const setActiveAnnotation = useUiStore(s => s.setActiveAnnotation)
  const glmApiKeyStatus = useUiStore(s => s.glmApiKeyStatus)
  // 2026-04-28 CLEAN · immersiveMode + dualPageMode 已下线,所有 immersive 分支
  //   都按"非沉浸式"路径执行(等价于 immersiveMode 永远 false)。
  const darkMode = useUiStore(s => s.darkMode)
  const searchHighlight = useUiStore(s => s.searchHighlight)
  const setSearchHighlight = useUiStore(s => s.setSearchHighlight)
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.0)
  // Which pages are currently "in render range" — others render as a fixed-
  // height placeholder so react-pdf doesn't instantiate 500 <Page> canvases
  // at once. Updated from an IntersectionObserver on each page wrapper.
  // Initial range covers first 3 pages; observer expands as user scrolls.
  const [pageRenderRange, setPageRenderRange] = useState<{ start: number; end: number }>({ start: 1, end: 3 })
  // debounced scale — so dragging the zoom slider (or rapid +/- keys) doesn't
  // force every visible Page canvas to re-rasterize on each tick.
  const [debouncedScale, setDebouncedScale] = useState(1.0)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedScale(scale), 120)
    return () => clearTimeout(t)
  }, [scale])
  const [pdfFileUrl, setPdfFileUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<number>(0)
  // PDF outline (table of contents) — populated in onDocumentLoadSuccess
  const [outline, setOutline] = useState<Array<{ title: string; dest: any; items?: any[] }> | null>(null)
  const [showOutline, setShowOutline] = useState(false)
  const pdfDocRef = useRef<any>(null)  // PDFDocumentProxy from react-pdf for getPageIndex
  // Page jump: input state + refs for the toolbar input
  const [pageJumpInput, setPageJumpInput] = useState('')
  const pageJumpRef = useRef<HTMLInputElement>(null)
  // Re-reading reminder: shown when user re-opens a doc they annotated before.
  // annCount/lastTime are the fallback static info; aiVoice is the AI-generated
  // single-sentence greeting that uses the user's own past notes as hooks.
  // aiVoice is null while fetching or if AI isn't available (no key / failed).
  const [rereadingReminder, setRereadingReminder] = useState<{ annCount: number; lastTime: string; aiVoice: string | null; aiLoading: boolean } | null>(null)
  const [ocrProgress, setOcrProgress] = useState<{ status: string } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('pdf')
  // When a doc opens, switch to whatever view the user was last in (so the
  // saved scrollTop applies to the right layout). Only auto-switches once
  // per doc-open — user can still toggle freely.
  useEffect(() => {
    const saved = useLibraryStore.getState().currentPdfMeta?.lastReadViewMode
    if (saved && saved !== viewMode) setViewMode(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry?.id, currentPdfMeta?.entryId])
  const [ocrFullText, setOcrFullText] = useState<string | null>(null)
  const [ocrFilePath, setOcrFilePath] = useState<string | null>(null)
  // 2026-04-28 CLEAN · "编辑"功能彻底删除(用户决定下线)。
  //   editMode / editContent / editDirty state 全部移除;按钮 + textarea + cleanup 同步删。
  // Persisted reading preferences
  // BUG-FIX R8#8 · 走 readNumber 兜底 NaN(原 lsGet 没防,坏数据时 fontSize: NaN 导致 OCR 文本不可读)
  const lsGet = (key: string, def: number) => readNumber(key, def)
  const lsSet = (key: string, v: number, setter: (v: number) => void) => { setter(v); try { localStorage.setItem(key, String(v)) } catch {} }
  const [ocrFontSize, _setOcrFontSize] = useState(() => lsGet('sj-fontSize', 16))
  const [ocrFontWeight, _setOcrFontWeight] = useState(() => lsGet('sj-fontWeight', 400))
  const [ocrColorDepth, _setOcrColorDepth] = useState(() => lsGet('sj-colorDepth', 80))
  const [ocrBgHue, _setOcrBgHue] = useState(() => lsGet('sj-bgHue', 40))
  const [ocrBgSat, _setOcrBgSat] = useState(() => lsGet('sj-bgSat', 30))
  const [ocrBgLight, _setOcrBgLight] = useState(() => lsGet('sj-bgLight', 97))
  const setOcrFontSize = (v: number) => lsSet('sj-fontSize', v, _setOcrFontSize)
  const setOcrFontWeight = (v: number) => lsSet('sj-fontWeight', v, _setOcrFontWeight)
  const setOcrColorDepth = (v: number) => lsSet('sj-colorDepth', v, _setOcrColorDepth)
  const setOcrBgHue = (v: number) => lsSet('sj-bgHue', v, _setOcrBgHue)
  const setOcrBgSat = (v: number) => lsSet('sj-bgSat', v, _setOcrBgSat)
  const setOcrBgLight = (v: number) => lsSet('sj-bgLight', v, _setOcrBgLight)
  const [showBgPicker, setShowBgPicker] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Save scroll position before entering immersive mode to restore on exit
  const savedScrollPos = useRef<number>(0)

  // 2026-04-28 CLEAN · "回顾"功能彻底删除(用户决定下线)。
  //   原有 `reviewing` state + `reviewStreamIdRef` 已移除;按钮 JSX 也一并删。
  //   `closingPrompt.ts` 留着不删,以防未来想恢复或港成 skill。

  // Track the "dominant visible page" inside the PDF scroll container so the
  // annotation panel's page-grouped list can auto-expand the right page.
  //
  // Why a scroll listener (not IntersectionObserver 0.5-threshold): when a
  // PDF page is taller than the viewport — the common case for A4 / book
  // scans on a 1080p screen — intersectionRatio never reaches 0.5 and the
  // observer never fires. The scroll-listener geometry check picks whichever
  // page's wrapper contains the viewport's vertical midpoint, which works
  // regardless of page-vs-viewport size ratio.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf: number | null = null
    // Debounced save of scrollTop AND viewMode to PdfMeta for resume-on-reopen.
    // Stored per-viewMode so PDF view scroll doesn't override OCR view
    // position (and vice versa). Also remembers which view the user was
    // last in so the next session opens that view automatically.
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    // Capture the entry id at effect-bind time so debounced writes go to the
    // right doc even if the user already started navigating to a new entry.
    const lockedEntryId = currentEntry?.id
    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        const top = Math.round(el.scrollTop)
        if (top <= 10 || !lockedEntryId) return
        const modeKey: 'pdf' | 'ocr' = viewMode === 'ocr' ? 'ocr' : 'pdf'
        useLibraryStore.getState().updatePdfMetaByEntryId(lockedEntryId, meta => ({
          ...meta,
          lastReadScrollTopByMode: { ...(meta.lastReadScrollTopByMode || {}), [modeKey]: top },
          lastReadViewMode: modeKey,
        })).catch(() => {})
      }, 1500)
    }
    const recompute = () => {
      raf = null
      const rect = el.getBoundingClientRect()
      const mid = rect.top + rect.height / 2
      // [data-page-number] covers PDF view's .pdf-page-wrapper and OCR view's
      // per-page <div data-page-number={n}>. For formats without real pages
      // (EPUB / DOCX / HTML / TXT / MD) we fall back to a "virtual page" =
      // floor(scrollTop / viewportHeight) + 1. One virtual page per
      // viewport-scroll-step is coarse but consistent with how users
      // navigate continuous documents visually.
      const wrappers = el.querySelectorAll<HTMLElement>('[data-page-number]')
      let best: { page: number; dist: number } | null = null
      for (const w of wrappers) {
        const r = w.getBoundingClientRect()
        const wCenter = r.top + r.height / 2
        const dist = Math.abs(wCenter - mid)
        const pageAttr = w.getAttribute('data-page-number')
        const p = pageAttr ? Number(pageAttr) : 0
        if (p > 0 && (!best || dist < best.dist)) best = { page: p, dist }
      }
      if (best) {
        useUiStore.getState().setCurrentVisiblePage(best.page)
        return
      }
      // Fallback: virtual page by scroll position
      const vh = el.clientHeight || 800
      const virtualPage = Math.max(1, Math.floor(el.scrollTop / vh) + 1)
      useUiStore.getState().setCurrentVisiblePage(virtualPage)
    }
    const onScroll = () => {
      scheduleSave()
      if (raf !== null) return
      raf = requestAnimationFrame(recompute)
    }
    // Restore last reading position. Layout / OCR text mount is async — a
    // single 600ms attempt can fire before scrollHeight is large enough to
    // accept the saved value (browser silently clamps to max). We retry at
    // 300 / 800 / 2000 ms; once we've successfully placed scrollTop within
    // a small tolerance of the target we stop.
    const modeKey: 'pdf' | 'ocr' = viewMode === 'ocr' ? 'ocr' : 'pdf'
    const meta0 = useLibraryStore.getState().currentPdfMeta
    const perMode = meta0?.lastReadScrollTopByMode?.[modeKey]
    const saved = (typeof perMode === 'number' ? perMode : undefined)
      ?? (meta0?.lastReadViewMode === modeKey ? meta0?.lastReadScrollTop : undefined)
    const restoreTimers: ReturnType<typeof setTimeout>[] = []
    if (typeof saved === 'number' && saved > 10) {
      // Hide content during restore so the user doesn't see a "jump from
      // top". Visibility:hidden keeps layout flowing (so scrollHeight grows
      // normally) but no flash of unscrolled-content.
      el.style.visibility = 'hidden'
      let placed = false
      const showAgain = () => { el.style.visibility = '' }
      const tryRestore = () => {
        if (placed) return true
        if (el.scrollTop > 10) { placed = true; showAgain(); return true }
        const maxScroll = el.scrollHeight - el.clientHeight
        if (maxScroll < saved - 50) return false  // not yet enough content
        el.scrollTop = saved
        if (Math.abs(el.scrollTop - saved) < 30) {
          placed = true; showAgain(); return true
        }
        return false
      }
      ;[80, 200, 500, 1000, 2000].forEach(delay => {
        restoreTimers.push(setTimeout(() => { tryRestore() }, delay))
      })
      // Safety net: show after 2.5s even if restore failed (avoid stuck blank)
      restoreTimers.push(setTimeout(showAgain, 2500))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Also recompute when the container resizes (panel toggle, etc.) so the
    // midpoint stays accurate.
    const ro = new ResizeObserver(() => { if (raf === null) raf = requestAnimationFrame(recompute) })
    ro.observe(el)
    // Initial compute — wait a beat so Document's pages have mounted.
    const settleTimer = setTimeout(recompute, 300)
    const settleTimer2 = setTimeout(recompute, 1200)  // second pass for slow PDFs
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
      if (saveTimer) clearTimeout(saveTimer)
      clearTimeout(settleTimer)
      clearTimeout(settleTimer2)
      restoreTimers.forEach(clearTimeout)
      // FLUSH on unmount / dep change: if the user scrolled within the last
      // 1.5s and we're now switching docs / view, the debounced save would
      // be lost. CRITICAL: use updatePdfMetaByEntryId locked to the entry
      // that was open when this effect fired — otherwise we'd write into
      // the meta of whatever doc the user just opened (overwriting *its*
      // saved position with our outgoing-doc scrollTop).
      const top = Math.round(el.scrollTop)
      if (top > 10 && lockedEntryId) {
        const modeKey: 'pdf' | 'ocr' = viewMode === 'ocr' ? 'ocr' : 'pdf'
        useLibraryStore.getState().updatePdfMetaByEntryId(lockedEntryId, meta => ({
          ...meta,
          lastReadScrollTopByMode: { ...(meta.lastReadScrollTopByMode || {}), [modeKey]: top },
          lastReadViewMode: modeKey,
        })).catch(() => {})
      }
    }
    // viewMode is in deps so switching PDF↔OCR rebinds the listener AND
    // re-runs the restore (each mode reads its own saved scrollTop).
  }, [numPages, viewMode, currentEntry?.id])

  // Translate modal — opened either from the floating toolbar ("选中" preset)
  // or from the main toolbar ("全文/按页" preset). Modal reads selected text,
  // OCR full text, and per-page OCR texts from the caller (this component)
  // and handles streaming + chunking itself.
  const [translateOpen, setTranslateOpen] = useState(false)
  const [translateInitialMode, setTranslateInitialMode] = useState<TranslateModalProps['initialMode']>('selection')
  const [translateSelectedText, setTranslateSelectedText] = useState<string>('')
  // 2026-04-28 CLEAN · 这个 useEffect 原本是给"回顾"按钮用的:切文献 / 关 viewer 时
  //   abort 在飞的 review stream。现在按钮已删,reviewStreamIdRef 也已删,这个 effect
  //   就是死代码,跟着一起清掉。
  //   (上一次 commit 6aac264d 漏了这一段,导致 reviewStreamIdRef is not defined 报错。)

  // Auto-switch OCR background when dark mode toggles
  useEffect(() => {
    if (darkMode && ocrBgLight > 50) {
      // Switching to dark — apply default dark preset
      setOcrBgHue(220); setOcrBgSat(10); setOcrBgLight(15)
    } else if (!darkMode && ocrBgLight < 50) {
      // Switching to light — apply default light preset
      setOcrBgHue(40); setOcrBgSat(30); setOcrBgLight(97)
    }
  }, [darkMode])

  const library = useLibraryStore(s => s.library)

  // Load other entries' annotations for cross-entry append (parallel, not serial)
  const [otherEntryAnns, setOtherEntryAnns] = useState<OtherEntryAnns[]>([])
  useEffect(() => {
    if (!library || !currentEntry) { setOtherEntryAnns([]); return }
    let cancelled = false
    async function load() {
      const targets = library!.entries.filter(e => e.id !== currentEntry!.id)
      const results = await Promise.all(targets.map(async entry => {
        try {
          const meta = await window.electronAPI.loadPdfMeta(entry.id)
          if (meta?.annotations?.length) {
            return { entryId: entry.id, entryTitle: entry.title, annotations: meta.annotations }
          }
        } catch {}
        return null
      }))
      if (!cancelled) setOtherEntryAnns(results.filter((x): x is OtherEntryAnns => x !== null))
    }
    load()
    return () => { cancelled = true }
  }, [library?.entries.length, currentEntry?.id])

  // Memoize marks & annotations — use annotation array reference as dependency
  const annotations = currentPdfMeta?.annotations
  const marks = currentPdfMeta?.marks
  const memoizedAnnotations = useMemo(() => {
    return (annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))
  }, [annotations])

  const memoizedMarks = useMemo(() => {
    return (marks || []).map(m => ({
      id: m.id, type: m.type as 'underline' | 'bold', color: m.color, selectedText: m.selectedText
    }))
  }, [marks])

  const handleRemoveMark = useCallback((markId: string) => {
    document.querySelectorAll(`.ocr-mark[data-mark-id="${markId}"]`).forEach(el => {
      try {
        const parent = el.parentNode
        if (parent) { while (el.firstChild) parent.insertBefore(el.firstChild, el); parent.removeChild(el) }
      } catch {}
    })
    updatePdfMeta(meta => ({ ...meta, marks: (meta.marks || []).filter(m => m.id !== markId) }))
  }, [updatePdfMeta])

  // 2026-04-28 · 任何"针对本文献注释的相关操作"都把当前 entryId 加入会话内
  //   "已查看"集合 → 后续切回时不再弹 rereadingReminder。
  //   触发点:点击注释 marker(activeAnnotationId 命中本文献的注释)/ 标注列表里
  //   选中条目。banner 上的"查看注释/查看旧注释/× 关闭"也分别在 onClick 里
  //   直接 add(就近,不依赖此 effect)。
  const activeAnnotationIdForReread = useUiStore(s => s.activeAnnotationId)
  useEffect(() => {
    if (!activeAnnotationIdForReread || !currentEntry?.id || !currentPdfMeta) return
    if (currentPdfMeta.annotations.some(a => a.id === activeAnnotationIdForReread)) {
      rereadingViewedThisSession.add(currentEntry.id)
      setRereadingReminder(prev => prev ? null : prev)  // 同时把 banner 收掉
    }
  }, [activeAnnotationIdForReread, currentEntry?.id, currentPdfMeta])

  const absPath = currentEntry?.absPath || ''
  const fileExt = absPath.split('.').pop()?.toLowerCase() || ''
  const isPdf = fileExt === 'pdf'
  const isHtml = ['html', 'htm'].includes(fileExt)
  const isText = ['txt', 'md'].includes(fileExt)
  const isOtherDoc = ['docx', 'doc', 'epub'].includes(fileExt)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  // Loaded text content for immersive dual-page rendering of TXT/MD files
  const [txtContent, setTxtContent] = useState<string | null>(null)
  // Loaded DOCX HTML for immersive dual-column rendering
  const [docxHtml, setDocxHtml] = useState<string | null>(null)

  // Load file when entry changes — reset ALL state first to prevent cross-format contamination
  useEffect(() => {
    // Reset everything
    setPdfFileUrl(null)
    setLoadProgress(0)
    setNumPages(0)
    setLoadError(null)
    setOcrFullText(null)
    setOcrFilePath(null)
    setHtmlContent(null)
    setTxtContent(null)
    setDocxHtml(null)
    setViewMode('pdf')
    setOcrProgress(null)
    setRereadingReminder(null)

    if (!currentEntry) return

    // Re-reading detection: if this doc was opened before and has annotations,
    // show the re-reading greeting. Has two layers:
    //   1. Instant fallback: static "上次 X 日留下 N 条" text (works with no AI)
    //   2. Async AI layer: a single-sentence "同伴" greeting quoting the
    //      user's own past notes. Triggers only if AI is configured AND
    //      the gap is meaningful (≥ 3 days). Replaces the static text when
    //      it arrives. If AI fails or isn't configured, static stays.
    if (currentEntry.lastOpenedAt) {
      // 2026-04-28 · 本次会话内已经查看过这本注释 → 切出再切入时跳过提示。
      if (rereadingViewedThisSession.has(currentEntry.id)) return
      const capturedEntryId = currentEntry.id
      window.electronAPI.loadPdfMeta(currentEntry.id).then(async meta => {
        if (!meta || !meta.annotations || meta.annotations.length < 2) return
        // Only act if we're still on the same entry (user may have switched)
        if (useLibraryStore.getState().currentEntry?.id !== capturedEntryId) return

        const lastOpenMs = new Date(currentEntry.lastOpenedAt!).getTime()
        const daysSince = Math.floor((Date.now() - lastOpenMs) / 86400000)

        // Show the static layer immediately
        setRereadingReminder({
          annCount: meta.annotations.length,
          lastTime: new Date(currentEntry.lastOpenedAt!).toLocaleDateString('zh-CN'),
          aiVoice: null,
          aiLoading: daysSince >= 3,   // we'll try AI for gaps ≥ 3 days
        })

        // Not worth an AI call for quick re-opens within 3 days
        if (daysSince < 3) return

        try {
          // Gather user's recent notes on THIS doc for the AI to reference.
          // Flatten all user-authored historyChain entries, sort newest-first, take top 5.
          const userNotes: Array<{ selectedText: string; content: string; createdAt: string; pageNumber: number }> = []
          for (const ann of meta.annotations) {
            for (const h of ann.historyChain || []) {
              if (h.author === 'user' && h.content) {
                userNotes.push({
                  selectedText: ann.anchor?.selectedText?.slice(0, 50) || '',
                  content: h.content.slice(0, 80),
                  createdAt: h.createdAt || ann.createdAt || '',
                  pageNumber: ann.anchor?.pageNumber || 0,
                })
              }
            }
          }
          userNotes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))

          // Find latest annotation's page for the "你上次停在第 X 页" hint
          const mostRecent = userNotes[0]
          const lastPage = mostRecent?.pageNumber || 0

          // Get an available provider: prefer configured ones, otherwise skip AI
          // PERF-R8#7 · 走 fetchAiConfig 共享 cache(命中缓存即同步)
          const configured = await fetchAiConfig()
          if (!configured || configured.length === 0) {
            // No AI available → keep static reminder
            setRereadingReminder(prev => prev ? { ...prev, aiLoading: false } : null)
            return
          }
          // Use the user's selected model if possible, else first configured
          const preferredModel = useUiStore.getState().selectedAiModel
          const [preferProvider] = preferredModel.split(':')
          const use = configured.find(p => p.id === preferProvider) || configured[0]
          const modelSpec = use.id === 'ollama' || use.id === 'claude_cli'
            ? `${use.id}:${use.models[0]?.id || ''}`
            : preferredModel

          // Lazy-import the prompt to avoid impacting startup bundle size
          const { REREADING_SYSTEM_PROMPT, buildRereadingUserMessage } = await import('./rereadingPrompt')
          const userMsg = buildRereadingUserMessage({
            entryTitle: currentEntry.title,
            daysSinceLastOpen: daysSince,
            totalAnnotations: meta.annotations.length,
            lastAnnotationPage: lastPage,
            recentUserNotes: userNotes.slice(0, 5).map(n => ({
              selectedText: n.selectedText,
              content: n.content,
              daysAgo: Math.max(0, Math.floor((Date.now() - new Date(n.createdAt || Date.now()).getTime()) / 86400000)),
            })),
          })

          // Use non-streaming aiChat via the generic chat channel. It returns
          // the full text in one shot — the greeting is <40 chars so streaming
          // would add complexity for no visible benefit.
          const streamId = uuid()
          let fullText = ''
          const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
            if (sid === streamId) fullText += chunk
          })
          try {
            const res = await window.electronAPI.aiChatStream(streamId, modelSpec, [
              { role: 'system', content: REREADING_SYSTEM_PROMPT },
              { role: 'user', content: userMsg },
            ])
            if (res.success && res.text) fullText = res.text
          } finally { cleanup() }

          // Still on same entry?
          if (useLibraryStore.getState().currentEntry?.id !== capturedEntryId) return
          setRereadingReminder(prev => prev ? { ...prev, aiVoice: fullText.trim() || null, aiLoading: false } : null)
        } catch (err) {
          console.warn('[rereading] AI greeting failed:', err)
          setRereadingReminder(prev => prev ? { ...prev, aiLoading: false } : null)
        }
      }).catch(() => {})
    }

    const ext = currentEntry.absPath.split('.').pop()?.toLowerCase() || ''
    const fileUrl = 'file:///' + currentEntry.absPath.replace(/\\/g, '/')

    // Only set PDF URL for PDF files
    if (ext === 'pdf') {
      setPdfFileUrl(fileUrl)
    }

    // Restore scroll position. We retry up to 10 times over 3s because large PDFs / OCR
    // documents keep growing in height as pages/content render in. If we set scrollTop too
    // early, the container is shorter than the target and the jump silently fails.
    let restoreAttempts = 0
    // BUG-FIX R8#8 · NaN 防御:坏数据时 savedScroll=0 → 不跳(预期行为)
    const savedScroll = readNumber(`sj-scroll-${currentEntry.id}`, 0)
    if (savedScroll > 0) {
      const tryRestore = () => {
        const el = scrollRef.current
        if (!el) return
        // Only jump if container is tall enough — otherwise retry
        if (el.scrollHeight >= savedScroll + el.clientHeight) {
          el.scrollTop = savedScroll
          return
        }
        if (restoreAttempts++ < 10) setTimeout(tryRestore, 300)
      }
      setTimeout(tryRestore, 200)
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }

    // Load HTML content for HTML files
    if (['html', 'htm'].includes(ext)) {
      window.electronAPI.readFileBuffer(currentEntry.absPath).then(buf => {
        const decoder = new TextDecoder('utf-8')
        setHtmlContent(decoder.decode(buf))
      }).catch(() => setHtmlContent(null))
    }

    // Check for existing OCR text file, default to OCR view if available (PDF only)
    const setDocText = useUiStore.getState().setCurrentDocText
    setDocText(null)
    window.electronAPI.readOcrText(currentEntry.absPath).then((result) => {
      if (result.exists && result.text) {
        setOcrFullText(result.text)
        setOcrFilePath(result.path)
        setDocText(result.text)
        if (ext === 'pdf') setViewMode('ocr')
        else setViewMode('pdf')
      } else {
        setOcrFullText(null)
        setOcrFilePath(null)
        setViewMode('pdf')
      }
    })

    // Also load text for non-PDF formats
    if (['txt', 'md'].includes(ext)) {
      window.electronAPI.readFileBuffer(currentEntry.absPath).then(buf => {
        const content = new TextDecoder('utf-8').decode(buf)
        setDocText(content)
        setTxtContent(content)
      }).catch(() => {})
    } else if (['docx', 'doc'].includes(ext)) {
      import('mammoth').then(async mammoth => {
        const buf = await window.electronAPI.readFileBuffer(currentEntry.absPath)
        const [rawResult, htmlResult] = await Promise.all([
          mammoth.extractRawText({ arrayBuffer: buf.buffer }),
          mammoth.convertToHtml({ arrayBuffer: buf.buffer }),
        ])
        setDocText(rawResult.value)
        setDocxHtml(htmlResult.value)
      }).catch(() => {})
    } else if (['html', 'htm'].includes(ext)) {
      window.electronAPI.readFileBuffer(currentEntry.absPath).then(buf => {
        const html = new TextDecoder('utf-8').decode(buf)
        const tmp = document.createElement('div')
        tmp.innerHTML = html
        setDocText(tmp.textContent || tmp.innerText || '')
      }).catch(() => {})
    }
  }, [currentEntry?.id])

  // Save scroll position on scroll (throttled)
  useEffect(() => {
    const el = scrollRef.current
    const entryId = currentEntry?.id
    if (!el || !entryId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const handler = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try { localStorage.setItem(`sj-scroll-${entryId}`, String(el.scrollTop)) } catch {}
      }, 300)
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => { el.removeEventListener('scroll', handler); if (timer) clearTimeout(timer) }
  }, [currentEntry?.id])

  const onDocumentLoadSuccess = useCallback(async (pdf: any) => {
    setNumPages(pdf.numPages)
    pdfDocRef.current = pdf
    // Try to read the PDF's internal outline (TOC). Many scanned / generated PDFs
    // don't have one — in that case we just silently skip.
    try {
      const o = await pdf.getOutline()
      setOutline(Array.isArray(o) && o.length > 0 ? o : null)
    } catch {
      setOutline(null)
    }
  }, [])

  // Reset outline state when switching entries
  useEffect(() => {
    setOutline(null)
    setShowOutline(false)
    pdfDocRef.current = null
  }, [currentEntry?.id])

  // Jump to a specific page (1-indexed). Works for:
  //   - PDF view: finds .pdf-page-wrapper[data-page-number="N"]
  //   - OCR view: finds any element with [data-page-number="N"]
  //   (OcrContent wraps each "=== 第 N 页 ===" section with data-page-number)
  const scrollToPage = useCallback((pageNumber: number) => {
    const container = scrollRef.current
    if (!container) return
    // Try PDF-specific first, then any matching data-page-number
    const el = (container.querySelector(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`)
      || container.querySelector(`[data-page-number="${pageNumber}"]`)) as HTMLElement | null
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }
    return false
  }, [])

  // Resolve a PDF outline item's destination → page number → scroll.
  // Destinations come in several shapes (array ref, string named dest, null); we try each.
  const handleOutlineClick = useCallback(async (item: any) => {
    const pdf = pdfDocRef.current
    if (!pdf || !item?.dest) return
    try {
      let dest = item.dest
      if (typeof dest === 'string') dest = await pdf.getDestination(dest)
      if (!dest || !dest[0]) return
      const pageIndex = await pdf.getPageIndex(dest[0])
      scrollToPage(pageIndex + 1)
      setShowOutline(false)
    } catch {
      /* ignore bad outline entries */
    }
  }, [scrollToPage])

  const onDocumentLoadError = useCallback((err: Error) => {
    setLoadError('PDF 解析失败: ' + err.message)
  }, [])

  // Compute total pages — for PDF use numPages; for OCR count "=== 第 N 页 ===" markers
  // (OcrContent splits on that pattern; section count = page count).
  const totalPages = useMemo(() => {
    if (numPages > 0) return numPages
    if (viewMode === 'ocr' && ocrFullText) {
      const matches = ocrFullText.match(/=== 第 \d+ 页 ===/g)
      if (matches && matches.length > 0) return matches.length
    }
    return 0
  }, [numPages, viewMode, ocrFullText])

  // Page-jump submission handler (for toolbar input).
  // Clamps user input to [1, totalPages] — entering a number larger than the max
  // snaps to the last page (and updates the visible input so the user sees the clamp).
  const handlePageJump = useCallback(() => {
    const raw = parseInt(pageJumpInput, 10)
    if (!Number.isFinite(raw) || raw < 1) return
    const max = totalPages > 0 ? totalPages : raw
    const n = Math.min(raw, max)
    // If we clamped, reflect that in the input briefly so the user sees what happened
    if (n !== raw) setPageJumpInput(String(n))
    const ok = scrollToPage(n)
    // Clear input only on a clean (non-clamped) successful jump; keep clamped value
    // visible for a moment so the user understands max-snap behavior
    if (ok && n === raw) setPageJumpInput('')
    else if (ok && n !== raw) {
      setTimeout(() => setPageJumpInput(''), 800)
    }
  }, [pageJumpInput, scrollToPage, totalPages])

  // Ctrl+C / Cmd+C fallback — ensures copy works even if the Electron
  // application menu's `role: 'copy'` accelerator is somehow swallowed (e.g.
  // when focus is inside the pdf.js text layer or a react-rendered span that
  // isn't contentEditable). We manually write the current window selection
  // into the clipboard via the async clipboard API. This runs in ADDITION to
  // the OS-level shortcut: if the OS copy already succeeded, writing the
  // identical string again is a no-op from the user's perspective.
  //
  // We intentionally do NOT preventDefault() — that would break the browser's
  // own copy path for inputs/textareas.
  useEffect(() => {
    const copyHandler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key !== 'c' && e.key !== 'C') return
      // Let INPUT/TEXTAREA/contentEditable use their own copy — they already
      // work, and we don't want to interfere with partial-field copies.
      const tgt = e.target as HTMLElement
      const tag = tgt?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return
      const sel = window.getSelection()?.toString()
      if (!sel || sel.length === 0) return
      // Fire-and-forget; permission errors are silently ignored.
      navigator.clipboard?.writeText(sel).catch(() => {})
    }
    document.addEventListener('keydown', copyHandler, true)  // capture phase
    return () => document.removeEventListener('keydown', copyHandler, true)
  }, [])

  // Keyboard shortcuts for PDF viewing
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!currentEntry) return
      const tag = (e.target as HTMLElement)?.tagName
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable
      const ctrl = e.ctrlKey || e.metaKey

      // Ctrl+G → focus page-jump input
      if (ctrl && (e.key === 'g' || e.key === 'G')) {
        if (isEditing) return
        e.preventDefault()
        pageJumpRef.current?.focus()
        pageJumpRef.current?.select()
        return
      }
      // Ctrl+= / Ctrl++ → zoom in (PDF only; OCR uses font-size slider)
      if (ctrl && (e.key === '=' || e.key === '+')) {
        if (isEditing) return
        if (viewMode !== 'pdf' || !isPdf) return
        e.preventDefault()
        setScale(s => Math.min(3, +(s + 0.15).toFixed(2)))
        return
      }
      // Ctrl+- → zoom out
      if (ctrl && e.key === '-') {
        if (isEditing) return
        if (viewMode !== 'pdf' || !isPdf) return
        e.preventDefault()
        setScale(s => Math.max(0.5, +(s - 0.15).toFixed(2)))
        return
      }
      // Ctrl+0 → reset zoom to 100%
      if (ctrl && e.key === '0') {
        if (isEditing) return
        if (viewMode !== 'pdf' || !isPdf) return
        e.preventDefault()
        setScale(1.0)
        return
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [currentEntry, viewMode, isPdf])

  // ===== OCR: Send entire PDF file to GLM-OCR =====
  const handleOcr = useCallback(async () => {
    if (!currentPdfMeta || !currentEntry) return
    if (glmApiKeyStatus !== 'set') { alert('请先在设置中填入 GLM API Key'); return }
    setOcrProgress({ status: '正在上传 PDF 并识别文字...' })

    // Flag the entry as OCR-running so FileTree shows the spinner. Cleared on
    // success/failure paths below.
    await updateEntry(currentEntry.id, {
      ocrStatus: 'running',
      ocrStatusUpdatedAt: new Date().toISOString(),
      ocrError: undefined,
    }).catch(() => {})

    try {
      const result = await window.electronAPI.glmOcrPdf(currentEntry.absPath)

      if (result.success && result.text) {
        // Build text with page markers if we have per-page data
        let textToSave = result.text
        if (result.pageTexts && result.pageTexts.length > 1) {
          textToSave = result.pageTexts
            .map((t, i) => `=== 第 ${i + 1} 页 ===\n\n${t}`)
            .join('\n\n')
        }

        // Save OCR text to local file
        const savedPath = await window.electronAPI.saveOcrText(currentEntry.absPath, textToSave)

        // Update meta
        const pageTexts = result.pageTexts || []
        await updatePdfMeta(meta => ({
          ...meta,
          ocrStatus: 'complete' as const,
          pages: pageTexts.map((t, i) => ({
            pageNumber: i + 1,
            ocrText: t,
            ocrTimestamp: new Date().toISOString()
          }))
        }))

        setOcrFullText(textToSave)
        setOcrFilePath(savedPath)
        // Update entry OCR status
        await updateEntry(currentEntry.id, {
          ocrStatus: 'complete',
          ocrFilePath: savedPath,
          ocrStatusUpdatedAt: new Date().toISOString(),
          ocrError: undefined,
        })
        setOcrProgress({ status: 'OCR 完成！' })
        setTimeout(() => setOcrProgress(null), 2000)
      } else {
        await updateEntry(currentEntry.id, {
          ocrStatus: 'failed',
          ocrStatusUpdatedAt: new Date().toISOString(),
          ocrError: result.error || '未知错误',
        }).catch(() => {})
        setOcrProgress({ status: `失败: ${result.error}` })
        setTimeout(() => setOcrProgress(null), 5000)
      }
    } catch (err: any) {
      await updateEntry(currentEntry.id, {
        ocrStatus: 'failed',
        ocrStatusUpdatedAt: new Date().toISOString(),
        ocrError: err?.message || String(err),
      }).catch(() => {})
      setOcrProgress({ status: `错误: ${err.message}` })
      setTimeout(() => setOcrProgress(null), 5000)
    }
  }, [currentEntry, currentPdfMeta, glmApiKeyStatus, updatePdfMeta, updateEntry])

  // Floating toolbar state
  const [toolbar, setToolbar] = useState<{ x: number; y: number; text: string; pageNumber: number } | null>(null)
  const toolbarRef = useRef(toolbar)
  toolbarRef.current = toolbar  // always keep ref in sync
  const [toolbarMode, setToolbarMode] = useState<'main' | 'underline-color' | 'append-list'>('main')

  const PRESET_COLORS = [
    { name: 'yellow', hex: '#FFD43B' },
    { name: 'red', hex: '#FF6B6B' },
    { name: 'green', hex: '#51CF66' },
    { name: 'blue', hex: '#339AF0' },
    { name: 'purple', hex: '#CC5DE8' },
    { name: 'orange', hex: '#FF922B' },
  ]

  // Text selection → show floating toolbar
  const handleMouseUp = useCallback((e: React.MouseEvent | any) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      // Clicked without selecting — clear textSelection if no annotation was created for it
      const { textSelection: ts, activeAnnotationId: aid } = useUiStore.getState()
      if (ts && !aid) {
        // Check if an annotation exists for this selection text
        const hasAnnotation = currentPdfMeta?.annotations.some(a => a.anchor.selectedText === ts.text)
        if (!hasAnnotation) {
          setTextSelection(null)
        }
      }
      return
    }
    const text = selection.toString().trim()
    if (!text || text.length < 2) return

    let el: HTMLElement | null = selection.getRangeAt(0).startContainer.parentElement
    let pageNumber = 0
    while (el) {
      const pn = el.getAttribute('data-page-number')
      if (pn) { pageNumber = parseInt(pn); break }
      el = el.parentElement
    }

    // Position toolbar above selection
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    // 2026-04-28 CLEAN · 沉浸式分支已删,固定走"非沉浸式"路径(toolbar 在选区上方)
    setToolbar({ x: rect.left + rect.width / 2, y: rect.top - 8, text, pageNumber: pageNumber || 1 })
    setToolbarMode('main')
  }, [])

  // Dismiss toolbar on click outside (but not when clicking immersive annotation box)
  useEffect(() => {
    if (!toolbar) return
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('.floating-toolbar') || el.closest('.immersive-annotation-box')) return
      setToolbar(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [toolbar])

  // 2026-04-28 CLEAN · 删除三个 useEffect:沉浸式 scroll save/restore + ESC/fullscreen
  //   exit 监听。沉浸式已下线 → 这些 effect 全部 unreachable (immersiveMode 永远
  //   是 falsy / undefined)。savedScrollPos ref 由 OCR/PDF 视图切换的滚动恢复路径
  //   独立维护,不依赖这里。

  // Toolbar action: create annotation with color
  const handleToolbarAnnotate = useCallback((color: string) => {
    const tb = toolbarRef.current
    if (!tb) return
    setActiveAnnotation(null)
    setTextSelection({ pageNumber: tb.pageNumber, text: tb.text, startOffset: 0, endOffset: tb.text.length })
    useUiStore.getState().setAnnotationColor(color)
    setToolbar(null)
  }, [setTextSelection, setActiveAnnotation])

  // 2026-04-28 CLEAN · handleImmersiveTextSelect 已删(沉浸式 ImmersiveOcrReader 不再调用)

  // Toolbar action: append to existing annotation
  const handleToolbarAppend = useCallback((annotationId: string) => {
    // Pass the selected text as supplementary context for the target annotation
    if (toolbar) {
      setTextSelection({ pageNumber: toolbar.pageNumber, text: toolbar.text, startOffset: 0, endOffset: toolbar.text.length })
    }
    setActiveAnnotation(annotationId)
    setToolbar(null)
  }, [setActiveAnnotation, toolbar, setTextSelection])

  // Append current selected text as a link to another entry's annotation
  const handleToolbarAppendOther = useCallback(async (targetEntryId: string, targetAnnotationId: string) => {
    if (!toolbar || !currentEntry) return
    const selectedText = toolbar.text

    // Load target entry's meta, add a link HistoryEntry, save
    let meta
    try {
      meta = await window.electronAPI.loadPdfMeta(targetEntryId)
    } catch (e: any) {
      alert(`目标注释加载失败：${e?.message || e}`)
      return
    }
    if (!meta) return
    const ann = meta.annotations.find((a: Annotation) => a.id === targetAnnotationId)
    if (!ann) return

    const linkEntry: import('../../types/library').HistoryEntry = {
      id: crypto.randomUUID(),
      type: 'link',
      content: selectedText,
      author: 'user',
      createdAt: new Date().toISOString(),
      linkedRef: {
        entryId: currentEntry.id,
        annotationId: '',
        selectedText: selectedText.substring(0, 80),
      },
    }
    ann.historyChain.push(linkEntry)
    ann.updatedAt = new Date().toISOString()
    await window.electronAPI.savePdfMeta(targetEntryId, meta)
    setToolbar(null)
  }, [toolbar, currentEntry])

  // Toolbar action: add underline mark
  const handleToolbarUnderline = useCallback((color: string) => {
    const tb = toolbarRef.current
    if (!tb || !currentEntry) { console.warn('[handleToolbarUnderline] no toolbar or entry'); return }
    const mark: import('../../types/library').TextMark = {
      id: crypto.randomUUID(),
      type: 'underline',
      color,
      pageNumber: tb.pageNumber,
      selectedText: tb.text,
      createdAt: new Date().toISOString(),
    }
    updatePdfMeta(meta => ({
      ...meta,
      marks: [...(meta.marks || []), mark],
    }))
    window.getSelection()?.removeAllRanges()
    // 2026-04-28 CLEAN · 沉浸式分支已删,固定 setToolbar(null)
    setToolbar(null)
  }, [currentEntry, updatePdfMeta])

  // Toolbar action: add bold mark
  const handleToolbarBold = useCallback(() => {
    const tb = toolbarRef.current
    if (!tb || !currentEntry) { console.warn('[handleToolbarBold] no toolbar or entry'); return }
    const mark: import('../../types/library').TextMark = {
      id: crypto.randomUUID(),
      type: 'bold',
      pageNumber: tb.pageNumber,
      selectedText: tb.text,
      createdAt: new Date().toISOString(),
    }
    updatePdfMeta(meta => ({
      ...meta,
      marks: [...(meta.marks || []), mark],
    }))
    window.getSelection()?.removeAllRanges()
    // 2026-04-28 CLEAN · 沉浸式分支已删,固定 setToolbar(null)
    setToolbar(null)
  }, [currentEntry, updatePdfMeta])

  // ===== RENDER =====

  if (!currentEntry) {
    // Different welcome depending on whether the library is empty
    const libraryEmpty = !library || library.entries.length === 0
    return (
      <div className="pdf-area">
        <div className="empty-state" style={{ maxWidth: 720, margin: '0 auto', textAlign: 'left', padding: '32px 32px 48px' }}>
          {libraryEmpty ? (
            <>
              {/* Hero: what shijuan actually is (not "yet another PDF reader") */}
              <div style={{ textAlign: 'center', marginBottom: 28 }}>
                <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                  拾卷
                </div>
                <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  不是又一个 PDF 阅读器 ——<br />
                  一个<strong style={{ color: 'var(--accent)' }}>陪你读书的同伴</strong>，看见你自己看不见的阅读模式
                </div>
              </div>

              {/* Primary action + quick ways in */}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 28, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-primary"
                  style={{ padding: '9px 22px', fontSize: 13 }}
                  onClick={() => useLibraryStore.getState().importFiles()}
                >
                  导入文件
                </button>
                <button
                  className="btn"
                  style={{ padding: '9px 22px', fontSize: 13 }}
                  onClick={() => useLibraryStore.getState().importFolder()}
                >
                  导入文件夹
                </button>
                <div style={{
                  fontSize: 11, color: 'var(--text-muted)', alignSelf: 'center',
                  paddingLeft: 6,
                }}>
                  或直接<strong>拖拽文件</strong>到窗口
                </div>
              </div>

              {/* Differentiation: the three AI voices */}
              <div style={{
                background: 'var(--bg-warm)', padding: '20px 22px', borderRadius: 12,
                border: '1px solid var(--border-light)', marginBottom: 16,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 14 }}>
                  拾卷独有的三种陪伴
                </div>

                {/* Voice 1: instant feedback */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start' }}>
                  <div style={{
                    fontSize: 18, width: 28, height: 28, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    borderRadius: 6, fontWeight: 600,
                  }}>1</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                      即时同伴 · 写每条注释时
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7,
                      fontStyle: 'italic', paddingLeft: 10, borderLeft: '2px solid var(--border)',
                    }}>
                      <em>《区分》里你把"权力"写成资本的效果；这里写"资本即权力"方向反了。</em>
                    </div>
                  </div>
                </div>

                {/* Voice 2: daily log */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start' }}>
                  <div style={{
                    fontSize: 18, width: 28, height: 28, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    borderRadius: 6, fontWeight: 600,
                  }}>2</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                      每日观察 · 每天自动生成
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7,
                      fontStyle: 'italic', paddingLeft: 10, borderLeft: '2px solid var(--border)',
                    }}>
                      <em>你下午连续两次在《福柯》第 12 页停下——第一次写「权力即资本」，第二次划掉改成「资本是权力的表层」。中间间隔了 40 分钟。</em>
                    </div>
                  </div>
                </div>

                {/* Voice 3: apprentice weekly */}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{
                    fontSize: 18, width: 28, height: 28, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--accent-soft)', color: 'var(--accent)',
                    borderRadius: 6, fontWeight: 600,
                  }}>3</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                      学徒周报 · 每周一份观察报告
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7,
                      fontStyle: 'italic', paddingLeft: 10, borderLeft: '2px solid var(--border)',
                    }}>
                      <em>这周你三次回到了《规训与惩罚》，但都没写下什么——你在等什么吗？《X》里你六月写过「权力是关系」，上周又回到那条注释但没再写。</em>
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer: three-step quick start + data location */}
              <div style={{
                fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.9,
                textAlign: 'center', padding: '0 8px',
              }}>
                上手三步：<strong>导入一本书</strong> → <strong>选中文字写想法</strong> → <strong>周一看学徒</strong><br />
                <span style={{ opacity: 0.75 }}>
                  支持 PDF · EPUB · DOCX · HTML · TXT · Markdown<br />
                  所有数据在本地 <code style={{ background: 'var(--bg)', padding: '0 5px', borderRadius: 3, fontSize: 10 }}>~/.lit-manager/</code>，不上传云端 · 纯阅读和注释不需要 AI Key
                </span>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '60px 20px 40px' }}>
              <span style={{ fontSize: 15, color: 'var(--text-secondary)' }}>从左侧选择文献开始阅读</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, display: 'block' }}>
                提示：按 <kbd style={{ background: 'var(--bg-warm)', padding: '1px 6px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 10 }}>Ctrl+P</kbd> 快速搜索文献
              </span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Active search-highlight banner (only shown when current entry matches target)
  const activeSearchQuery = searchHighlight?.targetEntryId === currentEntry?.id ? searchHighlight?.query : null

  return (
    <div className="pdf-area">
      {/* Search highlight banner — visible right below toolbar when user came from a search result */}
      {activeSearchQuery && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 12px', fontSize: 11,
          background: 'var(--accent-soft)', color: 'var(--accent-hover)',
          borderBottom: '1px solid var(--border-light)',
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span>正在高亮：<strong>{activeSearchQuery}</strong></span>
          <button
            onClick={() => setSearchHighlight(null)}
            style={{
              marginLeft: 'auto', padding: '1px 6px', fontSize: 10,
              background: 'transparent', border: '1px solid var(--accent)',
              color: 'var(--accent)', borderRadius: 3, cursor: 'pointer',
            }}
            title="清除搜索高亮 (Esc)"
          >
            ✕ 清除
          </button>
        </div>
      )}
      {/* Toolbar */}
      <div className="pdf-toolbar">
        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 250 }}>
          {currentEntry?.title || ''}
        </span>
        {numPages > 0 && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, flexShrink: 0 }}>{numPages} 页</span>
        )}
        {/* Page jump (PDF view + OCR view with page markers).
            totalPages handles both: PDF→numPages, OCR→count of "=== 第 N 页 ===" markers. */}
        {/* 2026-04-28 · 删独立的"跳转"标签,保留 placeholder 1-N + → 按钮即可 */}
        {totalPages > 0 && (
          // Pill-shaped page jump: input + arrow button in one container, preceded
          // by a "跳转" text label (rendered as a sibling span above so it sits to
          // the left of the pill with its own spacing). Both clickable button and
          // Enter key trigger the jump (Ctrl+G focuses input via shortcut elsewhere).
          <div
            // Proportions tuned so the pill isn't too elongated — slightly taller
            // vertical padding + narrower input width gives a ~2.8:1 W:H ratio instead
            // of the previous ~4:1 that looked skinny/stretched.
            style={{
              display: 'flex', alignItems: 'center',
              marginLeft: 8, flexShrink: 0,
              border: '1px solid var(--border)', borderRadius: 12,
              background: 'var(--bg-warm)', overflow: 'hidden',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <input
              ref={pageJumpRef}
              // Use type="text" + inputMode="numeric" instead of type="number" — the
              // browser's up/down spinner arrows on number inputs are tiny, easy to
              // mis-click, and feel cramped at this size. Digit filtering is done in
              // onChange so the user can still only enter numbers.
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pageJumpInput}
              onChange={e => {
                // Allow only digits; strip everything else
                const digits = e.target.value.replace(/\D/g, '')
                setPageJumpInput(digits)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); handlePageJump() }
                else if (e.key === 'Escape') { e.currentTarget.blur(); setPageJumpInput('') }
              }}
              placeholder={totalPages > 0 ? `1-${totalPages}` : '跳转到'}
              title={totalPages > 0
                ? `输入页码后按回车或点 → 跳转，范围 1-${totalPages} (Ctrl+G 聚焦)`
                : '输入页码后按回车或点 → 跳转 (Ctrl+G 聚焦)'}
              style={{
                width: 48, padding: '4px 7px', fontSize: 11,
                border: 'none', background: 'transparent',
                color: 'var(--text)', outline: 'none',
                textAlign: 'right',
              }}
            />
            <button
              onClick={handlePageJump}
              disabled={!pageJumpInput.trim()}
              title="跳转到该页"
              style={{
                padding: '4px 8px',
                background: pageJumpInput.trim() ? 'var(--accent)' : 'transparent',
                color: pageJumpInput.trim() ? '#fff' : 'var(--text-muted)',
                border: 'none', borderLeft: '1px solid var(--border)',
                cursor: pageJumpInput.trim() ? 'pointer' : 'default',
                fontSize: 11, lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'background 0.15s',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </button>
          </div>
        )}
        {/* PDF outline toggle — only shown when a PDF is loaded AND it has a real TOC */}
        {isPdf && outline && outline.length > 0 && (
          <button
            className="btn btn-sm btn-icon"
            title="显示目录"
            onClick={() => setShowOutline(v => !v)}
            style={{
              marginLeft: 6, padding: '4px 8px',
              color: showOutline ? 'var(--accent)' : 'var(--text-muted)',
              background: showOutline ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
        )}
        <div style={{ flex: 1 }} />

        {/* View mode toggle — only for PDF files.
            flexShrink: 0 + whiteSpace: nowrap prevent the buttons from squishing in
            narrow windows (previously "OCR 文本" would wrap vertically into an ugly
            tall sliver resembling a book spine). */}
        {isPdf && (
          <div style={{
            display: 'flex', flexShrink: 0,
            border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginRight: 8,
          }}>
            <button
              className={viewMode === 'pdf' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ borderRadius: 0, border: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => setViewMode('pdf')}
            >
              PDF
            </button>
            <button
              className={viewMode === 'ocr' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)', whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={() => { if (ocrFullText) setViewMode('ocr'); else alert('请先进行 OCR') }}
              disabled={!ocrFullText}
            >
              OCR 文本
            </button>
          </div>
        )}
        {isHtml && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>HTML 文档</span>
        )}
        {isText && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>{fileExt.toUpperCase()} 文本</span>
        )}
        {fileExt === 'epub' && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>EPUB 电子书</span>
        )}
        {['docx', 'doc'].includes(fileExt) && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>Word 文档</span>
        )}

        {isPdf && viewMode === 'pdf' ? (
          <>
            <button className="btn btn-sm" onClick={() => setScale(s => Math.max(0.5, s - 0.2))}>−</button>
            <span style={{ fontSize: 12, minWidth: 45, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
            <button className="btn btn-sm" onClick={() => setScale(s => Math.min(3, s + 0.2))}>+</button>
          </>
        ) : (viewMode === 'ocr' || ['docx', 'doc', 'epub', 'html', 'htm'].includes(fileExt) || isText) ? (
          // flexShrink: 0 on the container + whiteSpace: nowrap on labels prevent
          // "字号/粗细/深浅" from wrapping vertically in narrow windows.
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>字号</span>
            <input type="range" min="12" max="24" value={ocrFontSize}
              onChange={e => setOcrFontSize(Number(e.target.value))}
              style={{ width: 50, height: 3, accentColor: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 20, whiteSpace: 'nowrap', flexShrink: 0 }}>{ocrFontSize}</span>

            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>粗细</span>
            <input type="range" min="200" max="800" step="50" value={ocrFontWeight}
              onChange={e => setOcrFontWeight(Number(e.target.value))}
              style={{ width: 50, height: 3, accentColor: 'var(--accent)', flexShrink: 0 }} />

            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4, whiteSpace: 'nowrap', flexShrink: 0 }}>深浅</span>
            <input type="range" min="10" max="100" value={ocrColorDepth}
              onChange={e => setOcrColorDepth(Number(e.target.value))}
              style={{ width: 40, height: 3, accentColor: 'var(--accent)', flexShrink: 0 }} />

            <span style={{ width: 1, height: 14, background: 'var(--border)', marginLeft: 4 }} />

            {/* Background color dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowBgPicker(!showBgPicker)}
                title="背景颜色"
                style={{
                  width: 22, height: 22, borderRadius: '50%', border: '1.5px solid var(--border)',
                  background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
                  cursor: 'pointer', padding: 0, flexShrink: 0,
                  outline: showBgPicker ? '2px solid var(--accent)' : 'none', outlineOffset: 1,
                }}
              />
              {showBgPicker && (
                <div style={{
                  position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                  marginTop: 6, padding: '8px 6px',
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                  display: 'flex', flexDirection: 'column', gap: 4, zIndex: 100,
                  animation: 'bgPickerIn 0.15s ease-out',
                }}>
                  {(useUiStore.getState().darkMode ? [
                    { label: '墨', h: 220, s: 10, l: 15 },
                    { label: '碳', h: 0, s: 0, l: 12 },
                    { label: '夜蓝', h: 220, s: 20, l: 18 },
                    { label: '夜绿', h: 160, s: 15, l: 14 },
                    { label: '深棕', h: 30, s: 20, l: 16 },
                    { label: '紫夜', h: 270, s: 12, l: 15 },
                  ] : [
                    // v1.2.7: re-tuned presets. Previously 5 of 6 clustered at L≈94-97
                    // (visually indistinguishable); now each preset has clearly
                    // different hue + stronger saturation and L spread 82-92.
                    { label: '暖', h: 38, s: 55, l: 92 },      // 米黄 — 纸本质感
                    { label: '护眼', h: 128, s: 45, l: 88 },    // 浅绿 — 保留原经典色
                    { label: '晨雾', h: 30, s: 35, l: 86 },    // 淡杏 — 黄昏阅读
                    { label: '蓝', h: 210, s: 40, l: 90 },     // 冷蓝 — 集中
                    { label: '石灰', h: 60, s: 10, l: 87 },    // 暖灰 — 中性
                    { label: '檀', h: 22, s: 45, l: 82 },      // 深棕 — 低强度
                  ]).map(p => {
                    const active = ocrBgHue === p.h && ocrBgSat === p.s && ocrBgLight === p.l
                    return (
                      <button
                        key={p.label}
                        onClick={() => { setOcrBgHue(p.h); setOcrBgSat(p.s); setOcrBgLight(p.l); setShowBgPicker(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
                          background: active ? 'var(--accent-soft)' : 'transparent',
                          border: 'none', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                        onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
                        onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                      >
                        <span style={{
                          width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                          border: '1.5px solid var(--border)',
                          background: `hsl(${p.h}, ${p.s}%, ${p.l}%)`,
                          outline: active ? '2px solid var(--accent)' : 'none', outlineOffset: 1,
                        }} />
                        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{p.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {isPdf && (
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: 8 }}
            onClick={handleOcr}
            disabled={!!ocrProgress}
          >
            {ocrFullText ? '重新 OCR' : 'OCR 识别'}
          </button>
        )}

        {/* 翻译 — opens modal with full-text / page-range options. Only show when
            OCR text is available (for PDFs). For the 选中 mode, the button lives
            in the floating toolbar instead, since that's selection-triggered.
            A status badge in the top-right corner reflects the translation job
            for this entry: running (blue pulse), completed (green ✓), failed /
            aborted (red !). Clicking reopens the modal to view the latest job. */}
        {ocrFullText && (
          <TranslateButtonWithBadge
            entryId={currentEntry?.id || ''}
            onClick={() => {
              setTranslateSelectedText('')
              setTranslateInitialMode('full')
              setTranslateOpen(true)
            }}
          />
        )}

        {/* 2026-04-28 CLEAN · "编辑" + "回顾" 两个按钮都已下线(用户决定)。
            state / ref / textarea 同步全删。closingPrompt.ts 保留以防未来恢复。 */}

        {/* 2026-04-28 CLEAN · 沉浸式阅读完全下线 — toggle / state / dormant
            组件 / 全部分支均已清理。 */}
      </div>

      {/* Re-reading greeting. Two display modes:
          - AI voice available: render the sentence in serif italic (quote-like),
            with a subtle "— 同伴" attribution below. Feels like a whispered
            note, not a banner.
          - No AI (fallback / loading / failed): the old statistical text.
          Either way there's a "查看注释" affordance and a close button. */}
      {rereadingReminder && (
        <div style={{
          padding: '10px 18px',
          background: 'var(--accent-soft)',
          borderBottom: '1px solid var(--border)',
          fontSize: 12,
          color: 'var(--accent-hover)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div style={{ flex: 1, lineHeight: 1.65 }}>
            {rereadingReminder.aiVoice ? (
              <>
                <div style={{
                  fontFamily: 'var(--font-serif)', fontStyle: 'italic',
                  fontSize: 13, color: 'var(--text)',
                }}>
                  "{rereadingReminder.aiVoice}"
                </div>
                <div style={{
                  fontSize: 10, color: 'var(--text-muted)', marginTop: 3,
                  letterSpacing: '0.04em',
                }}>
                  — 同伴 · 距上次 {rereadingReminder.lastTime}
                  <button
                    onClick={() => {
                      // 2026-04-28 · 标记本会话已查看,切回不再弹
                      if (currentEntry?.id) rereadingViewedThisSession.add(currentEntry.id)
                      useUiStore.getState().toggleAnnotationPanel()
                      setRereadingReminder(null)
                    }}
                    style={{
                      background: 'none', border: 'none', color: 'var(--accent)',
                      cursor: 'pointer', fontSize: 10, marginLeft: 8,
                      padding: 0, textDecoration: 'underline',
                    }}
                  >
                    查看旧注释
                  </button>
                </div>
              </>
            ) : rereadingReminder.aiLoading ? (
              <>
                <span className="loading-spinner" style={{ width: 10, height: 10, marginRight: 6, verticalAlign: 'middle' }} />
                你上次在 {rereadingReminder.lastTime} 读过这本，留下 {rereadingReminder.annCount} 条注释…
              </>
            ) : (
              <>
                你上次在 {rereadingReminder.lastTime} 读过这本，留下了 {rereadingReminder.annCount} 条注释。
                <button
                  onClick={() => {
                    // 2026-04-28 · 标记本会话已查看,切回不再弹
                    if (currentEntry?.id) rereadingViewedThisSession.add(currentEntry.id)
                    useUiStore.getState().toggleAnnotationPanel()
                    setRereadingReminder(null)
                  }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--accent)',
                    cursor: 'pointer', textDecoration: 'underline', fontSize: 12,
                    marginLeft: 6, padding: 0,
                  }}
                >
                  查看注释
                </button>
              </>
            )}
          </div>
          <button
            onClick={() => {
              // 2026-04-28 · 主动关闭也算"已处理过",切回不再弹
              if (currentEntry?.id) rereadingViewedThisSession.add(currentEntry.id)
              setRereadingReminder(null)
            }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 16, lineHeight: 1,
              padding: '2px 4px', flexShrink: 0,
            }}
            title="关闭"
          >×</button>
        </div>
      )}

      {/* OCR Progress */}
      {ocrProgress && (
        <div style={{
          padding: '10px 16px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8
        }}>
          {!ocrProgress.status.startsWith('OCR 完成') && !ocrProgress.status.startsWith('失败') && !ocrProgress.status.startsWith('错误') && (
            <span className="loading-spinner" />
          )}
          {ocrProgress.status}
        </div>
      )}

      {/* ===== PDF View ===== */}
      {viewMode === 'pdf' && isPdf && (
        <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Outline drawer — absolute overlay on the left of the pdf scroll area */}
        {showOutline && outline && (
          <div style={{
            position: 'absolute', top: 0, left: 0, bottom: 0, width: 240, zIndex: 5,
            background: 'var(--bg)', borderRight: '1px solid var(--border)',
            boxShadow: '2px 0 8px rgba(0,0,0,0.06)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              padding: '8px 12px', borderBottom: '1px solid var(--border-light)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
            }}>
              <span>目录</span>
              <button
                onClick={() => setShowOutline(false)}
                title="关闭"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14, padding: 0 }}
              >✕</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
              <PdfOutlineList items={outline} depth={0} onItemClick={handleOutlineClick} />
            </div>
          </div>
        )}
        <div className="pdf-scroll-area" ref={scrollRef} onMouseUp={handleMouseUp}
          style={{ flex: 1 }}
        >
          {loadError ? (
            <div className="empty-state"><span style={{ fontSize: 32 }}>❌</span><span>{loadError}</span></div>
          ) : !pdfFileUrl ? (
            <div className="empty-state"><span>加载中...</span></div>
          ) : (
            <Document
              key={`${currentEntry?.id}-single`}
              file={pdfFileUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              onLoadProgress={({ loaded, total }: { loaded: number; total: number }) => {
                if (total > 0) setLoadProgress(Math.round((loaded / total) * 100))
              }}
              loading={
                <div className="empty-state">
                  <span className="loading-spinner" />
                  <span style={{ marginTop: 10 }}>
                    解析 PDF{loadProgress > 0 ? ` · ${loadProgress}%` : '...'}
                  </span>
                  {loadProgress > 0 && loadProgress < 100 && (
                    <div style={{ width: 180, height: 3, background: 'var(--border)', borderRadius: 2, marginTop: 10, overflow: 'hidden' }}>
                      <div style={{ width: `${loadProgress}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                    </div>
                  )}
                </div>
              }
              error={<div className="empty-state"><span>PDF 解析失败</span></div>}
            >
              {/* 2026-04-28 CLEAN · 沉浸式 dual-page 分支已删,固定走单列滚动布局 */}
              {Array.from({ length: numPages }, (_, i) => {
                const pageNum = i + 1
                // Render real <Page> only for pages near the current range
                // (±2 around pageRenderRange), placeholder for others. This
                // prevents react-pdf from instantiating every Page canvas
                // for huge PDFs, which was the main source of load+resize lag.
                const inRange = pageNum >= pageRenderRange.start - 2 && pageNum <= pageRenderRange.end + 2
                return (
                  <LazyPdfPage
                    key={pageNum}
                    pageNum={pageNum}
                    scale={debouncedScale}
                    inRange={inRange}
                    onVisible={(n) => {
                      setPageRenderRange(prev => ({
                        start: Math.min(prev.start, n),
                        end: Math.max(prev.end, n),
                      }))
                    }}
                  />
                )
              })}
            </Document>
          )}
        </div>
        </div>
      )}

      {/* ===== HTML View (iframe with postMessage for text selection) ===== */}
      {viewMode === 'pdf' && isHtml && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <HtmlViewer key={currentEntry?.id} absPath={absPath} onTextSelect={setTextSelection}
            annotations={(currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))}
            fontSize={ocrFontSize}
            fontWeight={ocrFontWeight}
            colorDepth={ocrColorDepth}
            bgHue={ocrBgHue}
            bgSat={ocrBgSat}
            bgLight={ocrBgLight}
            onToolbarShow={(x, y, text) => {
              // Use current "visible page" from uiStore so new annotations
              // land in the right chapter/page group even for EPUB / HTML /
              // DOCX / TXT / MD where there's no real pageNumber.
              setToolbar({ x, y, text, pageNumber: useUiStore.getState().currentVisiblePage })
              setToolbarMode('main')
            }}
          />
        </div>
      )}

      {/* ===== EPUB View ===== */}
      {viewMode === 'pdf' && fileExt === 'epub' && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <EpubViewer
            key={currentEntry?.id}
            absPath={absPath}
            onTextSelect={setTextSelection}
            annotations={(currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))}
            onAnnotationClick={(id) => setActiveAnnotation(id)}
            marks={memoizedMarks}
            onRemoveMark={handleRemoveMark}
            fontSize={ocrFontSize}
            fontWeight={ocrFontWeight}
            colorDepth={ocrColorDepth}
            bgHue={ocrBgHue}
            bgSat={ocrBgSat}
            bgLight={ocrBgLight}
            onToolbarShow={(x, y, text) => {
              // Use current "visible page" from uiStore so new annotations
              // land in the right chapter/page group even for EPUB / HTML /
              // DOCX / TXT / MD where there's no real pageNumber.
              setToolbar({ x, y, text, pageNumber: useUiStore.getState().currentVisiblePage })
              setToolbarMode('main')
            }}
          />
        </div>
      )}

      {/* ===== DOCX View ===== */}
      {/* 2026-04-28 CLEAN · 沉浸式 dual-column 分支已删,固定走单列 */}
      {viewMode === 'pdf' && ['docx', 'doc'].includes(fileExt) && (
        <div className="pdf-scroll-area" style={{
          alignItems: 'stretch', padding: 0,
          background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
          fontSize: ocrFontSize, fontWeight: ocrFontWeight,
          color: ocrBgLight < 50 ? `hsl(40, 15%, ${60 + (100 - ocrColorDepth) / 3}%)` : `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
        }} onMouseUp={handleMouseUp}>
          <DocxViewer key={currentEntry?.id} absPath={absPath} onTextSelect={setTextSelection}
            annotations={(currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))}
            onAnnotationClick={(id) => setActiveAnnotation(id)}
            marks={memoizedMarks}
            onRemoveMark={handleRemoveMark}
            activeSelectionText={textSelection?.text}
            searchHighlight={searchHighlight?.targetEntryId === currentEntry?.id ? searchHighlight.query : null}
          />
        </div>
      )}

      {/* ===== Text View ===== */}
      {/* 2026-04-28 CLEAN · 沉浸式 dual-page TXT/MD 分支已删,固定走单列 */}
      {viewMode === 'pdf' && isText && (
        <div className="pdf-scroll-area" style={{
          alignItems: 'stretch', padding: 0,
          background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
        }} onMouseUp={handleMouseUp}>
          <div style={{
            maxWidth: 'min(95%, 1400px)', margin: '0 auto',
            padding: '40px clamp(32px, 4vw, 80px)', minHeight: '100%',
          }} data-page-number="1">
            <TextFileContent
              key={currentEntry?.id}
              absPath={absPath}
              annotations={(currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))}
              onAnnotationClick={(id) => setActiveAnnotation(id)}
              marks={currentPdfMeta?.marks?.map(m => ({ id: m.id, type: m.type, color: m.color, selectedText: m.selectedText })) || []}
              onRemoveMark={handleRemoveMark}
              activeSelectionText={textSelection?.text}
              fontSize={ocrFontSize}
              fontWeight={ocrFontWeight}
              color={ocrBgLight < 50 ? `hsl(40, 15%, ${60 + (100 - ocrColorDepth) / 3}%)` : `hsl(30, 20%, ${100 - ocrColorDepth}%)`}
              searchHighlight={searchHighlight?.targetEntryId === currentEntry?.id ? searchHighlight.query : null}
            />
          </div>
        </div>
      )}

      {/* ===== Edit Mode 区块已删(2026-04-28 CLEAN) ===== */}

      {/* ===== OCR Text View ===== */}
      {viewMode === 'ocr' && (
        <div
          // Reuse scrollRef here so the page-jump's scrollToPage() can find OcrContent's
          // [data-page-number] elements. PDF/Edit/OCR scroll areas are mutually exclusive
          // — only one mounts at a time, so sharing the ref is safe.
          ref={scrollRef}
          className="pdf-scroll-area"
          style={{
            background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
            alignItems: 'stretch', padding: 0,
          }}
          onMouseUp={handleMouseUp}
        >
          {/* 2026-04-28 CLEAN · 沉浸式 dual-page OCR 分支已删,固定走单列 */}
          <div style={{
            maxWidth: 'min(95%, 1400px)', margin: '0 auto',
            padding: '40px clamp(32px, 4vw, 80px) 80px',
            background: 'transparent', minHeight: '100%',
            fontSize: ocrFontSize, fontWeight: ocrFontWeight,
            color: ocrBgLight < 50 ? `hsl(40, 15%, ${60 + (100 - ocrColorDepth) / 3}%)` : `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
          }}>
            <div style={{
              textAlign: 'center', marginBottom: 32, paddingBottom: 20,
              borderBottom: '2px solid var(--border)',
            }}>
              <h2 style={{ fontSize: ocrFontSize + 4, lineHeight: 1.4, marginBottom: 6 }}>
                {currentEntry?.title || ''}
              </h2>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                OCR 识别文本
                {ocrFilePath && <span> · {ocrFilePath.split(/[/\\]/).pop()}</span>}
              </div>
            </div>

            <OcrContent
              text={ocrFullText || ''}
              annotations={memoizedAnnotations}
              onAnnotationClick={(id) => setActiveAnnotation(id)}
              activeSelectionText={toolbar?.text || textSelection?.text || undefined}
              marks={memoizedMarks}
              onRemoveMark={handleRemoveMark}
              searchHighlight={searchHighlight?.targetEntryId === currentEntry?.id ? searchHighlight.query : null}
            />
          </div>
        </div>
      )}

      {/* ===== Floating Toolbar ===== */}
      {toolbar && (
        <div className="floating-toolbar" style={{ left: toolbar.x, top: toolbar.y, transform: 'translateX(-50%) translateY(-100%)' }}>
          {toolbarMode === 'main' && (
            <>
              <button onClick={() => handleToolbarAnnotate('yellow')} title="注释（默认黄色标记）">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                <span>注释</span>
              </button>
              <span className="ft-divider" />
              <button onClick={() => setToolbarMode('append-list')} title="追加到已有注释">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                <span>追加</span>
              </button>
              <span className="ft-divider" />
              <button onClick={() => setToolbarMode('underline-color')} title="划线">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>
                <span>划线</span>
              </button>
              <span className="ft-divider" />
              <button onClick={handleToolbarBold} title="高亮">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                <span>高亮</span>
              </button>
            </>
          )}

          {/* Color picker for underline */}
          {toolbarMode === 'underline-color' && (
            <div className="ft-colors">
              <button onClick={() => setToolbarMode('main')} style={{ padding: '4px 6px' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              {PRESET_COLORS.map(c => (
                <div key={c.name} className="ft-color" style={{ background: c.hex }}
                  onClick={() => handleToolbarUnderline(c.name)} title={c.name} />
              ))}
            </div>
          )}

          {/* Append: list of existing annotations — warm light theme, grouped by page */}
          {toolbarMode === 'append-list' && (
            <AppendAnnotationList
              annotations={currentPdfMeta?.annotations || []}
              otherEntries={otherEntryAnns}
              onAppend={handleToolbarAppend}
              onAppendOther={handleToolbarAppendOther}
              onBack={() => setToolbarMode('main')}
            />
          )}
        </div>
      )}

      {/* ===== Immersive Annotation Box 已删(2026-04-28 CLEAN) ===== */}

      {/* ===== Translate Modal ===== */}
      <TranslateModal
        open={translateOpen}
        onClose={() => setTranslateOpen(false)}
        entryId={currentEntry?.id || ''}
        initialMode={translateInitialMode}
        selectedText={translateSelectedText}
        fullText={ocrFullText || undefined}
        pageTexts={
          // Prefer the structured per-page texts when the meta stores them
          // (populated on fresh OCR runs). Fall back to parsing the full text
          // by "=== 第 N 页 ===" markers for older OCR output.
          currentPdfMeta?.pages && currentPdfMeta.pages.length > 0
            ? currentPdfMeta.pages.map(p => p.ocrText || '')
            : ocrFullText
              ? (() => {
                  const parts = ocrFullText.split(/=== 第 \d+ 页 ===/).slice(1)
                  return parts.length > 0 ? parts.map(s => s.trim()) : [ocrFullText]
                })()
              : undefined
        }
        totalPages={
          currentPdfMeta?.pages && currentPdfMeta.pages.length > 0
            ? currentPdfMeta.pages.length
            : numPages || 0
        }
        docTitle={currentEntry?.title}
      />
    </div>
  )
}

// Translation button with a small status dot anchored to the top-right corner.
// Reads this entry's translation job from the global store and renders:
//   running   → blue dot with pulsing halo
//   completed → green ✓
//   failed    → red !
//   aborted   → amber !
//   (no job)  → no badge
// Extracted so the top bar stays readable; the badge is a purely presentational
// wrapper around the same 翻译 button as before.
function TranslateButtonWithBadge({ entryId, onClick }: { entryId: string; onClick: () => void }) {
  const job = useTranslationJobsStore(s => s.jobs[entryId])
  const badge = (() => {
    if (!job || !entryId) return null
    // Running state always shows — it's a live progress indicator.
    if (job.status === 'running') return { bg: '#4a90e2', text: '', pulse: true, title: `翻译中 ${job.currentChunk}/${job.totalChunks}` }
    // Terminal states suppress once the user has opened the modal and seen them,
    // to avoid a "stale notification" forever sitting on the button.
    if (job.viewed) return null
    if (job.status === 'completed') return { bg: '#8BB174', text: '✓', pulse: false, title: '翻译完成，点击查看（查看后自动隐藏）' }
    if (job.status === 'failed') return { bg: '#C97070', text: '!', pulse: false, title: `翻译失败：${job.error || ''}（查看后自动隐藏）` }
    if (job.status === 'aborted') return { bg: '#D4A84B', text: '!', pulse: false, title: '翻译已停止（查看后自动隐藏）' }
    return null
  })()

  return (
    <div style={{ position: 'relative', display: 'inline-block', marginLeft: 8 }}>
      <button
        className="btn btn-sm"
        style={{ fontSize: 11 }}
        title={badge?.title || '翻译全文 / 按页'}
        onClick={onClick}
      >
        翻译
      </button>
      {badge && (
        <span
          style={{
            position: 'absolute', top: -4, right: -4, minWidth: 12, height: 12,
            padding: badge.text ? '0 3px' : 0, borderRadius: 6,
            background: badge.bg, color: '#fff', fontSize: 9, lineHeight: '12px',
            fontWeight: 700, textAlign: 'center',
            boxShadow: badge.pulse ? `0 0 0 0 ${badge.bg}` : 'none',
            animation: badge.pulse ? 'translate-badge-pulse 1.4s infinite' : undefined,
            pointerEvents: 'none',
          }}
        >
          {badge.text}
        </span>
      )}
      <style>{`
        @keyframes translate-badge-pulse {
          0% { box-shadow: 0 0 0 0 rgba(74, 144, 226, 0.5); }
          70% { box-shadow: 0 0 0 6px rgba(74, 144, 226, 0); }
          100% { box-shadow: 0 0 0 0 rgba(74, 144, 226, 0); }
        }
      `}</style>
    </div>
  )
}
