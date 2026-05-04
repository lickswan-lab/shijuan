import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { v4 as uuid } from 'uuid'
import Markdown from 'react-markdown'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import { openEntryById } from '../../utils/openEntryById'
import type { Annotation, HistoryEntry, BlockRef } from '../../types/library'
import { useAnnotationAiJobsStore, jobKey } from '../../store/annotationAiJobsStore'
import { fetchAiConfig, subscribeAiConfig } from '../../utils/aiConfigCache'
import { normalizeMixedChineseToSimplified } from '../../utils/chineseText'
import { fetchAgentMemory, invalidateAgentMemoryCache } from '../../utils/agentMemoryCache'
import { humanizeAiError } from '../../utils/humanizeAiError'
import { readNumber } from '../../utils/safeStorageRead'
// PERF-R8#11 · persona list 共享 cache,免每次 AnnotationPanel mount 都 IPC
import { fetchPersonaList, subscribePersonaList } from '../../utils/personaListCache'
import ImeInput from '../common/ImeInput'

// ===== Hermes background learning =====
// Silently appends annotation events to agent memory for behavior learning
const hermesEventQueue: string[] = []
let hermesFlushTimer: ReturnType<typeof setTimeout> | null = null

async function flushHermesQueue() {
  if (hermesEventQueue.length === 0) return
  const batch = hermesEventQueue.splice(0)
  try {
    // 这里需要最新内容（write-after-read），用 fetchAgentMemory 也行（cache 命中省 IPC）
    const { success, content } = await fetchAgentMemory()
    const existing = success && content ? content : ''
    const today = new Date().toLocaleDateString('zh-CN')
    const header = `\n\n## ${today} 阅读行为\n\n`
    const hasToday = existing.includes(`## ${today} 阅读行为`)
    const updated = hasToday
      ? existing + '\n' + batch.join('\n')
      : existing + header + batch.join('\n')
    await window.electronAPI.agentSaveMemory(updated)
    // 写完失效 cache，下次读到最新
    invalidateAgentMemoryCache()
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

    // Search agent memory for related mentions —— 2026-04-25 PERF · 走共享 cache
    // 用户每次选中文本都触发，cache 命中后 0 IPC 开销
    let cancelled = false
    fetchAgentMemory().then(({ success, content }) => {
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
      <span>学徒：你之前也关注过 — {hint}</span>
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
        学徒发现
      </div>
      <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.6 }}>{suggestion}</div>
    </div>
  )
}

// ===== Concept Tracker: detect cross-document concepts =====
function ConceptTracker({ currentEntryId, currentText, otherEntryAnnotations }: {
  currentEntryId?: string
  currentText?: string
  otherEntryAnnotations: Array<{ entryId: string; entryTitle: string; annotations: Annotation[] }>
}) {
  const [concepts, setConcepts] = useState<Array<{ keyword: string; entries: Array<{ title: string; count: number }> }>>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!currentText || currentText.length < 4 || otherEntryAnnotations.length < 2) {
      setConcepts([])
      return
    }

    // Extract academic concepts — filter out common words and sentence fragments
    // Strategy: look for noun phrases that appear as standalone terms
    const stopWords = new Set(['的','了','在','是','和','与','对','中','为','到','从','也','都','不','有','这','那','被','把','将','于','以','及','等','而','或','但','之','所','如','其','可','要','就','会','能','很','更','最','已','一','个','些','种','次','点','上','下','里','内','外','前','后','间','时','处','者','人','年','月','日','们'])

    const phrases: string[] = []
    // Match 2-6 char terms that look like concepts (contain no stop-word-only sequences)
    const candidates = currentText.match(/[\u4e00-\u9fff]{2,8}/g) || []
    for (const m of candidates) {
      // Skip if it's all stop words
      if ([...m].every(c => stopWords.has(c))) continue
      // Skip very generic phrases
      if (m.length <= 2 && stopWords.has(m[0])) continue
      // Skip if it starts/ends with a stop word particle (的/了/在/是)
      if ('的了在是和与'.includes(m[0]) || '的了在是'.includes(m[m.length - 1])) continue
      // Prefer longer, more specific terms
      if (!phrases.includes(m) && m.length >= 3) phrases.push(m)
    }
    if (phrases.length === 0) { setConcepts([]); return }

    // Check which phrases appear in 2+ other entries' annotations (stricter threshold)
    const found: Array<{ keyword: string; entries: Array<{ title: string; count: number }> }> = []
    for (const phrase of phrases.slice(0, 8)) {
      const matchedEntries: Array<{ title: string; count: number }> = []
      for (const other of otherEntryAnnotations) {
        if (other.entryId === currentEntryId) continue
        let count = 0
        for (const ann of other.annotations) {
          if (ann.anchor.selectedText.includes(phrase)) count++
          for (const h of ann.historyChain) {
            if (h.content.includes(phrase)) count++
          }
        }
        if (count >= 2) matchedEntries.push({ title: other.entryTitle, count })
      }
      // Require appearing in at least 1 other entry with 2+ mentions
      if (matchedEntries.length >= 1) {
        found.push({ keyword: phrase, entries: matchedEntries })
      }
    }
    // Sort by total cross-entry mentions (most relevant first)
    found.sort((a, b) => b.entries.reduce((s, e) => s + e.count, 0) - a.entries.reduce((s, e) => s + e.count, 0))
    setConcepts(found.slice(0, 5))
  }, [currentText, currentEntryId, otherEntryAnnotations])

  const visible = concepts.filter(c => !dismissed.has(c.keyword))
  if (visible.length === 0) return null

  return (
    <div style={{ margin: '4px 8px 8px', padding: '8px 12px', borderRadius: 8,
      background: 'var(--bg-warm)', border: '1px solid var(--border)', fontSize: 11 }}>
      <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 4, fontSize: 10 }}>
        📊 概念关联发现
      </div>
      {visible.slice(0, 3).map(c => (
        <div key={c.keyword} style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--text)' }}>「{c.keyword}」</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
              在 {c.entries.map(e => e.title.slice(0, 10)).join('、')} 中也出现
            </span>
          </div>
          <button onClick={() => setDismissed(prev => new Set([...prev, c.keyword]))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 10 }}>×</button>
        </div>
      ))}
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
    .replace(/^qwen3?\.?6?-?/, 'Qwen ')
    .replace(/-\d{8,}$/, '') // remove date suffixes like -20250414
}

// 2026-04-28 · 检测 AI 输出是否疑似被截断(LLM max_tokens / idle timeout / 主动 abort)
//   策略:看尾部 256 字符,触发条件之一即标 incomplete:
//   1) 以 markdown heading 开头但下面没正文(出现 "## 总结" 然后没了)
//   2) 结尾不是合理终止符号(中英标点 / 闭合符号 / 数字 / markdown 列表项),且字数 ≥ 100
//   3) 结尾是中英文连接词("和 / 但 / 而 / 因为 / and / but" 等),明显话没说完
//   误报成本低:多显示一个继续按钮;漏报成本高:用户以为输出完整结果产生错觉。
const TRAILING_CONJUNCTIONS = ['和', '但', '而', '因为', '所以', '如果', '虽然', '然而', '不过', '另外', '此外', 'and', 'but', 'or', 'because', 'so', 'however']
const VALID_ENDINGS = /[。！？.!?…」』"”’\)）\]】>]\s*$/
function detectIncomplete(text: string): boolean {
  if (!text || text.length < 100) return false  // 太短可能是用户主动停 / 简短回答
  const tail = text.slice(-256).trim()
  if (!tail) return false
  // 1) markdown heading 后无内容
  if (/^#{1,6}\s+\S+\s*$/m.test(tail.split(/\n/).slice(-2).join('\n')) === false) {
    // 检查最后一行是否为 heading 但其后无非空内容
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)
    const lastLine = lines[lines.length - 1] || ''
    if (/^#{1,6}\s+\S/.test(lastLine)) return true
    // 倒数第二行是 heading,最后一行是连接词或半句
    if (lines.length >= 2 && /^#{1,6}\s+\S/.test(lines[lines.length - 2])) {
      const last = lines[lines.length - 1]
      if (last.length < 30 && !VALID_ENDINGS.test(last)) return true
    }
  }
  // 2) 结尾不是合理终止符
  if (!VALID_ENDINGS.test(tail)) {
    // 3) 倒数 1-2 词是连接词
    const lastWord = tail.split(/[\s,，、]/).filter(Boolean).pop() || ''
    if (TRAILING_CONJUNCTIONS.includes(lastWord.toLowerCase())) return true
    // 结尾是无标点的纯文字 → 可能截断,但要排除"列表项 - 项目"这种合法收尾
    if (!/[\-\*\d]\s*[A-Za-z一-鿿]+\s*$/.test(tail)) return true
  }
  return false
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
    // 召唤名家以其视角批注——label 会被 HistoryEntryItem 覆盖成 personaName
    ai_persona: { label: '🧙', color: '#9b59b6', bgClass: 'ai-persona' },
  }
  return map[type] || map.note
}

