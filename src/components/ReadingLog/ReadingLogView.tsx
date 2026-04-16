import { useState, useEffect } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { ReadingLogEvent, ReadingLog } from '../../types/library'
import ReadingLogList from './ReadingLogList'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function formatDateFull(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

const EVENT_COLORS: Record<ReadingLogEvent['type'], string> = {
  open_doc: '#5B8DEF',
  annotate: '#C8956C',
  note: '#A0845C',
  question: '#D4A84B',
  stance: '#B8844E',
  ai_interaction: '#6BA87B',
  memo_create: '#9B7EC8',
  memo_edit: '#B09AD8',
  mark_text: '#B5A992',
}

const EVENT_ICONS: Record<ReadingLogEvent['type'], string> = {
  open_doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
  annotate: 'M12 20h9 M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
  question: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3 M12 17h.01',
  stance: 'M22 11.08V12a10 10 0 1 1-5.93-9.14',
  ai_interaction: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  memo_create: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
  memo_edit: 'M12 20h9 M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  mark_text: 'M4 7V4h16v3 M9 20h6 M12 4v16',
}

// ===== Learning Profile: reading overview with annotation heatmap =====
function LearningProfile() {
  const { library } = useLibraryStore()
  const [profileData, setProfileData] = useState<Array<{
    id: string; title: string; annCount: number; noteCount: number; lastOpened: string
  }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!library) return
    let cancelled = false
    setLoading(true)

    async function loadProfile() {
      const data: typeof profileData = []
      // Process in batches of 10 to avoid IPC flooding
      const entries = library!.entries
      for (let i = 0; i < entries.length; i += 10) {
        if (cancelled) return
        const batch = entries.slice(i, i + 10)
        const results = await Promise.all(batch.map(async (entry) => {
          try {
            const meta = await window.electronAPI.loadPdfMeta(entry.id)
            return {
              id: entry.id, title: entry.title,
              annCount: meta?.annotations?.length || 0,
              noteCount: meta?.annotations?.reduce((sum: number, a: any) =>
                sum + a.historyChain.filter((h: any) => h.author === 'user').length, 0) || 0,
              lastOpened: entry.lastOpenedAt || entry.addedAt,
            }
          } catch { return { id: entry.id, title: entry.title, annCount: 0, noteCount: 0, lastOpened: entry.addedAt } }
        }))
        data.push(...results)
      }
      data.sort((a, b) => b.annCount - a.annCount)
      if (!cancelled) { setProfileData(data); setLoading(false) }
    }

    loadProfile()
    return () => { cancelled = true }
  }, [library])

  const maxAnn = Math.max(...profileData.map(d => d.annCount), 1)
  const totalAnnotations = profileData.reduce((s, d) => s + d.annCount, 0)
  const totalNotes = profileData.reduce((s, d) => s + d.noteCount, 0)
  const totalEntries = library?.entries.length || 0
  const readEntries = profileData.filter(d => d.annCount > 0).length

  if (loading) {
    return (
      <div style={{ padding: '40px 32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        <span className="loading-spinner" style={{ marginRight: 8 }} />加载学习档案...
      </div>
    )
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>学习档案</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          共 {totalEntries} 篇文献，{readEntries} 篇有标注，{totalAnnotations} 条注释
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: '注释', value: totalAnnotations, color: 'var(--accent)' },
          { label: '笔记', value: totalNotes, color: 'var(--success)' },
          { label: '深度阅读', value: profileData.filter(d => d.annCount >= 5).length, color: 'var(--warning)' },
        ].map(s => (
          <div key={s.label} style={{
            padding: '12px 14px', borderRadius: 8,
            background: 'var(--bg-warm)', border: '1px solid var(--border)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Annotation depth bars */}
      {profileData.filter(d => d.annCount > 0).length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>阅读深度</div>
          {profileData.filter(d => d.annCount > 0).slice(0, 12).map(d => {
            const pct = (d.annCount / maxAnn) * 100
            return (
              <div key={d.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, cursor: 'pointer',
                padding: '3px 0', borderRadius: 4,
              }}
                onClick={() => {
                  const entry = library?.entries.find(e => e.id === d.id)
                  if (entry) {
                    useLibraryStore.getState().openEntry(entry)
                    useUiStore.getState().setActiveReadingLogDate(null)
                  }
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 100, fontSize: 11, color: 'var(--text)', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0,
                }} title={d.title}>
                  {d.title}
                </div>
                <div style={{ flex: 1, height: 10, background: 'var(--border-light)', borderRadius: 5, overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.max(pct, 4)}%`, height: '100%', borderRadius: 5,
                    background: `var(--accent)`, opacity: 0.4 + (pct / 100) * 0.6,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', width: 28, textAlign: 'right', flexShrink: 0 }}>
                  {d.annCount}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {profileData.filter(d => d.annCount > 0).length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          还没有阅读标注，开始阅读并标注吧
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', marginTop: 16 }}>
        选择左侧日期查看具体日志
      </div>
    </div>
  )
}

export default function ReadingLogView() {
  const { library, saveReadingLog, openEntry } = useLibraryStore()
  const { activeReadingLogDate, selectedAiModel, setActiveReadingLogDate, setActiveMemo } = useUiStore()
  const [generatingSummary, setGeneratingSummary] = useState(false)
  const [streamingText, setStreamingText] = useState('')

  const log = activeReadingLogDate
    ? library?.readingLogs?.find(l => l.date === activeReadingLogDate)
    : null

  const handleGenerateSummary = async () => {
    if (generatingSummary || !log) return
    setGeneratingSummary(true)
    setStreamingText('')

    try {
      const recentLogs = (library.readingLogs || [])
        .filter(l => l.date !== log.date && l.aiSummary)
        .slice(0, 3)

      // Build the same messages that readingLog.ts would build
      const systemPrompt = `你是一位学术阅读助手，正在和用户对话。请基于用户今天的阅读活动记录，生成一份简洁的每日阅读总结。\n\n重要：用「你」称呼用户（第二人称），像朋友和学术伙伴在跟用户聊天回顾今天的阅读。不要用「我」。禁止使用「亲爱的」等过于亲昵的称呼，直接用「你」即可。\n\n要求：\n1. 用2-4段中文概述今天的阅读和思考活动\n2. 提及具体的时间点（如"上午9点"、"下午2点"），让总结与时间线对应\n3. 如果用户在多篇文献间有关联性的注释或思考，指出这些联系\n4. 如果发现用户的注释中有值得深入思考的问题或矛盾，简要提及\n5. 语气温和、鼓励，像一位学术伙伴在跟你聊天\n6. 不要列举每一个事件，而是抓住重点和亮点\n7. 如果提供了历史日志摘要，可以提及与之前阅读的延续或变化`

      const timeline = log.events.map(e => {
        const t = new Date(e.timestamp)
        const timeStr = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`
        return `${timeStr} - ${e.detail}${e.selectedText ? `（"${e.selectedText}"）` : ''}`
      }).join('\n')

      let userMsg = `日期：${log.date}\n\n今日活动时间线：\n${timeline}`
      if (recentLogs.length > 0) {
        const history = recentLogs.slice(0, 3).map(l =>
          `${l.date}: ${(l.aiSummary || '无总结').substring(0, 200)}`
        ).join('\n\n')
        userMsg += `\n\n最近几天的阅读总结（供参考关联）：\n${history}`
      }

      const streamId = uuid()
      let fullText = ''

      const cleanupChunk = window.electronAPI.onAiStreamChunk((sid, chunk) => {
        if (sid !== streamId) return
        fullText += chunk
        setStreamingText(fullText)
      })

      try {
        const result = await window.electronAPI.aiChatStream(streamId, selectedAiModel, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ])
        if (!result.success) fullText = `错误：${result.error}`
      } finally {
        cleanupChunk()
      }

      setStreamingText('')

      if (fullText && !fullText.startsWith('错误：')) {
        const updated = {
          ...log,
          aiSummary: fullText,
          aiModel: selectedAiModel,
        }
        await window.electronAPI.readingLogSave(updated)
        saveReadingLog(updated)
      } else if (fullText.startsWith('错误：')) {
        alert(`AI 总结生成失败：${fullText}`)
      }
    } catch (err: any) {
      alert(`AI 总结生成失败：${err.message}`)
    } finally {
      setGeneratingSummary(false)
    }
  }

  const events = log?.events || []

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* Left: log list */}
      <div style={{
        width: 220, flexShrink: 0, borderRight: '1px solid var(--border-light)',
        display: 'flex', flexDirection: 'column', background: 'var(--bg-sidebar)',
      }}>
        <div style={{
          padding: '10px 12px', fontSize: 13, fontWeight: 600, color: 'var(--text)',
          borderBottom: '1px solid var(--border-light)', flexShrink: 0,
        }}>
          阅读日志
        </div>
        <ReadingLogList />
      </div>

      {/* Right: timeline content */}
      {log ? (
      <div className="reading-log-view" style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{
        padding: '20px 28px 16px', borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', margin: 0 }}>
            {formatDateFull(log.date)}
          </h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {events.length} 条活动记录
          </div>
        </div>
        {!log.aiSummary && !generatingSummary && (
          <button
            onClick={handleGenerateSummary}
            disabled={generatingSummary}
            style={{
              padding: '7px 14px', fontSize: 12, fontWeight: 500,
              background: generatingSummary ? 'var(--bg-warm)' : 'var(--accent-soft)',
              color: 'var(--accent-hover)', border: '1px solid var(--accent)',
              borderRadius: 6, cursor: generatingSummary ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {generatingSummary ? (
              <>
                <span className="loading-spinner" style={{ width: 12, height: 12 }} />
                生成中...
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                </svg>
                生成 AI 总结
              </>
            )}
          </button>
        )}
      </div>

      <div style={{ padding: '0 28px 28px' }}>
        {/* AI Streaming */}
        {generatingSummary && streamingText && (
          <div style={{
            margin: '20px 0', padding: '16px 20px',
            background: 'var(--bg-warm)', borderRadius: 10,
            border: '1px solid var(--border-light)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 10, fontSize: 12, fontWeight: 600, color: 'var(--accent-hover)',
            }}>
              <span className="loading-spinner" style={{ width: 12, height: 12 }} />
              AI 正在生成总结...
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text)' }}>
              <ReactMarkdown rehypePlugins={[rehypeRaw]}>{streamingText}</ReactMarkdown>
              <span className="streaming-cursor" />
            </div>
          </div>
        )}
        {generatingSummary && !streamingText && (
          <div style={{
            margin: '20px 0', padding: '16px 20px',
            background: 'var(--bg-warm)', borderRadius: 10,
            border: '1px solid var(--border-light)',
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, color: 'var(--text-muted)',
          }}>
            <span className="loading-spinner" style={{ width: 14, height: 14 }} />
            AI 正在思考...
          </div>
        )}

        {/* AI Summary */}
        {log.aiSummary && !generatingSummary && (
          <div style={{
            margin: '20px 0', padding: '16px 20px',
            background: 'var(--bg-warm)', borderRadius: 10,
            border: '1px solid var(--border-light)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: 10, fontSize: 12, fontWeight: 600, color: 'var(--accent-hover)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
              </svg>
              AI 阅读总结
              {log.aiModel && <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 10 }}>({log.aiModel})</span>}
            </div>
            <div className="reading-log-summary-content" style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text)' }}>
              <ReactMarkdown rehypePlugins={[rehypeRaw]}>{log.aiSummary}</ReactMarkdown>
            </div>
            <button
              onClick={handleGenerateSummary}
              disabled={generatingSummary}
              style={{
                marginTop: 10, padding: '4px 10px', fontSize: 10,
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid var(--border-light)', borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {generatingSummary ? '重新生成中...' : '重新生成'}
            </button>
          </div>
        )}

        {/* Timeline */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 16 }}>
            活动时间线
          </div>

          <div className="reading-log-timeline">
            {events.map((event, idx) => {
              const color = EVENT_COLORS[event.type] || 'var(--text-muted)'
              const isLast = idx === events.length - 1

              return (
                <div key={event.id} className="timeline-event" style={{ display: 'flex', gap: 12, position: 'relative', paddingBottom: isLast ? 0 : 4 }}>
                  {/* Time */}
                  <div className="timeline-time" style={{
                    width: 44, textAlign: 'right', fontSize: 11,
                    color: 'var(--text-muted)', flexShrink: 0, paddingTop: 2,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {formatTime(event.timestamp)}
                  </div>

                  {/* Dot + line */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 14 }}>
                    <div style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: color, flexShrink: 0, marginTop: 4,
                      boxShadow: `0 0 0 3px ${color}22`,
                    }} />
                    {!isLast && (
                      <div style={{
                        flex: 1, width: 2, background: 'var(--border-light)',
                        minHeight: 20,
                      }} />
                    )}
                  </div>

                  {/* Content — clickable to jump to document */}
                  <div
                    style={{ flex: 1, paddingBottom: isLast ? 0 : 12, cursor: event.entryId || event.memoId ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (event.entryId) {
                        const entry = library?.entries.find(e => e.id === event.entryId)
                        if (entry) {
                          openEntry(entry)
                          setActiveReadingLogDate(null)
                        }
                      } else if (event.memoId) {
                        setActiveMemo(event.memoId)
                        setActiveReadingLogDate(null)
                      }
                    }}
                    onMouseEnter={e => { if (event.entryId || event.memoId) (e.currentTarget.style.background = 'var(--bg-hover)') }}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    title={event.entryId ? '点击打开该文献' : event.memoId ? '点击打开该笔记' : ''}
                  >
                    <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                      {event.detail}
                      {(event.entryId || event.memoId) && (
                        <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 6 }}>↗</span>
                      )}
                    </div>
                    {event.selectedText && (
                      <div style={{
                        fontSize: 11, color: 'var(--text-muted)', marginTop: 3,
                        fontStyle: 'italic', lineHeight: 1.5,
                        borderLeft: `2px solid ${color}44`, paddingLeft: 8,
                        overflow: 'hidden', textOverflow: 'ellipsis',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                      }}>
                        "{event.selectedText}"
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {events.length === 0 && (
            <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              这天没有活动记录
            </div>
          )}
        </div>
      </div>
    </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
          <LearningProfile />
        </div>
      )}
    </div>
  )
}
