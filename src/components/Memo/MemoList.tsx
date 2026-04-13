import { useState, useRef } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'

export default function MemoList() {
  const { library, createMemo, deleteMemo } = useLibraryStore()
  const { activeMemoId, setActiveMemo } = useUiStore()
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [menuMemoId, setMenuMemoId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const memos = library?.memos || []
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const handleBatchDelete = () => {
    selectedIds.forEach(id => {
      deleteMemo(id)
      if (activeMemoId === id) setActiveMemo(null)
    })
    setSelectedIds(new Set())
    setMultiSelect(false)
  }

  const handleCreate = async () => {
    if (newTitle.trim()) {
      const memo = await createMemo(newTitle.trim())
      setActiveMemo(memo.id)
    }
    setCreating(false)
    setNewTitle('')
  }

  const handleContextMenu = (e: React.MouseEvent, memoId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuMemoId(memoId)
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const handleDelete = (id: string) => {
    deleteMemo(id)
    if (activeMemoId === id) setActiveMemo(null)
    setMenuMemoId(null)
    setMenuPos(null)
  }

  // Sort: most recently updated first (defend against missing updatedAt)
  const sorted = [...memos].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Action bar */}
      <div style={{ padding: '6px 10px', display: 'flex', gap: 4, borderBottom: '1px solid var(--border-light)' }}>
        {multiSelect ? (
          <>
            <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={() => { setMultiSelect(false); setSelectedIds(new Set()) }}>
              取消
            </button>
            <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={() => {
              if (selectedIds.size === memos.length) setSelectedIds(new Set())
              else setSelectedIds(new Set(memos.map(m => m.id)))
            }}>
              {selectedIds.size === memos.length ? '取消全选' : '全选'}
            </button>
            <div style={{ flex: 1 }} />
            {selectedIds.size > 0 && (
              <button className="btn btn-sm" style={{ fontSize: 10, color: 'var(--danger)' }} onClick={handleBatchDelete}>
                删除 ({selectedIds.size})
              </button>
            )}
          </>
        ) : (
          <>
            <button
              className="btn btn-sm"
              style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
              onClick={() => { setCreating(true); setTimeout(() => inputRef.current?.focus(), 50) }}
            >
              新建笔记
            </button>
            <button className="btn btn-sm" style={{ justifyContent: 'center', fontSize: 11 }} onClick={() => setMultiSelect(true)} title="多选">
              多选
            </button>
          </>
        )}
      </div>

      {/* New memo input */}
      {creating && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-light)' }}>
          <input
            ref={inputRef}
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onBlur={handleCreate}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewTitle('') } }}
            placeholder="笔记标题..."
            autoFocus
            style={{
              width: '100%', padding: '6px 10px', border: '1px solid var(--accent)',
              borderRadius: 4, fontSize: 12, outline: 'none', background: 'var(--bg)'
            }}
          />
        </div>
      )}

      {/* Memo list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {sorted.map(memo => {
          const isActive = activeMemoId === memo.id
          const blockCount = memo.blocks?.length || 0
          const contentPreview = memo.content
            ? memo.content.substring(0, 60).replace(/\n/g, ' ')
            : '空白笔记'

          const isSel = selectedIds.has(memo.id)
          return (
            <div
              key={memo.id}
              onClick={() => {
                if (multiSelect) { toggleSelect(memo.id); return }
                setActiveMemo(memo.id)
              }}
              onContextMenu={multiSelect ? undefined : e => handleContextMenu(e, memo.id)}
              style={{
                padding: '10px 14px', cursor: 'pointer',
                background: isSel ? 'var(--accent-soft)' : isActive ? 'var(--accent-soft)' : 'transparent',
                borderBottom: '1px solid var(--border-light)',
                borderLeft: isActive && !multiSelect ? '3px solid var(--accent)' : '3px solid transparent',
                transition: 'background 0.15s',
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}
              onMouseEnter={e => { if (!isActive && !isSel) e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { if (!isActive && !isSel) e.currentTarget.style.background = 'transparent' }}
            >
              {multiSelect && (
                <input type="checkbox" checked={isSel} onChange={() => toggleSelect(memo.id)}
                  onClick={e => e.stopPropagation()}
                  style={{ marginTop: 2, accentColor: 'var(--accent)' }} />
              )}
              <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{
                fontSize: 13, fontWeight: 500,
                color: isActive ? 'var(--accent-hover)' : 'var(--text)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: 4,
              }}>
                {memo.title}
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text-muted)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: 4, lineHeight: 1.4,
              }}>
                {contentPreview}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                <span>{memo.updatedAt ? new Date(memo.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
                {blockCount > 0 && <span>{blockCount} 引用块</span>}
                {(memo.snapshots?.length || 0) > 0 && <span>{memo.snapshots.length} 快照</span>}
              </div>
              </div>
            </div>
          )
        })}

        {memos.length === 0 && !creating && (
          <div style={{
            padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 12 }}>
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            <div style={{ fontSize: 12, marginBottom: 6 }}>还没有思考笔记</div>
            <div style={{ fontSize: 11, lineHeight: 1.6 }}>
              在阅读文献时，可以将注释和 AI 回复作为「引用块」收集到笔记中，帮助你整合跨文献的思考。
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {menuPos && menuMemoId && (
        <div
          ref={menuRef}
          style={{
            position: 'fixed', left: menuPos.x, top: menuPos.y, zIndex: 1000,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '4px 0', minWidth: 140,
          }}
          onMouseLeave={() => { setMenuMemoId(null); setMenuPos(null) }}
        >
          <div
            onClick={() => { setActiveMemo(menuMemoId); setMenuMemoId(null); setMenuPos(null) }}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            打开
          </div>
          <div
            onClick={() => handleDelete(menuMemoId)}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            删除笔记
          </div>
        </div>
      )}
    </div>
  )
}
