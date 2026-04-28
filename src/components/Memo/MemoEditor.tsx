import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { v4 as uuid } from 'uuid'
import Markdown from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import remarkMath from 'remark-math'
import { KATEX_FORGIVING, sanitizeMath } from '../../utils/markdownConfig'
// Vditor removed - using auto-switch textarea/preview instead
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import { openEntryById } from '../../utils/openEntryById'
import type { BlockRef, HistoryEntry, Annotation, PdfMeta } from '../../types/library'
import ImeInput from '../common/ImeInput'
import { useConfirmDialog } from '../common/ConfirmDialog'
// 2026-04-28 · MemoAiSection 接入 AI 模型选择 + 召唤功能(对齐 AnnotationPanel)
import { fetchAiConfig, subscribeAiConfig, type ConfiguredProvider } from '../../utils/aiConfigCache'
import { fetchPersonaList, subscribePersonaList, type PersonaListEntry } from '../../utils/personaListCache'
import { humanizeAiError } from '../../utils/humanizeAiError'

// ===== Clean OCR text for cite panel =====
function cleanOcrTextForCite(raw: string): string {
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
  const superDigits: Record<string, string> = {
    '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'
  }
  const toSuper = (s: string) => s.split('').map(c => superDigits[c] || c).join('')

  return raw
    .replace(/\$\s*\\\\?textcircled\{(\d+)\}\s*\$/g, (_m, n) => circled[parseInt(n)-1] || `(${n})`)
    .replace(/\$\s*\^?\s*\{?\s*\((\d+)\)\s*\}?\s*\$/g, (_m, n) => `⁽${toSuper(n)}⁾`)
    .replace(/\$\s*\^\s*\{(\d+)\}\s*\$/g, (_m, n) => toSuper(n))
    .replace(/\$\s*\^\s*\{?\s*\\circ\s*\}?\s*\$/g, '°')
    .replace(/\$\s*_\s*\{([^}]+)\}\s*\$/g, (_m, t) => t)
    .replace(/!\[[^\]]*\]\(page=\d+,\s*bbox=\[[^\]]*\]\)/g, '')
    .replace(/!\[\]\([^)]*\)/g, '')
    .replace(/\$([^$]{1,80})\$/g, (_m, inner) => {
      const cleaned = inner
        .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
        .replace(/\\textit\{([^}]+)\}/g, '*$1*')
        .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
        .replace(/\\\\/g, '')
        .replace(/[\\{}^_]/g, '')
        .trim()
      return cleaned || ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ===== Preprocess #N block references in memo content =====
// Emits a markdown link with the `block:` pseudo-protocol; the Markdown renderer
// replaces it with a styled span via `components.a`. No raw HTML, no XSS surface.
function preprocessBlockRefs(content: string, blocks: BlockRef[]): string {
  if (blocks.length === 0) return content
  // Match #N where N is 1-99, NOT preceded by another # (avoids ## headings)
  return content.replace(/(?<!#)#(\d{1,2})(?!\d)/g, (match, num) => {
    const idx = parseInt(num) - 1
    if (idx < 0 || idx >= blocks.length) return match
    return `[#${num}](block:${idx})`
  })
}

// ===== Collapsible annotation block for CitePanel =====
function CiteAnnotationAccordion({ ann, onCite }: {
  ann: Annotation
  onCite: (he: HistoryEntry) => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ marginBottom: 6 }}>
      {/* Clickable header — the annotation anchor text */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
          background: 'var(--bg-warm)', border: '1px solid var(--border-light)',
          borderLeft: '3px solid var(--accent)',
          display: 'flex', alignItems: 'center', gap: 6,
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
      >
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{
            fontSize: 12, color: 'var(--text-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            「{ann.anchor.selectedText.substring(0, 50)}{ann.anchor.selectedText.length > 50 ? '...' : ''}」
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
            p.{ann.anchor.pageNumber} · {ann.historyChain.length} 条记录
          </div>
        </div>
      </div>

      {/* Expanded: show history chain entries with cite buttons */}
      {expanded && (
        <div style={{ padding: '4px 0 4px 12px', borderLeft: '2px solid var(--border-light)', marginLeft: 6 }}>
          {ann.historyChain.map(he => (
            <div
              key={he.id}
              style={{
                padding: '6px 10px', marginTop: 4, borderRadius: 4, fontSize: 12,
                background: he.author === 'ai' ? 'rgba(76,175,80,0.05)' : 'transparent',
                borderLeft: `2px solid ${he.author === 'ai' ? 'var(--success)' : 'var(--accent)'}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
              }}
            >
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
                  {he.author === 'ai' ? 'AI' : '我'} · {he.type === 'ai_qa' && he.userQuery ? `问：${he.userQuery.substring(0, 20)}` : he.type}
                </div>
                <div style={{ lineHeight: 1.6 }}>
                  {he.content.substring(0, 150)}{he.content.length > 150 ? '...' : ''}
                </div>
              </div>
              <button
                className="btn btn-sm"
                style={{ fontSize: 10, padding: '3px 8px', flexShrink: 0 }}
                onClick={() => onCite(he)}
              >
                引用
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===== CitePanel: cite from literature text or annotations =====
function CitePanel({ memoId, onClose }: { memoId: string; onClose: () => void }) {
  const library = useLibraryStore(s => s.library)
  const addBlockToMemo = useLibraryStore(s => s.addBlockToMemo)
  const entries = library?.entries || []

  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [tab, setTab] = useState<'text' | 'annotations'>('annotations')
  const [entryMeta, setEntryMeta] = useState<PdfMeta | null>(null)
  const [ocrText, setOcrText] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const textRef = useRef<HTMLDivElement>(null)

  const selectedEntry = entries.find(e => e.id === selectedEntryId)

  // Load meta + text content when entry selected
  useEffect(() => {
    if (!selectedEntryId) { setEntryMeta(null); setOcrText(null); return }
    window.electronAPI.loadPdfMeta(selectedEntryId).then(m => setEntryMeta(m)).catch(() => setEntryMeta(null))
    const entry = entries.find(e => e.id === selectedEntryId)
    if (!entry?.absPath) return

    const ext = entry.absPath.split('.').pop()?.toLowerCase() || ''

    if (ext === 'pdf') {
      // PDF: try OCR text
      window.electronAPI.readOcrText(entry.absPath).then(r => {
        setOcrText(r.exists && r.text ? r.text : null)
      }).catch(() => setOcrText(null))
    } else if (['html', 'htm', 'txt', 'md'].includes(ext)) {
      // Text-based files: read directly
      window.electronAPI.readFileBuffer(entry.absPath).then(buf => {
        const decoder = new TextDecoder('utf-8')
        let text = decoder.decode(buf)
        // Strip HTML tags for HTML files to get plain text
        if (['html', 'htm'].includes(ext)) {
          text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ').trim()
        }
        setOcrText(text || null)
      }).catch(() => setOcrText(null))
    } else if (['docx', 'doc'].includes(ext)) {
      // DOCX: convert with mammoth
      import('mammoth').then(mammoth => {
        window.electronAPI.readFileBuffer(entry.absPath).then(buf => {
          mammoth.extractRawText({ arrayBuffer: buf.buffer }).then(result => {
            setOcrText(result.value || null)
          }).catch(() => setOcrText(null))
        }).catch(() => setOcrText(null))
      }).catch(() => setOcrText(null))
    } else {
      // Other: try OCR text as fallback
      window.electronAPI.readOcrText(entry.absPath).then(r => {
        setOcrText(r.exists && r.text ? r.text : null)
      }).catch(() => setOcrText(null))
    }
  }, [selectedEntryId])

  // Cite selected text from OCR
  const handleCiteText = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !selectedEntry) return
    const text = sel.toString().trim()
    if (!text || text.length < 2) return

    const block: BlockRef = {
      entryId: selectedEntry.id,
      entryTitle: selectedEntry.title,
      annotationId: '',
      historyEntryId: uuid(),
      selectedText: text.substring(0, 200),
      blockContent: text.substring(0, 300),
      blockAuthor: 'user',
    }
    addBlockToMemo(memoId, block)
    sel.removeAllRanges()
  }, [selectedEntry, memoId, addBlockToMemo])

  // Cite a history entry from an annotation
  const handleCiteHistoryEntry = useCallback((ann: Annotation, entry: HistoryEntry) => {
    if (!selectedEntry) return
    const block: BlockRef = {
      entryId: selectedEntry.id,
      entryTitle: selectedEntry.title,
      annotationId: ann.id,
      historyEntryId: entry.id,
      selectedText: ann.anchor.selectedText,
      blockContent: entry.content.substring(0, 300),
      blockAuthor: entry.author,
    }
    addBlockToMemo(memoId, block)
  }, [selectedEntry, memoId, addBlockToMemo])

  // 2026-04-25 PERF · useMemo 缓存
  const filteredEntries = useMemo(
    () => searchQuery
      ? entries.filter(e => e.title.toLowerCase().includes(searchQuery.toLowerCase()))
      : entries,
    [searchQuery, entries],
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 500,
      background: 'rgba(40,35,25,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        width: 520, maxHeight: '70vh', background: 'var(--bg)', borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {selectedEntryId && (
              <button className="btn btn-sm btn-icon" onClick={() => setSelectedEntryId(null)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
            )}
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {selectedEntry ? selectedEntry.title : '选择引用来源'}
            </span>
          </div>
          <button className="btn btn-sm btn-icon" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {!selectedEntryId ? (
          /* === Step 1: Entry list === */
          <div style={{ flex: 1, overflow: 'auto' }}>
            <div style={{ padding: '8px 12px' }}>
              <ImeInput
                placeholder="搜索文献..." value={searchQuery}
                onChange={setSearchQuery}
                style={{
                  width: '100%', padding: '6px 10px', border: '1px solid var(--border)',
                  borderRadius: 4, fontSize: 12, outline: 'none', background: 'var(--bg-warm)',
                }}
              />
            </div>
            {filteredEntries.map(entry => (
              <div
                key={entry.id}
                onClick={() => { setSelectedEntryId(entry.id); setTab('annotations') }}
                style={{
                  padding: '8px 14px', cursor: 'pointer', fontSize: 12,
                  borderBottom: '1px solid var(--border-light)',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.title}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {entry.ocrStatus === 'complete' ? 'OCR ·' : ''} {entry.absPath.split(/[/\\]/).slice(-2).join('/')}
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* === Step 2: Text / Annotations tabs === */
          <>
            {/* Tab bar */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
              <button
                onClick={() => setTab('annotations')}
                style={{
                  flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
                  background: tab === 'annotations' ? 'var(--bg)' : 'var(--bg-warm)',
                  color: tab === 'annotations' ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: tab === 'annotations' ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                注释 ({entryMeta?.annotations?.length || 0})
              </button>
              <button
                onClick={() => setTab('text')}
                style={{
                  flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 500, border: 'none', cursor: 'pointer',
                  background: tab === 'text' ? 'var(--bg)' : 'var(--bg-warm)',
                  color: tab === 'text' ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: tab === 'text' ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >
                文本 {ocrText ? '' : '(无内容)'}
              </button>
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, overflow: 'auto' }}>
              {tab === 'annotations' ? (
                /* Annotations list */
                <div style={{ padding: 10 }}>
                  {(entryMeta?.annotations || []).length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                      该文献暂无注释
                    </div>
                  ) : (entryMeta?.annotations || []).map(ann => (
                    <CiteAnnotationAccordion
                      key={ann.id}
                      ann={ann}
                      onCite={(he) => handleCiteHistoryEntry(ann, he)}
                    />
                  ))}
                </div>
              ) : (
                /* OCR text - user selects and cites */
                <div style={{ padding: '16px 20px' }}>
                  {ocrText ? (
                    <div
                      ref={textRef}
                      style={{ fontSize: 13, lineHeight: 2, color: 'var(--text)', userSelect: 'text' }}
                      onMouseUp={handleCiteText}
                    >
                      <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 10, fontWeight: 500 }}>
                        选中文字后自动引用
                      </div>
                      <div className="annotation-markdown">
                        <Markdown>{cleanOcrTextForCite(ocrText)}</Markdown>
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                      该文献没有 OCR 文本
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ===== Live editor: shows rendered markdown, click to edit =====
// Annotation drop picker: when an annotation is dropped, pick which history entry to cite
function AnnotationDropPicker({ data, onSelect, onClose }: {
  data: { entryId: string; entryTitle: string; annotationId: string; selectedText: string; historyChain: Array<{ id: string; type: string; content: string; author: string; userQuery?: string }> }
  onSelect: (content: string, author: string, historyEntryId: string) => void
  onClose: () => void
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 600,
      background: 'rgba(40,35,25,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        width: 420, maxHeight: '50vh', background: 'var(--bg)', borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.15)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border-light)', fontSize: 12, fontWeight: 600 }}>
          选择要引用的内容
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginTop: 2 }}>
            {data.entryTitle} · 「{data.selectedText.substring(0, 40)}...」
          </div>
        </div>
        {/* Option: cite the anchor text itself */}
        <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
          <div
            onClick={() => onSelect(data.selectedText, 'user', data.annotationId + '-anchor')}
            style={{
              padding: '8px 10px', marginBottom: 4, borderRadius: 4, cursor: 'pointer',
              fontSize: 12, borderLeft: '2px solid var(--accent)', background: 'var(--bg-warm)',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
          >
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>原文文本</div>
            <div>{data.selectedText.substring(0, 120)}{data.selectedText.length > 120 ? '...' : ''}</div>
          </div>
          {/* History chain entries */}
          {data.historyChain.map(he => (
            <div
              key={he.id}
              onClick={() => onSelect(he.content, he.author, he.id)}
              style={{
                padding: '8px 10px', marginBottom: 4, borderRadius: 4, cursor: 'pointer',
                fontSize: 12, background: he.author === 'ai' ? 'rgba(76,175,80,0.05)' : 'var(--bg-warm)',
                borderLeft: `2px solid ${he.author === 'ai' ? 'var(--success)' : 'var(--accent)'}`,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = he.author === 'ai' ? 'rgba(76,175,80,0.05)' : 'var(--bg-warm)')}
            >
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
                {he.author === 'ai' ? 'AI' : '我'} · {he.type}{he.userQuery ? ` — ${he.userQuery.substring(0, 20)}` : ''}
              </div>
              <div>{he.content.substring(0, 120)}{he.content.length > 120 ? '...' : ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ===== Live editor: shows rendered markdown, click to edit =====
function LiveMemoEditor({ content, onChange, blocks, memoId, onJumpBlock }: {
  content: string
  onChange: (val: string) => void
  blocks: BlockRef[]
  memoId: string
  onJumpBlock?: (block: BlockRef) => void
}) {
  const [editing, setEditing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const addBlockToMemo = useLibraryStore(s => s.addBlockToMemo)
  const [dropPickerData, setDropPickerData] = useState<any>(null)

  // Block refs now render via the Markdown `components.a` mapping below — no event
  // delegation needed because React wires onClick directly on the span.

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.selectionStart = textareaRef.current.selectionEnd = len
    }
  }, [editing])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()

    // Handle block card drag (from sidebar)
    const blockIdx = e.dataTransfer.getData('block-index')
    if (blockIdx && blocks) {
      const idx = parseInt(blockIdx) - 1
      const block = blocks[idx]
      if (block) {
        const source = `— ${block.entryTitle}（${block.blockAuthor === 'ai' ? 'AI' : '我'}）`
        const quotedContent = block.blockContent.split('\n').map(l => `> ${l}`).join('\n')
        onChange(content + `\n\n${quotedContent}\n> *${source}*\n\n`)
      }
      return
    }

    // Handle annotation drag (from annotation panel)
    const annData = e.dataTransfer.getData('annotation-drag')
    if (annData) {
      try {
        const parsed = JSON.parse(annData)
        setDropPickerData(parsed)
      } catch {}
      return
    }
  }, [blocks, content, onChange])

  const handlePickerSelect = useCallback((selectedContent: string, author: string, historyEntryId: string) => {
    if (!dropPickerData) return
    // Add as a BlockRef to the memo
    const block: BlockRef = {
      entryId: dropPickerData.entryId,
      entryTitle: dropPickerData.entryTitle,
      annotationId: dropPickerData.annotationId,
      historyEntryId,
      selectedText: dropPickerData.selectedText,
      blockContent: selectedContent.substring(0, 300),
      blockAuthor: author as 'user' | 'ai',
    }
    addBlockToMemo(memoId, block)
    // Also insert as blockquote in content
    const source = `— ${dropPickerData.entryTitle}（${author === 'ai' ? 'AI' : '我'}）`
    const quotedContent = selectedContent.substring(0, 300).split('\n').map((l: string) => `> ${l}`).join('\n')
    onChange(content + `\n\n${quotedContent}\n> *${source}*\n\n`)
    setDropPickerData(null)
  }, [dropPickerData, content, onChange, memoId, addBlockToMemo])

  const dragProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.currentTarget.style.outline = '2px dashed var(--accent)' },
    onDragLeave: (e: React.DragEvent) => { e.currentTarget.style.outline = 'none' },
    onDrop: (e: React.DragEvent) => { e.currentTarget.style.outline = 'none'; handleDrop(e) },
  }

  return (
    <>
      {dropPickerData && (
        <AnnotationDropPicker
          data={dropPickerData}
          onSelect={handlePickerSelect}
          onClose={() => setDropPickerData(null)}
        />
      )}
      {editing ? (
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }} {...dragProps}>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={e => onChange(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={e => {
              // Markdown shortcuts: Ctrl+B bold, Ctrl+I italic, Ctrl+K link
              const ctrl = e.ctrlKey || e.metaKey
              if (!ctrl) return
              const ta = e.currentTarget
              const s = ta.selectionStart, eSel = ta.selectionEnd
              const selected = content.slice(s, eSel)
              const wrap = (left: string, right: string, placeholder = '') => {
                e.preventDefault()
                const inner = selected || placeholder
                const next = content.slice(0, s) + left + inner + right + content.slice(eSel)
                onChange(next)
                // Restore selection to the inserted inner text on next tick
                setTimeout(() => {
                  ta.focus()
                  if (selected) {
                    ta.selectionStart = s + left.length
                    ta.selectionEnd = s + left.length + inner.length
                  } else {
                    ta.selectionStart = ta.selectionEnd = s + left.length + inner.length
                  }
                }, 0)
              }
              if (e.key === 'b' || e.key === 'B') wrap('**', '**', '粗体')
              else if (e.key === 'i' || e.key === 'I') wrap('*', '*', '斜体')
              else if (e.key === 'k' || e.key === 'K') {
                e.preventDefault()
                const url = prompt('链接地址：', 'https://')
                if (!url) return
                const text = selected || '链接文字'
                const next = content.slice(0, s) + `[${text}](${url})` + content.slice(eSel)
                onChange(next)
                setTimeout(() => {
                  ta.focus()
                  const pos = s + 1
                  ta.selectionStart = pos
                  ta.selectionEnd = pos + text.length
                }, 0)
              }
            }}
            style={{
              flex: 1, padding: '20px 28px', border: 'none', outline: 'none', resize: 'none',
              fontSize: 14, lineHeight: 2, fontFamily: 'var(--font)',
              color: 'var(--text)', background: 'var(--bg)',
            }}
          />
        </div>
      ) : (
        <div
          ref={previewRef}
          style={{ flex: 1, overflow: 'auto', padding: '20px 28px', cursor: 'text', minHeight: 0 }}
          onClick={() => setEditing(true)}
          {...dragProps}
        >
          {content ? (
            <div className="annotation-markdown" style={{ fontSize: 14, lineHeight: 2 }}>
              <Markdown
                remarkPlugins={[remarkMath]}
                rehypePlugins={[KATEX_FORGIVING]}
                components={{
                  a: ({ href, children, ...rest }) => {
                    if (href && href.startsWith('block:')) {
                      const idx = parseInt(href.slice(6), 10)
                      const block = blocks[idx]
                      if (!block) return <>{children}</>
                      const color = block.blockAuthor === 'ai' ? '#4caf50' : '#C8956C'
                      const authorLabel = block.blockAuthor === 'ai' ? 'AI' : '我'
                      const preview = block.blockContent.substring(0, 60).replace(/\n/g, ' ')
                      const shortPreview = preview.substring(0, 20) + (preview.length > 20 ? '…' : '')
                      return (
                        <span
                          className="block-ref-inline"
                          style={{
                            background: `${color}15`,
                            border: `1px solid ${color}40`,
                            borderRadius: 4,
                            padding: '1px 6px',
                            fontSize: 12,
                            cursor: 'pointer',
                            display: 'inline-block',
                            margin: '0 2px',
                          }}
                          title={`点击跳转 · ${block.entryTitle} · ${authorLabel}\n${preview}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            onJumpBlock?.(block)
                          }}
                        >
                          <span style={{ color, fontWeight: 600 }}>#{idx + 1}</span>{' '}
                          <span style={{ color: '#666', fontSize: 11 }}>{shortPreview}</span>
                        </span>
                      )
                    }
                    return <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>
                  },
                }}
              >
                {sanitizeMath(preprocessBlockRefs(content, blocks))}
              </Markdown>
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              点击此处开始写作...<br/>
              <span style={{ fontSize: 12 }}>从右侧注释面板拖入注释可引用</span>
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ===== Block card: a referenced thinking block =====
function BlockCard({ block, index, onRemove, onJump }: {
  block: BlockRef
  index: number
  onRemove: () => void
  onJump: () => void
}) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('block-index', String(index))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      style={{
      padding: '8px 10px', marginBottom: 6, borderRadius: 6,
      background: block.blockAuthor === 'ai' ? 'rgba(76, 175, 80, 0.08)' : 'var(--bg-warm)',
      border: '1px solid var(--border-light)',
      fontSize: 12, cursor: 'grab',
      borderLeft: `3px solid ${block.blockAuthor === 'ai' ? 'var(--success)' : 'var(--accent)'}`,
      position: 'relative',
    }}>
      {/* Number badge */}
      <span style={{
        position: 'absolute', top: -4, left: -4,
        width: 18, height: 18, borderRadius: '50%',
        background: block.blockAuthor === 'ai' ? 'var(--success)' : 'var(--accent)',
        color: '#fff', fontSize: 10, fontWeight: 700,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {index}
      </span>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 10 }}>
          {block.entryTitle} · {block.blockAuthor === 'ai' ? 'AI' : '我'}
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="btn btn-sm btn-icon" onClick={onJump} style={{ fontSize: 10, padding: '0 3px' }} title="跳转原文">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </button>
          <button className="btn btn-sm btn-icon" onClick={onRemove} style={{ fontSize: 10, padding: '0 3px' }} title="移除引用">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 4 }}>
        「{block.selectedText.substring(0, 50)}...」
      </div>
      <div style={{ lineHeight: 1.6 }}>
        {block.blockContent}
      </div>
    </div>
  )
}

