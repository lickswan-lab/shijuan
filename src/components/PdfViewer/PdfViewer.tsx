import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import Markdown from 'react-markdown'
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
    // Remaining LaTeX: try to extract readable content, or remove
    .replace(/\$([^$]{1,80})\$/g, (_m, inner) => {
      // If it's mostly normal text with minor LaTeX, extract text
      const cleaned = inner
        .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
        .replace(/\\textit\{([^}]+)\}/g, '*$1*')
        .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
        .replace(/\\\\/g, '')
        .replace(/[\\{}^_]/g, '')
        .trim()
      return cleaned || ''
    })
    // Bare superscripts without $ wrapper: ^{83} or ^83
    .replace(/\^{?\{(\d+)\}?}/g, (_m, n) => toSuper(n))
    .replace(/\^(\d{1,3})(?=\D|$)/g, (_m, n) => toSuper(n))
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

    // Build flat string from all text nodes (whitespace-collapsed)
    const nodeRanges: Array<{ node: Text; start: number; end: number }> = []
    let flat = ''
    for (const node of textNodes) {
      if (skipClass && (node.parentNode as HTMLElement)?.classList?.contains(skipClass)) continue
      const start = flat.length
      flat += (node.textContent || '').replace(/\s+/g, '')
      nodeRanges.push({ node, start, end: flat.length })
    }

    const flatIdx = flat.indexOf(searchText)
    if (flatIdx === -1) continue

    const flatEnd = flatIdx + searchText.length

    // Map flat position back to a single text node (find the node containing flatIdx)
    let bestNode: Text | null = null
    let bestNodeOffset = 0
    for (const nr of nodeRanges) {
      if (nr.start <= flatIdx && nr.end > flatIdx) {
        bestNode = nr.node
        // Calculate offset within this node's raw text
        const rawText = nr.node.textContent || ''
        let ri = 0, fi = nr.start
        while (fi < flatIdx && ri < rawText.length) {
          if (/\s/.test(rawText[ri])) { ri++; continue }
          ri++; fi++
        }
        bestNodeOffset = ri
        break
      }
    }
    if (!bestNode || !bestNode.isConnected) continue

    // Calculate how many raw chars to include to cover the searchText length
    const rawText = bestNode.textContent || ''
    let ri = bestNodeOffset, matchedChars = 0
    while (matchedChars < searchText.length && ri < rawText.length) {
      if (/\s/.test(rawText[ri])) { ri++; continue }
      ri++; matchedChars++
    }

    if (matchedChars < searchText.length) {
      // Match spans beyond this text node — wrap what we can in this node
      // This handles most cases since OCR text nodes are usually large
    }

    const endOffset = ri

    try {
      const before = rawText.substring(0, bestNodeOffset)
      const match = rawText.substring(bestNodeOffset, endOffset)
      const after = rawText.substring(endOffset)
      const parent = bestNode.parentNode!

      const wrapper = wrapFn(target)
      wrapper.textContent = match

      if (after) parent.insertBefore(document.createTextNode(after), bestNode.nextSibling)
      parent.insertBefore(wrapper, bestNode.nextSibling)
      if (before) { bestNode.textContent = before } else { parent.removeChild(bestNode) }
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
function OcrContent({ text, annotations, onAnnotationClick, activeSelectionText, marks }: {
  text: string
  annotations: Array<{ id: string; selectedText: string }>
  onAnnotationClick: (id: string) => void
  activeSelectionText?: string
  marks?: Array<{ id: string; type: 'underline' | 'bold'; color?: string; selectedText: string }>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cleaned = useMemo(() => cleanOcrText(text), [text])

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
      return span
    }, 'ocr-mark')
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
        <div key={i} style={{ marginBottom: 28 }}>
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
    </div>
  )
}

