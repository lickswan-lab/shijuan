// Translate modal — lets the user translate selected text, the current page,
// a page range, or the full document using whatever AI model they've picked.
//
// UX contract:
//   - Streams output as chunks arrive (feels responsive even for long docs).
//   - Auto-chunks long source text so we don't blow past model context.
//     Rough heuristic: ~4000 chars per request. Small enough for glm-4-flash
//     / kimi-k2 / claude-haiku; big enough that we don't fire 50 requests for
//     a typical paper.
//   - "停止" mid-stream aborts via aiAbortStream — the same pattern the 回顾
//     button uses.
//   - "保存为备忘" dumps the result as a memo titled `译文《原标题》`.
//
// Why inline instead of a PdfViewer-local helper: the modal is self-contained
// and might also be triggered from the top bar in the future; keeping it in a
// separate file lets that happen without further refactoring.
import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useUiStore } from '../../store/uiStore'
import { useLibraryStore } from '../../store/libraryStore'

type TranslateMode = 'selection' | 'current-page' | 'range' | 'full'

export interface TranslateModalProps {
  open: boolean
  onClose: () => void
  initialMode: TranslateMode
  // Optional inputs — provided depending on what's available in the caller
  selectedText?: string
  currentPageText?: string
  currentPageNumber?: number
  fullText?: string                // OCR full text (may include "=== 第 N 页 ===" markers)
  pageTexts?: string[]             // Per-page OCR texts, if known (1-indexed? 0-indexed? — callers pass 0-indexed)
  totalPages?: number
  docTitle?: string
}

// Split the given text into chunks that won't overrun a single chat request.
// Target: ~3500 chars of source per chunk — leaves room for the model to
// double the length in translation and still fit in typical 8k/32k contexts.
function splitForTranslation(text: string, chunkSize = 3500): string[] {
  if (!text) return []
  if (text.length <= chunkSize) return [text]
  const chunks: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + chunkSize, text.length)
    // Prefer to break at paragraph boundaries so we don't split mid-sentence.
    if (end < text.length) {
      const lastPara = text.lastIndexOf('\n\n', end)
      if (lastPara > i + chunkSize * 0.5) end = lastPara
      else {
        // Fall back to a sentence end
        const lastSent = Math.max(
          text.lastIndexOf('。', end),
          text.lastIndexOf('.', end),
          text.lastIndexOf('\n', end),
        )
        if (lastSent > i + chunkSize * 0.5) end = lastSent + 1
      }
    }
    chunks.push(text.substring(i, end))
    i = end
  }
  return chunks
}

// Build the source text from the user's selected mode.
function buildSourceText(props: TranslateModalProps, mode: TranslateMode, range: { start: number; end: number }): string {
  if (mode === 'selection') return props.selectedText || ''
  if (mode === 'current-page') return props.currentPageText || ''
  if (mode === 'full') return props.fullText || ''
  if (mode === 'range') {
    const pages = props.pageTexts || []
    if (pages.length === 0) return ''
    // Convert 1-indexed user input to 0-indexed array access; clamp.
    const s = Math.max(0, Math.min(pages.length - 1, range.start - 1))
    const e = Math.max(s, Math.min(pages.length - 1, range.end - 1))
    const parts: string[] = []
    for (let p = s; p <= e; p++) parts.push(`=== 第 ${p + 1} 页 ===\n\n${pages[p] || ''}`)
    return parts.join('\n\n')
  }
  return ''
}

