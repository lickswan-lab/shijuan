import { useState } from 'react'
import { useUiStore } from '../../store/uiStore'

/**
 * Floating progress bar for batch OCR. Sits bottom-right.
 * Visible whenever ocrQueue.status !== 'idle'.
 */
export default function BatchOcrProgress() {
  const { ocrQueue, cancelOcrQueue, dismissOcrQueue } = useUiStore()
  const [expanded, setExpanded] = useState(false)

  if (ocrQueue.status === 'idle') return null

  const total = ocrQueue.items.length
  const doneCount = ocrQueue.completed.length + ocrQueue.errors.length
  const currentItem = ocrQueue.status === 'running' ? ocrQueue.items[ocrQueue.currentIndex] : null
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const isDone = ocrQueue.status === 'done'

  return (
    <div style={{
      position: 'fixed', bottom: 16, right: 16, zIndex: 2000,
      width: expanded ? 360 : 280,
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 10, boxShadow: '0 8px 24px rgba(60,50,30,0.15)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px', borderBottom: expanded ? '1px solid var(--border-light)' : 'none',
      }}>
        {!isDone ? (
          <span className="loading-spinner" style={{ width: 12, height: 12, flexShrink: 0 }} />
        ) : (
          <span style={{ fontSize: 14, flexShrink: 0, color: ocrQueue.errors.length > 0 ? 'var(--warning)' : 'var(--success)' }}>
            {ocrQueue.errors.length > 0 ? '⚠' : '✓'}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
            {isDone
              ? (ocrQueue.cancelled ? '已取消' : '批量 OCR 完成')
              : `批量 OCR  ${doneCount}/${total}`
            }
          </div>
          {currentItem && (
            <div style={{
              fontSize: 10, color: 'var(--text-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              正在处理: {currentItem.title}
            </div>
          )}
          {isDone && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              成功 {ocrQueue.completed.length} · 失败 {ocrQueue.errors.length}
            </div>
          )}
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          title={expanded ? '收起' : '展开详情'}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 11, padding: '2px 6px',
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        {isDone ? (
          <button
            onClick={dismissOcrQueue}
            title="关闭"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 14, padding: '0 4px',
            }}
          >✕</button>
        ) : (
          <button
            onClick={cancelOcrQueue}
            disabled={ocrQueue.cancelled}
            title="取消剩余任务"
            style={{
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 4, cursor: 'pointer',
              color: 'var(--danger)', fontSize: 10, padding: '2px 8px',
            }}
          >{ocrQueue.cancelled ? '取消中...' : '取消'}</button>
        )}
      </div>

      {/* Progress bar */}
      {!isDone && (
        <div style={{ height: 3, background: 'var(--border-light)' }}>
          <div style={{
            width: `${pct}%`, height: '100%', background: 'var(--accent)',
            transition: 'width 0.3s',
          }} />
        </div>
      )}

      {/* Expanded details: items + errors */}
      {expanded && (
        <div style={{ maxHeight: 260, overflowY: 'auto', padding: '6px 10px' }}>
          {ocrQueue.items.map((item, i) => {
            let status: 'pending' | 'running' | 'done' | 'error' = 'pending'
            if (ocrQueue.completed.includes(item.entryId)) status = 'done'
            else if (ocrQueue.errors.some(e => e.entryId === item.entryId)) status = 'error'
            else if (i === ocrQueue.currentIndex && ocrQueue.status === 'running') status = 'running'

            const icon = status === 'done' ? '✓'
              : status === 'error' ? '✗'
              : status === 'running' ? '●'
              : '○'
            const color = status === 'done' ? 'var(--success)'
              : status === 'error' ? 'var(--danger)'
              : status === 'running' ? 'var(--accent)'
              : 'var(--text-muted)'
            const err = ocrQueue.errors.find(e => e.entryId === item.entryId)?.error

            return (
              <div key={item.entryId} style={{
                display: 'flex', alignItems: 'flex-start', gap: 6,
                fontSize: 11, padding: '3px 0',
                borderBottom: i < ocrQueue.items.length - 1 ? '1px solid var(--border-light)' : 'none',
              }}>
                <span style={{ color, flexShrink: 0, fontWeight: status === 'running' ? 700 : 400 }}>
                  {icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    color: 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    opacity: status === 'pending' ? 0.6 : 1,
                  }}>
                    {item.title}
                  </div>
                  {err && (
                    <div style={{ fontSize: 10, color: 'var(--danger)', opacity: 0.85, marginTop: 1 }}>
                      {err}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