// ===== Single history entry =====
// 2026-04-25 PERF · memo 包裹 —— 父组件传稳定 callback（handleEdit/handleDelete/handleCite
// 都是 useCallback），entry 引用在 historyChain 不变时稳定，所以 memo 能跳过未变化项
const HistoryEntryItem = React.memo(function HistoryEntryItem({
  entry,
  onEdit,
  onDelete,
  onCite,
  entryDocId,
  annotationId,
}: {
  entry: HistoryEntry
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
  onCite?: (entry: HistoryEntry) => void
  // Needed to look up the in-flight AI job in the global store.
  entryDocId?: string
  annotationId?: string
}) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(entry.content)

  // Subscribe to the global AI-job store by this entry's key. If a running
  // job exists, its streamingText takes precedence over entry.content
  // (persisted content is debounced-lagging by ~200ms behind the live chunks).
  const job = useAnnotationAiJobsStore(s =>
    entryDocId && annotationId ? s.jobs[jobKey(entryDocId, annotationId, entry.id)] : undefined
  )

  const effectiveStatus: HistoryEntry['aiStatus'] = job?.status ?? entry.aiStatus
  const effectiveContent = (job?.status === 'running' ? job.streamingText : '') || entry.content
  const isRunning = effectiveStatus === 'running'

  const display = getTypeDisplay(entry.type)
  const headerLabel = entry.author === 'user'
    ? '我'
    : entry.type === 'ai_persona'
      ? (entry.personaName || entry.modelLabel || '召唤')
      : (entry.modelLabel || 'AI')
  const headerColor = entry.author === 'user'
    ? 'var(--accent)'
    : entry.type === 'ai_persona'
      ? display.color
      : 'var(--success)'

  const handleSave = () => {
    onEdit(entry.id, editText)
    setEditing(false)
  }

  return (
    <div className={`history-entry ${display.bgClass}`}>
      <div className="history-entry-header">
        <span style={{ fontSize: 12.5, fontWeight: 500, color: headerColor, display: 'inline-flex', alignItems: 'center', gap: 8, letterSpacing: '0.2px' }}>
          {headerLabel}
          {/* AI job status chip: icon-in-circle + small label. Status chip
              uses 1px soft border + faint tinted bg — reads as a proper
              badge rather than a bare unicode symbol. */}
          {effectiveStatus === 'running' && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '2px 8px 2px 5px', borderRadius: 10,
              background: 'rgba(200,149,108,0.10)',
              border: '1px solid rgba(200,149,108,0.4)',
              color: 'var(--accent)', fontWeight: 500, fontSize: 10,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                style={{ animation: 'annList-spin 1.2s linear infinite', transformOrigin: 'center' }}>
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
              </svg>
              正在生成 · {(job?.streamingText.length || 0)} 字
            </span>
          )}
          {effectiveStatus === 'completed' && entry.author === 'ai' && (
            <span title="AI 已完成" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 7px 2px 4px', borderRadius: 10,
              background: 'rgba(139,177,116,0.12)',
              border: '1px solid rgba(139,177,116,0.4)',
              color: 'var(--success)', fontWeight: 500, fontSize: 10,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 12 10 18 20 6"/>
              </svg>
              已完成
            </span>
          )}
          {effectiveStatus === 'failed' && (
            <span title={entry.aiError || '失败'} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 7px 2px 4px', borderRadius: 10,
              background: 'rgba(201,112,112,0.12)',
              border: '1px solid rgba(201,112,112,0.4)',
              color: '#C97070', fontWeight: 500, fontSize: 10,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9.5"/><line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.5" fill="currentColor"/>
              </svg>
              失败
            </span>
          )}
          {effectiveStatus === 'aborted' && (
            <span title="已取消" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 7px 2px 4px', borderRadius: 10,
              background: 'rgba(212,168,75,0.12)',
              border: '1px solid rgba(212,168,75,0.4)',
              color: '#B48A3B', fontWeight: 500, fontSize: 10,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9.5"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/>
              </svg>
              已取消
            </span>
          )}
        </span>
        <div className="history-entry-actions">
          {/* 2026-04-28 · 日期紧凑化 '4月28日 15:33' → '04/28 15:33',窄面板防换行 */}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
            {(() => {
              const d = new Date(entry.createdAt)
              const m = String(d.getMonth() + 1).padStart(2, '0')
              const day = String(d.getDate()).padStart(2, '0')
              const h = String(d.getHours()).padStart(2, '0')
              const min = String(d.getMinutes()).padStart(2, '0')
              return `${m}/${day} ${h}:${min}`
            })()}
          </span>
          {!editing && !isRunning && (
            <>
              {onCite && <button className="btn btn-sm btn-icon" onClick={() => onCite(entry)} title="引用此块">引用</button>}
              <button className="btn btn-sm btn-icon" onClick={() => { setEditText(entry.content); setEditing(true) }}>编辑</button>
              <button className="btn btn-sm btn-icon" onClick={() => onDelete(entry.id)}>删除</button>
            </>
          )}
          {isRunning && entryDocId && annotationId && (
            <button
              className="btn btn-sm btn-icon"
              onClick={() => useAnnotationAiJobsStore.getState().abortJob(entryDocId, annotationId, entry.id)}
              title="中止"
              style={{ color: '#C97070' }}
            >停止</button>
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
        <div style={{ fontSize: 14, color: 'var(--accent)', marginBottom: 8, fontWeight: 600, lineHeight: 1.55 }}>
          问：{entry.userQuery}
        </div>
      )}
      {entry.type === 'ai_persona' && entry.userQuery && (
        <div style={{ fontSize: 13.5, color: 'var(--accent)', marginBottom: 8, fontWeight: 600, lineHeight: 1.55 }}>
          {entry.userQuery === '（无追问，纯批注）'
            ? `召唤：${entry.personaName || '名家'} 批注`
            : `追问 ${entry.personaName || '名家'}：${entry.userQuery}`}
        </div>
      )}
      {entry.linkedRef && (
        <div style={{ fontSize: 11, color: '#5B9BD5', marginBottom: 6, fontStyle: 'italic' }}>
          关联：「{entry.linkedRef.selectedText?.substring(0, 60)}...」
        </div>
      )}
      {editing ? (
        <div>
          {/* Inline-edit textarea — styled to blend with the surrounding
              history block rather than overlaying a dark boxed input: same
              bg (transparent to inherit the .ai-qa / .user-note tint), no
              chrome border, just a subtle accent outline while focused.
              minHeight mirrors a typical AI reply so edit feels like "typing
              over" the content instead of a popup. */}
          <textarea
            value={editText}
            onChange={e => setEditText(e.target.value)}
            autoFocus
            style={{
              width: '100%',
              minHeight: Math.max(120, Math.min(400, (editText.split('\n').length + 2) * 22)),
              padding: '4px 2px',
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'inherit',
              fontSize: 14,
              lineHeight: 1.7,
              fontFamily: 'var(--font)',
              resize: 'vertical',
              boxShadow: 'inset 0 0 0 1px rgba(200,149,108,0.25)',
              borderRadius: 4,
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>取消</button>
            <button className="btn btn-sm btn-primary" onClick={handleSave}>保存</button>
          </div>
        </div>
      ) : entry.author === 'ai' ? (
        <div className="annotation-markdown">
          {isRunning && !effectiveContent ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
              AI 正在思考...（首 token 返回前可能需要几秒）
            </div>
          ) : (
            <>
              <Markdown>{effectiveContent}</Markdown>
              {isRunning && <span className="streaming-cursor" />}
            </>
          )}
        </div>
      ) : (
        <div style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</div>
      )}
      {entry.editedAt && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>已编辑</div>
      )}
    </div>
  )
})

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
  const library = useLibraryStore(s => s.library)
  const addBlockToMemo = useLibraryStore(s => s.addBlockToMemo)
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

