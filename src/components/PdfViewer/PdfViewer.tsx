import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import Markdown from 'react-markdown'
const ReactMarkdown = Markdown  // alias for compatibility
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import { v4 as uuid } from 'uuid'
import 'react-pdf/dist/esm/Page/TextLayer.css'
import 'react-pdf/dist/esm/Page/AnnotationLayer.css'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

// Clean OCR text for display
function cleanOcrText(raw: string): string {
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
  const superDigits: Record<string, string> = {
    '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'
  }
  const toSuper = (s: string) => s.split('').map(c => superDigits[c] || c).join('')

  return raw
    // \textcircled{N} → circled number
    .replace(/\$\s*\\\\?textcircled\{(\d+)\}\s*\$/g, (_m, n) => circled[parseInt(n)-1] || `(${n})`)
    // $^{(15)}$ or $^{15}$ or $ ^{(15)} $ → superscript: ⁽¹⁵⁾
    .replace(/\$\s*\^?\s*\{?\s*\((\d+)\)\s*\}?\s*\$/g, (_m, n) => `⁽${toSuper(n)}⁾`)
    .replace(/\$\s*\^\s*\{(\d+)\}\s*\$/g, (_m, n) => toSuper(n))
    .replace(/\$\s*\^\s*\{?\s*\\circ\s*\}?\s*\$/g, '°')
    // $_{text}$ → subscript (just keep the text)
    .replace(/\$\s*_\s*\{([^}]+)\}\s*\$/g, (_m, t) => t)
    // Remove image bbox references
    .replace(/!\[[^\]]*\]\(page=\d+,\s*bbox=\[[^\]]*\]\)/g, '')
    .replace(/!\[\]\([^)]*\)/g, '')
    // Remaining $...$ LaTeX: keep for remark-math / KaTeX to render
    // (don't strip — let the math renderer handle it)
    // Bare superscripts without $ wrapper: ^{83} or ^83
    .replace(/\^{?\{(\d+)\}?}/g, (_m, n) => toSuper(n))
    .replace(/\^(\d{1,3})(?=\D|$)/g, (_m, n) => toSuper(n))
    // Wrap bare LaTeX expressions (not inside $) in $ for remark-math
    // Strategy: find lines containing bare \ commands with braces, wrap the entire LaTeX segment
    .replace(/^(.*?)(\\(?:frac|partial|sqrt|sum|int|prod|lim|nabla|vec|hat|bar|overline|underline)\s*\{[\s\S]*?\}(?:\s*\{[^}]*\})*(?:\s*[,，.。])?)/gm, (full, before, latex) => {
      // Check if already inside $ delimiters
      const dollarsBefore = (before.match(/\$/g) || []).length
      if (dollarsBefore % 2 === 1) return full  // inside $ pair, don't wrap
      return `${before} $${latex.trim()}$ `
    })
    // Also wrap simpler bare LaTeX like \partial x or \alpha
    .replace(/(?<!\$)\\(partial|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|omega|pi|phi|psi|infty|cdot|times|div|pm|mp|leq|geq|neq|approx|equiv|forall|exists)(?=[^a-zA-Z])/g, (match) => {
      return ` $${match}$ `
    })
    // Clean up excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

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

// ===== Robust text highlighting in rendered DOM =====
// Collects all text nodes, builds a flat string, finds match positions,
// then maps back to DOM ranges for wrapping. Handles multiple matches correctly.

function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

function wrapRange(
  textNodes: Text[],
  startNodeIdx: number, startOffset: number,
  endNodeIdx: number, endOffset: number,
  wrapFn: () => HTMLElement,
): HTMLElement | null {
  try {
    if (startNodeIdx === endNodeIdx) {
      // Simple case: match within a single text node
      const node = textNodes[startNodeIdx]
      if (!node.isConnected) return null
      const range = document.createRange()
      range.setStart(node, startOffset)
      range.setEnd(node, endOffset)
      const wrapper = wrapFn()
      range.surroundContents(wrapper)
      return wrapper
    }
    // Cross-node: wrap each segment individually inside a common span is complex,
    // fall back to wrapping just the first node's portion
    const node = textNodes[startNodeIdx]
    if (!node.isConnected) return null
    const text = node.textContent || ''
    const matchText = text.substring(startOffset)
    const parent = node.parentNode!
    const wrapper = wrapFn()
    wrapper.textContent = matchText
    if (startOffset > 0) {
      node.textContent = text.substring(0, startOffset)
      parent.insertBefore(wrapper, node.nextSibling)
    } else {
      parent.insertBefore(wrapper, node)
      parent.removeChild(node)
    }
    return wrapper
  } catch { return null }
}

function findAndWrapAll(
  container: HTMLElement,
  targets: Array<{ text: string; id: string }>,
  wrapFn: (target: { text: string; id: string }) => HTMLElement,
  skipClass?: string,
) {
  for (const target of targets) {
    const searchText = target.text.replace(/\s+/g, '').trim()
    if (searchText.length < 2) continue

    // Re-collect text nodes each iteration (DOM changes between iterations)
    const textNodes = collectTextNodes(container)

    // Build flat string + map each flat char back to (nodeIndex, rawOffset)
    const charMap: Array<{ ni: number; offset: number }> = []
    let flat = ''
    for (let ni = 0; ni < textNodes.length; ni++) {
      const node = textNodes[ni]
      if (skipClass && (node.parentNode as HTMLElement)?.classList?.contains(skipClass)) continue
      const raw = node.textContent || ''
      for (let ri = 0; ri < raw.length; ri++) {
        if (/\s/.test(raw[ri])) continue // skip whitespace in flat string
        charMap.push({ ni, offset: ri })
        flat += raw[ri]
      }
    }

    const flatIdx = flat.indexOf(searchText)
    if (flatIdx === -1) continue

    const flatEnd = flatIdx + searchText.length

    // Collect which nodes are involved and their raw start/end offsets
    const segments: Array<{ node: Text; startOffset: number; endOffset: number }> = []
    let currentNi = -1
    let segStart = 0
    let segEnd = 0

    for (let fi = flatIdx; fi < flatEnd; fi++) {
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

    // Wrap each segment (reverse order to preserve offsets)
    try {
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si]
        if (!seg.node.isConnected) continue
        const raw = seg.node.textContent || ''
        const before = raw.substring(0, seg.startOffset)
        const match = raw.substring(seg.startOffset, seg.endOffset)
        const after = raw.substring(seg.endOffset)
        const parent = seg.node.parentNode!

        const wrapper = wrapFn(target)
        wrapper.textContent = match

        if (after) parent.insertBefore(document.createTextNode(after), seg.node.nextSibling)
        parent.insertBefore(wrapper, seg.node.nextSibling)
        if (before) { seg.node.textContent = before } else { parent.removeChild(seg.node) }
      }
    } catch { /* DOM changed, skip */ }
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

// OCR Content component with per-page sections and markdown rendering
function OcrContent({ text, annotations, onAnnotationClick, activeSelectionText, marks, onRemoveMark }: {
  text: string
  annotations: Array<{ id: string; selectedText: string }>
  onAnnotationClick: (id: string) => void
  activeSelectionText?: string
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onRemoveMark?: (id: string) => void
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
              fontSize: 12, color: '#bbb', marginBottom: 10,
              paddingBottom: 6, borderBottom: '1px solid #eee',
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
function HtmlViewer({ absPath, onTextSelect, annotations }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
  annotations?: Array<{ id: string; selectedText: string }>
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Listen for text selection messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'text-selection' && e.data.text) {
        onTextSelect({
          pageNumber: 1,
          text: e.data.text,
          startOffset: 0,
          endOffset: e.data.text.length,
        })
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onTextSelect])

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

      // Inject script before </body>
      const selectionScript = `
<script>
document.addEventListener('mouseup', function() {
  var sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    var text = sel.toString().trim();
    if (text && text.length >= 2) {
      window.parent.postMessage({ type: 'text-selection', text: text }, '*');
    }
  }
});
${annHighlightJS}
</script>`

      if (html.includes('</body>')) {
        html = html.replace('</body>', selectionScript + '</body>')
      } else {
        html += selectionScript
      }

      iframeRef.current!.srcdoc = html
    }).catch(() => {
      if (iframeRef.current) iframeRef.current.srcdoc = '<p>无法加载文件</p>'
    })
  }, [absPath, annotations])

  return (
    <iframe
      ref={iframeRef}
      style={{ width: '100%', height: '100%', border: 'none', background: 'var(--bg)' }}
      sandbox="allow-scripts allow-same-origin"
    />
  )
}

