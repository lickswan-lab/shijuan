import { useState, useRef, useEffect, DragEvent, MouseEvent } from 'react'
import type { LibraryEntry, VirtualFolder } from '../../types/library'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import MemoList from '../Memo/MemoList'

// ===== Context Menu =====
interface MenuPos { x: number; y: number }
interface MenuItem { label: string; danger?: boolean; onClick: () => void }
interface ContextMenuProps {
  pos: MenuPos
  items: MenuItem[]
  onClose: () => void
}

function ContextMenu({ pos, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000,
    background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    padding: '4px 0', minWidth: 160,
  }

  return (
    <div ref={ref} style={style}>
      {items.map((item, i) => (
        <div
          key={i}
          onClick={() => { item.onClick(); onClose() }}
          style={{
            padding: '7px 14px', fontSize: 12, cursor: 'pointer',
            color: item.danger ? 'var(--danger)' : 'var(--text)',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = item.danger ? 'var(--bg-hover)' : 'var(--bg-warm)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}

// ===== Single file entry item =====
function EntryItem({ entry, multiSelect, selected, onToggleSelect }: {
  entry: LibraryEntry
  multiSelect?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const { currentEntry, openEntry, removeEntry, deleteEntry, reorderEntry } = useLibraryStore()
  const { setActiveMemo, setActiveReadingLogDate } = useUiStore()
  const isActive = currentEntry?.id === entry.id
  const [dropPos, setDropPos] = useState<'before' | 'after' | null>(null)
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const parts = entry.absPath.split(/[/\\]/)
  const folderParts = parts.slice(-4, -1)
  const folder = folderParts.join('/')

  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData('entry-id', entry.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const midY = rect.top + rect.height / 2
    setDropPos(e.clientY < midY ? 'before' : 'after')
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const draggedId = e.dataTransfer.getData('entry-id')
    if (draggedId && draggedId !== entry.id && dropPos) {
      reorderEntry(draggedId, entry.id, dropPos)
    }
    setDropPos(null)
  }

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setConfirmDelete(false)
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  return (
    <>
      <div
        className={`tree-item ${isActive ? 'active' : ''} ${selected ? 'selected' : ''}`}
        onClick={() => {
          if (multiSelect) { onToggleSelect?.(); return }
          setActiveMemo(null); setActiveReadingLogDate(null); openEntry(entry)
        }}
        draggable={!multiSelect}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={() => setDropPos(null)}
        onDrop={handleDrop}
        onContextMenu={multiSelect ? undefined : handleContextMenu}
        title={entry.absPath}
        style={{
          borderTop: dropPos === 'before' ? '2px solid var(--accent)' : '2px solid transparent',
          borderBottom: dropPos === 'after' ? '2px solid var(--accent)' : '2px solid transparent',
          background: selected ? 'var(--accent-soft)' : undefined,
        }}
      >
        {multiSelect ? (
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect?.()}
            onClick={e => e.stopPropagation()}
            style={{ marginRight: 4, accentColor: 'var(--accent)' }}
          />
        ) : (
          <svg className="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}>
            {entry.title}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {folder}
          </div>
        </div>
        {(entry.ocrStatus === 'complete' || entry.ocrFilePath) && (
          <span style={{
            flexShrink: 0, fontSize: 9, color: 'var(--success)',
            background: 'rgba(76,175,80,0.1)', padding: '1px 4px',
            borderRadius: 3, fontWeight: 500, letterSpacing: 0.5,
          }}>
            OCR
          </span>
        )}
      </div>
      {menuPos && (
        <EntryContextMenu
          pos={menuPos}
          confirmDelete={confirmDelete}
          onClose={() => { setMenuPos(null); setConfirmDelete(false) }}
          onRemove={() => { removeEntry(entry.id); setMenuPos(null) }}
          onDeleteStep={() => setConfirmDelete(true)}
          onDeleteConfirm={() => { deleteEntry(entry.id); setMenuPos(null) }}
          onShowInFolder={() => { window.electronAPI.showItemInFolder?.(entry.absPath) }}
        />
      )}
    </>
  )
}

// Two-step context menu for entry
function EntryContextMenu({ pos, confirmDelete, onClose, onRemove, onDeleteStep, onDeleteConfirm, onShowInFolder }: {
  pos: MenuPos
  confirmDelete: boolean
  onClose: () => void
  onRemove: () => void
  onDeleteStep: () => void
  onDeleteConfirm: () => void
  onShowInFolder: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000,
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
        padding: '4px 0', minWidth: 170,
      }}
    >
      {!confirmDelete ? (
        <>
          <div
            onClick={() => { onShowInFolder(); onClose() }}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            查看文件位置
          </div>
          <div style={{ height: 1, background: 'var(--border-light)', margin: '2px 0' }} />
          <div
            onClick={onRemove}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            移除（保留原文件）
          </div>
          <div
            onClick={onDeleteStep}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--danger)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            删除原文件...
          </div>
        </>
      ) : (
        <>
          <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--text-muted)' }}>
            文件将移入回收站
          </div>
          <div
            onClick={onDeleteConfirm}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--danger)', fontWeight: 500 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            确认删除
          </div>
          <div
            onClick={onClose}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            取消
          </div>
        </>
      )}
    </div>
  )
}

// ===== Virtual folder =====
function FolderItem({ folder }: { folder: VirtualFolder }) {
  const { library, moveEntryToFolder, renameFolder, deleteFolder } = useLibraryStore()
  const [expanded, setExpanded] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(folder.name)
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)

  const entries = (library?.entries.filter(e => e.folderId === folder.id) || [])
    .sort((a, b) => (a.sortIndex ?? 9999) - (b.sortIndex ?? 9999))

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const entryId = e.dataTransfer.getData('entry-id')
    if (entryId) moveEntryToFolder(entryId, folder.id)
  }

  const handleRename = () => {
    if (editName.trim()) renameFolder(folder.id, editName.trim())
    setEditing(false)
  }

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  return (
    <div>
      <div
        className={`tree-item tree-folder ${dragOver ? 'active' : ''}`}
        onClick={() => setExpanded(!expanded)}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); setEditName(folder.name) }}
        onContextMenu={handleContextMenu}
      >
        <span className="icon" style={{ fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        {editing ? (
          <input
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false) }}
            onClick={e => e.stopPropagation()}
            autoFocus
            style={{
              flex: 1, border: '1px solid var(--accent)', borderRadius: 4,
              padding: '1px 6px', fontSize: 13, outline: 'none', background: 'var(--bg)'
            }}
          />
        ) : (
          <>
            <span style={{ flex: 1 }}>{folder.name}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{entries.length}</span>
          </>
        )}
      </div>
      {menuPos && (
        <ContextMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          items={[
            { label: '重命名', onClick: () => { setEditing(true); setEditName(folder.name) } },
            { label: '删除分组', danger: true, onClick: () => deleteFolder(folder.id) },
          ]}
        />
      )}
      {expanded && (
        <div style={{ paddingLeft: 14 }}>
          {entries.map(entry => <EntryItem key={entry.id} entry={entry} />)}
        </div>
      )}
    </div>
  )
}