export default function TranslateModal(props: TranslateModalProps) {
  const { open, onClose, docTitle, totalPages = 0 } = props
  const selectedAiModel = useUiStore(s => s.selectedAiModel)
  const createMemo = useLibraryStore(s => s.createMemo)
  const updateMemo = useLibraryStore(s => s.updateMemo)
  const setActiveMemo = useUiStore(s => s.setActiveMemo)

  const [mode, setMode] = useState<TranslateMode>(props.initialMode)
  const [targetLang, setTargetLang] = useState<'zh' | 'en'>('zh')
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 1, end: Math.min(5, totalPages || 1) })
  const [result, setResult] = useState('')
  const [running, setRunning] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')
  const streamIdRef = useRef<string | null>(null)
  const cancelledRef = useRef(false)

  // Local model override — defaults to the globally selected model but can be
  // overridden per-translation (e.g. pick a bigger model for long docs).
  // We keep it local so switching here doesn't pollute the global choice used
  // by划词提问 / 回顾 etc.
  const [localModel, setLocalModel] = useState<string>(selectedAiModel)
  const [configuredProviders, setConfiguredProviders] = useState<
    Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  >([])

  // Load configured AI providers once on mount, and refresh whenever the modal
  // opens (the user may have added/removed a provider between opens).
  useEffect(() => {
    if (open && (window as any).electronAPI?.aiGetConfigured) {
      (window as any).electronAPI.aiGetConfigured().then(setConfiguredProviders).catch(() => {})
    }
  }, [open])

  // Reset state when modal opens / mode switches to a new request
  useEffect(() => {
    if (open) {
      setMode(props.initialMode)
      setResult('')
      setProgressMsg('')
      cancelledRef.current = false
      // Sync local model to current global choice on each open — user's latest
      // pick from the top bar should win unless they override inside the modal.
      setLocalModel(selectedAiModel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, props.initialMode])

  // Also reset page range when modal opens, so stale state from a prior entry doesn't carry over
  useEffect(() => {
    if (open && totalPages > 0) {
      setRange({ start: 1, end: Math.min(5, totalPages) })
    }
  }, [open, totalPages])

  if (!open) return null

  const currentSource = buildSourceText(props, mode, range)
  const canRun = currentSource.trim().length > 0 && !running

  async function handleRun() {
    if (!canRun) return
    setRunning(true)
    setResult('')
    setProgressMsg('正在翻译...')
    cancelledRef.current = false

    const chunks = splitForTranslation(currentSource)
    const target = targetLang === 'zh' ? '中文（简体）' : 'English'
    const style = targetLang === 'zh'
      ? '学术中文，保留原文术语（首次出现用括号标注英文原文），不改写论证结构，忠实逐段对应。公式与引用保持原样。'
      : 'Academic English, preserve original terminology, faithful paragraph-by-paragraph correspondence, keep formulas and citations intact.'

    let accumulated = ''
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (cancelledRef.current) break
        setProgressMsg(chunks.length > 1 ? `正在翻译第 ${i + 1}/${chunks.length} 段...` : '正在翻译...')

        const streamId = uuid()
        streamIdRef.current = streamId
        let chunkText = ''
        const cleanup = window.electronAPI.onAiStreamChunk((sid: string, c: string) => {
          if (sid === streamId) {
            chunkText += c
            // Show chunks[0..i-1] (already finalized) + current partial
            setResult(accumulated + chunkText)
          }
        })
        try {
          await window.electronAPI.aiChatStream(streamId, localModel, [
            {
              role: 'system',
              content: `你是一名学术翻译。请将用户给出的文本翻译为${target}。\n要求：${style}\n直接输出译文，不要添加任何解释、前言、说明、"翻译如下"之类的元话语。`,
            },
            { role: 'user', content: chunks[i] },
          ])
        } finally {
          cleanup()
          streamIdRef.current = null
        }
        accumulated += (accumulated ? '\n\n' : '') + chunkText
      }
      setResult(accumulated)
      setProgressMsg(cancelledRef.current ? '已停止' : `完成 · ${chunks.length} 段`)
    } catch (err: any) {
      setProgressMsg(`失败：${err?.message || err}`)
    } finally {
      setRunning(false)
    }
  }

  function handleAbort() {
    cancelledRef.current = true
    const sid = streamIdRef.current
    if (sid) {
      window.electronAPI.aiAbortStream?.(sid).catch(() => {})
    }
  }

  async function handleCopyResult() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result)
      setProgressMsg('已复制到剪贴板')
      setTimeout(() => { if (!running) setProgressMsg('') }, 1800)
    } catch {
      setProgressMsg('复制失败，请手动选择文本')
    }
  }

  async function handleSaveAsMemo() {
    if (!result) return
    const memo = await createMemo()
    if (memo) {
      const title = `译文 · ${docTitle || '未命名'}`
      await updateMemo(memo.id, { title, content: result })
      setActiveMemo(memo.id)
      onClose()
    }
  }

  const modeLabel: Record<TranslateMode, string> = {
    selection: '选中文本',
    'current-page': '当前页',
    range: '页码范围',
    full: '全文',
  }

  const sourceAvailability: Record<TranslateMode, boolean> = {
    selection: !!(props.selectedText && props.selectedText.trim()),
    'current-page': !!(props.currentPageText && props.currentPageText.trim()),
    range: !!(props.pageTexts && props.pageTexts.length > 0),
    full: !!(props.fullText && props.fullText.trim()),
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !running) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000,
      }}
    >
      <div style={{
        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10,
        width: 'min(720px, 92vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 12px 32px rgba(0,0,0,0.25)',
      }}>
        {/* Header */}
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>翻译</div>
          <button
            onClick={() => { if (!running) onClose() }}
            disabled={running}
            style={{
              background: 'transparent', border: 'none', cursor: running ? 'not-allowed' : 'pointer',
              color: 'var(--text-muted)', fontSize: 16, padding: '0 4px',
            }}
          >✕</button>
        </div>

        {/* Controls */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-light)' }}>
          {/* Mode picker */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {(Object.keys(modeLabel) as TranslateMode[]).map(m => {
              const avail = sourceAvailability[m]
              const active = mode === m
              return (
                <button
                  key={m}
                  disabled={!avail || running}
                  onClick={() => setMode(m)}
                  style={{
                    padding: '4px 10px', fontSize: 12, borderRadius: 4,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: !avail ? 'var(--text-muted)' : active ? 'var(--accent)' : 'var(--text)',
                    cursor: !avail || running ? 'not-allowed' : 'pointer',
                    opacity: !avail ? 0.5 : 1,
                  }}
                  title={!avail ? '当前没有可用的源文本（先完成 OCR 或选中文字）' : undefined}
                >
                  {modeLabel[m]}
                </button>
              )
            })}
          </div>

          {/* Page range inputs */}
          {mode === 'range' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>第</span>
              <input
                type="number" min={1} max={totalPages || 9999}
                value={range.start}
                disabled={running}
                onChange={e => setRange(r => ({ ...r, start: Math.max(1, parseInt(e.target.value) || 1) }))}
                style={{ width: 60, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 3 }}
              />
              <span style={{ color: 'var(--text-muted)' }}>—</span>
              <input
                type="number" min={1} max={totalPages || 9999}
                value={range.end}
                disabled={running}
                onChange={e => setRange(r => ({ ...r, end: Math.max(1, parseInt(e.target.value) || 1) }))}
                style={{ width: 60, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 3 }}
              />
              <span style={{ color: 'var(--text-muted)' }}>页{totalPages > 0 ? `（共 ${totalPages} 页）` : ''}</span>
            </div>
          )}

          {/* Target language + model + source preview */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>译为</span>
            <select
              value={targetLang} onChange={e => setTargetLang(e.target.value as any)} disabled={running}
              style={{ fontSize: 12, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--bg)', color: 'var(--text)' }}
            >
              <option value="zh">中文</option>
              <option value="en">英文</option>
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>模型</span>
            <select
              value={localModel}
              onChange={e => setLocalModel(e.target.value)}
              disabled={running}
              title="选择本次翻译使用的模型（仅本弹窗生效，不影响全局）"
              style={{
                fontSize: 12, padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 3,
                background: 'var(--bg)', color: 'var(--text)', maxWidth: 200,
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
                <option value={localModel}>请先配置 Key</option>
              )}
            </select>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              源文 {currentSource.length.toLocaleString()} 字
              {currentSource.length > 3500 && `（将拆为 ${splitForTranslation(currentSource).length} 段翻译）`}
            </span>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {running ? (
              <button
                onClick={handleAbort}
                className="btn btn-sm"
                style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' }}
              >停止</button>
            ) : (
              <button
                onClick={handleRun} disabled={!canRun}
                className="btn btn-sm btn-primary"
              >开始翻译</button>
            )}
            {result && !running && (
              <>
                <button onClick={handleCopyResult} className="btn btn-sm">复制</button>
                <button onClick={handleSaveAsMemo} className="btn btn-sm">保存为备忘</button>
              </>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {progressMsg}
            </span>
          </div>
        </div>

        {/* Result area — streaming */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '12px 16px',
          fontSize: 13, lineHeight: 1.7, color: 'var(--text)',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {result || (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
              {running ? '…' : '选择模式后点"开始翻译"。译文会在此处流式显示。'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
