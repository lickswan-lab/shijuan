import { useState, useCallback, useEffect, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import Markdown from 'react-markdown'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { Annotation, HistoryEntry, BlockRef } from '../../types/library'

// ===== Hermes background learning =====
// Silently appends annotation events to agent memory for behavior learning
const hermesEventQueue: string[] = []
let hermesFlushTimer: ReturnType<typeof setTimeout> | null = null

async function flushHermesQueue() {
  if (hermesEventQueue.length === 0) return
  const batch = hermesEventQueue.splice(0)
  try {
    const { success, content } = await window.electronAPI.agentLoadMemory()
    const existing = success && content ? content : ''
    const today = new Date().toLocaleDateString('zh-CN')
    const header = `\n\n## ${today} 阅读行为\n\n`
    const hasToday = existing.includes(`## ${today} 阅读行为`)
    const updated = hasToday
      ? existing + '\n' + batch.join('\n')
      : existing + header + batch.join('\n')
    await window.electronAPI.agentSaveMemory(updated)
  } catch {}
  hermesFlushTimer = null
}

function feedHermes(event: string) {
  hermesEventQueue.push(`- [${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}] ${event}`)

  // Flush quickly (3s) so data is ready when user opens Agent
  if (hermesFlushTimer) clearTimeout(hermesFlushTimer)
  hermesFlushTimer = setTimeout(flushHermesQueue, 3000)
}

// ===== Hermes contextual hint component =====
function HermesHint({ selectedText, currentTitle }: { selectedText?: string; currentTitle?: string }) {
  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedText || selectedText.length < 4) { setHint(null); return }

    // Search agent memory for related mentions
    let cancelled = false
    window.electronAPI.agentLoadMemory().then(({ success, content }) => {
      if (cancelled || !success || !content) return

      // Simple keyword matching: find lines in memory mentioning similar terms
      const keywords = selectedText.slice(0, 60).replace(/[，。、；：""''【】（）]/g, ' ').split(/\s+/).filter(w => w.length >= 2)
      const lines = content.split('\n').filter(l => l.startsWith('- ['))

      const matches: string[] = []
      for (const line of lines) {
        // Skip if it's about the current document
        if (currentTitle && line.includes(currentTitle)) continue
        for (const kw of keywords) {
          if (line.includes(kw)) {
            matches.push(line.replace(/^- \[[^\]]*\]\s*/, '').slice(0, 80))
            break
          }
        }
      }

      if (matches.length > 0 && !cancelled) {
        setHint(matches[matches.length - 1])  // Show most recent related activity
      } else {
        setHint(null)
      }
    }).catch(() => {})

    return () => { cancelled = true }
  }, [selectedText, currentTitle])

  if (!hint) return null

  return (
    <div style={{
      padding: '6px 12px', margin: '0 8px 4px', borderRadius: 6,
      background: 'linear-gradient(90deg, var(--accent-soft), transparent)',
      fontSize: 10, color: 'var(--accent-hover)', lineHeight: 1.5,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
      <span>Hermes: 你之前也关注过 — {hint}</span>
    </div>
  )
}

// ===== Ghost Reader: proactive cross-doc analysis after annotation =====
function GhostReaderCard({ suggestion, onDismiss }: { suggestion: string | null; onDismiss: () => void }) {
  if (!suggestion) return null

  return (
    <div style={{
      margin: '4px 8px 8px', padding: '8px 12px', borderRadius: 8,
      background: 'linear-gradient(135deg, var(--bg-hover), var(--bg-warm))',
      border: '1px solid var(--border)', position: 'relative',
    }}>
      <button onClick={onDismiss} style={{
        position: 'absolute', top: 4, right: 6, background: 'none', border: 'none',
        cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, lineHeight: 1,
      }}>x</button>
      <div style={{ fontSize: 10, fontWeight: 600, color: '#6b3fa0', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        Hermes 发现
      </div>
      <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.6 }}>{suggestion}</div>
    </div>
  )
}

// Map entry types to display info
function getModelLabel(modelSpec: string): string {
  // "glm:glm-5.1" → "GLM-5.1", "claude:claude-opus-4-6-..." → "Claude Opus 4.6"
  const [, modelId] = modelSpec.includes(':') ? modelSpec.split(':', 2) : ['', modelSpec]
  return modelId
    .replace(/^glm-/, 'GLM-')
    .replace(/^gpt-/, 'GPT-')
    .replace(/^claude-/, 'Claude ')
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^moonshot-/, 'Moonshot ')
    .replace(/^deepseek-/, 'DeepSeek ')
    .replace(/^doubao-/, '豆包 ')
    .replace(/^kimi-/, 'Kimi ')
    .replace(/-\d{8,}$/, '') // remove date suffixes like -20250414
}