// ===== Library panel (file tree content) =====
function LibraryPanel() {
  const { library, importFiles, importFolder, createFolder, moveEntryToFolder, removeEntry, deleteEntry, openEntry } = useLibraryStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [fullTextResults, setFullTextResults] = useState<Array<{
    entryId: string; entryTitle: string; type: 'ocr' | 'annotation';
    text: string; pageNumber?: number; annotationId?: string;
  }>>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Web scraper — shelved, code in _shelved_features/

  // Debounced full-text search
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setFullTextResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      if (!window.electronAPI?.fullTextSearch || !library) return
      setSearching(true)
      try {
        const results = await window.electronAPI.fullTextSearch(searchQuery, library)
        setFullTextResults(results)
      } catch { setFullTextResults([]) }
      setSearching(false)
    }, 400)  // 400ms debounce
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [searchQuery, library])
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)

  const entries = library?.entries || []
  const folders = library?.folders || []

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const handleBatchRemove = () => {
    selectedIds.forEach(id => removeEntry(id))
    setSelectedIds(new Set())
    setMultiSelect(false)
  }

  const handleBatchDelete = () => {
    if (!confirmBatchDelete) { setConfirmBatchDelete(true); return }
    selectedIds.forEach(id => deleteEntry(id))
    setSelectedIds(new Set())
    setMultiSelect(false)
    setConfirmBatchDelete(false)
  }

  const handleBatchMove = (folderId: string | undefined) => {
    selectedIds.forEach(id => moveEntryToFolder(id, folderId))
    setSelectedIds(new Set())
    setMultiSelect(false)
    setShowMoveMenu(false)
  }

  const filtered = searchQuery
    ? entries.filter(e =>
        e.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.absPath.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.tags.some(t => t.includes(searchQuery))
      )
    : entries

  const rootEntries = searchQuery
    ? filtered
    : filtered.filter(e => !e.folderId)

  const sorted = [...rootEntries].sort((a, b) => {
    const ai = a.sortIndex ?? 9999
    const bi = b.sortIndex ?? 9999
    if (ai !== bi) return ai - bi
    const ta = a.lastOpenedAt || a.addedAt
    const tb = b.lastOpenedAt || b.addedAt
    return tb.localeCompare(ta)
  })

  const handleNewFolder = () => {
    setNewFolderName('')
    setTimeout(() => newFolderInputRef.current?.focus(), 50)
  }

  const confirmNewFolder = async () => {
    if (newFolderName?.trim()) {
      await createFolder(newFolderName.trim())
    }
    setNewFolderName(null)
  }

  const handleRootDrop = (e: DragEvent) => {
    e.preventDefault()
    const entryId = e.dataTransfer.getData('entry-id')
    if (entryId) moveEntryToFolder(entryId, undefined)
  }

  return (
    <>
      {/* Search */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-light)' }}>
        <input
          type="text"
          placeholder="搜索文献 / 全文搜索..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{
            width: '100%', padding: '6px 10px', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-xs)', fontSize: 12, outline: 'none',
            background: 'var(--bg-warm)', color: 'var(--text)'
          }}
        />
      </div>

      {/* Full-text search results */}
      {searchQuery.length >= 2 && fullTextResults.length > 0 && (
        <div style={{ maxHeight: 240, overflow: 'auto', borderBottom: '1px solid var(--border-light)', background: 'var(--bg-warm)' }}>
          <div style={{ padding: '4px 12px', fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>
            全文搜索 {searching ? '...' : `(${fullTextResults.length})`}
          </div>
          {fullTextResults.map((r, i) => (
            <div key={i}
              onClick={() => {
                const entry = library?.entries.find(e => e.id === r.entryId)
                if (entry) {
                  openEntry(entry)
                  if (r.annotationId) {
                    useUiStore.getState().setActiveAnnotation(r.annotationId)
                  }
                }
                setSearchQuery('')
                setFullTextResults([])
              }}
              style={{
                padding: '6px 12px', cursor: 'pointer', fontSize: 11,
                borderBottom: '1px solid var(--border-light)',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ fontWeight: 500, color: 'var(--text)', marginBottom: 2, display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{
                  fontSize: 9, padding: '1px 4px', borderRadius: 3,
                  background: r.type === 'ocr' ? 'var(--accent-soft)' : 'rgba(139,177,116,0.15)',
                  color: r.type === 'ocr' ? 'var(--accent)' : 'var(--success)',
                }}>
                  {r.type === 'ocr' ? '正文' : '注释'}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.entryTitle}</span>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.text}
              </div>
            </div>
          ))}
        </div>
      )}
      {searchQuery.length >= 2 && searching && fullTextResults.length === 0 && (
        <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)' }}>
          <span className="loading-spinner" style={{ marginRight: 6 }} />搜索中...
        </div>
      )}

      {/* Action buttons */}
      <div style={{ padding: '6px 10px', display: 'flex', gap: 4, borderBottom: '1px solid var(--border-light)' }}>
        {multiSelect ? (
          <>
            <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={() => { setMultiSelect(false); setSelectedIds(new Set()); setConfirmBatchDelete(false) }}>
              取消
            </button>
            <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={() => {
              if (selectedIds.size === entries.length) setSelectedIds(new Set())
              else setSelectedIds(new Set(entries.map(e => e.id)))
            }}>
              {selectedIds.size === entries.length ? '取消全选' : '全选'}
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>{selectedIds.size} 项</span>
          </>
        ) : (
          <>
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }} onClick={() => importFiles()} title="导入文件">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>
            </button>
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }} onClick={() => importFolder()} title="导入文件夹">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="17" x2="12" y2="11"/><polyline points="9 14 12 11 15 14"/></svg>
            </button>
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }} onClick={handleNewFolder} title="新建分组">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
            </button>
            <button className="btn btn-sm btn-icon" style={{ flex: 1, justifyContent: 'center', padding: '6px 0' }} onClick={() => setMultiSelect(true)} title="多选">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="14" height="14" rx="2"/><polyline points="9 12 11 14 17 8"/></svg>
            </button>
          </>
        )}
      </div>

      {/* Batch actions bar */}
      {multiSelect && selectedIds.size > 0 && (
        <div style={{ padding: '5px 10px', display: 'flex', gap: 4, borderBottom: '1px solid var(--border-light)', background: 'var(--accent-soft)' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <button className="btn btn-sm" style={{ width: '100%', justifyContent: 'center', fontSize: 10 }}
              onClick={() => setShowMoveMenu(!showMoveMenu)}>
              移入分组 ▾
            </button>
            {showMoveMenu && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                padding: '2px 0', marginTop: 2,
              }}>
                <div onClick={() => handleBatchMove(undefined)}
                  style={{ padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  根目录
                </div>
                {folders.map(f => (
                  <div key={f.id} onClick={() => handleBatchMove(f.id)}
                    style={{ padding: '5px 10px', fontSize: 11, cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    {f.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={handleBatchRemove}>
            移除
          </button>
          <button className="btn btn-sm" style={{ fontSize: 10, color: 'var(--danger)', fontWeight: confirmBatchDelete ? 600 : 400 }} onClick={handleBatchDelete}>
            {confirmBatchDelete ? '确认删除?' : '删除'}
          </button>
        </div>
      )}

      {/* File list */}
      <div
        className="file-tree"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleRootDrop}
      >
        {entries.length === 0 ? (
          <div className="empty-state" style={{ padding: 24, fontSize: 12 }}>
            <span>点击上方按钮导入 PDF 文件</span>
          </div>
        ) : (
          <>
            {newFolderName !== null && (
              <div className="tree-item tree-folder" style={{ gap: 6 }}>
                <span className="icon" style={{ fontSize: 10 }}>▸</span>
                <input
                  ref={newFolderInputRef}
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onBlur={confirmNewFolder}
                  onKeyDown={e => { if (e.key === 'Enter') confirmNewFolder(); if (e.key === 'Escape') setNewFolderName(null) }}
                  placeholder="输入分组名称..."
                  autoFocus
                  style={{
                    flex: 1, border: '1px solid var(--accent)', borderRadius: 4,
                    padding: '1px 6px', fontSize: 13, outline: 'none', background: 'var(--bg)'
                  }}
                />
              </div>
            )}
            {!searchQuery && folders.map(f => <FolderItem key={f.id} folder={f} />)}
            {sorted.map(entry => (
              <EntryItem
                key={entry.id}
                entry={entry}
                multiSelect={multiSelect}
                selected={selectedIds.has(entry.id)}
                onToggleSelect={() => toggleSelect(entry.id)}
              />
            ))}
            {searchQuery && filtered.length === 0 && (
              <div className="empty-state" style={{ padding: 16, fontSize: 12 }}>无匹配结果</div>
            )}
          </>
        )}
      </div>
      {/* Web Scraper — shelved */}
      {false && (
        <div className="modal-overlay" onClick={() => setShowWebScraper(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, maxHeight: '80vh', overflow: 'auto' }}>
            <h3 style={{ marginBottom: 12 }}>在线获取资源</h3>

            {/* Open built-in browser for login-required sites */}
            <div style={{ padding: '10px 14px', marginBottom: 12, borderRadius: 8, background: 'var(--accent-soft)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>需要登录的网站？</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                打开内置浏览器 → 登录网站 → 导航到资源页 → 点击「扫描浏览器」
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }}
                  onClick={() => window.electronAPI?.openResourceBrowser?.(webUrl || undefined)}>
                  打开浏览器{webUrl ? '（前往该网址）' : ''}
                </button>
                <button className="btn btn-sm" style={{ fontSize: 11 }}
                  onClick={async () => {
                    if (!window.electronAPI?.scanBrowserResources) return
                    setWebLoading(true); setWebError(''); setWebResources([])
                    const result = await window.electronAPI.scanBrowserResources()
                    if (result.success) {
                      setWebResources(result.resources)
                      setWebPageTitle(result.title || '')
                      if (result.resources.length === 0) setWebError('浏览器页面上没有找到可下载资源')
                    } else {
                      setWebError(result.error || '请先打开浏览器并导航到资源页面')
                    }
                    setWebLoading(false)
                  }}>
                  扫描浏览器页面
                </button>
              </div>
            </div>

            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, textAlign: 'center' }}>
              — 或直接输入公开网页地址 —
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="输入网址，如 https://example.com/resources"
                value={webUrl}
                onChange={e => setWebUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScrape() }}
                style={{
                  flex: 1, padding: '8px 12px', border: '1px solid var(--border)',
                  borderRadius: 6, fontSize: 13, outline: 'none',
                  background: 'var(--bg-warm)', color: 'var(--text)',
                }}
              />
              <button
                className="btn btn-primary"
                onClick={handleScrape}
                disabled={webLoading || !webUrl.trim()}
                style={{ fontSize: 13, padding: '8px 16px' }}
              >
                {webLoading ? '扫描中...' : '扫描'}
              </button>
            </div>

            {webError && (
              <div style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 8 }}>{webError}</div>
            )}

            {webPageTitle && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                页面标题：{webPageTitle}
              </div>
            )}

            {webResources.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                发现 {webResources.length} 个可下载资源
              </div>
            )}

            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              {webResources.map((r, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  borderBottom: '1px solid var(--border-light)', fontSize: 12,
                }}>
                  <span style={{
                    padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                    background: r.ext === 'pdf' ? 'rgba(200,80,80,0.1)' : 'var(--accent-soft)',
                    color: r.ext === 'pdf' ? '#c05050' : 'var(--accent)',
                    flexShrink: 0,
                  }}>
                    {r.ext.toUpperCase()}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }} title={r.name}>
                    {r.name}
                  </span>
                  <button
                    className="btn btn-sm"
                    disabled={downloadingUrl === r.url}
                    onClick={async () => {
                      setDownloadingUrl(r.url); setDownloadProgress(0)
                      // Try browser download (uses authenticated session) first, fallback to direct
                      if (window.electronAPI?.browserDownload) {
                        window.electronAPI.browserDownload(r.url)
                        // The download will be handled by browser's will-download → auto import
                        setTimeout(() => setDownloadingUrl(null), 3000)
                      } else {
                        const cleanup = window.electronAPI.onDownloadResourceProgress?.((pct: number) => setDownloadProgress(pct))
                        try {
                          const result = await window.electronAPI.downloadResource(r.url, r.name)
                          cleanup?.()
                          if (result.success && result.path) {
                            const { importByPaths } = useLibraryStore.getState()
                            await importByPaths([result.path])
                          }
                        } catch {}
                        setDownloadingUrl(null)
                      }
                    }}
                    style={{ fontSize: 10, padding: '3px 10px', flexShrink: 0 }}
                  >
                    {downloadingUrl === r.url ? `${downloadProgress}%` : '下载导入'}
                  </button>
                </div>
              ))}
            </div>

            {webResources.length === 0 && !webLoading && webUrl && !webError && (
              <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                未发现可下载资源
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn" onClick={() => setShowWebScraper(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  async function handleScrape() {
    if (!webUrl.trim() || !window.electronAPI?.scrapeResources) return
    setWebLoading(true); setWebError(''); setWebResources([]); setWebPageTitle('')
    try {
      let url = webUrl.trim()
      if (!url.startsWith('http')) url = 'https://' + url
      const result = await window.electronAPI.scrapeResources(url)
      if (result.success) {
        setWebResources(result.resources)
        setWebPageTitle(result.pageTitle || '')
        if (result.resources.length === 0) setWebError('页面上没有找到可下载的文档资源')
      } else {
        setWebError(result.error || '扫描失败')
      }
    } catch (err: any) {
      setWebError(err.message || '网络错误')
    }
    setWebLoading(false)
  }
}