// Choose a label-formatter for PagedAnnotationList based on file format.
// EPUB: tocLabels[idx-1] when available (real chapter names from the book's
//       navigation), fallback to "第 N 章".
// Continuous (DOCX/HTML/TXT/MD): "第 N 段" since "page" is a virtual slice.
// PDF / OCR: default "第 N 页".
function makeLabelFor(absPath: string | undefined, tocLabels: string[] | null): ((p: number) => string) | undefined {
  if (!absPath) return undefined
  const ext = (absPath.split('.').pop() || '').toLowerCase()
  if (ext === 'epub') {
    return (p: number) => {
      const label = tocLabels?.[p - 1]
      return label ? label : `第 ${p} 章`
    }
  }
  if (['docx', 'doc', 'html', 'htm', 'txt', 'md'].includes(ext)) {
    return (p: number) => `第 ${p} 段`
  }
  return undefined
}

// Page-grouped annotation list: one collapsible section per page number.
// Only pages with annotations render a section; the section matching the
// current reader page opens by default, others collapse. User can toggle any.
//
// Why useState (not <details>): we need to programmatically re-open when the
// user scrolls to a different page, while leaving manually-toggled pages
// alone. A map of pageNumber → boolean gives that granularity.
function PagedAnnotationList({
  annotations,
  renderItem,
  autoOpenCurrent = true,
  labelFor,
}: {
  annotations: Annotation[]
  renderItem: (ann: Annotation) => React.ReactNode
  // When true (current doc), the page matching uiStore.currentVisiblePage
  // opens by default. When false (other doc, where "current page" has no
  // meaning), all pages start collapsed.
  autoOpenCurrent?: boolean
  // Label formatter for the group header. Defaults to "第 N 页". EPUB uses
  // "第 N 章"; other continuous formats can pass their own labeling scheme.
  labelFor?: (page: number) => string
}) {
  const formatLabel = labelFor || ((p: number) => `第 ${p} 页`)
  const storeCurrent = useUiStore(s => s.currentVisiblePage)
  const currentPage = autoOpenCurrent ? storeCurrent : -1

  // Bucket annotations by page number, keep pages sorted ascending.
  const pageMap = new Map<number, Annotation[]>()
  for (const a of annotations) {
    const p = a.anchor.pageNumber || 1
    if (!pageMap.has(p)) pageMap.set(p, [])
    pageMap.get(p)!.push(a)
  }
  const pages = [...pageMap.keys()].sort((a, b) => a - b)

  // open state: pageNumber → boolean. Defaults keep currentPage open; when
  // currentPage changes we open the new one without closing whatever the
  // user had already opened themselves.
  const [openPages, setOpenPages] = useState<Record<number, boolean>>({})
  useEffect(() => {
    setOpenPages(prev => {
      if (prev[currentPage]) return prev
      return { ...prev, [currentPage]: true }
    })
  }, [currentPage])

  return (
    <div>
      {pages.map(page => {
        const list = pageMap.get(page)!
        // The current reader page is open by default unless user toggled it shut.
        const isOpen = openPages[page] ?? (page === currentPage)
        const isCurrent = page === currentPage
        return (
          <div key={page} style={{ marginBottom: 6 }}>
            <button
              onClick={() => setOpenPages(prev => ({ ...prev, [page]: !isOpen }))}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', border: 'none',
                background: isCurrent ? 'rgba(200,149,108,0.10)' : 'transparent',
                borderLeft: isCurrent ? '2px solid var(--accent)' : '2px solid transparent',
                borderRadius: 4, cursor: 'pointer',
                fontSize: 12, fontWeight: 500, color: 'var(--text)',
                textAlign: 'left',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = isCurrent ? 'rgba(200,149,108,0.10)' : 'transparent')}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0, color: 'var(--text-muted)' }}>
                <polyline points="9 6 15 12 9 18"/>
              </svg>
              <span>{formatLabel(page)}</span>
              {isCurrent && (
                <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 400 }}>· 当前</span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
                {list.length} 条
              </span>
            </button>
            {isOpen && (
              <div style={{ marginTop: 4, marginLeft: 4 }}>
                {list.map(ann => <React.Fragment key={ann.id}>{renderItem(ann)}</React.Fragment>)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Three-level nesting for cross-document annotations:
//   文献名 (collapsed by default)
//     → 第 N 页 (PagedAnnotationList, all collapsed since "current page"
//                has no meaning for a doc the user isn't reading)
//         → individual annotation cards
// User has to explicitly expand the literature → page → see annotations,
// which keeps the "other annotations" section quiet by default.
function OtherEntryGroup({
  entryTitle,
  annotations,
  renderItem,
}: {
  entryId: string
  entryTitle: string
  annotations: Annotation[]
  renderItem: (ann: Annotation) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginBottom: 6 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', border: 'none',
          background: open ? 'rgba(200,149,108,0.06)' : 'transparent',
          borderRadius: 4, cursor: 'pointer',
          fontSize: 12, fontWeight: 600, color: 'var(--accent)',
          textAlign: 'left',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = open ? 'rgba(200,149,108,0.06)' : 'transparent')}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <polyline points="9 6 15 12 9 18"/>
        </svg>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, opacity: 0.75 }}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entryTitle}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
          {annotations.length} 条
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 4, marginLeft: 12 }}>
          <PagedAnnotationList
            annotations={annotations}
            renderItem={renderItem}
            autoOpenCurrent={false}
          />
        </div>
      )}
    </div>
  )
}