function getTypeDisplay(type: HistoryEntry['type']) {
  const map: Record<string, { label: string; color: string; bgClass: string }> = {
    note: { label: '我', color: 'var(--accent)', bgClass: 'user-note' },
    annotation: { label: '我', color: 'var(--accent)', bgClass: 'user-note' },
    question: { label: '我', color: 'var(--accent)', bgClass: 'user-note' },
    stance: { label: '我', color: 'var(--accent)', bgClass: 'user-note' },
    link: { label: '关联', color: '#5B9BD5', bgClass: 'user-link' },
    ai_interpretation: { label: 'AI', color: 'var(--success)', bgClass: 'ai-response' },
    ai_qa: { label: 'AI', color: 'var(--warning)', bgClass: 'ai-qa' },
    ai_feedback: { label: 'AI', color: '#9DB5B2', bgClass: 'ai-feedback' },
  }
  return map[type] || map.note
}

// ===== Single history entry =====
function HistoryEntryItem({
  entry,
  onEdit,
  onDelete,
  onCite,
}: {
  entry: HistoryEntry
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
  onCite?: (entry: HistoryEntry) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(entry.content)

  const display = getTypeDisplay(entry.type)

  const handleSave = () => {
    onEdit(entry.id, editText)
    setEditing(false)
  }

  return (
    <div className={`history-entry ${display.bgClass}`}>
      <div className="history-entry-header">
        <span style={{ fontSize: 11, fontWeight: 500, color: entry.author === 'user' ? 'var(--accent)' : 'var(--success)' }}>
          {entry.author === 'user' ? '我' : (entry.modelLabel || 'AI')}
        </span>
        <div className="history-entry-actions">
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {new Date(entry.createdAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </span>
          {!editing && (
            <>
              {onCite && <button className="btn btn-sm btn-icon" onClick={() => onCite(entry)} title="引用此块">引用</button>}
              <button className="btn btn-sm btn-icon" onClick={() => { setEditText(entry.content); setEditing(true) }}>编辑</button>
              <button className="btn btn-sm btn-icon" onClick={() => onDelete(entry.id)}>删除</button>
            </>
          )}
        </div>
      </div>
      {entry.contextText && (
        <div style={{
          fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6,
          padding: '4px 8px', background: 'rgba(200,149,108,0.1)', borderRadius: 4,
          borderLeft: '2px solid var(--accent)',
        }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>引用：</span>
          「{entry.contextText.substring(0, 80)}{entry.contextText.length > 80 ? '...' : ''}」
        </div>
      )}
      {entry.type === 'ai_qa' && entry.userQuery && (
        <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 6, fontWeight: 500 }}>
          问：{entry.userQuery}
        </div>
      )}
      {entry.linkedRef && (
        <div style={{ fontSize: 11, color: '#5B9BD5', marginBottom: 6, fontStyle: 'italic' }}>
          关联：「{entry.linkedRef.selectedText?.substring(0, 60)}...」
        </div>
      )}
      {editing ? (
        <div>
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            style={{
              width: '100%', minHeight: 80, padding: 8, border: '1px solid var(--border)',
              borderRadius: 4, fontSize: 13, fontFamily: 'var(--font)', resize: 'vertical'
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>取消</button>
            <button className="btn btn-sm btn-primary" onClick={handleSave}>保存</button>
          </div>
        </div>
      ) : entry.author === 'ai' ? (
        <div className="annotation-markdown"><Markdown>{entry.content}</Markdown></div>
      ) : (
        <div style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</div>
      )}
      {entry.editedAt && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>已编辑</div>
      )}
    </div>
  )
}

// ===== AI Instant Feedback bubble =====
function FeedbackBubble({ text, loading, onKeep, onDismiss, onExpand }: {
  text: string | null
  loading: boolean
  onKeep: () => void
  onDismiss: () => void
  onExpand: (feedbackText: string) => void
}) {
  if (!loading && !text) return null

  return (
    <div style={{
      padding: '10px 14px', margin: '0 14px 10px',
      background: 'var(--bg-warm)', borderRadius: 8,
      border: '1px solid var(--border)',
      fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)',
      flexShrink: 0,
    }}>
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <span className="loading-spinner" />
          AI 正在思考...
        </div>
      ) : (
        <>
          <div style={{ fontSize: 10, color: '#9DB5B2', fontWeight: 600, marginBottom: 4 }}>AI 即时反馈</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={onDismiss} style={{ fontSize: 11 }}>忽略</button>
            <button className="btn btn-sm" onClick={() => { onKeep(); onExpand(text!) }} style={{ fontSize: 11, color: 'var(--accent)' }}>追问</button>
            <button className="btn btn-sm" onClick={onKeep} style={{ fontSize: 11, color: 'var(--success)' }}>保留</button>
          </div>
        </>
      )}
    </div>
  )
}