// ===== Main sidebar with tabs =====
export default function FileTree() {
  const { library } = useLibraryStore()
  const { sidebarTab, setSidebarTab, setActiveMemo } = useUiStore()

  const entries = library?.entries || []
  const memos = library?.memos || []

  return (
    <div className="sidebar">
      {/* Tab header */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--border-light)',
        flexShrink: 0,
      }}>
        <button
          onClick={() => setSidebarTab('library')}
          style={{
            flex: 1, padding: '10px 0', fontSize: 12, fontWeight: 600,
            border: 'none', cursor: 'pointer',
            background: sidebarTab === 'library' ? 'var(--bg)' : 'var(--bg-warm)',
            color: sidebarTab === 'library' ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: sidebarTab === 'library' ? '2px solid var(--accent)' : '2px solid transparent',
            transition: 'all 0.15s',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            文献库
            <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.7 }}>{entries.length}</span>
          </span>
        </button>
        <button
          onClick={() => { setSidebarTab('memos'); }}
          style={{
            flex: 1, padding: '10px 0', fontSize: 12, fontWeight: 600,
            border: 'none', cursor: 'pointer',
            background: sidebarTab === 'memos' ? 'var(--bg)' : 'var(--bg-warm)',
            color: sidebarTab === 'memos' ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: sidebarTab === 'memos' ? '2px solid var(--accent)' : '2px solid transparent',
            transition: 'all 0.15s',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            笔记
            {memos.length > 0 && <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.7 }}>{memos.length}</span>}
          </span>
        </button>
      </div>

      {/* Tab content */}
      {sidebarTab === 'library' ? (
        <LibraryPanel />
      ) : (
        <MemoList />
      )}
    </div>
  )
}