// EPUB viewer using epub.js
function EpubViewer({ absPath, onTextSelect }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<any>(null)
  const renditionRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    async function loadEpub() {
      const ePub = (await import('epubjs')).default
      const buf = await window.electronAPI.readFileBuffer(absPath)
      const book = ePub(buf.buffer)
      bookRef.current = book

      if (destroyed || !containerRef.current) return

      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'scrolled-doc',
      })
      renditionRef.current = rendition

      rendition.themes.default({
        body: { 'font-family': '"Noto Serif SC", "Source Han Serif", Georgia, serif', 'line-height': '2', 'max-width': '760px', 'margin': '0 auto', 'padding': '24px 32px' },
        'h1,h2,h3': { 'font-family': '-apple-system, "Microsoft YaHei", sans-serif' },
      })

      // Capture text selection
      rendition.on('selected', (cfiRange: string, contents: any) => {
        const sel = contents?.window?.getSelection()
        if (sel) {
          const text = sel.toString().trim()
          if (text && text.length >= 2) {
            onTextSelect({ pageNumber: 1, text, startOffset: 0, endOffset: text.length })
          }
        }
      })

      await rendition.display()
    }

    loadEpub().catch(err => console.error('[epub] Load error:', err))

    return () => {
      destroyed = true
      if (renditionRef.current) try { renditionRef.current.destroy() } catch {}
      if (bookRef.current) try { bookRef.current.destroy() } catch {}
    }
  }, [absPath, onTextSelect])

  return <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'auto', background: 'var(--bg)' }} />
}

