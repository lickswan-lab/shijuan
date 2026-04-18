import { useState, useRef } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { MemoFolder, Memo } from '../../types/library'

// ===== MemoFolderItem =====

function MemoFolderItem({
  folder, memos, activeMemoId, multiSelect, selectedIds,
  onSelect, onToggleSelect, onContextMenu,
  onRenameFolder, onDeleteFolder, onMoveMemoToFolder,
}: {
  folder: MemoFolder
  memos: Memo[]
  activeMemoId: string | null
  multiSelect: boolean
  selectedIds: Set<string>
  onSelect: (id: string) => void
  onToggleSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string) => void
  onMoveMemoToFolder: (memoId: string, folderId: string | undefined) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState(folder.name)
  const [dragOver, setDragOver] = useState(false)
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  const children = memos.filter(m => m.folderId === folder.id)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))

  const handleRename = () => {
    if (renameName.trim() && renameName.trim() !== folder.name) {
      onRenameFolder(folder.id, renameName.trim())
    }
    setRenaming(false)
  }

  return (
    <div>
      {/* Folder header */}
      <div
        onClick={() => setExpanded(!expanded)}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setFolderMenu({ x: e.clientX, y: e.clientY }) }}
        onDoubleClick={e => { e.stopPropagation(); setRenaming(true); setTimeout(() => renameRef.current?.focus(), 50) }}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => {
          e.preventDefault(); setDragOver(false)
          const memoId = e.dataTransfer.getData('memo-drag')
          if (memoId) onMoveMemoToFolder(memoId, folder.id)
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '7px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          color: 'var(--text)', userSelect: 'none',
          background: dragOver ? 'var(--accent-soft)' : 'transparent',
          borderBottom: '1px solid var(--border-light)',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (!dragOver) e.currentTarget.style.background = 'var(--bg-hover)' }}
        onMouseLeave={e => { if (!dragOver) e.currentTarget.style.background = 'transparent' }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0 }}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        {renaming ? (
          <input
            ref={renameRef}
            value={renameName}
            onChange={e => setRenameName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenaming(false) }}
            onClick={e => e.stopPropagation()}
            autoFocus
            style={{
              flex: 1, padding: '2px 6px', border: '1px solid var(--accent)',
              borderRadius: 3, fontSize: 12, outline: 'none', background: 'var(--bg)',
            }}
          />
        ) : (
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {folder.name}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{children.length}</span>
      </div>

      {/* Children */}
      {expanded && children.map(memo => (
        <MemoItem
          key={memo.id}
          memo={memo}
          isActive={activeMemoId === memo.id}
          indent
          multiSelect={multiSelect}
          isSelected={selectedIds.has(memo.id)}
          onSelect={onSelect}
          onToggleSelect={onToggleSelect}
          onContextMenu={onContextMenu}
        />
      ))}

      {/* Folder context menu */}
      {folderMenu && (
        <div
          style={{
            position: 'fixed', left: folderMenu.x, top: folderMenu.y, zIndex: 1000,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '4px 0', minWidth: 130,
          }}
          onMouseLeave={() => setFolderMenu(null)}
        >
          <div
            onClick={() => { setRenaming(true); setFolderMenu(null); setTimeout(() => renameRef.current?.focus(), 50) }}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            重命名
          </div>
          <div
            onClick={() => {
              const childCount = memos.filter(m => m.folderId === folder.id).length
              const msg = childCount > 0
                ? `删除文件夹「${folder.name}」？\n\n文件夹内的 ${childCount} 条笔记会移回根目录（不会被删除）。`
                : `删除空文件夹「${folder.name}」？`
              if (!window.confirm(msg)) { setFolderMenu(null); return }
              onDeleteFolder(folder.id); setFolderMenu(null)
            }}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            删除文件夹
          </div>
        </div>
      )}
    </div>
  )
}

// ===== MemoItem =====