// ===== AI chat within memo =====
function MemoAiSection({ memoId, blocks, aiHistory }: {
  memoId: string
  blocks: BlockRef[]
  aiHistory: HistoryEntry[]
}) {
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorToast, setErrorToast] = useState<string | null>(null)

  // 2026-04-28 · 接入用户选定的 AI 模型(对齐 AnnotationPanel),不再写死 glm-4-flash
  const aiModel = useUiStore(s => s.selectedAiModel)
  const setAiModel = useUiStore(s => s.setSelectedAiModel)
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])

  // 2026-04-28 · 思考强度 + 联网搜索(对齐 AgentPanel),仅当前 model 支持时生效
  const aiReasoningEffort = useUiStore(s => s.aiReasoningEffort)
  const setAiReasoningEffort = useUiStore(s => s.setAiReasoningEffort)
  const aiWebSearch = useUiStore(s => s.aiWebSearch)
  const setAiWebSearch = useUiStore(s => s.setAiWebSearch)
  const [effortSupported, setEffortSupported] = useState(false)
  const [webSearchSupported, setWebSearchSupported] = useState(false)

  // 2026-04-28 · 接入召唤思想家(对齐 AnnotationPanel)
  const [personaList, setPersonaList] = useState<PersonaListEntry[]>([])
  const [personaPopoverOpen, setPersonaPopoverOpen] = useState(false)
  const summonPopoverRef = useRef<HTMLDivElement | null>(null)

  // BUG-FIX MEMO#1 · mountedRef + fresh-library read after await, so:
  //   (a) setInput/setLoading don't fire after unmount
  //   (b) saveLibrary uses the latest library (catches edits to other memos
  //       that happened while the AI was thinking — previously the closure's
  //       stale `library` would overwrite them on save).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Subscribe configured providers + persona list(走共享 cache,与其它面板复用)
  useEffect(() => {
    let cancelled = false
    fetchAiConfig().then(r => { if (!cancelled) setConfiguredProviders(r) })
    const unsubAi = subscribeAiConfig(latest => { if (!cancelled) setConfiguredProviders(latest) })
    fetchPersonaList().then(r => { if (!cancelled) setPersonaList(r) })
    const unsubPersona = subscribePersonaList(latest => { if (!cancelled) setPersonaList(latest) })
    return () => { cancelled = true; unsubAi(); unsubPersona() }
  }, [])

  // 2026-04-28 · 检测当前 model 是否支持 effort / web search(同 AgentPanel 模式)
  useEffect(() => {
    let cancelled = false
    const [pid, mid] = aiModel.includes(':') ? aiModel.split(':', 2) : [aiModel, '']
    if (!pid || !mid) { setEffortSupported(false); return }
    window.electronAPI.aiModelSupportsEffort?.(pid, mid).then(ok => {
      if (!cancelled) setEffortSupported(!!ok)
    }).catch(() => { if (!cancelled) setEffortSupported(false) })
    return () => { cancelled = true }
  }, [aiModel])
  useEffect(() => {
    let cancelled = false
    const [pid] = aiModel.includes(':') ? aiModel.split(':', 2) : [aiModel]
    if (!pid) { setWebSearchSupported(false); return }
    window.electronAPI.aiProviderSupportsWebSearch?.(pid).then(ok => {
      if (!cancelled) setWebSearchSupported(!!ok)
    }).catch(() => { if (!cancelled) setWebSearchSupported(false) })
    return () => { cancelled = true }
  }, [aiModel])

  // Esc / 点击外部关闭 popover
  useEffect(() => {
    if (!personaPopoverOpen) return
    const onDown = (e: MouseEvent) => {
      if (summonPopoverRef.current?.contains(e.target as Node)) return
      setPersonaPopoverOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPersonaPopoverOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [personaPopoverOpen])

  // Auto-dismiss error toast
  useEffect(() => {
    if (!errorToast) return
    const t = setTimeout(() => setErrorToast(null), 5000)
    return () => clearTimeout(t)
  }, [errorToast])

  // Build memo + cited blocks context shared by 提问 / 召唤
  const buildContext = useCallback((): string => {
    const libAtStart = useLibraryStore.getState().library
    const memo = (libAtStart?.memos || []).find(m => m.id === memoId)
    const memoContent = memo?.content || ''
    const blocksContext = blocks.map(b =>
      `[${b.entryTitle}, ${b.blockAuthor === 'ai' ? 'AI' : '用户'}] 原文「${b.selectedText.substring(0, 100)}」→ ${b.blockContent}`
    ).join('\n')
    return `用户的笔记内容：\n${memoContent.substring(0, 1500)}\n\n引用的信息块：\n${blocksContext}`
  }, [memoId, blocks])

  // Save AI response into memo.aiHistory(re-read latest library to avoid 覆写)
  const appendAiHistoryEntry = useCallback(async (entry: HistoryEntry) => {
    const currentLib = useLibraryStore.getState().library
    if (!currentLib) return
    const m = (currentLib.memos || []).find(m => m.id === memoId)
    if (!m) return
    m.aiHistory.push(entry)
    m.updatedAt = new Date().toISOString()
    await window.electronAPI.saveLibrary(currentLib)
    if (!mountedRef.current) return
    useLibraryStore.setState({ library: { ...currentLib } })
  }, [memoId])

  const handleAsk = useCallback(async () => {
    if (!input.trim() || loading) return
    setLoading(true)
    const userQuery = input.trim()
    const context = buildContext()

    // 2026-04-28 · 走 aiChatStream(用户选定的 model),取代写死的 glmAsk
    const streamId = uuid()
    let fullText = ''
    const cleanup = window.electronAPI.onAiStreamChunk((sid: string, chunk: string) => {
      if (sid === streamId) fullText += chunk
    })
    let errMsg: string | null = null
    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: '你是学术文献阅读助手。请基于用户提供的笔记内容和引用信息块,简洁地回答问题。' },
      ]
      // 历史 ai_qa 转 messages
      for (const h of aiHistory) {
        if (h.type === 'ai_qa') {
          if (h.userQuery) messages.push({ role: 'user', content: h.userQuery })
          messages.push({ role: 'assistant', content: h.content })
        }
      }
      messages.push({ role: 'user', content: `${context}\n\n问题: ${userQuery}` })

      const res = await window.electronAPI.aiChatStream(streamId, aiModel, messages, { effort: aiReasoningEffort, webSearch: aiWebSearch })
      if (!res.success) errMsg = res.error || 'AI 调用失败'
      else if ((res as any).text) fullText = (res as any).text
    } catch (e: any) {
      errMsg = e?.message || String(e)
    } finally {
      cleanup()
    }

    if (!mountedRef.current) return

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_qa',
      content: errMsg ? `错误：${errMsg}` : fullText.trim(),
      userQuery,
      author: 'ai',
      createdAt: new Date().toISOString(),
    }
    await appendAiHistoryEntry(entry)
    if (errMsg) {
      const h = humanizeAiError(errMsg)
      if (!h.silent) setErrorToast(h.hint ? `${h.message}（${h.hint}）` : h.message)
    }
    if (!mountedRef.current) return
    setInput('')
    setLoading(false)
  }, [input, loading, aiModel, aiReasoningEffort, aiWebSearch, aiHistory, buildContext, appendAiHistoryEntry])

  // 召唤一位思想家来评论这条 memo
  const handleSummon = useCallback(async (personaId: string, personaName: string) => {
    if (loading) return
    setPersonaPopoverOpen(false)
    setLoading(true)
    const context = buildContext()
    const userPrompt = input.trim()
      ? `请以你的视角审视下面这段笔记,并回应用户的追问。\n\n${context}\n\n【用户追问】${input.trim()}`
      : `请以你的视角审视下面这段笔记——你会注意什么、挑剔什么、补充什么?\n\n${context}`
    const streamId = uuid()
    let fullText = ''
    const cleanup = window.electronAPI.onAiStreamChunk((sid: string, chunk: string) => {
      if (sid === streamId) fullText += chunk
    })
    let errMsg: string | null = null
    try {
      const sysRes = await window.electronAPI.personaGetSystemPrompt?.(personaId, userPrompt)
      if (!sysRes?.success || !sysRes.systemPrompt) throw new Error(sysRes?.error || '无法加载 skill')
      const res = await window.electronAPI.aiChatStream(streamId, aiModel, [
        { role: 'system', content: sysRes.systemPrompt },
        { role: 'user', content: userPrompt },
      ], { effort: aiReasoningEffort, webSearch: aiWebSearch })
      if (!res.success) errMsg = res.error || 'AI 调用失败'
      else if ((res as any).text) fullText = (res as any).text
    } catch (e: any) {
      errMsg = e?.message || String(e)
    } finally {
      cleanup()
    }

    if (!mountedRef.current) return

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_qa',
      content: errMsg ? `错误：${errMsg}` : `**${personaName}**:\n\n${fullText.trim()}`,
      userQuery: input.trim() ? `召唤 ${personaName}: ${input.trim()}` : `召唤 ${personaName}`,
      author: 'ai',
      createdAt: new Date().toISOString(),
    }
    await appendAiHistoryEntry(entry)
    if (errMsg) {
      const h = humanizeAiError(errMsg)
      if (!h.silent) setErrorToast(h.hint ? `${h.message}（${h.hint}）` : h.message)
    }
    if (!mountedRef.current) return
    setInput('')
    setLoading(false)
  }, [loading, input, aiModel, aiReasoningEffort, aiWebSearch, buildContext, appendAiHistoryEntry])

  return (
    <div style={{ borderTop: '1px solid var(--border-light)', padding: '10px 0 0', position: 'relative' }}>
      {aiHistory.length > 0 && (
        <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 8 }}>
          {aiHistory.map(entry => (
            <div key={entry.id} style={{
              padding: '6px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12,
              background: entry.author === 'ai' ? '#F5FAF0' : 'var(--bg-warm)',
              borderLeft: `2px solid ${entry.author === 'ai' ? 'var(--success)' : 'var(--accent)'}`,
            }}>
              {entry.userQuery && (
                <div style={{ color: 'var(--accent)', fontWeight: 500, marginBottom: 2, fontSize: 11 }}>
                  问：{entry.userQuery}
                </div>
              )}
              <div className="annotation-markdown"><Markdown>{entry.content}</Markdown></div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="让 AI 帮你审视这段思考..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAsk() } }}
          style={{
            flex: 1, padding: '6px 10px', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 12, outline: 'none',
            background: 'var(--bg-warm)', color: 'var(--text)'
          }}
        />
        {/* 模型选择(对齐 AnnotationPanel) */}
        <select
          value={aiModel}
          onChange={e => setAiModel(e.target.value)}
          title="AI 模型"
          style={{
            fontSize: 10, padding: '4px 4px', border: '1px solid var(--border)',
            borderRadius: 4, background: 'var(--bg-warm)', color: 'var(--text-secondary)',
            outline: 'none', cursor: 'pointer', maxWidth: 100,
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
        {/* 思考强度 effort:仅当 model 支持 reasoning 时显示 */}
        {effortSupported && (
          <select
            value={aiReasoningEffort}
            onChange={e => setAiReasoningEffort(e.target.value as 'low' | 'medium' | 'high')}
            title="思考强度（仅支持 reasoning 的模型生效）"
            style={{
              flexShrink: 0, fontSize: 10, padding: '4px 4px',
              border: '1px solid var(--border)', borderRadius: 4,
              background: 'var(--bg-warm)', color: 'var(--text-secondary)',
              outline: 'none', cursor: 'pointer',
            }}
          >
            <option value="low">思考·低</option>
            <option value="medium">思考·中</option>
            <option value="high">思考·高</option>
          </select>
        )}
        {/* 联网搜索:provider 不支持时灰掉 + tooltip */}
        {(() => {
          const effective = aiWebSearch && webSearchSupported
          const tip = !webSearchSupported
            ? '当前 provider 不支持联网搜索（仅 Ollama / Claude CLI 不支持）'
            : (effective
                ? '已开启联网搜索：AI 提问 / 召唤前可查时事 / 实时信息（关闭可省 quota）'
                : '点击开启联网搜索')
          return (
            <button
              type="button"
              disabled={!webSearchSupported}
              onClick={() => { if (webSearchSupported) setAiWebSearch(!aiWebSearch) }}
              title={tip}
              style={{
                flexShrink: 0, padding: '4px 7px', fontSize: 10,
                border: `1px solid ${effective ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 4,
                background: effective ? 'var(--accent)' : 'var(--bg-warm)',
                color: effective ? '#fff' : (webSearchSupported ? 'var(--text-secondary)' : 'var(--text-muted)'),
                cursor: webSearchSupported ? 'pointer' : 'not-allowed',
                opacity: webSearchSupported ? 1 : 0.5,
                transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1), color 180ms, border-color 180ms',
              }}
            >🌐</button>
          )
        })()}
        <button className="btn btn-sm btn-primary" onClick={handleAsk} disabled={loading || !input.trim()}>
          {loading ? '...' : '提问'}
        </button>
        {/* 召唤思想家 */}
        <div ref={summonPopoverRef} style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            className="btn btn-sm"
            disabled={loading}
            onClick={() => setPersonaPopoverOpen(v => !v)}
            title={personaList.length === 0 ? '还没导入思想家,去 Agent 面板召唤 tab 导一位' : '召唤一位思想家以其视角审视这条笔记'}
            style={{
              fontSize: 12, padding: '6px 10px', whiteSpace: 'nowrap',
              color: personaList.length === 0 ? 'var(--text-muted)' : 'var(--accent-hover)',
              opacity: personaList.length === 0 ? 0.7 : 1,
            }}
          >召唤</button>
          {personaPopoverOpen && (
            <div style={{
              position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
              minWidth: 180, maxHeight: 240, overflow: 'auto',
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 6, boxShadow: '0 6px 22px rgba(60,40,20,0.15)',
              padding: '4px 0', zIndex: 100,
              animation: 'sj-pop-in 0.16s cubic-bezier(.2,.9,.3,1.2)',
            }}>
              {personaList.length > 0 ? (
                <>
                  <div style={{ fontSize: 10, letterSpacing: '1.6px', color: 'var(--text-secondary)', padding: '8px 12px 4px', fontWeight: 500 }}>选一位审视这条笔记</div>
                  {personaList.map(p => (
                    <div
                      key={p.id}
                      onClick={() => handleSummon(p.id, p.canonicalName || p.name)}
                      style={{
                        padding: '7px 14px', fontSize: 12.5, cursor: 'pointer',
                        color: 'var(--text)',
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >{p.canonicalName || p.name}</div>
                  ))}
                </>
              ) : (
                <div style={{ padding: '12px 14px', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  还没有导入思想家——
                  <br />去 <span style={{ color: 'var(--accent-hover)' }}>Agent · 召唤社区</span> 挑一位
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {errorToast && (
        <div
          onClick={() => setErrorToast(null)}
          style={{
            position: 'fixed', left: '50%', bottom: 32, zIndex: 9999,
            transform: 'translateX(-50%)',
            padding: '10px 18px', borderRadius: 6,
            background: 'rgba(181,90,79,0.96)', color: '#fff',
            fontSize: 12.5, lineHeight: 1.5, maxWidth: 420,
            boxShadow: '0 6px 22px rgba(60,40,20,0.28)',
            cursor: 'pointer',
          }}
          title="点击关闭"
        >{errorToast}</div>
      )}
    </div>
  )
}

// ===== Main Memo Editor =====
export default function MemoEditor() {
  // Batch 43: 替换 window.confirm
  const { ask: askConfirm, dialog: confirmDialog } = useConfirmDialog()
  // 2026-04-25 PERF · 选择性订阅
  const library = useLibraryStore(s => s.library)
  const updateMemo = useLibraryStore(s => s.updateMemo)
  const deleteMemo = useLibraryStore(s => s.deleteMemo)
  const removeBlockFromMemo = useLibraryStore(s => s.removeBlockFromMemo)
  const activeMemoId = useUiStore(s => s.activeMemoId)
  const setActiveMemo = useUiStore(s => s.setActiveMemo)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showCitePanel, setShowCitePanel] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The pending write waiting for the 800ms debounce — tracked with its memoId so
  // that switching to a different memo (or unmounting) flushes it to the *correct*
  // memo rather than dropping it.
  const pendingSaveRef = useRef<{ memoId: string; content: string } | null>(null)
  const prevActiveMemoIdRef = useRef<string | null>(activeMemoId)

  const memos = library?.memos || []
  const activeMemo = memos.find(m => m.id === activeMemoId) || null
  // Ensure all fields exist (handles old data without these fields)
  if (activeMemo) {
    if (!activeMemo.blocks) activeMemo.blocks = []
    if (!activeMemo.aiHistory) activeMemo.aiHistory = []
    if (!activeMemo.snapshots) activeMemo.snapshots = []
    if (activeMemo.content == null) activeMemo.content = ''
  }

  // Flush the pending debounced save immediately. Reads updateMemo from the store
  // each time so the callback itself has zero deps → safe to use in unmount cleanup.
  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingSaveRef.current
    if (pending) {
      useLibraryStore.getState().updateMemo(pending.memoId, { content: pending.content })
      pendingSaveRef.current = null
    }
  }, [])

  // Auto-save with debounce
  // BUG-FIX MEMO#2 · `library` was closure-captured — a concurrent add-memo
  // from another code path (AI auto-memo, apprentice write-observation) between
  // renders would be reverted by the `setState({ library: {...library} })`
  // shallow-clone. Use getState() so we always spread the latest library.
  const handleContentChange = useCallback((newContent: string) => {
    if (!activeMemo) return
    // If a save is pending for a DIFFERENT memo, flush it right away — otherwise the
    // clearTimeout below would silently drop that memo's last typed characters.
    const pending = pendingSaveRef.current
    if (pending && pending.memoId !== activeMemo.id) {
      useLibraryStore.getState().updateMemo(pending.memoId, { content: pending.content })
      pendingSaveRef.current = null
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    activeMemo.content = newContent
    const latestLib = useLibraryStore.getState().library
    useLibraryStore.setState({ library: latestLib ? { ...latestLib } : null })
    pendingSaveRef.current = { memoId: activeMemo.id, content: newContent }
    saveTimerRef.current = setTimeout(() => {
      const p = pendingSaveRef.current
      if (p) {
        useLibraryStore.getState().updateMemo(p.memoId, { content: p.content })
        pendingSaveRef.current = null
      }
      saveTimerRef.current = null
    }, 800)
  }, [activeMemo])

  // Memo switch: flush any pending write for the previous memo *before* we show the
  // new one, so we don't carry a stale pending save into a different editing session.
  useEffect(() => {
    if (prevActiveMemoIdRef.current !== activeMemoId) {
      flushPendingSave()
      prevActiveMemoIdRef.current = activeMemoId
    }
  }, [activeMemoId, flushPendingSave])

  // Unmount: commit the pending save so unsaved edits aren't lost.
  useEffect(() => {
    return () => { flushPendingSave() }
  }, [flushPendingSave])

  const handleTitleSave = useCallback(() => {
    if (!activeMemo || !titleInput.trim()) { setEditingTitle(false); return }
    updateMemo(activeMemo.id, { title: titleInput.trim() })
    setEditingTitle(false)
  }, [activeMemo, titleInput, updateMemo])

  const handleDelete = useCallback(() => {
    if (!activeMemo) return
    // Batch 43: window.confirm() → 暖金 ConfirmDialog
    const title = activeMemo.title || '无标题'
    const memoId = activeMemo.id
    askConfirm({
      title: '删除笔记',
      message: `删除笔记「${title}」？\n\n此操作无法撤销（笔记不进回收站）。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        deleteMemo(memoId)
        setActiveMemo(null)
      },
    })
  }, [activeMemo, deleteMemo, setActiveMemo, askConfirm])

  const handleJumpToBlock = useCallback(async (block: BlockRef) => {
    setActiveMemo(null)
    useUiStore.getState().setSidebarTab('library')
    await openEntryById(block.entryId, { annotationId: block.annotationId })
  }, [setActiveMemo])

  if (!activeMemo) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: 13,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: 8 }}>未找到该笔记</div>
          <button className="btn btn-sm" onClick={() => setActiveMemo(null)}>返回</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: 'var(--bg)', minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 20px', borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
      }}>
        <button className="btn btn-sm btn-icon" onClick={() => setActiveMemo(null)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        {editingTitle ? (
          <input
            value={titleInput}
            onChange={e => setTitleInput(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={e => { if (e.key === 'Enter') handleTitleSave(); if (e.key === 'Escape') setEditingTitle(false) }}
            autoFocus
            style={{
              flex: 1, fontSize: 15, fontWeight: 600, border: '1px solid var(--accent)',
              borderRadius: 4, padding: '2px 8px', outline: 'none', background: 'var(--bg)'
            }}
          />
        ) : (
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <span
              // Click (or double-click) to rename — whichever feels natural.
              // Hover shows a subtle background + edit cursor so the click
              // affordance is visible instead of hidden behind "try double-clicking".
              style={{
                fontSize: 15, fontWeight: 600, cursor: 'text',
                padding: '2px 6px', borderRadius: 4,
                transition: 'background 0.15s',
                display: 'inline-block',
              }}
              onClick={() => { setEditingTitle(true); setTitleInput(activeMemo.title) }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title="点击重命名"
            >
              {activeMemo.title}
            </span>
            {activeMemo.filePath && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeMemo.filePath}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-sm" onClick={() => setShowCitePanel(true)} title="引用文献文本或注释">
            + 引用
          </button>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-sm" onClick={() => setShowExportMenu(!showExportMenu)} title="导出笔记">
              导出
            </button>
            {showExportMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, zIndex: 100, marginTop: 4,
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)', padding: '2px 0', minWidth: 130,
              }}>
                {[
                  { label: '导出 .md', ext: 'md' },
                  { label: '导出 .txt', ext: 'txt' },
                  { label: '导出 .html', ext: 'html' },
                  // PDF goes through the system print dialog (user picks "Save as PDF")
                  // — no extra deps, every OS has a built-in PDF printer.
                  { label: '导出 .pdf', ext: 'pdf' },
                  // DOCX uses the well-known "HTML-with-Word-namespace" trick — Word and
                  // LibreOffice both open it as a real document. No new deps needed.
                  { label: '导出 .docx', ext: 'docx' },
                ].map(opt => (
                  <div key={opt.ext}
                    onClick={async () => {
                      setShowExportMenu(false)

                      // Render the memo's markdown to HTML once — used by html/pdf/docx
                      // exports. Plain .md/.txt skip this and write raw markdown.
                      const renderMarkdownToHtml = () => {
                        try {
                          return renderToStaticMarkup(
                            <Markdown remarkPlugins={[remarkMath]}>
                              {sanitizeMath(activeMemo.content || '')}
                            </Markdown>
                          )
                        } catch {
                          // Fallback: simple line-break replacement for malformed content
                          return (activeMemo.content || '').replace(/\n/g, '<br>')
                        }
                      }

                      // Shared print/export styles — keeps PDF & DOCX visually consistent
                      // with on-screen serif look. Blockquote color matches the app accent.
                      const sharedCss = `
                        body { font-family: 'Songti SC', 'STSong', 'SimSun', serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.9; color: #222; }
                        h1, h2, h3, h4 { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
                        h1 { font-size: 22px; border-bottom: 1px solid #ccc; padding-bottom: 8px; }
                        h2 { font-size: 18px; margin-top: 24px; }
                        h3 { font-size: 16px; }
                        blockquote { border-left: 3px solid #C8956C; padding-left: 16px; margin: 16px 0; color: #666; }
                        code { background: #f5f0e6; padding: 1px 4px; border-radius: 3px; font-family: Consolas, Menlo, monospace; }
                        pre { background: #f5f0e6; padding: 12px; border-radius: 4px; overflow-x: auto; }
                        img { max-width: 100%; }
                        ul, ol { padding-left: 24px; }
                        a { color: #C8956C; }
                      `

                      if (opt.ext === 'md' || opt.ext === 'txt') {
                        await window.electronAPI.exportFile(
                          `${activeMemo.title}.${opt.ext}`,
                          [{ name: opt.ext.toUpperCase(), extensions: [opt.ext] }],
                          activeMemo.content
                        )
                        return
                      }

                      if (opt.ext === 'html') {
                        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${activeMemo.title}</title><style>${sharedCss}</style></head><body><h1>${activeMemo.title}</h1>${renderMarkdownToHtml()}</body></html>`
                        await window.electronAPI.exportFile(
                          `${activeMemo.title}.html`,
                          [{ name: 'HTML', extensions: ['html'] }],
                          html
                        )
                        return
                      }

                      if (opt.ext === 'pdf') {
                        // Open system print dialog with a print-styled iframe — user selects
                        // "Microsoft Print to PDF" / "Save as PDF" / etc. Works on every OS
                        // without extra dependencies. Iframe is removed after print to avoid
                        // a dangling DOM node.
                        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${activeMemo.title}</title><style>${sharedCss} @media print { body { margin: 0; } }</style></head><body><h1>${activeMemo.title}</h1>${renderMarkdownToHtml()}</body></html>`
                        const iframe = document.createElement('iframe')
                        iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'
                        document.body.appendChild(iframe)
                        const doc = iframe.contentDocument || iframe.contentWindow?.document
                        if (!doc) { iframe.remove(); return }
                        doc.open(); doc.write(html); doc.close()
                        // Wait one frame for layout, then trigger print
                        setTimeout(() => {
                          try { iframe.contentWindow?.focus(); iframe.contentWindow?.print() }
                          catch { /* user cancelled or print failed */ }
                          // Give the print dialog time to capture content before removing
                          setTimeout(() => iframe.remove(), 1000)
                        }, 100)
                        return
                      }

                      if (opt.ext === 'docx') {
                        // Microsoft Word + LibreOffice both open HTML files saved with
                        // .docx (via the special namespace headers below) as proper Word
                        // documents. This is the canonical "HTML-to-Word" workaround that
                        // avoids pulling in a 200KB docx library.
                        const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${activeMemo.title}</title><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]--><style>${sharedCss}</style></head><body><h1>${activeMemo.title}</h1>${renderMarkdownToHtml()}</body></html>`
                        await window.electronAPI.exportFile(
                          `${activeMemo.title}.docx`,
                          [{ name: 'Word', extensions: ['docx'] }],
                          html
                        )
                        return
                      }
                    }}
                    style={{ padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {opt.label}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* 快照按钮已移除 — 功能没有被使用，去掉以减少 UI 噪音。
              snapshotMemo 这个 store 动作 + Memo.snapshots 数据字段保留以兼容
              旧数据，不会丢失之前手动保存的版本（看不到入口但数据还在）。 */}
          <button className="btn btn-sm" onClick={handleDelete} style={{ color: 'var(--danger)' }}>
            删除
          </button>
        </div>
      </div>

      {/* Cite panel overlay */}
      {showCitePanel && (
        <CitePanel memoId={activeMemo.id} onClose={() => setShowCitePanel(false)} />
      )}

      {/* Body: Vditor IR editor + blocks sidebar */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        {/* Main editor area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Live editor: rendered view, click to edit */}
          <LiveMemoEditor
            content={activeMemo.content}
            onChange={handleContentChange}
            blocks={activeMemo.blocks}
            memoId={activeMemo.id}
            onJumpBlock={handleJumpToBlock}
          />

          {/* AI section */}
          <div style={{ padding: '0 20px 12px', flexShrink: 0 }}>
            <MemoAiSection
              memoId={activeMemo.id}
              blocks={activeMemo.blocks}
              aiHistory={activeMemo.aiHistory}
            />
          </div>
        </div>

        {/* Blocks sidebar */}
        {activeMemo.blocks.length > 0 && (
          <div style={{
            width: 260, borderLeft: '1px solid var(--border-light)',
            overflow: 'auto', padding: 10, flexShrink: 0,
          }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, marginBottom: 4 }}>
              引用的信息块 ({activeMemo.blocks.length})
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 8, opacity: 0.7 }}>
              拖入编辑区引用
            </div>
            {activeMemo.blocks.map((block, i) => (
              <BlockCard
                key={block.historyEntryId}
                block={block}
                index={i + 1}
                onRemove={() => removeBlockFromMemo(activeMemo.id, block.historyEntryId)}
                onJump={() => handleJumpToBlock(block)}
              />
            ))}
          </div>
        )}
      </div>
      {/* Batch 43: ConfirmDialog 替代 window.confirm */}
      {confirmDialog}
    </div>
  )
}