// ===== Block cite dropdown: cite a specific HistoryEntry to a memo =====
function BlockCiteDropdown({ historyEntry, annotation, entryId, entryTitle, onDone }: {
  historyEntry: HistoryEntry
  annotation: Annotation
  entryId: string
  entryTitle: string
  onDone: () => void
}) {
  const { library, addBlockToMemo } = useLibraryStore()
  const ref = useRef<HTMLDivElement>(null)
  const memos = library?.memos || []

  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDone()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onDone])

  const handleCite = async (memoId: string) => {
    const block: BlockRef = {
      entryId,
      entryTitle,
      annotationId: annotation.id,
      historyEntryId: historyEntry.id,
      selectedText: annotation.anchor.selectedText,
      blockContent: historyEntry.content.substring(0, 300),
      blockAuthor: historyEntry.author,
    }
    await addBlockToMemo(memoId, block)
    onDone()
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute', right: 0, top: '100%', zIndex: 100,
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        padding: '4px 0', minWidth: 160, marginTop: 4,
      }}
    >
      <div style={{ padding: '4px 12px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>
        引用到笔记
      </div>
      {memos.length === 0 ? (
        <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
          请先创建笔记
        </div>
      ) : memos.map(m => (
        <div
          key={m.id}
          onClick={() => handleCite(m.id)}
          style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          {m.title}
        </div>
      ))}
    </div>
  )
}

