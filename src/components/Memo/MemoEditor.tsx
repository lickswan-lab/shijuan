import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { v4 as uuid } from 'uuid'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
// Vditor removed - using auto-switch textarea/preview instead
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { BlockRef, HistoryEntry, Annotation, PdfMeta } from '../../types/library'

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
// The rendered span carries `data-block-idx` so a parent event delegate can wire click → jump.
function preprocessBlockRefs(content: string, blocks: BlockRef[]): string {
  if (blocks.length === 0) return content
  // Match #N where N is 1-99, NOT preceded by another # (avoids ## headings)
  return content.replace(/(?<!#)#(\d{1,2})(?!\d)/g, (_match, num) => {
    const idx = parseInt(num) - 1
    if (idx < 0 || idx >= blocks.length) return _match
    const block = blocks[idx]
    const preview = block.blockContent.substring(0, 60).replace(/"/g, '&quot;').replace(/\n/g, ' ')
    const authorLabel = block.blockAuthor === 'ai' ? 'AI' : '我'
    const color = block.blockAuthor === 'ai' ? '#4caf50' : '#C8956C'
    return `<span class="block-ref-inline" data-block-idx="${idx}" style="background:${color}15;border:1px solid ${color}40;border-radius:4px;padding:1px 6px;font-size:12px;cursor:pointer;display:inline-block;margin:0 2px" title="点击跳转 · ${block.entryTitle} · ${authorLabel}&#10;${preview}"><span style="color:${color};font-weight:600">#${num}</span> <span style="color:#666;font-size:11px">${preview.substring(0, 20)}${preview.length > 20 ? '…' : ''}</span></span>`
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
  const { library, addBlockToMemo } = useLibraryStore()
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
    window.electronAPI.loadPdfMeta(selectedEntryId).then(m => setEntryMeta(m))
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

  const filteredEntries = searchQuery
    ? entries.filter(e => e.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : entries

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
              <input
                type="text" placeholder="搜索文献..." value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
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
  const { addBlockToMemo } = useLibraryStore()
  const [dropPickerData, setDropPickerData] = useState<any>(null)

  // Event delegation: click on any .block-ref-inline inside preview → jump to that block.
  // Using delegation (instead of React props on the HTML spans) because the spans are
  // rendered from HTML strings via rehype-raw — they don't accept React props.
  useEffect(() => {
    const el = previewRef.current
    if (!el || editing) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const span = target.closest('.block-ref-inline') as HTMLElement | null
      if (!span) return
      e.stopPropagation()  // don't toggle into edit mode
      e.preventDefault()
      const idx = parseInt(span.dataset.blockIdx || '', 10)
      if (!Number.isFinite(idx)) return
      const block = blocks[idx]
      if (block && onJumpBlock) onJumpBlock(block)
    }
    el.addEventListener('click', handler, true)  // capture phase → runs before parent click
    return () => el.removeEventListener('click', handler, true)
  }, [blocks, editing, content, onJumpBlock])

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
              <Markdown rehypePlugins={[rehypeRaw]}>
                {preprocessBlockRefs(content, blocks)}
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
      background: block.blockAuthor === 'ai' ? '#F5FAF0' : 'var(--bg-warm)',
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
  const { library } = useLibraryStore()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const handleAsk = useCallback(async () => {
    if (!input.trim() || loading) return
    setLoading(true)

    // Get current memo content
    const memo = (library?.memos || []).find(m => m.id === memoId)
    const memoContent = memo?.content || ''

    // Build context from cited blocks
    const blocksContext = blocks.map(b =>
      `[${b.entryTitle}, ${b.blockAuthor === 'ai' ? 'AI' : '用户'}] 原文「${b.selectedText.substring(0, 100)}」→ ${b.blockContent}`
    ).join('\n')

    const result = await window.electronAPI.glmAsk(
      input.trim(),
      `用户的笔记内容：\n${memoContent.substring(0, 1500)}\n\n引用的信息块：\n${blocksContext}`,
      aiHistory
    )

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_qa',
      content: result.success ? result.text! : `错误：${result.error}`,
      userQuery: input.trim(),
      author: 'ai',
      createdAt: new Date().toISOString()
    }

    // Save to memo's aiHistory
    if (library) {
      const m = (library.memos || []).find(m => m.id === memoId)
      if (m) {
        m.aiHistory.push(entry)
        m.updatedAt = new Date().toISOString()
        await window.electronAPI.saveLibrary(library)
        useLibraryStore.setState({ library: { ...library } })
      }
    }

    setInput('')
    setLoading(false)
  }, [input, loading, memoId, blocks, aiHistory, library])

  return (
    <div style={{ borderTop: '1px solid var(--border-light)', padding: '10px 0 0' }}>
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
      <div style={{ display: 'flex', gap: 6 }}>
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
        <button className="btn btn-sm btn-primary" onClick={handleAsk} disabled={loading || !input.trim()}>
          {loading ? '...' : '提问'}
        </button>
      </div>
    </div>
  )
}

// ===== Main Memo Editor =====
export default function MemoEditor() {
  const { library, updateMemo, deleteMemo, removeBlockFromMemo, snapshotMemo } = useLibraryStore()
  const { activeMemoId, setActiveMemo } = useUiStore()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showCitePanel, setShowCitePanel] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const memos = library?.memos || []
  const activeMemo = memos.find(m => m.id === activeMemoId) || null
  // Ensure all fields exist (handles old data without these fields)
  if (activeMemo) {
    if (!activeMemo.blocks) activeMemo.blocks = []
    if (!activeMemo.aiHistory) activeMemo.aiHistory = []
    if (!activeMemo.snapshots) activeMemo.snapshots = []
    if (activeMemo.content == null) activeMemo.content = ''
  }

  // Auto-save with debounce
  const handleContentChange = useCallback((newContent: string) => {
    if (!activeMemo) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    activeMemo.content = newContent
    useLibraryStore.setState({ library: library ? { ...library } : null })
    saveTimerRef.current = setTimeout(() => {
      updateMemo(activeMemo.id, { content: newContent })
    }, 800)
  }, [activeMemo, library, updateMemo])

  const handleTitleSave = useCallback(() => {
    if (!activeMemo || !titleInput.trim()) { setEditingTitle(false); return }
    updateMemo(activeMemo.id, { title: titleInput.trim() })
    setEditingTitle(false)
  }, [activeMemo, titleInput, updateMemo])

  const handleDelete = useCallback(() => {
    if (!activeMemo) return
    deleteMemo(activeMemo.id)
    setActiveMemo(null)
  }, [activeMemo, deleteMemo, setActiveMemo])

  const handleJumpToBlock = useCallback((block: BlockRef) => {
    const entry = library?.entries.find(e => e.id === block.entryId)
    if (entry) {
      setActiveMemo(null)
      useUiStore.getState().setSidebarTab('library')
      useLibraryStore.getState().openEntry(entry)
      setTimeout(() => {
        useUiStore.getState().setActiveAnnotation(block.annotationId)
      }, 300)
    }
  }, [library, setActiveMemo])

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
              style={{ fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
              onDoubleClick={() => { setEditingTitle(true); setTitleInput(activeMemo.title) }}
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
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)', padding: '2px 0', minWidth: 120,
              }}>
                {[
                  { label: '导出 .md', ext: 'md' },
                  { label: '导出 .txt', ext: 'txt' },
                  { label: '导出 .html', ext: 'html' },
                ].map(opt => (
                  <div key={opt.ext}
                    onClick={async () => {
                      setShowExportMenu(false)
                      let content = activeMemo.content
                      if (opt.ext === 'html') {
                        content = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${activeMemo.title}</title><style>body{font-family:serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:2}blockquote{border-left:3px solid #C8956C;padding-left:16px;margin:16px 0;color:#666}</style></head><body><h1>${activeMemo.title}</h1>${content.replace(/\n/g, '<br>')}</body></html>`
                      }
                      await window.electronAPI.exportFile(
                        `${activeMemo.title}.${opt.ext}`,
                        [{ name: opt.ext.toUpperCase(), extensions: [opt.ext] }],
                        content
                      )
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
          <button className="btn btn-sm" onClick={() => snapshotMemo(activeMemo.id)} title="保存版本快照">
            快照{activeMemo.snapshots.length > 0 ? ` (${activeMemo.snapshots.length})` : ''}
          </button>
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
    </div>
  )
}