// HTML viewer: uses iframe for proper rendering + postMessage for text selection
function HtmlViewer({ absPath, onTextSelect }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
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

  // Load HTML and inject selection script
  useEffect(() => {
    if (!iframeRef.current) return
    window.electronAPI.readFileBuffer(absPath).then(buf => {
      const decoder = new TextDecoder('utf-8')
      let html = decoder.decode(buf)

      // Inject a small script before </body> to capture text selection
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
  }, [absPath])

  return (
    <iframe
      ref={iframeRef}
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
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

  return <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'auto', background: '#fff' }} />
}

// DOCX viewer: convert to HTML using mammoth
function DocxViewer({ absPath, onTextSelect }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
}) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString().trim()
    if (text && text.length >= 2) {
      onTextSelect({ pageNumber: 1, text, startOffset: 0, endOffset: text.length })
    }
  }, [onTextSelect])

  if (error) return <div className="empty-state"><span>DOCX 解析失败：{error}</span></div>
  if (!html) return <div className="empty-state"><span className="loading-spinner" /><span>正在转换 DOCX...</span></div>

  return (
    <div
      onMouseUp={handleMouseUp}
      style={{ maxWidth: 800, margin: '0 auto', padding: '32px 40px 80px', fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit', lineHeight: 2, fontFamily: 'var(--font-serif)' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// Simple text file reader
function TextFileContent({ absPath }: { absPath: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    window.electronAPI.readFileBuffer(absPath).then(buf => {
      const decoder = new TextDecoder('utf-8')
      setText(decoder.decode(buf))
    }).catch(() => setText('无法读取文件'))
  }, [absPath])

  if (!text) return <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
  return (
    <div className="ocr-markdown-content" style={{ fontSize: 14, lineHeight: 2 }}>
      <Markdown>{text}</Markdown>
    </div>
  )
}

type ViewMode = 'pdf' | 'ocr'

export default function PdfViewer() {
  const { currentEntry, currentPdfMeta, updatePdfMeta, updateEntry } = useLibraryStore()
  const { textSelection, setTextSelection, setActiveAnnotation, glmApiKeyStatus } = useUiStore()
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.0)
  const [pdfFileUrl, setPdfFileUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [ocrProgress, setOcrProgress] = useState<{ status: string } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('pdf')
  const [ocrFullText, setOcrFullText] = useState<string | null>(null)
  const [ocrFilePath, setOcrFilePath] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editDirty, setEditDirty] = useState(false)
  const [ocrFontSize, setOcrFontSize] = useState(16)
  const [ocrFontWeight, setOcrFontWeight] = useState(400)
  const [ocrColorDepth, setOcrColorDepth] = useState(80)
  const [ocrBgHue, setOcrBgHue] = useState(40)       // hue: 0-360
  const [ocrBgSat, setOcrBgSat] = useState(30)       // saturation: 0-100
  const [ocrBgLight, setOcrBgLight] = useState(97)    // lightness: 85-100
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const absPath = currentEntry?.absPath || ''
  const fileExt = absPath.split('.').pop()?.toLowerCase() || ''
  const isPdf = fileExt === 'pdf'
  const isHtml = ['html', 'htm'].includes(fileExt)
  const isText = ['txt', 'md'].includes(fileExt)
  const isOtherDoc = ['docx', 'doc', 'epub'].includes(fileExt)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)

  // Load file when entry changes — reset ALL state first to prevent cross-format contamination
  useEffect(() => {
    // Reset everything
    setPdfFileUrl(null)
    setNumPages(0)
    setLoadError(null)
    setOcrFullText(null)
    setOcrFilePath(null)
    setHtmlContent(null)
    setViewMode('pdf')
    setOcrProgress(null)
    setEditMode(false)
    setEditContent('')
    setEditDirty(false)

    if (!currentEntry) return

    const ext = currentEntry.absPath.split('.').pop()?.toLowerCase() || ''
    const fileUrl = 'file:///' + currentEntry.absPath.replace(/\\/g, '/')

    // Only set PDF URL for PDF files
    if (ext === 'pdf') {
      setPdfFileUrl(fileUrl)
    }

    if (scrollRef.current) scrollRef.current.scrollTop = 0

    // Load HTML content for HTML files
    if (['html', 'htm'].includes(ext)) {
      window.electronAPI.readFileBuffer(currentEntry.absPath).then(buf => {
        const decoder = new TextDecoder('utf-8')
        setHtmlContent(decoder.decode(buf))
      }).catch(() => setHtmlContent(null))
    }

    // Check for existing OCR text file, default to OCR view if available (PDF only)
    window.electronAPI.readOcrText(currentEntry.absPath).then((result) => {
      if (result.exists && result.text) {
        setOcrFullText(result.text)
        setOcrFilePath(result.path)
        // Only auto-switch to OCR for PDF files; HTML/text render natively
        if (ext === 'pdf') setViewMode('ocr')
        else setViewMode('pdf')
      } else {
        setOcrFullText(null)
        setOcrFilePath(null)
        setViewMode('pdf')
      }
    })
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
    if (!selection || selection.isCollapsed) { return }
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
    setToolbar({ x: rect.left + rect.width / 2, y: rect.top - 8, text, pageNumber: pageNumber || 1 })
    setToolbarMode('main')
  }, [])

  // Dismiss toolbar on click outside
  useEffect(() => {
    if (!toolbar) return
    const handler = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('.floating-toolbar')) return
      setToolbar(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [toolbar])

  // Toolbar action: create annotation with color
  const handleToolbarAnnotate = useCallback((color: string) => {
    if (!toolbar) return
    setTextSelection({ pageNumber: toolbar.pageNumber, text: toolbar.text, startOffset: 0, endOffset: toolbar.text.length })
    // Store color for the annotation to be created
    useUiStore.getState().setAnnotationColor(color)
    setToolbar(null)
  }, [toolbar, setTextSelection])

  // Toolbar action: append to existing annotation
  const handleToolbarAppend = useCallback((annotationId: string) => {
    setActiveAnnotation(annotationId)
    setToolbar(null)
  }, [setActiveAnnotation])

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
    if (!toolbar || !currentEntry) return
    const mark: import('../../types/library').TextMark = {
      id: crypto.randomUUID(),
      type: 'underline',
      color,
      pageNumber: toolbar.pageNumber,
      selectedText: toolbar.text,
      createdAt: new Date().toISOString(),
    }
    updatePdfMeta(meta => ({
      ...meta,
      marks: [...(meta.marks || []), mark],
    }))
    window.getSelection()?.removeAllRanges()
    setToolbar(null)
  }, [toolbar, currentEntry, updatePdfMeta])

  // Toolbar action: add bold mark
  const handleToolbarBold = useCallback(() => {
    if (!toolbar || !currentEntry) return
    const mark: import('../../types/library').TextMark = {
      id: crypto.randomUUID(),
      type: 'bold',
      pageNumber: toolbar.pageNumber,
      selectedText: toolbar.text,
      createdAt: new Date().toISOString(),
    }
    updatePdfMeta(meta => ({
      ...meta,
      marks: [...(meta.marks || []), mark],
    }))
    window.getSelection()?.removeAllRanges()
    setToolbar(null)
  }, [toolbar, currentEntry, updatePdfMeta])

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

            {/* Background presets */}
            {[
              { label: '暖', h: 40, s: 30, l: 97 },
              { label: '绿', h: 100, s: 25, l: 95 },
              { label: '蓝', h: 210, s: 20, l: 96 },
              { label: '灰', h: 0, s: 0, l: 94 },
              { label: '暗', h: 30, s: 10, l: 88 },
            ].map(p => (
              <button
                key={p.label}
                onClick={() => { setOcrBgHue(p.h); setOcrBgSat(p.s); setOcrBgLight(p.l) }}
                title={`背景：${p.label}`}
                style={{
                  width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border)',
                  background: `hsl(${p.h}, ${p.s}%, ${p.l}%)`, cursor: 'pointer', padding: 0, flexShrink: 0,
                  outline: (ocrBgHue === p.h && ocrBgSat === p.s && ocrBgLight === p.l) ? '2px solid var(--accent)' : 'none',
                  outlineOffset: 1,
                }}
              />
            ))}
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
      </div>

      {/* OCR Progress */}
      {ocrProgress && (
        <div style={{
          padding: '10px 16px', background: '#fff8f0', borderBottom: '1px solid var(--border)',
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
        <div className="pdf-scroll-area" ref={scrollRef} onMouseUp={handleMouseUp}>
          {loadError ? (
            <div className="empty-state"><span style={{ fontSize: 32 }}>❌</span><span>{loadError}</span></div>
          ) : !pdfFileUrl ? (
            <div className="empty-state"><span>加载中...</span></div>
          ) : (
            <Document
              key={currentEntry?.id}
              file={pdfFileUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={<div className="empty-state"><span>解析 PDF...</span></div>}
              error={<div className="empty-state"><span>PDF 解析失败</span></div>}
            >
              {Array.from({ length: numPages }, (_, i) => (
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
              ))}
            </Document>
          )}
        </div>
      )}

      {/* ===== HTML View (iframe with postMessage for text selection) ===== */}
      {viewMode === 'pdf' && isHtml && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <HtmlViewer key={currentEntry?.id} absPath={absPath} onTextSelect={setTextSelection} />
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
        <div className="pdf-scroll-area" style={{
          alignItems: 'stretch', padding: 0,
          background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
          fontSize: ocrFontSize, fontWeight: ocrFontWeight,
          color: `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
        }} onMouseUp={handleMouseUp}>
          <DocxViewer key={currentEntry?.id} absPath={absPath} onTextSelect={setTextSelection} />
        </div>
      )}

      {/* ===== Text View ===== */}
      {viewMode === 'pdf' && !editMode && isText && (
        <div className="pdf-scroll-area" style={{ alignItems: 'stretch', padding: 0, background: 'var(--bg-warm)' }} onMouseUp={handleMouseUp}>
          <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 48px', minHeight: '100%' }}>
            <TextFileContent key={currentEntry?.id} absPath={absPath} />
          </div>
        </div>
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
              color: `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
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
          style={{ background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`, alignItems: 'stretch', padding: 0 }}
          onMouseUp={handleMouseUp}
        >
          <div style={{
            maxWidth: 800, margin: '0 auto', padding: '40px 48px 80px',
            background: 'transparent', minHeight: '100%',
            fontSize: ocrFontSize, fontWeight: ocrFontWeight,
            color: `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
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
              annotations={(currentPdfMeta?.annotations || []).map(a => ({
                id: a.id,
                selectedText: a.anchor.selectedText,
              }))}
              onAnnotationClick={(id) => setActiveAnnotation(id)}
              activeSelectionText={toolbar?.text || textSelection?.text || undefined}
              marks={(currentPdfMeta?.marks || []).map(m => ({
                id: m.id, type: m.type, color: m.color, selectedText: m.selectedText
              }))}
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
    </div>
  )
}