function MemoItem({
  memo, isActive, indent, multiSelect, isSelected,
  onSelect, onToggleSelect, onContextMenu,
}: {
  memo: Memo
  isActive: boolean
  indent?: boolean
  multiSelect: boolean
  isSelected: boolean
  onSelect: (id: string) => void
  onToggleSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, id: string) => void
}) {
  const blockCount = memo.blocks?.length || 0
  const contentPreview = memo.content
    ? memo.content.substring(0, 60).replace(/\n/g, ' ')
    : '空白笔记'

  return (
    <div
      draggable={!multiSelect}
      onDragStart={e => {
        e.dataTransfer.setData('memo-drag', memo.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => {
        if (multiSelect) { onToggleSelect(memo.id); return }
        onSelect(memo.id)
      }}
      onContextMenu={multiSelect ? undefined : e => onContextMenu(e, memo.id)}
      style={{
        padding: '10px 14px', cursor: 'pointer',
        paddingLeft: indent ? 28 : 14,
        background: isSelected ? 'var(--accent-soft)' : isActive ? 'var(--accent-soft)' : 'transparent',
        borderBottom: '1px solid var(--border-light)',
        borderLeft: isActive && !multiSelect ? '3px solid var(--accent)' : '3px solid transparent',
        transition: 'background 0.15s',
        display: 'flex', gap: 8, alignItems: 'flex-start',
      }}
      onMouseEnter={e => { if (!isActive && !isSelected) e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!isActive && !isSelected) e.currentTarget.style.background = 'transparent' }}
    >
      {multiSelect && (
        <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(memo.id)}
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
}

// ===== MemoList =====

export default function MemoList() {
  const { library, createMemo, deleteMemo, createMemoFolder, renameMemoFolder, deleteMemoFolder, moveMemoToFolder } = useLibraryStore()
  const { activeMemoId, setActiveMemo } = useUiStore()
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [menuMemoId, setMenuMemoId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  const memos = library?.memos || []
  const memoFolders = library?.memoFolders || []
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
    if (selectedIds.size === 0) return
    if (!window.confirm(`删除选中的 ${selectedIds.size} 条笔记？\n\n此操作无法撤销。`)) return
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

  const handleNewFolder = async () => {
    setCreatingFolder(true)
    setTimeout(() => folderInputRef.current?.focus(), 50)
  }

  const handleCreateFolder = async () => {
    if (newFolderName.trim()) {
      await createMemoFolder(newFolderName.trim())
    }
    setCreatingFolder(false)
    setNewFolderName('')
  }

  const handleContextMenu = (e: React.MouseEvent, memoId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuMemoId(memoId)
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const handleDelete = (id: string) => {
    const memo = memos.find(m => m.id === id)
    const title = memo?.title || '无标题'
    if (!window.confirm(`删除笔记「${title}」？\n\n此操作无法撤销。`)) {
      setMenuMemoId(null)
      setMenuPos(null)
      return
    }
    deleteMemo(id)
    if (activeMemoId === id) setActiveMemo(null)
    setMenuMemoId(null)
    setMenuPos(null)
  }

  // Root memos (no folder)
  const rootMemos = memos.filter(m => !m.folderId)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))

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
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }}
              onClick={() => { setCreating(true); setTimeout(() => inputRef.current?.focus(), 50) }} title="新建笔记">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>
            </button>
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }}
              onClick={handleNewFolder} title="新建文件夹">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
            </button>
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }}
              onClick={() => setMultiSelect(true)} title="多选">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="14" height="14" rx="2"/><polyline points="9 12 11 14 17 8"/></svg>
            </button>
          </>
        )}
      </div>

      {/* New folder input */}
      {creatingFolder && (
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-light)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0 }}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <input
            ref={folderInputRef}
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onBlur={handleCreateFolder}
            onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName('') } }}
            placeholder="文件夹名称..."
            autoFocus
            style={{
              flex: 1, padding: '5px 8px', border: '1px solid var(--accent)',
              borderRadius: 4, fontSize: 12, outline: 'none', background: 'var(--bg)'
            }}
          />
        </div>
      )}

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

      {/* Memo list with folders */}
      <div
        style={{ flex: 1, overflow: 'auto' }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          const memoId = e.dataTransfer.getData('memo-drag')
          if (memoId) moveMemoToFolder(memoId, undefined) // drop to root
        }}
      >
        {/* Folders */}
        {memoFolders.map(folder => (
          <MemoFolderItem
            key={folder.id}
            folder={folder}
            memos={memos}
            activeMemoId={activeMemoId}
            multiSelect={multiSelect}
            selectedIds={selectedIds}
            onSelect={id => setActiveMemo(id)}
            onToggleSelect={toggleSelect}
            onContextMenu={handleContextMenu}
            onRenameFolder={renameMemoFolder}
            onDeleteFolder={deleteMemoFolder}
            onMoveMemoToFolder={moveMemoToFolder}
          />
        ))}

        {/* Root memos */}
        {rootMemos.map(memo => (
          <MemoItem
            key={memo.id}
            memo={memo}
            isActive={activeMemoId === memo.id}
            multiSelect={multiSelect}
            isSelected={selectedIds.has(memo.id)}
            onSelect={id => setActiveMemo(id)}
            onToggleSelect={toggleSelect}
            onContextMenu={handleContextMenu}
          />
        ))}

        {memos.length === 0 && !creating && !creatingFolder && (
          <div style={{
            padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 12 }}>
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            <div style={{ fontSize: 12, marginBottom: 6, color: 'var(--text-secondary)' }}>这里会放你的笔记</div>
            <div style={{ fontSize: 11, lineHeight: 1.7 }}>
              读文献时把注释拖过来，跨文献的想法可以在这儿沉淀成一段。<br />
              按 <kbd style={{ background: 'var(--bg-warm)', padding: '0 4px', borderRadius: 3, border: '1px solid var(--border)', fontSize: 10 }}>Ctrl+N</kbd> 或点上方 ＋ 开始写。
            </div>
          </div>
        )}
      </div>

      {/* Context menu */}
      {menuPos && menuMemoId && (
        <div
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
          {/* Move to folder submenu */}
          {memoFolders.length > 0 && (
            <div style={{ position: 'relative' }} className="memo-move-menu">
              <div
                style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                移入文件夹
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
              </div>
              <div className="memo-move-submenu" style={{
                position: 'absolute', left: '100%', top: 0,
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                padding: '4px 0', minWidth: 120, display: 'none',
              }}>
                {memoFolders.map(f => (
                  <div
                    key={f.id}
                    onClick={() => {
                      moveMemoToFolder(menuMemoId, f.id)
                      setMenuMemoId(null); setMenuPos(null)
                    }}
                    style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {f.name}
                  </div>
                ))}
                <div
                  onClick={() => {
                    moveMemoToFolder(menuMemoId, undefined)
                    setMenuMemoId(null); setMenuPos(null)
                  }}
                  style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)', borderTop: '1px solid var(--border-light)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  移出文件夹
                </div>
              </div>
            </div>
          )}
          <div
            onClick={() => handleDelete(menuMemoId)}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            删除笔记
          </div>
        </div>
      )}
    </div>
  )
}
