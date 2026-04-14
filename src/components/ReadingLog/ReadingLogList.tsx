import { useState } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import { v4 as uuid } from 'uuid'
import type { ReadingLog } from '../../types/library'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekday = WEEKDAYS[d.getDay()]
  return `${month}月${day}日 ${weekday}`
}

function isToday(dateStr: string): boolean {
  return dateStr === new Date().toISOString().slice(0, 10)
}

export default function ReadingLogList() {
  const { library, saveReadingLog } = useLibraryStore()
  const { activeReadingLogDate, setActiveReadingLogDate } = useUiStore()
  const [generating, setGenerating] = useState(false)

  const logs = library?.readingLogs || []

  const handleGenerateToday = async () => {
    if (generating) return
    setGenerating(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const result = await window.electronAPI.readingLogCollectEvents(today)
      if (result.success && result.events.length > 0) {
        const log: ReadingLog = {
          id: uuid(),
          date: today,
          events: result.events,
          generatedAt: new Date().toISOString(),
        }
        // Save via IPC (persists to disk)
        await window.electronAPI.readingLogSave(log)
        // Update local store
        saveReadingLog(log)
        setActiveReadingLogDate(today)
      } else if (result.events.length === 0) {
        alert('今天还没有阅读活动记录。')
      }
    } catch (err: any) {
      console.error('[reading-log] Generate failed:', err)
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Action bar */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-light)' }}>
        <button
          className="btn btn-sm"
          onClick={handleGenerateToday}
          disabled={generating}
          style={{
            width: '100%', justifyContent: 'center', padding: '7px 0',
            fontSize: 12, fontWeight: 500,
            background: generating ? 'var(--bg-warm)' : 'var(--accent-soft)',
            color: 'var(--accent-hover)', border: '1px solid var(--accent)',
            borderRadius: 6, cursor: generating ? 'wait' : 'pointer',
          }}
        >
          {generating ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="loading-spinner" style={{ width: 12, height: 12 }} />
              生成中...
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              生成今日日志
            </span>
          )}
        </button>
      </div>

      {/* Log list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {logs.map(log => {
          const isActive = activeReadingLogDate === log.date
          const today = isToday(log.date)
          return (
            <div
              key={log.date}
              onClick={() => setActiveReadingLogDate(log.date)}
              style={{
                padding: '10px 14px', cursor: 'pointer',
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                borderBottom: '1px solid var(--border-light)',
                borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: isActive ? 'var(--accent-hover)' : 'var(--text)' }}>
                  {formatDate(log.date)}
                </span>
                {today && (
                  <span style={{
                    fontSize: 9, padding: '1px 5px', borderRadius: 3,
                    background: 'var(--accent)', color: '#fff', fontWeight: 600,
                  }}>
                    TODAY
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                <span>{log.events.length} 条活动</span>
                {log.aiSummary ? (
                  <span style={{ color: 'var(--success)' }}>AI 总结</span>
                ) : (
                  <span style={{ opacity: 0.6 }}>无总结</span>
                )}
              </div>
            </div>
          )
        })}

        {logs.length === 0 && (
          <div style={{
            padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 12 }}>
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <div style={{ fontSize: 12, marginBottom: 6 }}>还没有阅读日志</div>
            <div style={{ fontSize: 11, lineHeight: 1.6 }}>
              点击上方按钮生成今日日志，或在午夜时自动生成前一天的日志。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