// ===== Main Panel =====
export default function AnnotationPanel() {
  const { currentEntry, currentPdfMeta, updatePdfMeta, library } = useLibraryStore()
  const { textSelection, activeAnnotationId, setTextSelection, setActiveAnnotation } = useUiStore()
  const [panelWidth, _setPanelWidth] = useState(() => { try { const v = localStorage.getItem('sj-annPanelWidth'); return v ? Number(v) : 340 } catch { return 340 } })
  const setPanelWidth = (w: number) => { _setPanelWidth(w); try { localStorage.setItem('sj-annPanelWidth', String(w)) } catch {} }
  const resizingRef = useRef(false)

  // Resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX
    const startWidth = panelWidth

    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = startX - ev.clientX
      setPanelWidth(Math.max(260, Math.min(600, startWidth + delta)))
    }
    const onUp = () => {
      resizingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [panelWidth])
  const [noteInput, setNoteInput] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const { selectedAiModel: aiModel, setSelectedAiModel: setAiModel, annotationColor } = useUiStore()
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>([])

  // Load configured AI providers
  useEffect(() => {
    if (window.electronAPI?.aiGetConfigured) {
      window.electronAPI.aiGetConfigured().then(setConfiguredProviders).catch(() => {})
    }
  }, [])
  const [citingEntry, setCitingEntry] = useState<{ historyEntry: HistoryEntry; annotation: Annotation } | null>(null)

  // Instant feedback state
  const [feedbackText, setFeedbackText] = useState<string | null>(null)
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const feedbackAnnotationId = useRef<string | null>(null)

  // Ghost Reader state
  const [ghostSuggestion, setGhostSuggestion] = useState<string | null>(null)

  const historyEndRef = useRef<HTMLDivElement>(null)

  // Load annotations from other entries
  interface OtherEntryAnnotations {
    entryId: string
    entryTitle: string
    annotations: Annotation[]
  }
  const [otherEntryAnnotations, setOtherEntryAnnotations] = useState<OtherEntryAnnotations[]>([])

  useEffect(() => {
    if (!library || !currentEntry) { setOtherEntryAnnotations([]); return }
    let cancelled = false

    async function loadOthers() {
      const others: OtherEntryAnnotations[] = []
      for (const entry of library!.entries) {
        if (entry.id === currentEntry!.id) continue
        try {
          const meta = await window.electronAPI.loadPdfMeta(entry.id)
          if (meta && meta.annotations && meta.annotations.length > 0) {
            others.push({
              entryId: entry.id,
              entryTitle: entry.title,
              annotations: meta.annotations,
            })
          }
        } catch { /* skip */ }
      }
      if (!cancelled) setOtherEntryAnnotations(others)
    }
    loadOthers()
    return () => { cancelled = true }
  }, [library?.entries.length, currentEntry?.id])

  // Jump to another entry's annotation
  const handleJumpToOtherAnnotation = useCallback((entryId: string, annotationId: string) => {
    const entry = library?.entries.find(e => e.id === entryId)
    if (entry) {
      useLibraryStore.getState().openEntry(entry)
      setTimeout(() => {
        useUiStore.getState().setActiveAnnotation(annotationId)
      }, 300)
    }
  }, [library])

  // Find the active annotation
  const activeAnnotation = currentPdfMeta?.annotations.find(a => a.id === activeAnnotationId)
  const selectionAnnotation = textSelection
    ? currentPdfMeta?.annotations.find(a =>
        a.anchor.selectedText === textSelection.text ||
        (a.anchor.pageNumber === textSelection.pageNumber &&
         (a.anchor.selectedText.includes(textSelection.text) || textSelection.text.includes(a.anchor.selectedText)))
      )
    : null
  const displayAnnotation = activeAnnotation || selectionAnnotation

  // Detect if user selected NEW text while viewing an existing annotation
  const hasNewContext = !!(
    displayAnnotation &&
    textSelection &&
    textSelection.text !== displayAnnotation.anchor.selectedText
  )
  const newContextText = hasNewContext ? textSelection!.text : null

  // Scroll to bottom when new entries added
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [displayAnnotation?.historyChain.length])

  // Clear feedback when switching annotation
  useEffect(() => {
    setFeedbackText(null)
    setFeedbackLoading(false)
  }, [displayAnnotation?.id])

  // ===== Trigger instant feedback =====
  const triggerFeedback = useCallback(async (userNote: string, annotationId: string, selectedText: string) => {
    if (!window.electronAPI?.glmInstantFeedback) {
      console.warn('[instant-feedback] glmInstantFeedback not available in electronAPI')
      return
    }
    const { glmApiKeyStatus } = useUiStore.getState()
    if (glmApiKeyStatus !== 'set') {
      console.warn('[instant-feedback] API key not set, skipping')
      return
    }

    setFeedbackLoading(true)
    setFeedbackText(null)
    feedbackAnnotationId.current = annotationId

    try {
      // Gather other annotations from current PDF as context
      const otherAnnotations: Array<{ text: string; note: string; entryTitle: string }> = []
      const entryTitle = currentEntry?.title || ''

      if (currentPdfMeta) {
        for (const ann of currentPdfMeta.annotations) {
          if (ann.id === annotationId) continue
          for (const h of ann.historyChain) {
            if (h.author === 'user') {
              otherAnnotations.push({
                text: ann.anchor.selectedText.substring(0, 100),
                note: h.content.substring(0, 200),
                entryTitle
              })
            }
          }
        }
      }

      // Get OCR context
      let ocrContext = ''
      if (currentEntry?.absPath) {
        try {
          const ocr = await window.electronAPI.readOcrText(currentEntry.absPath)
          if (ocr.exists && ocr.text) {
            ocrContext = ocr.text.substring(0, 1000)
          }
        } catch { /* ignore */ }
      }

      const result = await window.electronAPI.glmInstantFeedback(
        userNote, selectedText, ocrContext, otherAnnotations
      )

      // Only show if we're still on the same annotation
      if (feedbackAnnotationId.current === annotationId) {
        if (result.success && result.text) {
          setFeedbackText(result.text)
        } else if (!result.success) {
          console.warn('[instant-feedback] API error:', result.error)
          setFeedbackText(null)
        } else {
          setFeedbackText(null)
        }
        setFeedbackLoading(false)
      }
    } catch (err) {
      console.error('[instant-feedback] Exception:', err)
      setFeedbackLoading(false)
    }
  }, [currentEntry, currentPdfMeta])

  // ===== Keep feedback as history entry =====
  const handleKeepFeedback = useCallback(async () => {
    if (!feedbackText || !displayAnnotation) return

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_feedback',
      content: feedbackText,
      author: 'ai',
      createdAt: new Date().toISOString()
    }

    await updatePdfMeta(meta => ({
      ...meta,
      annotations: meta.annotations.map(a =>
        a.id === displayAnnotation.id
          ? { ...a, historyChain: [...a.historyChain, entry], updatedAt: new Date().toISOString() }
          : a
      )
    }))

    setFeedbackText(null)
  }, [feedbackText, displayAnnotation, updatePdfMeta])

  // ===== Add note =====
  const handleAddNote = useCallback(async () => {
    if (!noteInput.trim()) return
    if (!displayAnnotation && !textSelection) return

    const newEntry: HistoryEntry = {
      id: uuid(),
      type: 'note',
      content: noteInput.trim(),
      author: 'user',
      createdAt: new Date().toISOString(),
      ...(newContextText ? { contextText: newContextText } : {}),
    }

    let targetAnnotationId: string

    // Try to find existing annotation for this text (covers async race condition)
    const existingAnn = displayAnnotation || (textSelection
      ? currentPdfMeta?.annotations.find(a => a.anchor.selectedText === textSelection.text)
      : null)

    if (existingAnn) {
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: meta.annotations.map(a =>
          a.id === existingAnn.id
            ? { ...a, historyChain: [...a.historyChain, newEntry], updatedAt: new Date().toISOString() }
            : a
        )
      }))
      targetAnnotationId = existingAnn.id
      if (!activeAnnotationId) setActiveAnnotation(existingAnn.id)
    } else {
      // Create new annotation from text selection
      const newAnnotation: Annotation = {
        id: uuid(),
        anchor: {
          pageNumber: textSelection!.pageNumber,
          startOffset: textSelection!.startOffset,
          endOffset: textSelection!.endOffset,
          selectedText: textSelection!.text
        },
        historyChain: [newEntry],
        style: { color: annotationColor },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: [...meta.annotations, newAnnotation]
      }))
      targetAnnotationId = newAnnotation.id
      setActiveAnnotation(newAnnotation.id)
    }

    const savedNote = noteInput.trim()
    const savedText = newContextText || displayAnnotation?.anchor.selectedText || textSelection?.text || ''
    setNoteInput('')

    // Feed to Hermes: record annotation behavior
    const entryTitle = currentEntry?.title || '未知文献'
    feedHermes(`在「${entryTitle}」中对「${savedText.slice(0, 40)}」添加笔记：${savedNote.slice(0, 60)}`)

    // Trigger instant feedback after saving
    triggerFeedback(savedNote, targetAnnotationId, savedText)

    // Ghost Reader: async cross-doc analysis (non-blocking)
    ;(async () => {
      try {
        // Search other documents' annotations for related content
        const result = await window.electronAPI.agentExecuteTool('build_knowledge_map', '{}')
        const data = JSON.parse(result.result)
        if (!data.annotationSummary || data.totalAnnotations < 3) return

        // Ask AI to find cross-doc connections (quick, focused prompt)
        const { selectedAiModel } = useUiStore.getState()
        const streamId = uuid()
        let fullText = ''
        const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => { if (sid === streamId) fullText += chunk })
        try {
          await window.electronAPI.aiChatStream(streamId, selectedAiModel, [
            { role: 'system', content: '你是 Hermes 幽灵读者。用户刚刚在一篇文献上做了注释，你需要在1-2句话内指出一个有价值的跨文献关联。如果没有发现关联，只回复"无"。不要客套，直接说发现。' },
            { role: 'user', content: `用户刚在「${entryTitle}」中对「${savedText.slice(0, 100)}」写了笔记：「${savedNote.slice(0, 150)}」\n\n其他文献的注释概要：\n${data.annotationSummary.slice(0, 2000)}` },
          ])
        } finally { cleanup() }

        if (fullText && !fullText.startsWith('无') && fullText.length > 5) {
          setGhostSuggestion(fullText.trim())
        }
      } catch {}
    })()
  }, [textSelection, noteInput, displayAnnotation, newContextText, updatePdfMeta, setActiveAnnotation, triggerFeedback])

  // ===== AI interpret =====
  const handleAiInterpret = useCallback(async () => {
    // Use new context text if available, otherwise original anchor text
    const interpretText = newContextText || displayAnnotation?.anchor.selectedText || textSelection?.text
    if (!interpretText) return
    setAiLoading(true)

    const result = await window.electronAPI.glmInterpret(interpretText, '')

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_interpretation',
      content: result.success ? result.text! : `错误：${result.error}`,
      contextSent: interpretText,
      author: 'ai',
      createdAt: new Date().toISOString(),
      ...(newContextText ? { contextText: newContextText } : {}),
    }

    if (displayAnnotation) {
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: meta.annotations.map(a =>
          a.id === displayAnnotation.id
            ? { ...a, historyChain: [...a.historyChain, entry], updatedAt: new Date().toISOString() }
            : a
        )
      }))
    } else if (textSelection) {
      const newAnnotation: Annotation = {
        id: uuid(),
        anchor: {
          pageNumber: textSelection.pageNumber,
          startOffset: textSelection.startOffset,
          endOffset: textSelection.endOffset,
          selectedText: textSelection.text
        },
        historyChain: [entry],
        style: { color: annotationColor },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: [...meta.annotations, newAnnotation]
      }))
      setActiveAnnotation(newAnnotation.id)
    }

    setAiLoading(false)
  }, [textSelection, newContextText, displayAnnotation, updatePdfMeta, setActiveAnnotation])

  // ===== AI dialogue (streaming) =====
  const handleAskQuestionWithText = useCallback(async (text: string) => {
    if (!text.trim()) return
    if (!displayAnnotation && !textSelection) return
    setAiLoading(true)
    setStreamingText('')

    const anchorText = displayAnnotation?.anchor.selectedText || textSelection?.text || ''
    let contextForAi = anchorText
    if (newContextText) {
      contextForAi += `\n\n[用户补充的上下文文本]\n${newContextText}`
    }

    const historyChain = displayAnnotation?.historyChain || []

    // Build messages for streaming call (same logic as glm-ask handler)
    // Build system prompt with surrounding context window
    const docText = useUiStore.getState().currentDocText
    const docTitle = useLibraryStore.getState().currentEntry?.title || ''
    const contextWindow = useUiStore.getState().aiContextWindow

    let surroundingContext = ''
    if (docText && anchorText) {
      if (contextWindow === -1) {
        // Full document
        surroundingContext = docText
      } else {
        // Find selected text position, extract window before and after
        const cleanAnchor = anchorText.replace(/\s+/g, '')
        const cleanDoc = docText.replace(/\s+/g, '')
        const pos = cleanDoc.indexOf(cleanAnchor)
        if (pos >= 0) {
          const ratio = docText.length / cleanDoc.length
          const origPos = Math.floor(pos * ratio)
          const start = Math.max(0, origPos - contextWindow)
          const end = Math.min(docText.length, origPos + anchorText.length + contextWindow)
          surroundingContext = (start > 0 ? '[...] ' : '') + docText.substring(start, end) + (end < docText.length ? ' [...]' : '')
        }
      }
    }

    let systemContent = `你是一位非常熟悉文献「${docTitle}」的学术导师。请基于文献上下文回答用户关于选中文本的问题。\n\n用户选中的文本：\n「${contextForAi}」`
    if (surroundingContext) {
      systemContent += `\n\n选中文本的前后上下文（来自同一篇文献）：\n${surroundingContext}`
    }

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemContent }
    ]
    for (const entry of historyChain) {
      if (entry.type === 'ai_qa') {
        if (entry.userQuery) messages.push({ role: 'user', content: entry.userQuery })
        messages.push({ role: 'assistant', content: entry.content })
      } else if (['note', 'question', 'stance'].includes(entry.type)) {
        messages.push({ role: 'user', content: `[我的笔记] ${entry.content}` })
      } else if (entry.type === 'ai_interpretation' || entry.type === 'ai_feedback') {
        messages.push({ role: 'assistant', content: entry.content })
      }
    }
    messages.push({ role: 'user', content: text.trim() })

    const streamId = uuid()
    let fullText = ''

    // Listen for streaming chunks
    const cleanupChunk = window.electronAPI.onAiStreamChunk((sid, chunk) => {
      if (sid !== streamId) return
      fullText += chunk
      setStreamingText(fullText)
    })

    try {
      const result = await window.electronAPI.aiChatStream(streamId, aiModel, messages)
      if (!result.success) fullText = `错误：${result.error}`
    } catch (err: any) {
      fullText = `错误：${err.message}`
    } finally {
      cleanupChunk()
    }

    setStreamingText('')

    // Feed to Hermes: record AI dialogue
    const entryTitle = useLibraryStore.getState().currentEntry?.title || '未知文献'
    feedHermes(`在「${entryTitle}」中向AI提问：${text.trim().slice(0, 50)}`)

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_qa',
      content: fullText,
      userQuery: text.trim(),
      author: 'ai',
      modelLabel: getModelLabel(aiModel),
      createdAt: new Date().toISOString(),
      ...(newContextText ? { contextText: newContextText } : {}),
    }

    const existingAnn = displayAnnotation || (textSelection
      ? currentPdfMeta?.annotations.find(a => a.anchor.selectedText === textSelection.text)
      : null)

    if (existingAnn) {
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: meta.annotations.map(a =>
          a.id === existingAnn.id
            ? { ...a, historyChain: [...a.historyChain, entry], updatedAt: new Date().toISOString() }
            : a
        )
      }))
      if (!activeAnnotationId) setActiveAnnotation(existingAnn.id)
    } else if (textSelection) {
      const newAnnotation: Annotation = {
        id: uuid(),
        anchor: {
          pageNumber: textSelection.pageNumber,
          startOffset: textSelection.startOffset,
          endOffset: textSelection.endOffset,
          selectedText: textSelection.text,
        },
        historyChain: [entry],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: [...meta.annotations, newAnnotation]
      }))
      setActiveAnnotation(newAnnotation.id)
    }

    setNoteInput('')
    setAiLoading(false)
  }, [displayAnnotation, textSelection, newContextText, aiModel, updatePdfMeta, setActiveAnnotation])

  // Convenience wrapper
  const handleAskQuestion = useCallback(() => {
    handleAskQuestionWithText(noteInput)
  }, [noteInput, handleAskQuestionWithText])

  // ===== Edit / Delete =====
  const handleEdit = useCallback(async (entryId: string, newContent: string) => {
    if (!displayAnnotation) return
    await updatePdfMeta(meta => ({
      ...meta,
      annotations: meta.annotations.map(a =>
        a.id === displayAnnotation.id
          ? {
              ...a,
              historyChain: a.historyChain.map(e =>
                e.id === entryId
                  ? { ...e, originalContent: e.originalContent || e.content, content: newContent, editedAt: new Date().toISOString() }
                  : e
              ),
              updatedAt: new Date().toISOString()
            }
          : a
      )
    }))
  }, [displayAnnotation, updatePdfMeta])

  const handleDelete = useCallback(async (entryId: string) => {
    if (!displayAnnotation) return
    await updatePdfMeta(meta => ({
      ...meta,
      annotations: meta.annotations.map(a =>
        a.id === displayAnnotation.id
          ? { ...a, historyChain: a.historyChain.filter(e => e.id !== entryId), updatedAt: new Date().toISOString() }
          : a
      ).filter(a => a.historyChain.length > 0)
    }))
    if (displayAnnotation.historyChain.length <= 1) {
      setActiveAnnotation(null)
    }
  }, [displayAnnotation, updatePdfMeta, setActiveAnnotation])

  const { toggleAnnotationPanel, clearAnnotationFocus } = useUiStore()

  // ===== Delete entire annotation (whole chain) =====
  const [confirmDeleteChain, setConfirmDeleteChain] = useState(false)
  const handleDeleteChain = useCallback(async () => {
    if (!displayAnnotation) return
    await updatePdfMeta(meta => ({
      ...meta,
      annotations: meta.annotations.filter(a => a.id !== displayAnnotation.id)
    }))
    clearAnnotationFocus()
    setConfirmDeleteChain(false)
  }, [displayAnnotation, updatePdfMeta, clearAnnotationFocus])

  // ===== Annotation list helper =====
  const renderAnnotationItem = (ann: Annotation, onClick: () => void, sourceLabel?: string, entryId?: string, entryTitle?: string) => {
    const lastEntry = ann.historyChain[ann.historyChain.length - 1]
    const display = lastEntry ? getTypeDisplay(lastEntry.type) : null
    return (
      <div
        key={ann.id}
        className="annotation-list-item"
        draggable
        onDragStart={e => {
          // Carry annotation data for memo drop
          e.dataTransfer.setData('annotation-drag', JSON.stringify({
            entryId: entryId || currentEntry?.id || '',
            entryTitle: entryTitle || currentEntry?.title || '',
            annotationId: ann.id,
            selectedText: ann.anchor.selectedText,
            historyChain: ann.historyChain.map(h => ({
              id: h.id, type: h.type, content: h.content.substring(0, 300),
              author: h.author, userQuery: h.userQuery,
            })),
          }))
          e.dataTransfer.effectAllowed = 'copy'
        }}
        style={{
          padding: '8px 10px', marginBottom: 4, borderRadius: 6,
          cursor: 'grab', fontSize: 12, background: 'var(--bg-warm)',
          borderLeft: `3px solid ${display?.color || 'var(--border)'}`,
          position: 'relative',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
      >
        <div onClick={onClick} style={{ cursor: 'pointer' }}>
          {sourceLabel && (
            <div style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 500, marginBottom: 2, opacity: 0.8 }}>
              {sourceLabel}
            </div>
          )}
          <div style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 28 }}>
            「{ann.anchor.selectedText.substring(0, 40)}{ann.anchor.selectedText.length > 40 ? '...' : ''}」
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            p.{ann.anchor.pageNumber} · {ann.historyChain.length} 条记录
          </div>
        </div>
        {/* Delete button only for current entry's annotations */}
        {!sourceLabel && (
          <div className="annotation-list-actions" style={{
            position: 'absolute', right: 6, top: 0, bottom: 0,
            display: 'flex', alignItems: 'center', gap: 2, opacity: 0, transition: 'opacity 0.15s',
          }}>
            <button
              className="btn btn-sm btn-icon"
              title="删除此注释"
              style={{ padding: '3px 5px', color: 'var(--text-muted)' }}
              onClick={(e) => {
                e.stopPropagation()
                updatePdfMeta(meta => ({
                  ...meta,
                  annotations: meta.annotations.filter(a => a.id !== ann.id)
                }))
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        )}
      </div>
    )
  }

  const totalOtherAnnotations = otherEntryAnnotations.reduce((sum, e) => sum + e.annotations.length, 0)

  // ===== Empty state (all annotations list) =====
  if (!textSelection && !activeAnnotationId) {
    const hasCurrentAnnotations = currentPdfMeta && currentPdfMeta.annotations.length > 0
    const hasAny = hasCurrentAnnotations || totalOtherAnnotations > 0

    return (
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div onMouseDown={handleResizeStart} style={{ width: 4, cursor: 'col-resize', background: 'transparent', flexShrink: 0, transition: 'background 0.15s' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')} />
        <div className="annotation-panel" style={{ width: panelWidth }}>
        <div className="annotation-panel-header">
          <span>注释</span>
          <button className="btn btn-sm btn-icon" onClick={toggleAnnotationPanel} title="关闭面板">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {hasAny ? (
          <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
            {/* Current entry's annotations */}
            {hasCurrentAnnotations && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 4px 10px', fontWeight: 500 }}>
                  本文献的注释 ({currentPdfMeta!.annotations.length})
                </div>
                {currentPdfMeta!.annotations.map(ann =>
                  renderAnnotationItem(ann, () => setActiveAnnotation(ann.id))
                )}
              </>
            )}

            {/* Divider + Other entries' annotations */}
            {totalOtherAnnotations > 0 && (
              <>
                <div style={{
                  margin: '16px 0 12px', padding: '10px 0 0',
                  borderTop: '2px solid var(--border-light)',
                  fontSize: 11, color: 'var(--text-muted)', fontWeight: 500,
                }}>
                  其他文献的注释 ({totalOtherAnnotations})
                </div>
                {otherEntryAnnotations.map(other => (
                  <div key={other.entryId}>
                    <div style={{
                      fontSize: 10, color: 'var(--accent)', fontWeight: 600,
                      padding: '6px 4px 4px', opacity: 0.7,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      📄 {other.entryTitle}
                    </div>
                    {other.annotations.map(ann =>
                      renderAnnotationItem(
                        ann,
                        () => handleJumpToOtherAnnotation(other.entryId, ann.id),
                        other.entryTitle,
                        other.entryId,
                        other.entryTitle,
                      )
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <div className="empty-state">
            <span style={{ fontSize: 13 }}>选中 PDF 中的文字</span>
            <span style={{ fontSize: 12 }}>即可添加注释或提问</span>
          </div>
        )}
      </div>
      </div>
    )
  }

  // ===== Active annotation view =====
  return (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      <div onMouseDown={handleResizeStart} style={{ width: 4, cursor: 'col-resize', background: 'transparent', flexShrink: 0, transition: 'background 0.15s' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')} />
      <div className="annotation-panel" style={{ width: panelWidth }}>
      <div className="annotation-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="btn btn-sm btn-icon" onClick={clearAnnotationFocus} title="返回全部注释">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <span>{displayAnnotation ? '历史链' : '新注释'}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {displayAnnotation && (
            confirmDeleteChain ? (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>
                <button className="btn btn-sm" style={{ fontSize: 11, color: 'var(--danger)' }} onClick={handleDeleteChain}>
                  确认删除
                </button>
                <button className="btn btn-sm" style={{ fontSize: 11 }} onClick={() => setConfirmDeleteChain(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                className="btn btn-sm btn-icon"
                onClick={() => setConfirmDeleteChain(true)}
                title="删除整条历史链"
                style={{ color: 'var(--text-muted)' }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            )
          )}
          <button className="btn btn-sm btn-icon" onClick={toggleAnnotationPanel} title="关闭面板">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Selected text preview */}
      {(textSelection || displayAnnotation) && (
        <div style={{
          padding: '10px 16px', background: 'var(--bg-warm)', borderBottom: '1px solid var(--border-light)',
          fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0,
        }}>
          <div style={{ maxHeight: 60, overflow: 'auto' }}>
            「{displayAnnotation?.anchor.selectedText || textSelection?.text}」
          </div>
          {/* Show newly selected context text */}
          {hasNewContext && newContextText && (
            <div style={{
              marginTop: 8, padding: '6px 10px', borderRadius: 4,
              background: 'rgba(200,149,108,0.12)', border: '1px solid rgba(200,149,108,0.25)',
            }}>
              <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 500, marginBottom: 2 }}>
                + 补充选中
              </div>
              <div style={{ maxHeight: 40, overflow: 'auto', fontSize: 12 }}>
                「{newContextText}」
              </div>
            </div>
          )}
        </div>
      )}

      {/* History chain */}
      <div className="history-chain">
        {displayAnnotation?.historyChain.map(entry => (
          <HistoryEntryItem
            key={entry.id}
            entry={entry}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onCite={displayAnnotation ? (he) => setCitingEntry({ historyEntry: he, annotation: displayAnnotation }) : undefined}
          />
        ))}
        {/* AI streaming / loading indicator */}
        {aiLoading && (
          <div className="history-entry ai-response">
            {streamingText ? (
              <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                {streamingText}
                <span className="streaming-cursor" />
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                <span className="loading-spinner" />
                AI 正在思考...
              </div>
            )}
          </div>
        )}
        <div ref={historyEndRef} />

        {/* Block cite dropdown */}
        {citingEntry && (
          <div style={{ position: 'relative' }}>
            <BlockCiteDropdown
              historyEntry={citingEntry.historyEntry}
              annotation={citingEntry.annotation}
              entryId={currentEntry?.id || ''}
              entryTitle={currentEntry?.title || ''}
              onDone={() => setCitingEntry(null)}
            />
          </div>
        )}
      </div>

      {/* AI Instant Feedback bubble */}
      <FeedbackBubble
        text={feedbackText}
        loading={feedbackLoading}
        onKeep={handleKeepFeedback}
        onDismiss={() => { setFeedbackText(null); setFeedbackLoading(false) }}
        onExpand={(fbText) => {
          // Pre-fill the input with a follow-up question about the feedback
          setNoteInput(`关于「${fbText.substring(0, 30)}...」，`)
          setFeedbackText(null)
          setFeedbackLoading(false)
        }}
      />

      {/* Ghost Reader suggestion */}
      <GhostReaderCard suggestion={ghostSuggestion} onDismiss={() => setGhostSuggestion(null)} />

      {/* Hermes contextual hint */}
      <HermesHint selectedText={displayAnnotation?.anchor.selectedText || textSelection?.text} currentTitle={currentEntry?.title} />

      {/* Unified input area */}
      <div className="ai-chat-input">
        <textarea
          placeholder={hasNewContext ? '针对补充选中的文本写下想法...' : '写下想法 / 向 AI 提要求...'}
          value={noteInput}
          onChange={e => setNoteInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); handleAddNote() }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <select
              value={aiModel}
              onChange={e => setAiModel(e.target.value)}
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
            <button
              className="btn btn-sm"
              onClick={handleAskQuestion}
              disabled={aiLoading || !noteInput.trim()}
              style={{ fontSize: 12, padding: '6px 18px' }}
            >
              {aiLoading ? '...' : '发送 AI'}
            </button>
          </div>
          <button className="btn btn-sm btn-primary" onClick={handleAddNote} disabled={!noteInput.trim() || (!displayAnnotation && !textSelection)}
            style={{ fontSize: 12, padding: '6px 14px' }}>
            保存笔记 <span style={{ fontSize: 9, opacity: 0.5 }}>Ctrl+↵</span>
          </button>
        </div>
      </div>
    </div>
    </div>
  )
}