// ===== Main Panel =====
export default function AnnotationPanel() {
  // 2026-04-25 PERF · 选择性订阅
  const currentEntry = useLibraryStore(s => s.currentEntry)
  const currentPdfMeta = useLibraryStore(s => s.currentPdfMeta)
  const updatePdfMeta = useLibraryStore(s => s.updatePdfMeta)
  const library = useLibraryStore(s => s.library)
  const textSelection = useUiStore(s => s.textSelection)
  const activeAnnotationId = useUiStore(s => s.activeAnnotationId)
  const setTextSelection = useUiStore(s => s.setTextSelection)
  const setActiveAnnotation = useUiStore(s => s.setActiveAnnotation)
  // Subscribe to the full AI jobs map so list-item status badges re-render
  // when jobs transition. Cheap — jobs map rarely has more than a few entries.
  const aiJobs = useAnnotationAiJobsStore(s => s.jobs)
  // Flat TOC labels (EPUB only) — null for other formats. AnnotationPanel
  // uses these to title page groups with actual chapter names.
  const tocLabels = useUiStore(s => s.currentDocTocLabels)
  // BUG-FIX R8#8 · NaN 防御 + 最小宽度 80px 兜底,避免 panel 缩到 0 隐身
  const [panelWidth, _setPanelWidth] = useState(() => readNumber('sj-annPanelWidth', 380, 80))
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
      // Range expanded in v1.3.0: was 300-600. Lower bound 200 lets users
      // shrink the right panel hard so the reading column (OCR/TXT/MD/DOCX)
      // can stretch wide; upper bound 800 lets users park reference notes
      // in a roomy column when they have screen real estate.
      setPanelWidth(Math.max(200, Math.min(800, startWidth + delta)))
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
  // Annotation list search (filters both current and other-entries annotations)
  const [annSearch, setAnnSearch] = useState('')
  // 2026-04-28 · 苏格拉底模式彻底删除(用户决定下线,UI 按钮 batch 43 已删但
  //   state/system prompt 切换逻辑残留 → 老用户 localStorage 里 sj-socraticMode='true'
  //   会让 AI 反问而不是直接回答)。强制清 localStorage 防止幽灵复活。
  useEffect(() => { try { localStorage.removeItem('sj-socraticMode') } catch {} }, [])
  // 2026-04-25 PERF · 选择性订阅
  const aiModel = useUiStore(s => s.selectedAiModel)
  const setAiModel = useUiStore(s => s.setSelectedAiModel)
  const annotationColor = useUiStore(s => s.annotationColor)
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>>([])

  // Persona list for "召唤名家批注" entry — loaded alongside providers below.
  const [personaListAnno, setPersonaListAnno] = useState<Array<{ id: string; name: string; canonicalName?: string; currentFitnessTotal?: number }>>([])
  // Popover toggle for the 召唤 button — shows persona picker above the button.
  const [personaPopoverOpen, setPersonaPopoverOpen] = useState(false)
  // P0-2: popover 外层容器 ref — 用 document click 判断点击在容器外时关闭，替代仅靠再点按钮
  const summonPopoverRef = useRef<HTMLDivElement | null>(null)
  // P0-3: 召唤失败用 in-app toast 替代 alert()，5s 自消失
  // UX-R8#13 · P2-8 · 当错误是 API Key / 余额 / 模型 不存在类时,toast 多挂一个"去设置"按钮
  //   直接打开 Settings 面板。humanizeAiError 已经返回 ctaSettings 标志,只是之前没人用。
  const [summonErr, setSummonErr] = useState<{ message: string; ctaSettings?: boolean } | null>(null)
  useEffect(() => {
    if (!summonErr) return
    const t = setTimeout(() => setSummonErr(null), 5000)
    return () => clearTimeout(t)
  }, [summonErr])

  // Load configured AI providers + personas
  // 2026-04-25 PERF · aiGetConfigured 走共享 cache
  // Batch 43 · 订阅 cache 变化：用户改 Settings API key 后这里自动重 fetch
  // PERF-R8#11 · persona list 也走共享 cache + subscribe(导入/删除 persona 后自动刷新)
  useEffect(() => {
    let cancelled = false
    fetchAiConfig().then(r => { if (!cancelled) setConfiguredProviders(r) })
    const unsubAi = subscribeAiConfig(latest => {
      if (!cancelled) setConfiguredProviders(latest)
    })
    fetchPersonaList().then(r => { if (!cancelled) setPersonaListAnno(r) })
    const unsubPersona = subscribePersonaList(latest => {
      if (!cancelled) setPersonaListAnno(latest)
    })
    return () => { cancelled = true; unsubAi(); unsubPersona() }
  }, [])

  // P0-2: 点击 popover 外关闭 / Esc 关闭 — 只在 popover 打开时挂监听，卸载即自清
  useEffect(() => {
    if (!personaPopoverOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!summonPopoverRef.current) return
      if (!summonPopoverRef.current.contains(e.target as Node)) setPersonaPopoverOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPersonaPopoverOpen(false)
    }
    // 延迟一帧再挂，避免"打开时点击按钮"这一次事件冒泡到 document 立刻又关掉
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', onDocClick)
      document.addEventListener('keydown', onKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [personaPopoverOpen])
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
      const targets = library!.entries.filter(e => e.id !== currentEntry!.id)
      const results = await Promise.all(targets.map(async entry => {
        try {
          const meta = await window.electronAPI.loadPdfMeta(entry.id)
          if (meta?.annotations?.length) {
            return { entryId: entry.id, entryTitle: entry.title, annotations: meta.annotations }
          }
        } catch { /* skip */ }
        return null
      }))
      if (!cancelled) setOtherEntryAnnotations(results.filter((x): x is OtherEntryAnnotations => x !== null))
    }
    loadOthers()
    return () => { cancelled = true }
  }, [library?.entries.length, currentEntry?.id])

  // Jump to another entry's annotation
  const handleJumpToOtherAnnotation = useCallback(async (entryId: string, annotationId: string) => {
    await openEntryById(entryId, { annotationId })
  }, [])

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

  // When the user opens an annotation, mark any terminal-state AI entries
  // as viewed — this clears the list-item badge (✓ / !) so it doesn't nag
  // forever. Running entries are skipped so the live spinner still shows
  // in the list until the job completes.
  useEffect(() => {
    if (!displayAnnotation || !currentEntry) return
    const needsMark = displayAnnotation.historyChain.filter(h =>
      h.author === 'ai'
      && h.aiStatus
      && h.aiStatus !== 'running'
      && !h.aiViewed
    )
    if (needsMark.length === 0) return
    const ids = new Set(needsMark.map(h => h.id))
    const annId = displayAnnotation.id
    void updatePdfMeta(meta => ({
      ...meta,
      annotations: meta.annotations.map(a =>
        a.id === annId
          ? { ...a, historyChain: a.historyChain.map(h => ids.has(h.id) ? { ...h, aiViewed: true } : h) }
          : a
      ),
    }))
    // Also clear the in-memory job slot so the store doesn't resurrect it.
    for (const h of needsMark) {
      useAnnotationAiJobsStore.getState().markJobViewed(currentEntry.id, annId, h.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayAnnotation?.id, displayAnnotation?.historyChain.length, currentEntry?.id])

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
      // Gather annotation context to feed the AI. Two sources, different weights:
      //   1. Current document's other annotations (most relevant context)
      //   2. Other documents' annotations (cross-library — the prompt's #1 "open
      //      your mouth" condition is "echoes / contradictions with OTHER docs",
      //      so we MUST feed this; without it the AI can only find in-doc
      //      connections and cross-lib callouts become impossible).
      // Budget: ~20 items total (enough for Kimi/GLM 128k to digest, small
      // enough that the request stays snappy).
      const otherAnnotations: Array<{ text: string; note: string; entryTitle: string }> = []
      const currentTitle = currentEntry?.title || ''

      // 1) Current doc first — they're the most immediately relevant
      if (currentPdfMeta) {
        for (const ann of currentPdfMeta.annotations) {
          if (ann.id === annotationId) continue
          for (const h of ann.historyChain) {
            if (h.author === 'user' && otherAnnotations.length < 8) {
              otherAnnotations.push({
                text: ann.anchor.selectedText.substring(0, 100),
                note: h.content.substring(0, 200),
                entryTitle: currentTitle,
              })
            }
          }
        }
      }

      // 2) Other documents — recent first (by entry.lastOpenedAt), capped so we
      //    don't flood the IPC with dozens of meta reads on large libraries.
      //    Parallel fetch with Promise.all, then sort/dedupe.
      if (library && currentEntry) {
        const otherEntries = library.entries
          .filter(e => e.id !== currentEntry.id)
          .sort((a, b) => (b.lastOpenedAt || b.addedAt || '').localeCompare(a.lastOpenedAt || a.addedAt || ''))
          .slice(0, 12)  // only probe the 12 most recently-touched docs
        const metas = await Promise.all(
          otherEntries.map(e =>
            window.electronAPI.loadPdfMeta(e.id).then(m => ({ entry: e, meta: m })).catch(() => ({ entry: e, meta: null }))
          )
        )
        for (const { entry, meta } of metas) {
          if (!meta?.annotations) continue
          // Take up to 2 most-recent user annotations per other doc, newest-first
          const userHistByAnn: Array<{ ann: any; h: any; ts: string }> = []
          for (const ann of meta.annotations) {
            for (const h of ann.historyChain || []) {
              if (h.author === 'user') {
                userHistByAnn.push({ ann, h, ts: h.createdAt || ann.createdAt || '' })
              }
            }
          }
          userHistByAnn.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
          for (const x of userHistByAnn.slice(0, 2)) {
            if (otherAnnotations.length >= 20) break
            otherAnnotations.push({
              text: x.ann.anchor?.selectedText?.substring(0, 100) || '',
              note: x.h.content?.substring(0, 200) || '',
              entryTitle: entry.title,
            })
          }
          if (otherAnnotations.length >= 20) break
        }
      }

      // Get OCR context around the selection. The old behavior fed the first
      // 1000 chars of the OCR file, which was almost never the right window
      // — if the reader is on page 50, the AI was looking at page 1's preface.
      // Now we find the selection and take ±500 chars around it. Falls back
      // to the first 1000 if we can't find the selection (e.g. OCR text has
      // different whitespace than the PDF's text layer).
      let ocrContext = ''
      if (currentEntry?.absPath) {
        try {
          const ocr = await window.electronAPI.readOcrText(currentEntry.absPath)
          if (ocr.exists && ocr.text) {
            const full = normalizeMixedChineseToSimplified(ocr.text)
            const needle = normalizeMixedChineseToSimplified(selectedText).slice(0, 50).trim()  // short probe — OCR may differ subtly
            const idx = needle ? full.indexOf(needle) : -1
            if (idx >= 0) {
              const s = Math.max(0, idx - 500)
              const e = Math.min(full.length, idx + needle.length + 500)
              ocrContext = (s > 0 ? '...' : '') + full.slice(s, e) + (e < full.length ? '...' : '')
            } else {
              ocrContext = full.substring(0, 1000)  // fallback
            }
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
  }, [currentEntry, currentPdfMeta, library])

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

    // Batch 43 · AI 即时反馈暂时禁用——prompt 把 OCR 文本（作者写的）当成用户笔记。
    // feedHermes 保留（学徒后台累积事件，prompt 准确）。
    // 未来恢复时取消注释下行。
    // triggerFeedback(savedNote, targetAnnotationId, savedText)

    // Ghost Reader: async cross-doc analysis (non-blocking)
    ;(async () => {
      try {
        // Search other documents' annotations for related content
        if (!window.electronAPI?.agentExecuteTool) return
        const result = await window.electronAPI.agentExecuteTool('build_knowledge_map', '{}')
        if (!result?.success || !result.result) return
        const data = JSON.parse(result.result)
        if (!data.annotationSummary || data.totalAnnotations < 3) return

        // Ask AI to find cross-doc connections (quick, focused prompt)
        const { selectedAiModel } = useUiStore.getState()
        const streamId = uuid()
        let fullText = ''
        const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => { if (sid === streamId) fullText += chunk })
        try {
          await window.electronAPI.aiChatStream(streamId, selectedAiModel, [
            { role: 'system', content: '你是学徒——一位在用户背后默默跟读的幽灵读者。用户刚刚在一篇文献上做了注释，你需要在1-2句话内指出一个有价值的跨文献关联。如果没有发现关联，只回复"无"。不要客套，直接说发现。' },
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

    // Batch 43: 失败时把 raw error 转译；并在 toast 里也提示用户
    let entryContent: string
    if (result.success) {
      entryContent = result.text!
    } else {
      const h = humanizeAiError(result.error)
      entryContent = `错误：${h.message}${h.hint ? `（${h.hint}）` : ''}`
      if (!h.silent) {
        setSummonErr({
          message: h.hint ? `${h.message}（${h.hint}）` : h.message,
          ctaSettings: h.ctaSettings,
        })
      }
    }

    const entry: HistoryEntry = {
      id: uuid(),
      type: 'ai_interpretation',
      content: entryContent,
      contextSent: interpretText,
      author: 'ai',
      createdAt: new Date().toISOString(),
      ...(newContextText ? { contextText: newContextText } : {}),
      ...(result.success && detectIncomplete(entryContent) ? { incomplete: true } : {}),
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

    // === Hermes 融合: 注入跨文献记忆和关联注释 ===
    let hermesContext = ''
    try {
      // Load Hermes memory (accumulated reading behavior insights) —— 走 cache
      const memResult = await fetchAgentMemory()
      const memory = memResult?.content || ''
      if (memory.length > 20) {
        hermesContext += `\n\n[学徒记忆 — 用户的阅读偏好和历史洞察]\n${memory.slice(-800)}`
      }

      // Gather related annotations from other documents
      const relatedAnns: string[] = []
      for (const other of otherEntryAnnotations.slice(0, 5)) {
        for (const ann of other.annotations) {
          // Check if this annotation's text has any overlap with current context
          const overlap = anchorText.split('').filter(c => ann.anchor.selectedText.includes(c) && /[\u4e00-\u9fff]/.test(c)).length
          if (overlap >= 4) {
            const userNotes = ann.historyChain.filter(h => h.author === 'user').map(h => h.content).join('; ')
            relatedAnns.push(`《${other.entryTitle}》: 「${ann.anchor.selectedText.slice(0, 50)}」${userNotes ? ` — 用户笔记: ${userNotes.slice(0, 80)}` : ''}`)
          }
        }
      }
      if (relatedAnns.length > 0) {
        hermesContext += `\n\n[跨文献关联 — 用户在其他文献中对相似内容的标注]\n${relatedAnns.slice(0, 5).join('\n')}`
      }
    } catch {}

    // 2026-04-28 · 苏格拉底分支已删,固定走"直接回答"路径
    let systemContent = `你是拾卷的学徒——一位陪读的学术研究伙伴。你非常熟悉文献「${docTitle}」，并且了解用户在整个文献库中的阅读历史和笔记。请基于文献上下文和跨文献关联回答用户的问题。如果发现用户的问题与其他文献的内容有关联，主动指出。\n\n用户选中的文本：\n「${contextForAi}」`
    if (surroundingContext) {
      systemContent += `\n\n选中文本的前后上下文（来自同一篇文献）：\n${surroundingContext}`
    }
    if (hermesContext) {
      systemContent += hermesContext
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

    // === Build placeholder entry and persist BEFORE starting AI stream ===
    // User can now navigate away; the entry stays in the annotation's
    // historyChain with aiStatus='running' and updates as chunks arrive.
    const historyEntryId = uuid()
    const placeholder: HistoryEntry = {
      id: historyEntryId,
      type: 'ai_qa',
      content: '',
      userQuery: text.trim(),
      author: 'ai',
      modelLabel: getModelLabel(aiModel),
      createdAt: new Date().toISOString(),
      aiStatus: 'running',
      ...(newContextText ? { contextText: newContextText } : {}),
    }

    const existingAnn = displayAnnotation || (textSelection
      ? currentPdfMeta?.annotations.find(a => a.anchor.selectedText === textSelection.text)
      : null)

    const currentEntryId = useLibraryStore.getState().currentEntry?.id
    if (!currentEntryId) { setAiLoading(false); return }

    let targetAnnotationId: string
    if (existingAnn) {
      targetAnnotationId = existingAnn.id
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: meta.annotations.map(a =>
          a.id === existingAnn.id
            ? { ...a, historyChain: [...a.historyChain, placeholder], updatedAt: new Date().toISOString() }
            : a
        ),
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
        historyChain: [placeholder],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      targetAnnotationId = newAnnotation.id
      await updatePdfMeta(meta => ({
        ...meta,
        annotations: [...meta.annotations, newAnnotation],
      }))
      setActiveAnnotation(newAnnotation.id)
    } else {
      setAiLoading(false)
      return
    }

    // Clear input immediately + release the submit button. The AI job runs
    // in the background via the store; the placeholder entry shows the
    // spinner + streaming text, and the annotation list gains a running
    // badge. User can navigate wherever they want.
    setNoteInput('')
    setAiLoading(false)
    setStreamingText('')

    // Feed to Hermes now (not waiting for completion — the submission
    // itself is the Hermes-observable event).
    const entryTitle = useLibraryStore.getState().currentEntry?.title || '未知文献'
    feedHermes(`在「${entryTitle}」中向AI提问：${text.trim().slice(0, 50)}`)

    // Launch the background job. The store writes chunks back into the
    // placeholder entry via updatePdfMetaByEntryId (works even if user
    // switches to a different literature).
    const updateStore = useLibraryStore.getState()
    useAnnotationAiJobsStore.getState().startJob({
      entryId: currentEntryId,
      annotationId: targetAnnotationId,
      historyEntryId,
      model: aiModel,
      modelLabel: getModelLabel(aiModel),
      messages,
      updater: async (eid, aid, hid, patch) => {
        await updateStore.updatePdfMetaByEntryId(eid, (meta) => ({
          ...meta,
          annotations: meta.annotations.map(a =>
            a.id === aid
              ? {
                  ...a,
                  historyChain: a.historyChain.map(h =>
                    h.id === hid ? { ...h, ...patch } : h
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : a
          ),
        }))
      },
    })
  }, [displayAnnotation, textSelection, newContextText, aiModel, activeAnnotationId, currentPdfMeta, updatePdfMeta, setActiveAnnotation])

  // Convenience wrapper
  const handleAskQuestion = useCallback(() => {
    handleAskQuestionWithText(noteInput)
  }, [noteInput, handleAskQuestionWithText])

  // Summon-mode annotate — call a distilled persona's skill as system prompt
  // and ask it to annotate the currently selected text. Result becomes an
  // 'ai_persona' history entry on the annotation.
  //
  // Differs from handleAskQuestionWithText: no Hermes context injection, no
  // cross-document linking, no ReAct. Plain chat with persona as narrator.
  // This is the "让名家在这段文字旁批注" affordance.
  const handleSummonAnnotate = useCallback(async (personaId: string, personaName: string) => {
    // P0-3: 用 in-app toast 替代 alert()，保持暖金美学
    if (!displayAnnotation && !textSelection) { setSummonErr({ message: '请先选中一段文字再召唤' }); return }
    const anchorText = displayAnnotation?.anchor.selectedText || textSelection?.text || ''
    if (!anchorText.trim()) return
    const currentEntryId = useLibraryStore.getState().currentEntry?.id
    if (!currentEntryId) {
      setSummonErr({ message: '当前没有打开的文献，无法保存召唤批注' })
      return
    }
    setAiLoading(true)
    setStreamingText('')
    try {
      // RAG seed: build the query from the user's note (if any) plus the
      // anchor text, so BM25 can pull the persona's most relevant original
      // passages for this specific annotation. Cap the anchor to avoid
      // flooding the query vocabulary.
      const ragQuery = [noteInput.trim(), anchorText.slice(0, 400)].filter(Boolean).join(' \n ')
      const sysRes = await window.electronAPI.personaGetSystemPrompt?.(personaId, ragQuery)
      if (!sysRes?.success || !sysRes.systemPrompt) throw new Error(sysRes?.error || '无法加载 skill')
      const userQ = noteInput.trim()
        ? `请以你的视角批注下面这段文字，并回应用户的问题。\n\n【选中文字】\n${anchorText}\n\n【用户追问】\n${noteInput.trim()}`
        : `请以你的视角批注下面这段文字——你会注意什么、挑剔什么、反问什么？\n\n【选中文字】\n${anchorText}`

      const historyEntryId = uuid()
      const entry: HistoryEntry = {
        id: historyEntryId,
        type: 'ai_persona',
        content: '',
        userQuery: noteInput.trim() || '（无追问，纯批注）',
        author: 'ai',
        modelLabel: getModelLabel(aiModel),
        personaId,
        personaName,
        createdAt: new Date().toISOString(),
        aiStatus: 'running',
      }

      // Attach entry to the active/selected annotation, creating one if the
      // user only had a textSelection without a persisted annotation yet.
      const existingAnn = displayAnnotation || (textSelection
        ? currentPdfMeta?.annotations.find(a => a.anchor.selectedText === textSelection.text)
        : null)
      if (existingAnn) {
        const targetAnnotationId = existingAnn.id
        await updatePdfMeta(meta => ({
          ...meta,
          annotations: meta.annotations.map(a =>
            a.id === existingAnn.id
              ? { ...a, historyChain: [...a.historyChain, entry], updatedAt: new Date().toISOString() }
              : a
          )
        }))
        if (!activeAnnotationId) setActiveAnnotation(existingAnn.id)
        setNoteInput('')
        setAiLoading(false)
        const updateStore = useLibraryStore.getState()
        void useAnnotationAiJobsStore.getState().startJob({
          entryId: currentEntryId,
          annotationId: targetAnnotationId,
          historyEntryId,
          model: aiModel,
          modelLabel: getModelLabel(aiModel),
          messages: [
            { role: 'system', content: sysRes.systemPrompt },
            { role: 'user', content: userQ },
          ],
          updater: async (eid, aid, hid, patch) => {
            await updateStore.updatePdfMetaByEntryId(eid, (meta) => ({
              ...meta,
              annotations: meta.annotations.map(a =>
                a.id === aid
                  ? {
                      ...a,
                      historyChain: a.historyChain.map(h =>
                        h.id === hid ? { ...h, ...patch } : h
                      ),
                      updatedAt: new Date().toISOString(),
                    }
                  : a
              ),
            }))
          },
        })
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
        setNoteInput('')
        setAiLoading(false)
        const updateStore = useLibraryStore.getState()
        void useAnnotationAiJobsStore.getState().startJob({
          entryId: currentEntryId,
          annotationId: newAnnotation.id,
          historyEntryId,
          model: aiModel,
          modelLabel: getModelLabel(aiModel),
          messages: [
            { role: 'system', content: sysRes.systemPrompt },
            { role: 'user', content: userQ },
          ],
          updater: async (eid, aid, hid, patch) => {
            await updateStore.updatePdfMetaByEntryId(eid, (meta) => ({
              ...meta,
              annotations: meta.annotations.map(a =>
                a.id === aid
                  ? {
                      ...a,
                      historyChain: a.historyChain.map(h =>
                        h.id === hid ? { ...h, ...patch } : h
                      ),
                      updatedAt: new Date().toISOString(),
                    }
                  : a
              ),
            }))
          },
        })
      }
    } catch (err: any) {
      // P0-3: 用 in-app toast 替代 alert()
      // Batch 43: humanizeAiError 把 raw 后端字符串转成中文
      const h = humanizeAiError(err)
      if (!h.silent) {
        setSummonErr({
          message: h.hint ? `召唤批注失败：${h.message}（${h.hint}）` : `召唤批注失败：${h.message}`,
          ctaSettings: h.ctaSettings,
        })
      }
    } finally {
      setAiLoading(false)
    }
  }, [displayAnnotation, textSelection, noteInput, aiModel, currentPdfMeta, activeAnnotationId, updatePdfMeta, setActiveAnnotation])

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

  const toggleAnnotationPanel = useUiStore(s => s.toggleAnnotationPanel)
  const clearAnnotationFocus = useUiStore(s => s.clearAnnotationFocus)

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

  // 2026-04-25 PERF · onCite 用 useCallback 稳定，让 HistoryEntryItem 的 props
  // 引用稳定（之前 inline arrow 每次 render 新引用，memo 失效）
  const handleCite = useCallback((he: HistoryEntry) => {
    if (displayAnnotation) setCitingEntry({ historyEntry: he, annotation: displayAnnotation })
  }, [displayAnnotation])

  // ===== Annotation list helper =====
  const renderAnnotationItem = (ann: Annotation, onClick: () => void, sourceLabel?: string, entryId?: string, entryTitle?: string) => {
    const lastEntry = ann.historyChain[ann.historyChain.length - 1]
    const display = lastEntry ? getTypeDisplay(lastEntry.type) : null
    // Aggregate AI-job status for this annotation: any running job wins;
    // else show failed (unviewed); else completed (unviewed); else nothing.
    // Runtime store status takes precedence over persisted entry.aiStatus
    // (store may be slightly ahead of the debounced disk write).
    const docIdForBadge = entryId || currentEntry?.id
    let badgeState: 'running' | 'completed' | 'failed' | null = null
    if (docIdForBadge) {
      for (const h of ann.historyChain) {
        if (h.author !== 'ai') continue
        const k = jobKey(docIdForBadge, ann.id, h.id)
        const st = aiJobs[k]?.status ?? h.aiStatus
        if (st === 'running') { badgeState = 'running'; break }
      }
      if (!badgeState) {
        for (const h of ann.historyChain) {
          if (h.author !== 'ai') continue
          const st = h.aiStatus
          if (st === 'failed' && !h.aiViewed) { badgeState = 'failed'; break }
          if (st === 'completed' && !h.aiViewed && badgeState !== 'failed') badgeState = 'completed'
        }
      }
    }
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
          <div style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 28, display: 'flex', alignItems: 'center', gap: 7 }}>
            {badgeState === 'running' && (
              <span title="AI 正在生成回答" style={{
                flexShrink: 0, width: 14, height: 14, borderRadius: '50%',
                background: 'rgba(200,149,108,0.14)', border: '1px solid rgba(200,149,108,0.5)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                animation: 'annList-running-pulse 1.8s ease-in-out infinite',
              }}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--accent)"
                  strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                  style={{ animation: 'annList-spin 1.2s linear infinite', transformOrigin: 'center' }}>
                  <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
              </span>
            )}
            {badgeState === 'completed' && (
              <span title="AI 已完成（点击查看后隐藏）" style={{
                flexShrink: 0, width: 14, height: 14, borderRadius: '50%',
                background: 'rgba(139,177,116,0.14)', border: '1px solid rgba(139,177,116,0.5)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--success)"
                  strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 12 10 18 20 6"/>
                </svg>
              </span>
            )}
            {badgeState === 'failed' && (
              <span title="AI 回答失败（点击查看后隐藏）" style={{
                flexShrink: 0, width: 14, height: 14, borderRadius: '50%',
                background: 'rgba(201,112,112,0.14)', border: '1px solid rgba(201,112,112,0.5)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="#C97070"
                  strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/>
                </svg>
              </span>
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              「{ann.anchor.selectedText.substring(0, 40)}{ann.anchor.selectedText.length > 40 ? '...' : ''}」
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            p.{ann.anchor.pageNumber} · {ann.historyChain.length} 条记录
          </div>
        </div>
        <style>{`
          @keyframes annList-running-pulse {
            0%   { box-shadow: 0 0 0 0 rgba(200,149,108,0.35); }
            70%  { box-shadow: 0 0 0 4px rgba(200,149,108,0); }
            100% { box-shadow: 0 0 0 0 rgba(200,149,108,0); }
          }
          @keyframes annList-spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
        `}</style>
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

  // 2026-04-25 PERF · totalOtherAnnotations useMemo
  const totalOtherAnnotations = useMemo(
    () => otherEntryAnnotations.reduce((sum, e) => sum + e.annotations.length, 0),
    [otherEntryAnnotations],
  )

  // ===== Search filtering (match selectedText + history chain contents) =====
  // 2026-04-25 PERF · 用 useMemo 缓存 filter 结果，避免每次 render 都重新扫描
  // annotations 数组（用户长期使用后注释可达数百条，每次 streaming chunk 触发
  // 父组件 re-render 都会重做 O(n × historyChain) 扫描）
  const q = annSearch.trim()
  const { filteredCurrentAnns, filteredOtherAnns, filteredOtherTotal } = useMemo(() => {
    const annMatches = (ann: Annotation): boolean => {
      if (!q) return true
      const needle = q.toLowerCase()
      if ((ann.anchor?.selectedText || '').toLowerCase().includes(needle)) return true
      for (const h of ann.historyChain || []) {
        if ((h.content || '').toLowerCase().includes(needle)) return true
      }
      return false
    }
    const fc = q && currentPdfMeta
      ? currentPdfMeta.annotations.filter(annMatches)
      : (currentPdfMeta?.annotations || [])
    const fo = q
      ? otherEntryAnnotations
          .map(e => ({ ...e, annotations: e.annotations.filter(annMatches) }))
          .filter(e => e.annotations.length > 0)
      : otherEntryAnnotations
    const fot = fo.reduce((sum, e) => sum + e.annotations.length, 0)
    return { filteredCurrentAnns: fc, filteredOtherAnns: fo, filteredOtherTotal: fot }
  }, [q, currentPdfMeta?.annotations, otherEntryAnnotations])

  // ===== Empty state (all annotations list) =====
  if (!textSelection && !activeAnnotationId) {
    const hasCurrentAnnotations = currentPdfMeta && currentPdfMeta.annotations.length > 0
    const hasAny = hasCurrentAnnotations || totalOtherAnnotations > 0

    return (
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div onMouseDown={handleResizeStart} style={{ width: 6, cursor: 'col-resize', background: 'var(--border-light)', flexShrink: 0, transition: 'background 0.15s' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent)')} onMouseLeave={e => (e.currentTarget.style.background = 'var(--border-light)')} />
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
          <>
            {/* Search bar (only show when >= 5 annotations exist — avoids clutter for light users) */}
            {(currentPdfMeta!.annotations.length + totalOtherAnnotations) >= 5 && (
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border-light)' }}>
                {/* 2026-04-25 PERF · IME-aware，避免拼音中间态触发 useMemo filter */}
                <ImeInput
                  value={annSearch}
                  onChange={setAnnSearch}
                  placeholder="搜索注释内容..."
                  style={{
                    width: '100%', padding: '5px 9px', border: '1px solid var(--border)',
                    borderRadius: 4, fontSize: 11, outline: 'none',
                    background: 'var(--bg-warm)', color: 'var(--text)',
                  }}
                />
              </div>
            )}
            <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
              {/* Current entry's annotations — grouped by page number. Only
                  pages with at least one annotation render a group. The page
                  matching uiStore.currentVisiblePage opens by default; all
                  others collapse. User can click any header to toggle. */}
              {filteredCurrentAnns.length > 0 && (
                <>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '4px 4px 10px', fontWeight: 500 }}>
                    本文献的注释 ({q ? `${filteredCurrentAnns.length}/${currentPdfMeta!.annotations.length}` : currentPdfMeta!.annotations.length})
                  </div>
                  <PagedAnnotationList
                    annotations={filteredCurrentAnns}
                    renderItem={ann => renderAnnotationItem(ann, () => setActiveAnnotation(ann.id))}
                    labelFor={makeLabelFor(currentEntry?.absPath, tocLabels)}
                  />
                </>
              )}

              {/* Divider + Other entries' annotations */}
              {filteredOtherTotal > 0 && (
                <>
                  <div style={{
                    margin: '16px 0 12px', padding: '10px 0 0',
                    borderTop: '2px solid var(--border-light)',
                    fontSize: 11, color: 'var(--text-muted)', fontWeight: 500,
                  }}>
                    其他文献的注释 ({q ? `${filteredOtherTotal}/${totalOtherAnnotations}` : totalOtherAnnotations})
                  </div>
                  {filteredOtherAnns.map(other => (
                    <OtherEntryGroup
                      key={other.entryId}
                      entryId={other.entryId}
                      entryTitle={other.entryTitle}
                      annotations={other.annotations}
                      renderItem={(ann) => renderAnnotationItem(
                        ann,
                        () => handleJumpToOtherAnnotation(other.entryId, ann.id),
                        other.entryTitle,
                        other.entryId,
                        other.entryTitle,
                      )}
                    />
                  ))}
                </>
              )}

              {q && filteredCurrentAnns.length === 0 && filteredOtherTotal === 0 && (
                <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                  没有匹配「{q}」的注释
                </div>
              )}
            </div>
          </>
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
      <div onMouseDown={handleResizeStart} style={{ width: 6, cursor: 'col-resize', background: 'var(--border-light)', flexShrink: 0, transition: 'background 0.15s' }} onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent)')} onMouseLeave={e => (e.currentTarget.style.background = 'var(--border-light)')} />
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
            onCite={displayAnnotation ? handleCite : undefined}
            entryDocId={currentEntry?.id}
            annotationId={displayAnnotation?.id}
          />
        ))}
        {/* Note: per-entry AI streaming lives INSIDE the entry block now
            (via store subscription). The legacy "floating AI streaming
            indicator" at the bottom of the chain was removed to avoid the
            "ghost indicator after navigating away" bug. */}
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

      {/* AI Instant Feedback bubble · Batch 43 暂时隐藏
          原因：prompt 把 OCR 文本（文献作者写的）误识别为用户笔记，
          反馈"《X》里你写过 Y" 但实际 Y 是文献作者的话。
          学徒洞察（Hermes 后台学习）保留——它读 hermesEventQueue 累积事件，
          不会做"这是用户写的"误判。
          代码保留（FeedbackBubble 组件 / triggerFeedback / glmInstantFeedback IPC）
          以便未来 prompt 修好后恢复。 */}
      {false && (
        <FeedbackBubble
          text={feedbackText}
          loading={feedbackLoading}
          onKeep={handleKeepFeedback}
          onDismiss={() => { setFeedbackText(null); setFeedbackLoading(false) }}
          onExpand={(fbText) => {
            setNoteInput(`关于「${fbText.substring(0, 30)}...」，`)
            setFeedbackText(null)
            setFeedbackLoading(false)
          }}
        />
      )}

      {/* Ghost Reader suggestion */}
      <GhostReaderCard suggestion={ghostSuggestion} onDismiss={() => setGhostSuggestion(null)} />

      {/* Concept tracker — detect cross-document concepts */}
      <ConceptTracker
        currentEntryId={currentEntry?.id}
        currentText={displayAnnotation?.anchor.selectedText || textSelection?.text}
        otherEntryAnnotations={otherEntryAnnotations}
      />

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
            {/* 2026-04-28 · 苏格拉底模式彻底下线(state + 分支 + localStorage 全清)。
                如果将来想做"苏格拉底式辅导"重新作为召唤 skill 蒸馏即可。 */}
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
              style={{ fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {aiLoading ? '...' : '发送 AI'}
            </button>
            {/* 召唤名家在批注旁留言——2026-04 放开。
                点按钮 → 弹出 persona popover → 选一位 → handleSummonAnnotate。
                personaListAnno 为空时 title 提示先去 Agent 面板导入 skill。 */}
            {/* P0-2: ref 挂在外层容器，document mousedown 判定容器外时关闭 popover */}
            <div ref={summonPopoverRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className="btn btn-sm"
                // P1-8: 空态不再 disabled —— click 打开空态 popover 引导用户去导入
                disabled={aiLoading}
                onClick={() => setPersonaPopoverOpen(v => !v)}
                title={personaListAnno.length === 0
                  ? '还没导入思想家，点击查看'
                  : '召唤一位思想家以其视角对该段落作批注'}
                style={{
                  fontSize: 12, padding: '6px 10px',
                  opacity: personaListAnno.length === 0 ? 0.7 : 1,
                  cursor: aiLoading ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  whiteSpace: 'nowrap', flexShrink: 0,
                  // P1-1: 启用时图标用 accent 色（暖金星星），跟 AgentPanel 召唤 tab 视觉一致
                  color: personaListAnno.length === 0 ? 'var(--text-muted)' : 'var(--accent-hover)',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.55L12 14.77 7.06 17.45 8 11.9 4 8l5.61-1.16L12 2z"/>
                </svg>
                召唤
              </button>
              {personaPopoverOpen && (
                <div style={{
                  position: 'absolute', bottom: '100%', right: 0, marginBottom: 8,
                  background: 'var(--bg, #FFFDF7)', border: '1px solid var(--border, #E8E0D0)',
                  borderRadius: 8, boxShadow: '0 10px 28px rgba(58,47,31,0.14), 0 2px 6px rgba(58,47,31,0.06)',
                  minWidth: 216, maxHeight: 260, overflowY: 'auto', zIndex: 100,
                  padding: '6px 0',
                  // P1-7: 淡入动画，消除"瞬间出现"的突兀感；复用 AgentPanel 的 sj-pop-in 关键帧
                  animation: 'sj-pop-in 0.16s cubic-bezier(.2,.9,.3,1.2)',
                }}>
                  {personaListAnno.length > 0 ? (
                    <>
                      <div style={{ fontSize: 10, letterSpacing: '1.6px', color: 'var(--text-secondary)', padding: '10px 14px 6px', fontWeight: 500 }}>选择你要召唤的人物</div>
                      {personaListAnno.map(p => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setPersonaPopoverOpen(false)
                            void handleSummonAnnotate(p.id, p.canonicalName || p.name)
                          }}
                          style={{
                            display: 'block', width: '94%', textAlign: 'left',
                            margin: '0 auto', padding: '9px 12px', fontSize: 13, background: 'transparent',
                            border: 'none', cursor: 'pointer', color: 'var(--text)',
                            borderRadius: 5, transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm, #FBF8F1)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        >
                          {p.canonicalName || p.name}
                        </button>
                      ))}
                    </>
                  ) : (
                    /* P1-8 / P2-9 · 空态引导：说明状况 + 一键跳到 Agent 面板召唤 tab */
                    <div style={{ padding: '14px 16px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
                        还没导入思想家 skill。<br />
                        去 <span style={{ color: 'var(--accent-hover)' }}>召唤社区</span> 挑一位，或导入自己蒸馏的 skill。
                      </div>
                      <button
                        onClick={() => {
                          setPersonaPopoverOpen(false)
                          useUiStore.getState().setRightPanel('agent')
                          // Signal AgentPanel to open personas tab on mount
                          try { localStorage.setItem('sj-agent-tab-pending', 'personas') } catch {}
                        }}
                        style={{
                          width: '100%', padding: '8px 12px', fontSize: 12, fontWeight: 500,
                          border: 'none', borderRadius: 5, cursor: 'pointer',
                          background: 'var(--accent)', color: '#fff',
                          transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                        }}
                      >
                        去 Agent 面板 · 召唤
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <button className="btn btn-sm btn-primary" onClick={handleAddNote} disabled={!noteInput.trim() || (!displayAnnotation && !textSelection)}
            title="保存笔记（Ctrl+Enter）"
            style={{ fontSize: 12, padding: '6px 14px', whiteSpace: 'nowrap', flexShrink: 0 }}>
            保存笔记
          </button>
        </div>
      </div>
    </div>
    {/* P0-3: 召唤批注错误 toast — 取代 alert()。用 fixed 定位避免依赖祖先 position：relative;
         底部居中漂浮，5s 自消失，点击立即关闭。
         UX-R8#13 · ctaSettings=true 时多挂"去设置"按钮直接打开 Settings 面板,
         按钮区独立 click handler,不会触发外层关闭。 */}
    {summonErr && (
      <div
        onClick={() => setSummonErr(null)}
        style={{
          position: 'fixed', left: '50%', bottom: 32, zIndex: 9999,
          transform: 'translateX(-50%)',
          padding: '10px 18px', borderRadius: 6,
          background: 'rgba(181,90,79,0.96)', color: '#fff',
          fontSize: 12.5, lineHeight: 1.5, maxWidth: 420,
          boxShadow: '0 6px 22px rgba(60,40,20,0.28)',
          cursor: 'pointer',
          animation: 'sj-anno-toast-in 0.18s cubic-bezier(.2,.9,.3,1.2)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}
        title="点击关闭"
      >
        <span style={{ flex: 1 }}>{summonErr.message}</span>
        {summonErr.ctaSettings && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              useUiStore.getState().setShowSettings(true)
              setSummonErr(null)
            }}
            style={{
              flexShrink: 0,
              fontSize: 11.5,
              padding: '4px 10px',
              background: 'rgba(255,255,255,0.18)',
              border: '1px solid rgba(255,255,255,0.45)',
              borderRadius: 4,
              color: '#fff',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              fontWeight: 500,
            }}
          >去设置</button>
        )}
      </div>
    )}
    {/* P1-7 / P0-3: 局部关键帧供 popover 淡入 + toast 弹入使用 */}
    <style>{`
      @keyframes sj-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
      @keyframes sj-anno-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    `}</style>
    </div>
  )
}