// DOCX viewer: convert to HTML using mammoth
function DocxViewer({ absPath, onTextSelect, annotations, marks, onAnnotationClick, onRemoveMark, activeSelectionText }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
  annotations?: Array<{ id: string; selectedText: string }>
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onAnnotationClick?: (id: string) => void
  onRemoveMark?: (id: string) => void
  activeSelectionText?: string
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
        style={{ maxWidth: 800, margin: '0 auto', padding: '32px 40px 80px', fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit', lineHeight: 2, fontFamily: 'var(--font-serif)', position: 'relative' }}
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
function TextFileContent({ absPath, annotations, onAnnotationClick, marks, onRemoveMark, activeSelectionText }: {
  absPath: string
  annotations?: Array<{ id: string; selectedText: string }>
  onAnnotationClick?: (id: string) => void
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
  onRemoveMark?: (id: string) => void
  activeSelectionText?: string
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
    <div ref={containerRef} className="ocr-markdown-content" style={{ fontSize: 14, lineHeight: 2, position: 'relative' }}>
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

// ===== Immersive OCR Reader: page-flip, auto-fill, side page markers =====
function ImmersiveOcrReader({ text, fontSize, fontWeight, bgHue, bgSat, bgLight, colorDepth,
  annotations, marks, onAnnotationClick, onRemoveMark, activeSelectionText, onTextSelect }: {
  text: string; fontSize: number; fontWeight: number;
  bgHue: number; bgSat: number; bgLight: number; colorDepth: number;
  annotations: Array<{ id: string; selectedText: string }>;
  marks: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>;
  onAnnotationClick: (id: string) => void; onRemoveMark: (id: string) => void;
  activeSelectionText?: string;
  onTextSelect?: (sel: { text: string; pageNumber: number; x: number; y: number }) => void;
}) {
  const [spread, setSpread] = useState(0)
  const [flipDir, setFlipDir] = useState<'none' | 'left' | 'right'>('none')

  // Clean text: strip LaTeX artifacts, parse page markers
  const parsed = useMemo(() => {
    const lines: Array<{ text: string; origPage?: number }> = []
    let currentOrigPage = 1
    for (let rawLine of text.split('\n')) {
      const pageMatch = rawLine.match(/^=== 第 (\d+) 页 ===$/)
      if (pageMatch) { currentOrigPage = parseInt(pageMatch[1]); continue }
      lines.push({ text: rawLine, origPage: currentOrigPage })
    }
    return lines
  }, [text])

  // Calculate page capacity based on font size and viewport
  const lineH = fontSize * 1.75
  const pagePadV = 32
  const pagePadH = 36
  const pageH = window.innerHeight - 20  // nearly full screen
  const pageW = (window.innerWidth / 2) - 1
  const contentH = pageH - pagePadV * 2
  const contentW = pageW - pagePadH * 2
  const charsPerLine = Math.max(10, Math.floor(contentW / fontSize))
  // Fill page more aggressively — allow slight overflow which CSS will clip
  const linesPerPage = Math.max(5, Math.floor(contentH / lineH) + 1)

  // Split into visual pages
  const visualPages = useMemo(() => {
    const pages: Array<Array<{ text: string; origPage?: number }>> = []
    let cur: typeof pages[0] = []
    let count = 0
    for (const line of parsed) {
      // Skip pure empty lines at page start
      if (cur.length === 0 && !line.text.trim()) continue
      const wrap = Math.max(1, Math.ceil((line.text.length || 1) / charsPerLine))
      if (count + wrap > linesPerPage && cur.length > 0) {
        // Don't create a page with less than 3 lines of real content
        const realLines = cur.filter(l => l.text.trim()).length
        if (realLines < 3 && pages.length > 0) {
          // Merge with previous page (allow overflow)
          pages[pages.length - 1].push(...cur)
        } else {
          pages.push(cur)
        }
        cur = []; count = 0
      }
      cur.push(line); count += wrap
    }
    if (cur.length > 0) pages.push(cur)
    return pages
  }, [parsed, linesPerPage, charsPerLine])

  const totalSpreads = Math.ceil(visualPages.length / 2)

  // Navigation with animation
  const goNext = useCallback(() => {
    if (spread >= totalSpreads - 1) return
    setFlipDir('right'); setTimeout(() => { setSpread(s => s + 1); setFlipDir('none') }, 250)
  }, [spread, totalSpreads])

  const goPrev = useCallback(() => {
    if (spread <= 0) return
    setFlipDir('left'); setTimeout(() => { setSpread(s => s - 1); setFlipDir('none') }, 250)
  }, [spread])

  // Keyboard + click navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goNext() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [goNext, goPrev])

  // Handle text selection inside the reader (direct, no event bubbling needed)
  const handleInternalMouseUp = useCallback(() => {
    if (!onTextSelect) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const text = selection.toString().trim()
    if (!text || text.length < 2) return

    // Find page number from DOM
    let el: HTMLElement | null = selection.getRangeAt(0).startContainer.parentElement
    let pageNumber = 0
    while (el) {
      const pn = el.getAttribute('data-page-number')
      if (pn) { pageNumber = parseInt(pn); break }
      el = el.parentElement
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect()
    onTextSelect({ text, pageNumber: pageNumber || 1, x: rect.left + rect.width / 2, y: rect.bottom + 8 })
  }, [onTextSelect])

  const leftPage = visualPages[spread * 2]
  const rightPage = spread * 2 + 1 < visualPages.length ? visualPages[spread * 2 + 1] : null

  const bgColor = `hsl(${bgHue}, ${bgSat}%, ${bgLight}%)`
  const textColor = bgLight < 50
    ? `hsl(40, 15%, ${60 + (100 - colorDepth) / 3}%)`
    : `hsl(30, 20%, ${100 - colorDepth}%)`
  const markerColor = bgLight < 50 ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'

  // Flip animation style
  const animStyle = flipDir === 'none' ? {} : {
    transition: 'transform 0.25s ease, opacity 0.25s ease',
    transform: flipDir === 'right' ? 'translateX(-20px)' : 'translateX(20px)',
    opacity: 0.7,
  }

  const renderPage = (lines: Array<{ text: string; origPage?: number }>, side: 'left' | 'right') => {
    // Find original page markers for side labels
    const pageMarkers: Array<{ lineIdx: number; origPage: number }> = []
    let lastOrig = -1
    lines.forEach((line, i) => {
      if (line.origPage !== undefined && line.origPage !== lastOrig) {
        pageMarkers.push({ lineIdx: i, origPage: line.origPage })
        lastOrig = line.origPage
      }
    })

    // Join lines into markdown text for proper rendering
    const mdText = lines.map(l => l.text).join('\n')

    return (
      <div data-page-number={spread * 2 + (side === 'left' ? 1 : 2)} style={{
        flex: 1, padding: `${pagePadV}px ${pagePadH}px`,
        background: bgColor, fontSize, fontWeight, color: textColor,
        lineHeight: 1.75, height: '100vh', overflow: 'hidden', position: 'relative',
        borderLeft: side === 'right' ? `1px solid ${markerColor}` : 'none',
        ...animStyle,
      }}>
        {/* Original page markers */}
        {pageMarkers.map(m => (
          <span key={m.origPage} style={{
            position: 'absolute', left: 6, top: `${pagePadV + m.lineIdx * lineH}px`,
            fontSize: 8, color: markerColor, fontWeight: 400,
            userSelect: 'none', fontStyle: 'italic',
          }}>
            {m.origPage}
          </span>
        ))}
        {/* Rendered content */}
        <div className="ocr-markdown-content" style={{ fontSize, lineHeight: 1.75 }}>
          <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{mdText}</Markdown>
        </div>
      </div>
    )
  }

  return (
    <div onMouseUp={handleInternalMouseUp} style={{ width: '100%', height: '100%', background: bgColor, overflow: 'hidden', userSelect: 'text', position: 'relative' }}>
      {/* Two-page spread */}
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        {/* Left click zone — pointer-events only when not selecting text */}
        <div onClick={goPrev} onMouseDown={e => { if (window.getSelection()?.toString()) e.stopPropagation() }}
          style={{ position: 'absolute', left: 0, top: 0, width: '12%', height: '100%', zIndex: 10, cursor: spread > 0 ? 'w-resize' : 'default', pointerEvents: 'auto' }} />
        {/* Right click zone */}
        <div onClick={goNext} onMouseDown={e => { if (window.getSelection()?.toString()) e.stopPropagation() }}
          style={{ position: 'absolute', right: 0, top: 0, width: '12%', height: '100%', zIndex: 10, cursor: spread < totalSpreads - 1 ? 'e-resize' : 'default', pointerEvents: 'auto' }} />

        {leftPage && renderPage(leftPage, 'left')}
        {rightPage ? renderPage(rightPage, 'right') : (
          <div style={{ flex: 1, background: bgColor, borderLeft: `1px solid ${markerColor}` }} />
        )}
      </div>

      {/* Page indicator — overlaid at bottom center, minimal */}
      <div style={{
        position: 'absolute', bottom: 4, left: '50%', transform: 'translateX(-50%)',
        fontSize: 9, color: markerColor, padding: '2px 8px',
        borderRadius: 8, background: 'rgba(0,0,0,0.05)',
      }}>
        {spread * 2 + 1}{rightPage ? `-${spread * 2 + 2}` : ''} / {visualPages.length}
      </div>
    </div>
  )
}

// ===== Immersive mode: floating annotation box with note + AI =====
function ImmersiveAnnotationBox({ toolbar, textSelection, annotations, onAnnotate, onBold, onUnderline, onClose }: {
  toolbar: { x: number; y: number; text: string; pageNumber: number }
  textSelection: any
  annotations: any[]
  onAnnotate: () => void
  onBold: () => void
  onUnderline: (color: string) => void
  onClose: () => void
}) {
  const [noteText, setNoteText] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const { updatePdfMeta } = useLibraryStore()
  const { selectedAiModel, setSelectedAiModel } = useUiStore()
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>([])

  // Load configured AI providers
  useEffect(() => {
    if (window.electronAPI?.aiGetConfigured) {
      window.electronAPI.aiGetConfigured().then(setConfiguredProviders).catch(() => {})
    }
  }, [])

  const existingAnn = annotations.find((a: any) => a.anchor?.selectedText === textSelection.text)
  const history = existingAnn?.historyChain || []

  // Save note to annotation
  const handleSaveNote = async () => {
    if (!noteText.trim()) return
    const entry: any = {
      id: uuid(), type: 'note', content: noteText.trim(),
      author: 'user', createdAt: new Date().toISOString(),
    }
    if (existingAnn) {
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: meta.annotations.map((a: any) =>
          a.id === existingAnn.id ? { ...a, historyChain: [...a.historyChain, entry], updatedAt: new Date().toISOString() } : a
        ),
      }))
    } else {
      const newAnn = {
        id: uuid(),
        anchor: { pageNumber: toolbar.pageNumber, startOffset: 0, endOffset: textSelection.text.length, selectedText: textSelection.text },
        historyChain: [entry], style: { color: 'yellow' },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      await updatePdfMeta(meta => ({ ...meta, annotations: [...meta.annotations, newAnn] }))
    }
    setNoteText('')
  }

  // Ask AI
  const handleAskAi = async () => {
    if (!noteText.trim()) return
    setAiLoading(true); setAiResponse('')
    try {
      const model = useUiStore.getState().selectedAiModel
      const docTitle = useLibraryStore.getState().currentEntry?.title || ''
      const streamId = uuid()
      let fullText = ''
      const cleanup = window.electronAPI.onAiStreamChunk((sid: string, chunk: string) => { if (sid === streamId) { fullText += chunk; setAiResponse(fullText) } })
      try {
        await window.electronAPI.aiChatStream(streamId, model, [
          { role: 'system', content: `你是文献「${docTitle}」的学术导师。简洁回答。` },
          { role: 'user', content: `选中文本：「${textSelection.text.slice(0, 200)}」\n\n问题：${noteText}` },
        ])
      } finally { cleanup() }
      // Save AI response as annotation
      if (fullText) {
        const userEntry: any = { id: uuid(), type: 'question', content: noteText.trim(), author: 'user', createdAt: new Date().toISOString() }
        const aiEntry: any = { id: uuid(), type: 'ai_qa', content: fullText, userQuery: noteText.trim(), author: 'ai', createdAt: new Date().toISOString(), aiModel: model }
        if (existingAnn) {
          await updatePdfMeta(meta => ({
            ...meta,
            annotations: meta.annotations.map((a: any) =>
              a.id === existingAnn.id ? { ...a, historyChain: [...a.historyChain, userEntry, aiEntry], updatedAt: new Date().toISOString() } : a
            ),
          }))
        } else {
          const newAnn = {
            id: uuid(),
            anchor: { pageNumber: toolbar.pageNumber, startOffset: 0, endOffset: textSelection.text.length, selectedText: textSelection.text },
            historyChain: [userEntry, aiEntry], style: { color: 'yellow' },
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }
          await updatePdfMeta(meta => ({ ...meta, annotations: [...meta.annotations, newAnn] }))
        }
      }
      setNoteText('')
    } catch (err) {
      console.error('[ImmersiveAnnotationBox] AI error:', err)
      setAiResponse('AI 调用失败，请检查 API Key 设置')
    }
    setAiLoading(false)
  }

  // Model display name
  const modelLabel = (() => {
    const [pid, mid] = selectedAiModel.split(':')
    const p = configuredProviders.find(p => p.id === pid)
    const m = p?.models.find(m => m.id === mid)
    return m?.name || mid || selectedAiModel
  })()

  return (
    <div style={{
      position: 'fixed',
      left: Math.max(10, Math.min(toolbar.x - 220, window.innerWidth - 460)),
      top: Math.min(toolbar.y + 20, window.innerHeight - 480),
      width: 440, padding: '14px', background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', zIndex: 200,
    }} className="immersive-annotation-box">
      {/* Header: selected text + close */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '0 2px', flex: 1, lineHeight: 1.5 }}>
          「{textSelection.text.slice(0, 80)}{textSelection.text.length > 80 ? '...' : ''}」
        </div>
        <button onClick={onClose} style={{ padding: '2px 6px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0, marginLeft: 8 }}>x</button>
      </div>

      {/* History chain */}
      {history.length > 0 && (
        <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 8 }}>
          {history.slice(-6).map((h: any) => (
            <div key={h.id} style={{
              padding: '6px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12, lineHeight: 1.6,
              background: h.author === 'user' ? 'var(--accent-soft)' : 'var(--bg-warm)',
              color: 'var(--text)', borderLeft: h.author === 'ai' ? '2px solid var(--accent)' : 'none',
            }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 4 }}>{h.author === 'user' ? '我' : 'AI'}</span>
              {h.content.slice(0, 300)}{h.content.length > 300 ? '...' : ''}
            </div>
          ))}
        </div>
      )}

      {/* AI response streaming */}
      {aiResponse && (
        <div style={{ padding: '8px 10px', marginBottom: 8, borderRadius: 8, background: 'var(--bg-warm)', border: '1px solid var(--border-light)', fontSize: 13, lineHeight: 1.7, maxHeight: 240, overflow: 'auto' }}>
          <ReactMarkdown rehypePlugins={[rehypeRaw]}>{aiResponse}</ReactMarkdown>
          {aiLoading && <span className="streaming-cursor" />}
        </div>
      )}

      {/* Input */}
      <textarea
        autoFocus value={noteText} onChange={e => setNoteText(e.target.value)}
        placeholder="写笔记 / 向 AI 提问..."
        rows={3}
        style={{
          width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8,
          fontSize: 13, outline: 'none', resize: 'none', fontFamily: 'var(--font)',
          background: 'var(--bg-warm)', color: 'var(--text)', lineHeight: 1.6,
        }}
        onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
        onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
        onKeyDown={e => {
          if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleSaveNote() }
          if (e.key === 'Escape') onClose()
        }}
      />

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button onClick={onBold} style={{ padding: '4px 10px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>高亮</button>
          <button onClick={() => onUnderline('yellow')} style={{ padding: '4px 10px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>划线</button>
          {/* Model selector */}
          <select
            value={selectedAiModel}
            onChange={e => setSelectedAiModel(e.target.value)}
            style={{
              fontSize: 10, padding: '4px 4px', border: '1px solid var(--border)',
              borderRadius: 4, background: 'var(--bg-warm)', color: 'var(--text-secondary)',
              outline: 'none', cursor: 'pointer', maxWidth: 110,
            }}
          >
            {configuredProviders.length > 0 ? (
              configuredProviders.map(p => (
                <optgroup key={p.id} label={p.name}>
                  {p.models.map(m => (
                    <option key={`${p.id}:${m.id}`} value={`${p.id}:${m.id}`}>{m.name}</option>
                  ))}
                </optgroup>
              ))
            ) : (
              <option value="glm:glm-4-flash">请先配置 Key</option>
            )}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={handleSaveNote} disabled={!noteText.trim()} style={{ padding: '4px 12px', fontSize: 11, border: 'none', borderRadius: 4, background: noteText.trim() ? 'var(--accent)' : 'var(--border)', color: '#fff', cursor: 'pointer' }}>
            保存笔记
          </button>
          <button onClick={handleAskAi} disabled={!noteText.trim() || aiLoading} style={{ padding: '4px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-soft)', cursor: 'pointer', color: 'var(--accent-hover)' }}>
            {aiLoading ? '...' : '问 AI'}
          </button>
        </div>
      </div>
    </div>
  )
}

type ViewMode = 'pdf' | 'ocr'

export default function PdfViewer() {
  const { currentEntry, currentPdfMeta, updatePdfMeta, updateEntry } = useLibraryStore()
  const { textSelection, setTextSelection, setActiveAnnotation, glmApiKeyStatus, immersiveMode, darkMode, dualPageMode } = useUiStore()
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.0)
  const [pdfFileUrl, setPdfFileUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rereadingReminder, setRereadingReminder] = useState<{ annCount: number; lastTime: string } | null>(null)
  const [ocrProgress, setOcrProgress] = useState<{ status: string } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('pdf')
  const [ocrFullText, setOcrFullText] = useState<string | null>(null)
  const [ocrFilePath, setOcrFilePath] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editDirty, setEditDirty] = useState(false)
  // Persisted reading preferences
  const lsGet = (key: string, def: number) => { try { const v = localStorage.getItem(key); return v !== null ? Number(v) : def } catch { return def } }
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

  // Load other entries' annotations for cross-entry append
  const [otherEntryAnns, setOtherEntryAnns] = useState<OtherEntryAnns[]>([])
  useEffect(() => {
    if (!library || !currentEntry) { setOtherEntryAnns([]); return }
    let cancelled = false
    async function load() {
      const others: OtherEntryAnns[] = []
      for (const entry of library!.entries) {
        if (entry.id === currentEntry!.id) continue
        try {
          const meta = await window.electronAPI.loadPdfMeta(entry.id)
          if (meta?.annotations?.length) {
            others.push({ entryId: entry.id, entryTitle: entry.title, annotations: meta.annotations })
          }
        } catch {}
      }
      if (!cancelled) setOtherEntryAnns(others)
    }
    load()
    return () => { cancelled = true }
  }, [library?.entries.length, currentEntry?.id])

  // Memoize marks & annotations to prevent useEffect from re-running on every render
  const annsJson = JSON.stringify((currentPdfMeta?.annotations || []).map(a => a.id + a.anchor.selectedText))
  const memoizedAnnotations = useMemo(() => {
    return (currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))
  }, [annsJson])

  const marksJson = JSON.stringify(currentPdfMeta?.marks || [])
  const memoizedMarks = useMemo(() => {
    return (currentPdfMeta?.marks || []).map(m => ({
      id: m.id, type: m.type as 'underline' | 'bold', color: m.color, selectedText: m.selectedText
    }))
  }, [marksJson])

  const handleRemoveMark = useCallback((markId: string) => {
    document.querySelectorAll(`.ocr-mark[data-mark-id="${markId}"]`).forEach(el => {
      try {
        const parent = el.parentNode
        if (parent) { while (el.firstChild) parent.insertBefore(el.firstChild, el); parent.removeChild(el) }
      } catch {}
    })
    updatePdfMeta(meta => ({ ...meta, marks: (meta.marks || []).filter(m => m.id !== markId) }))
  }, [updatePdfMeta])

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
    setNumPages(0)
    setLoadError(null)
    setOcrFullText(null)
    setOcrFilePath(null)
    setHtmlContent(null)
    setTxtContent(null)
    setDocxHtml(null)
    setViewMode('pdf')
    setOcrProgress(null)
    setEditMode(false)
    setEditContent('')
    setEditDirty(false)
    setRereadingReminder(null)

    if (!currentEntry) return

    // Re-reading detection: if this doc was opened before and has annotations, show reminder
    if (currentEntry.lastOpenedAt) {
      window.electronAPI.loadPdfMeta(currentEntry.id).then(meta => {
        if (meta && meta.annotations && meta.annotations.length >= 2) {
          setRereadingReminder({
            annCount: meta.annotations.length,
            lastTime: new Date(currentEntry.lastOpenedAt!).toLocaleDateString('zh-CN'),
          })
        }
      }).catch(() => {})
    }

    const ext = currentEntry.absPath.split('.').pop()?.toLowerCase() || ''
    const fileUrl = 'file:///' + currentEntry.absPath.replace(/\\/g, '/')

    // Only set PDF URL for PDF files
    if (ext === 'pdf') {
      setPdfFileUrl(fileUrl)
    }

    // Restore scroll position after content renders (delayed to let async content load)
    setTimeout(() => {
      if (scrollRef.current) {
        try {
          const saved = localStorage.getItem(`sj-scroll-${currentEntry.id}`)
          scrollRef.current.scrollTop = saved ? Number(saved) : 0
        } catch { scrollRef.current.scrollTop = 0 }
      }
    }, 300)

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

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n)
  }, [])

  const onDocumentLoadError = useCallback((err: Error) => {
    setLoadError('PDF 解析失败: ' + err.message)
  }, [])

  // ===== OCR: Send entire PDF file to GLM-OCR =====
  const handleOcr = useCallback(async () => {
    if (!currentPdfMeta || !currentEntry) return
    if (glmApiKeyStatus !== 'set') { alert('请先在设置中填入 GLM API Key'); return }
    setOcrProgress({ status: '正在上传 PDF 并识别文字...' })

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
        await updateEntry(currentEntry.id, { ocrStatus: 'complete', ocrFilePath: savedPath })
        setOcrProgress({ status: 'OCR 完成！' })
        setTimeout(() => setOcrProgress(null), 2000)
      } else {
        setOcrProgress({ status: `失败: ${result.error}` })
        setTimeout(() => setOcrProgress(null), 5000)
      }
    } catch (err: any) {
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

    const isImmersive = useUiStore.getState().immersiveMode
    if (isImmersive) {
      // In immersive mode: set toolbar position for the floating annotation box,
      // and set textSelection directly (no floating toolbar needed)
      setToolbar({ x: rect.left + rect.width / 2, y: rect.bottom + 8, text, pageNumber: pageNumber || 1 })
      setTextSelection({ pageNumber: pageNumber || 1, text, startOffset: 0, endOffset: text.length })
    } else {
      setToolbar({ x: rect.left + rect.width / 2, y: rect.top - 8, text, pageNumber: pageNumber || 1 })
      setToolbarMode('main')
    }
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

  // Save/restore scroll position on immersive mode toggle
  useEffect(() => {
    if (immersiveMode) {
      // Entering immersive: save current scroll position
      if (scrollRef.current) {
        savedScrollPos.current = scrollRef.current.scrollTop
      }
    } else {
      // Exiting immersive: restore scroll position after layout settles
      setTimeout(() => {
        if (scrollRef.current && savedScrollPos.current > 0) {
          scrollRef.current.scrollTop = savedScrollPos.current
        }
      }, 100)
    }
  }, [immersiveMode])

  // ESC to exit immersive mode
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && immersiveMode) {
        useUiStore.getState().setImmersiveMode(false)
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [])

  // Also listen for fullscreen exit (browser ESC exits fullscreen before our handler)
  useEffect(() => {
    const handleFsChange = () => {
      if (!document.fullscreenElement && immersiveMode) {
        useUiStore.getState().setImmersiveMode(false)
      }
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  // Toolbar action: create annotation with color
  const handleToolbarAnnotate = useCallback((color: string) => {
    const tb = toolbarRef.current
    if (!tb) return
    setActiveAnnotation(null)
    setTextSelection({ pageNumber: tb.pageNumber, text: tb.text, startOffset: 0, endOffset: tb.text.length })
    useUiStore.getState().setAnnotationColor(color)
    setToolbar(null)
  }, [setTextSelection, setActiveAnnotation])

  // Handle text selection from ImmersiveOcrReader (direct callback, no event bubbling)
  const handleImmersiveTextSelect = useCallback((sel: { text: string; pageNumber: number; x: number; y: number }) => {
    setToolbar({ x: sel.x, y: sel.y, text: sel.text, pageNumber: sel.pageNumber })
    setTextSelection({ pageNumber: sel.pageNumber, text: sel.text, startOffset: 0, endOffset: sel.text.length })
  }, [setTextSelection])

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
    const meta = await window.electronAPI.loadPdfMeta(targetEntryId)
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
    // In immersive mode, keep annotation box open (no floating toolbar to dismiss)
    if (!useUiStore.getState().immersiveMode) setToolbar(null)
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
    // In immersive mode, keep annotation box open
    if (!useUiStore.getState().immersiveMode) setToolbar(null)
  }, [currentEntry, updatePdfMeta])

  // ===== RENDER =====

  if (!currentEntry) {
    return (
      <div className="pdf-area">
        <div className="empty-state">
          <span style={{ fontSize: 48 }}></span>
          <span>从左侧选择文献开始阅读</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>支持 PDF · HTML · EPUB · DOCX · TXT · MD</span>
        </div>
      </div>
    )
  }

  return (
    <div className="pdf-area">
      {/* Toolbar */}
      <div className="pdf-toolbar">
        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 250 }}>
          {currentEntry?.title || ''}
        </span>
        {numPages > 0 && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, flexShrink: 0 }}>{numPages} 页</span>
        )}
        <div style={{ flex: 1 }} />

        {/* View mode toggle — only for PDF files */}
        {isPdf && (
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginRight: 8 }}>
            <button
              className={viewMode === 'pdf' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ borderRadius: 0, border: 'none' }}
              onClick={() => setViewMode('pdf')}
            >
              PDF
            </button>
            <button
              className={viewMode === 'ocr' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)' }}
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
        ) : (viewMode === 'ocr' || ['docx', 'doc'].includes(fileExt)) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>字号</span>
            <input type="range" min="12" max="24" value={ocrFontSize}
              onChange={e => setOcrFontSize(Number(e.target.value))}
              style={{ width: 50, height: 3, accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 20 }}>{ocrFontSize}</span>

            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>粗细</span>
            <input type="range" min="200" max="800" step="50" value={ocrFontWeight}
              onChange={e => setOcrFontWeight(Number(e.target.value))}
              style={{ width: 50, height: 3, accentColor: 'var(--accent)' }} />

            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>深浅</span>
            <input type="range" min="10" max="100" value={ocrColorDepth}
              onChange={e => setOcrColorDepth(Number(e.target.value))}
              style={{ width: 40, height: 3, accentColor: 'var(--accent)' }} />

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
                    { label: '暖', h: 40, s: 30, l: 97 },
                    { label: '护眼', h: 128, s: 45, l: 88 },
                    { label: '绿', h: 100, s: 25, l: 95 },
                    { label: '蓝', h: 210, s: 20, l: 96 },
                    { label: '灰', h: 0, s: 0, l: 94 },
                    { label: '暗', h: 30, s: 10, l: 88 },
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

        {/* Edit button — for OCR text, TXT, MD, DOCX views */}
        {(viewMode === 'ocr' || isText || ['docx', 'doc'].includes(fileExt)) && (
          editMode ? (
            <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
              <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }}
                onClick={async () => {
                  // Save as .edited.txt next to original file
                  const editPath = currentEntry!.absPath.replace(/\.[^.]+$/, '.edited.txt')
                  await window.electronAPI.exportFile(editPath, [], editContent)
                  setEditDirty(false)
                }}>
                保存备份
              </button>
              <button className="btn btn-sm" style={{ fontSize: 11 }}
                onClick={async () => {
                  await window.electronAPI.exportFile(
                    currentEntry!.title + '.txt',
                    [{ name: '文本', extensions: ['txt', 'md'] }],
                    editContent
                  )
                }}>
                导出
              </button>
              <button className="btn btn-sm" style={{ fontSize: 11 }}
                onClick={() => { setEditMode(false) }}>
                退出编辑
              </button>
            </div>
          ) : (
            <button className="btn btn-sm" style={{ marginLeft: 8, fontSize: 11 }}
              onClick={async () => {
                if (ocrFullText) {
                  setEditContent(cleanOcrText(ocrFullText))
                } else if (isText && currentEntry) {
                  try {
                    const buf = await window.electronAPI.readFileBuffer(currentEntry.absPath)
                    setEditContent(new TextDecoder('utf-8').decode(buf))
                  } catch { setEditContent('') }
                } else if (['docx', 'doc'].includes(fileExt) && currentEntry) {
                  try {
                    const mammoth = await import('mammoth')
                    const buf = await window.electronAPI.readFileBuffer(currentEntry.absPath)
                    const result = await mammoth.extractRawText({ arrayBuffer: buf.buffer })
                    setEditContent(result.value || '')
                  } catch { setEditContent('') }
                } else {
                  setEditContent('')
                }
                setEditMode(true)
                setEditDirty(false)
              }}>
              编辑
            </button>
          )
        )}

        {/* 读后反刍: generate structured review memo from annotations */}
        {currentPdfMeta && currentPdfMeta.annotations.length >= 2 && (
          <button className="btn btn-sm" style={{ marginLeft: 8, fontSize: 11 }}
            title="基于本文献的所有注释，AI 生成一份结构化的反刍笔记"
            onClick={async () => {
              const annotations = currentPdfMeta.annotations
              if (annotations.length < 2) return

              const title = currentEntry?.title || '未知文献'
              const annSummary = annotations.map((a, i) => {
                const notes = a.historyChain
                  .filter(h => h.author === 'user')
                  .map(h => h.content)
                  .join('; ')
                return `${i + 1}. 「${a.anchor.selectedText.slice(0, 60)}」${notes ? ` — 笔记: ${notes.slice(0, 100)}` : ''}`
              }).join('\n')

              // Create memo with AI-generated review
              const model = useUiStore.getState().selectedAiModel
              const streamId = uuid()
              let fullText = ''
              const cleanup = window.electronAPI.onAiStreamChunk((sid: string, chunk: string) => { if (sid === streamId) fullText += chunk })

              try {
                await window.electronAPI.aiChatStream(streamId, model, [
                  { role: 'system', content: `你是学术阅读助手。用户读完了文献「${title}」并留下了一些注释。请基于这些注释生成一份结构化的「读后反刍」笔记。\n\n格式要求：\n1. **核心论点**（1-2句概括文献主旨）\n2. **我的标注与思考**（按注释整理，保留用户原话）\n3. **疑问与待深入**（从注释中提炼出值得继续探索的问题）\n4. **下次阅读时思考**（3个引导性问题）\n\n用「你」称呼用户。` },
                  { role: 'user', content: `文献：${title}\n\n我的 ${annotations.length} 条注释：\n${annSummary}` },
                ])
              } finally { cleanup() }

              if (fullText) {
                const memoContent = `# 读后反刍：${title}\n\n${fullText}`
                const { createMemo } = useLibraryStore.getState()
                const memo = await createMemo()
                if (memo) {
                  await useLibraryStore.getState().updateMemo(memo.id, { content: memoContent, title: `反刍：${title}` })
                  useUiStore.getState().setActiveMemo(memo.id)
                }
              }
            }}
          >
            反刍
          </button>
        )}

        {/* Immersive mode toggle — hidden for now, feature in development */}
        {false && <button
          className="btn btn-sm"
          style={{ marginLeft: 8 }}
          onClick={() => {
            useUiStore.getState().setImmersiveMode(!immersiveMode)
          }}
          title={immersiveMode ? '退出沉浸阅读（ESC）' : '沉浸式阅读'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {immersiveMode ? (
              <><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></>
            ) : (
              <><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></>
            )}
          </svg>
        </button>}
      </div>

      {/* Re-reading reminder */}
      {rereadingReminder && (
        <div style={{
          padding: '8px 16px', background: 'var(--accent-soft)', borderBottom: '1px solid var(--border)',
          fontSize: 12, color: 'var(--accent-hover)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>
            📖 你上次在 {rereadingReminder.lastTime} 阅读过这篇文献，留下了 {rereadingReminder.annCount} 条注释。
            <button onClick={() => {
              useUiStore.getState().toggleAnnotationPanel()
              setRereadingReminder(null)
            }} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', fontSize: 12, marginLeft: 4 }}>
              查看注释
            </button>
          </span>
          <button onClick={() => setRereadingReminder(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14 }}>×</button>
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
        <div className="pdf-scroll-area" ref={scrollRef} onMouseUp={handleMouseUp}
          style={immersiveMode ? { background: 'var(--bg)', padding: 0 } : undefined}
        >
          {loadError ? (
            <div className="empty-state"><span style={{ fontSize: 32 }}>❌</span><span>{loadError}</span></div>
          ) : !pdfFileUrl ? (
            <div className="empty-state"><span>加载中...</span></div>
          ) : (
            <Document
              key={`${currentEntry?.id}-${immersiveMode ? 'dual' : 'single'}`}
              file={pdfFileUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={<div className="empty-state"><span>解析 PDF...</span></div>}
              error={<div className="empty-state"><span>PDF 解析失败</span></div>}
            >
              {immersiveMode && dualPageMode ? (
                /* Dual-page layout for immersive mode */
                (() => {
                  const pairs: Array<[number, number | null]> = []
                  for (let i = 1; i <= numPages; i += 2) {
                    pairs.push([i, i + 1 <= numPages ? i + 1 : null])
                  }
                  const immScale = Math.min((window.innerWidth / 2 - 40) / 600, (window.innerHeight - 60) / 800)
                  return pairs.map(([left, right]) => (
                    <div key={left} style={{
                      display: 'flex', justifyContent: 'center', gap: 4,
                      minHeight: '100vh', alignItems: 'center', padding: '20px 0',
                    }}>
                      <div className="pdf-page-wrapper" data-page-number={left} style={{ position: 'relative', boxShadow: '0 2px 16px rgba(0,0,0,0.3)' }}>
                        <div style={{ position: 'absolute', top: 4, right: 8, fontSize: 10, color: '#999', background: 'rgba(255,255,255,0.85)', padding: '1px 6px', borderRadius: 4, zIndex: 5 }}>{left}</div>
                        <Page pageNumber={left} scale={immScale} renderTextLayer={true} renderAnnotationLayer={false}
                          loading={<div style={{ width: 600 * immScale, height: 800 * immScale, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>第 {left} 页...</div>} />
                      </div>
                      {right && (
                        <div className="pdf-page-wrapper" data-page-number={right} style={{ position: 'relative', boxShadow: '0 2px 16px rgba(0,0,0,0.3)' }}>
                          <div style={{ position: 'absolute', top: 4, right: 8, fontSize: 10, color: '#999', background: 'rgba(255,255,255,0.85)', padding: '1px 6px', borderRadius: 4, zIndex: 5 }}>{right}</div>
                          <Page pageNumber={right} scale={immScale} renderTextLayer={true} renderAnnotationLayer={false}
                            loading={<div style={{ width: 600 * immScale, height: 800 * immScale, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>第 {right} 页...</div>} />
                        </div>
                      )}
                    </div>
                  ))
                })()
              ) : (
                /* Normal single-page scroll layout */
                Array.from({ length: numPages }, (_, i) => (
                  <div key={i + 1} className="pdf-page-wrapper" data-page-number={i + 1} style={{ position: 'relative' }}>
                    <div style={{
                      position: 'absolute', top: 4, right: 8, fontSize: 11,
                      color: '#999', background: 'rgba(255,255,255,0.85)', padding: '2px 8px',
                      borderRadius: 4, zIndex: 5
                    }}>
                      {i + 1}
                    </div>
                    <Page
                      pageNumber={i + 1}
                      scale={scale}
                      renderTextLayer={true}
                      renderAnnotationLayer={false}
                      loading={
                        <div style={{ width: 600 * scale, height: 800 * scale, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                          第 {i + 1} 页...
                        </div>
                      }
                    />
                  </div>
                ))
              )}
            </Document>
          )}
        </div>
      )}

      {/* ===== HTML View (iframe with postMessage for text selection) ===== */}
      {viewMode === 'pdf' && isHtml && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <HtmlViewer key={currentEntry?.id} absPath={absPath} onTextSelect={setTextSelection}
            annotations={(currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))}
          />
        </div>
      )}

      {/* ===== EPUB View ===== */}
      {viewMode === 'pdf' && fileExt === 'epub' && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <EpubViewer key={currentEntry?.id} absPath={absPath} onTextSelect={setTextSelection} />
        </div>
      )}

      {/* ===== DOCX View ===== */}
      {viewMode === 'pdf' && !editMode && ['docx', 'doc'].includes(fileExt) && (
        immersiveMode && dualPageMode && docxHtml ? (
          /* Immersive dual-column DOCX */
          <div className="pdf-scroll-area" style={{
            alignItems: 'stretch', padding: 0,
            background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
          }} onMouseUp={handleMouseUp}>
            <div style={{
              columnCount: 2, columnGap: '48px', columnRule: `1px solid ${ocrBgLight < 50 ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
              padding: '40px 48px', minHeight: '100vh',
              fontSize: ocrFontSize, fontWeight: ocrFontWeight, lineHeight: 2,
              fontFamily: 'var(--font-serif)',
              color: ocrBgLight < 50 ? `hsl(40, 15%, ${60 + (100 - ocrColorDepth) / 3}%)` : `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
            }} className="ocr-markdown-content" dangerouslySetInnerHTML={{ __html: docxHtml }} />
          </div>
        ) : (
          /* Normal single-column DOCX */
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
            />
          </div>
        )
      )}

      {/* ===== Text View ===== */}
      {viewMode === 'pdf' && !editMode && isText && (
        immersiveMode && dualPageMode && txtContent ? (
          /* Immersive dual-page TXT/MD via ImmersiveOcrReader */
          <div className="pdf-scroll-area" style={{
            alignItems: 'stretch', padding: 0,
            background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
          }} onMouseUp={handleMouseUp}>
            <ImmersiveOcrReader
              text={txtContent}
              fontSize={ocrFontSize}
              fontWeight={ocrFontWeight}
              bgHue={ocrBgHue} bgSat={ocrBgSat} bgLight={ocrBgLight}
              colorDepth={ocrColorDepth}
              annotations={memoizedAnnotations}
              marks={memoizedMarks}
              onAnnotationClick={(id) => setActiveAnnotation(id)}
              onRemoveMark={handleRemoveMark}
              activeSelectionText={toolbar?.text || textSelection?.text || undefined}
              onTextSelect={handleImmersiveTextSelect}
            />
          </div>
        ) : (
          /* Normal single-column TXT/MD */
          <div className="pdf-scroll-area" style={{ alignItems: 'stretch', padding: 0, background: 'var(--bg-warm)' }} onMouseUp={handleMouseUp}>
            <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 48px', minHeight: '100%' }} data-page-number="1">
              <TextFileContent
                key={currentEntry?.id}
                absPath={absPath}
                annotations={(currentPdfMeta?.annotations || []).map(a => ({ id: a.id, selectedText: a.anchor.selectedText }))}
                onAnnotationClick={(id) => setActiveAnnotation(id)}
                marks={currentPdfMeta?.marks?.map(m => ({ id: m.id, type: m.type, color: m.color, selectedText: m.selectedText })) || []}
                onRemoveMark={handleRemoveMark}
                activeSelectionText={textSelection?.text}
              />
            </div>
          </div>
        )
      )}

      {/* ===== Edit Mode ===== */}
      {editMode && (
        <div className="pdf-scroll-area" style={{
          background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
          padding: 0, display: 'flex', flexDirection: 'column',
        }}>
          <textarea
            value={editContent}
            onChange={e => { setEditContent(e.target.value); setEditDirty(true) }}
            style={{
              flex: 1, width: '100%', padding: '24px 48px',
              border: 'none', outline: 'none', resize: 'none',
              fontSize: ocrFontSize, fontWeight: ocrFontWeight,
              lineHeight: 2, fontFamily: 'var(--font-serif)',
              color: ocrBgLight < 50 ? `hsl(40, 15%, ${60 + (100 - ocrColorDepth) / 3}%)` : `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
              background: 'transparent',
            }}
          />
          {editDirty && (
            <div style={{ padding: '4px 48px 8px', fontSize: 11, color: 'var(--accent)', flexShrink: 0 }}>
              有未保存的更改
            </div>
          )}
        </div>
      )}

      {/* ===== OCR Text View ===== */}
      {viewMode === 'ocr' && !editMode && (
        <div
          className="pdf-scroll-area"
          style={{
            background: immersiveMode ? `hsl(${ocrBgHue}, ${Math.max(ocrBgSat - 10, 0)}%, ${Math.max(ocrBgLight - 8, 10)}%)` : `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
            alignItems: 'stretch', padding: 0,
          }}
          onMouseUp={handleMouseUp}
        >
          {immersiveMode && dualPageMode ? (
            <ImmersiveOcrReader
              text={ocrFullText || ''}
              fontSize={ocrFontSize}
              fontWeight={ocrFontWeight}
              bgHue={ocrBgHue} bgSat={ocrBgSat} bgLight={ocrBgLight}
              colorDepth={ocrColorDepth}
              annotations={memoizedAnnotations}
              marks={memoizedMarks}
              onAnnotationClick={(id) => setActiveAnnotation(id)}
              onRemoveMark={handleRemoveMark}
              activeSelectionText={toolbar?.text || textSelection?.text || undefined}
              onTextSelect={handleImmersiveTextSelect}
            />
          ) : (
            /* Normal single-column OCR layout */
            <div style={{
              maxWidth: 800, margin: '0 auto', padding: '40px 48px 80px',
              background: 'transparent', minHeight: '100%',
              fontSize: ocrFontSize, fontWeight: ocrFontWeight,
              color: ocrBgLight < 50 ? `hsl(40, 15%, ${60 + (100 - ocrColorDepth) / 3}%)` : `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
            }}>
              <div style={{
                textAlign: 'center', marginBottom: 32, paddingBottom: 20,
                borderBottom: '2px solid #333'
              }}>
                <h2 style={{ fontSize: ocrFontSize + 4, lineHeight: 1.4, marginBottom: 6 }}>
                  {currentEntry?.title || ''}
                </h2>
                <div style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>
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
              />
            </div>
          )}
        </div>
      )}

      {/* ===== Floating Toolbar (hidden in immersive mode — annotation box takes over) ===== */}
      {toolbar && !immersiveMode && (
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

      {/* ===== Immersive Mode: floating annotation panel ===== */}
      {immersiveMode && textSelection && toolbar && (
        <ImmersiveAnnotationBox
          toolbar={toolbar}
          textSelection={textSelection}
          annotations={currentPdfMeta?.annotations || []}
          onAnnotate={() => handleToolbarAnnotate('yellow')}
          onBold={() => handleToolbarBold()}
          onUnderline={(color) => handleToolbarUnderline(color)}
          onClose={() => { setToolbar(null); setTextSelection(null) }}
        />
      )}
    </div>
  )
}
