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
import { useEffect, useState } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useLibraryStore } from '../../store/libraryStore'
import { useTranslationJobsStore } from '../../store/translationJobsStore'

type TranslateMode = 'selection' | 'current-page' | 'range' | 'full'

export interface TranslateModalProps {
  open: boolean
  onClose: () => void
  // Entry the translation is associated with — key into the jobs store.
  // Required so the modal can survive being closed ("minimized") without
  // killing the in-flight chunk loop.
  entryId: string
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

// Format a job's current state into a short status line shown in the modal's
// action row. Returns '' for no-job / fresh-state so the row can stay empty.
function deriveProgressMsg(job: ReturnType<typeof useTranslationJobsStore.getState>['jobs'][string] | undefined): string {
  if (!job) return ''
  if (job.status === 'running') {
    const { currentChunk, totalChunks } = job
    return totalChunks > 1 ? `正在翻译第 ${currentChunk}/${totalChunks} 段...` : '正在翻译...'
  }
  if (job.status === 'aborted') return '已停止'
  if (job.status === 'failed') return `失败：${job.error || '未知错误'}`
  if (job.status === 'completed') return `完成 · ${job.totalChunks} 段`
  return ''
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
  const { open, onClose, entryId, docTitle, totalPages = 0 } = props
  const selectedAiModel = useUiStore(s => s.selectedAiModel)
  const createMemo = useLibraryStore(s => s.createMemo)
  const updateMemo = useLibraryStore(s => s.updateMemo)
  const setActiveMemo = useUiStore(s => s.setActiveMemo)
  const addEntryFromPath = useLibraryStore(s => s.addEntryFromPath)
  const openEntry = useLibraryStore(s => s.openEntry)
  const currentEntry = useLibraryStore(s => s.currentEntry)

  // Read the in-flight / latest job for this entry from the global store.
  // The chunk loop and stream subscription live in the store, so closing this
  // modal does NOT abort the translation — reopening just reattaches to state.
  const job = useTranslationJobsStore(s => s.jobs[entryId])
  const startTranslation = useTranslationJobsStore(s => s.startTranslation)
  const abortTranslation = useTranslationJobsStore(s => s.abortTranslation)

  const result = job?.result || ''
  const running = job?.status === 'running'
  const progressMsg = deriveProgressMsg(job)

  const [mode, setMode] = useState<TranslateMode>(props.initialMode)
  const [targetLang, setTargetLang] = useState<'zh' | 'en'>('zh')
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 1, end: Math.min(5, totalPages || 1) })
  const [localProgressMsg, setLocalProgressMsg] = useState('')

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

  // Reset local-only state when modal opens. We DON'T clear result/progress
  // here — those come from the jobs store and should persist across open/close
  // cycles so the user can reopen a minimized translation and see its state.
  useEffect(() => {
    if (open) {
      setMode(props.initialMode)
      setLocalProgressMsg('')
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
    if (!canRun || !entryId) return
    const chunks = splitForTranslation(currentSource)
    if (chunks.length === 0) return
    // Fire-and-forget: the store owns the chunk loop, so we don't await here.
    // The modal re-renders from store state as chunks stream in.
    startTranslation({
      entryId,
      mode,
      targetLang,
      model: localModel,
      sourceText: currentSource,
      chunks,
      docTitle: docTitle || '未命名',
    })
  }

  function handleAbort() {
    if (!entryId) return
    abortTranslation(entryId)
  }

  async function handleCopyResult() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result)
      setLocalProgressMsg('已复制到剪贴板')
      setTimeout(() => setLocalProgressMsg(''), 1800)
    } catch {
      setLocalProgressMsg('复制失败，请手动选择文本')
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

  // Build the document title per user spec: 「源文本名称 翻译部分 翻译文本（语言）」
  // 翻译部分 varies by mode: 全文 / 第N页 / 第N-M页 / 选中片段
  function buildEntryTitle(): string {
    const src = docTitle || '未命名'
    const lang = targetLang === 'zh' ? '中文' : '英文'
    let partLabel: string
    switch (mode) {
      case 'full': partLabel = '全文'; break
      case 'current-page': partLabel = props.currentPageNumber ? `第${props.currentPageNumber}页` : '当前页'; break
      case 'range': partLabel = range.start === range.end ? `第${range.start}页` : `第${range.start}-${range.end}页`; break
      case 'selection':
      default: partLabel = '选中片段'; break
    }
    return `${src} ${partLabel} 翻译文本（${lang}）`
  }

  // "保存为文献"：把当前译文写成 .txt 文件（在 ~/.lit-manager/translations/
  // 下），然后作为一条 LibraryEntry 加入左侧文献栏。保存后直接打开，让用户
  // 立刻看到结果。
  async function handleSaveAsEntry() {
    if (!result) return
    setLocalProgressMsg('正在保存为文献...')
    try {
      const title = buildEntryTitle()
      const writeRes = await window.electronAPI.saveTranslationAsFile(title, result)
      if (!writeRes.success || !writeRes.absPath) {
        setLocalProgressMsg(`保存失败：${writeRes.error || '未知错误'}`)
        return
      }
      // Put the new entry in the same folder as the source, if we have one —
      // so翻译跟着原文放，不会散到根目录。
      const folderId = currentEntry?.folderId
      const entry = await addEntryFromPath(writeRes.absPath, title, folderId)
      if (!entry) {
        setLocalProgressMsg('保存成功但未能加入文献栏（库未初始化？）')
        return
      }
      setLocalProgressMsg(`已保存为文献：${title}`)
      // Close the modal and open the new entry so the user sees it
      // immediately — same UX as "保存为备忘" jumps into the memo.
      openEntry(entry).catch(() => {})
      setTimeout(() => onClose(), 400)
    } catch (err: any) {
      setLocalProgressMsg(`保存失败：${err?.message || err}`)
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
      // Backdrop click minimizes (not aborts) — the job continues in the
      // background via the store. Click ✕ to still minimize; no longer blocks
      // while running.
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
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
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
            翻译
            {running && (
              <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)', fontWeight: 400 }}>
                · 后台运行中（关闭弹窗不会中止）
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={onClose}
              title={running ? '最小化（翻译后台继续）' : '关闭'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: 14, padding: '0 6px',
              }}
            >{running ? '—' : '✕'}</button>
          </div>
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
                <button onClick={handleSaveAsEntry} className="btn btn-sm" title="保存为 .txt 并加入左侧文献栏">保存为文献</button>
                <button onClick={handleSaveAsMemo} className="btn btn-sm">保存为备忘</button>
              </>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              {localProgressMsg || progressMsg}
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
