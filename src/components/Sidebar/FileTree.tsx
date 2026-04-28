import { useState, useRef, useEffect, useLayoutEffect, memo, useMemo, useCallback, DragEvent, MouseEvent } from 'react'
import type { LibraryEntry, VirtualFolder } from '../../types/library'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import { openEntryById } from '../../utils/openEntryById'
import { generateBibTeX } from '../../utils/citations'
import MemoList from '../Memo/MemoList'
import ImeInput from '../common/ImeInput'
import { useConfirmDialog } from '../common/ConfirmDialog'

// Format a single library entry as a plain-text citation suitable for pasting
// into a footnote, email, or chat. Chicago-ish humanities convention:
//   "作者. 《标题》. 年份." (Chinese names, no parens)
//   "Author. Title. Year." (Western, no italics since it's plain text)
// We don't try to detect language — just join authors with "、" if Chinese-ish
// (any CJK character) else " and ".
function plainTextCitation(entry: LibraryEntry): string {
  const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s)
  const parts: string[] = []
  if (entry.authors.length > 0) {
    const sep = entry.authors.some(hasCjk) ? '、' : ' and '
    parts.push(entry.authors.join(sep) + '.')
  }
  if (entry.title) {
    const isChinese = hasCjk(entry.title)
    parts.push(isChinese ? `《${entry.title}》.` : `${entry.title}.`)
  }
  if (entry.year) parts.push(`${entry.year}.`)
  return parts.join(' ').trim()
}

// 2026-04-28 · 嵌套子分组:把 folder 树按 DFS 展平为 (folder, depth) 列表,
//   用于"移入分组"下拉菜单的缩进显示。父级在子级前面。坏 parentId(指向不存在
//   的 folder)的当作根级处理,避免数据损坏导致整棵树丢失。
function flattenFoldersWithDepth(folders: VirtualFolder[]): Array<{ folder: VirtualFolder; depth: number }> {
  if (!folders || folders.length === 0) return []
  const ids = new Set(folders.map(f => f.id))
  const childrenOf = new Map<string | undefined, VirtualFolder[]>()
  for (const f of folders) {
    const key = f.parentId && ids.has(f.parentId) ? f.parentId : undefined
    const arr = childrenOf.get(key) || []
    arr.push(f)
    childrenOf.set(key, arr)
  }
  const out: Array<{ folder: VirtualFolder; depth: number }> = []
  const dfs = (parentId: string | undefined, depth: number) => {
    const kids = childrenOf.get(parentId) || []
    for (const f of kids) {
      out.push({ folder: f, depth })
      dfs(f.id, depth + 1)
    }
  }
  dfs(undefined, 0)
  return out
}

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
  // 2026-04-28 · 防视口剪裁:右键点击靠近底/右边时,默认 top:pos.y 会让菜单
  //   伸出视口被切掉(用户截图)。useLayoutEffect 测量后翻转(底→上,右→左)。
  const [adjustedPos, setAdjustedPos] = useState(pos)

  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const PAD = 8
    let x = pos.x
    let y = pos.y
    if (x + r.width > vw - PAD) x = Math.max(PAD, vw - r.width - PAD)
    if (y + r.height > vh - PAD) y = Math.max(PAD, vh - r.height - PAD)
    if (x !== adjustedPos.x || y !== adjustedPos.y) setAdjustedPos({ x, y })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y])

  const style: React.CSSProperties = {
    position: 'fixed', left: adjustedPos.x, top: adjustedPos.y, zIndex: 1000,
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
// 2026-04-25 PERF · onToggleSelect 改成接 (id: string) => void —— 父组件可以用
// 稳定的 useCallback 引用传下来，不再每次 inline arrow 击穿 memo。
const EntryItem = memo(function EntryItem({ entry, multiSelect, selected, onToggleSelect }: {
  entry: LibraryEntry
  multiSelect?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
}) {
  // 2026-04-25 PERF · 进一步细化 —— 只订阅"我自己是否被选中"的 boolean，
  // 而不是订阅整个 currentEntry。这样切换打开的文件时，只有"上一个 active"和
  // "新 active"两个 EntryItem 重新计算 isActive，其他几十个文件 entry 完全 skip。
  const isActive = useLibraryStore(s => s.currentEntry?.id === entry.id)
  const openEntry = useLibraryStore(s => s.openEntry)
  const removeEntry = useLibraryStore(s => s.removeEntry)
  const deleteEntry = useLibraryStore(s => s.deleteEntry)
  const reorderEntry = useLibraryStore(s => s.reorderEntry)
  const setActiveMemo = useUiStore(s => s.setActiveMemo)
  const setActiveReadingLogDate = useUiStore(s => s.setActiveReadingLogDate)
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
          if (multiSelect) { onToggleSelect?.(entry.id); return }
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
            onChange={() => onToggleSelect?.(entry.id)}
            onClick={e => e.stopPropagation()}
            style={{ marginRight: 4, accentColor: 'var(--accent)' }}
          />
        ) : (
          <svg className="icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
        )}
        <div style={{ flex: 1, overflow: 'hidden' }} title={`${entry.title}\n${folder}`}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 13 }}>
            {entry.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {folder}
          </div>
        </div>
        <OcrStatusBadge entry={entry} />
        <style>{`
          @keyframes filetree-ocr-spin { to { transform: rotate(360deg); } }
        `}</style>
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
          onCopyCitation={() => {
            // Plain-text — works in Word, email, Notion, anything.
            const text = plainTextCitation(entry) || entry.title || ''
            navigator.clipboard?.writeText(text).catch(() => {})
            setMenuPos(null)
          }}
          onCopyBibTeX={() => {
            // generateBibTeX prepends a "% 拾卷导出..." header line — for a
            // single-entry copy that's noisy. Strip the comment header so the
            // clipboard contains just the @misc{...} block.
            const full = generateBibTeX([entry])
            const cleaned = full.split('\n').filter(l => !l.startsWith('%')).join('\n').trim()
            navigator.clipboard?.writeText(cleaned).catch(() => {})
            setMenuPos(null)
          }}
        />
      )}
    </>
  )
})

// Small status dot shown at the right edge of each entry row. Reflects the
// library's persisted ocrStatus field:
//   running  — blue spinner (entry currently being OCR'd by main process)
//   complete — green "OCR" pill (same as the old UI, kept to minimize churn)
//   failed   — red "!" with the error in the tooltip, clickable-looking
//   partial  — amber "OCR·半" (legacy half-complete runs)
//   none     — nothing rendered (don't clutter untouched entries)
// The fallback to ocrFilePath mirrors the old behavior: if the file is on disk
// we still count the entry as having OCR even if ocrStatus wasn't migrated.
function OcrStatusBadge({ entry }: { entry: LibraryEntry }) {
  // 2026-04-24 OCR badge 只对 PDF 显示 —— 其它格式（epub / docx / txt / md / html）
  // 本身就是文本，"OCR 完成" 徽章完全没意义还误导用户。
  const isPdf = entry.absPath.toLowerCase().endsWith('.pdf')
  if (!isPdf) return null
  const status = entry.ocrStatus
  if (status === 'running') {
    return (
      <span
        title={`正在 OCR...（${entry.ocrStatusUpdatedAt ? new Date(entry.ocrStatusUpdatedAt).toLocaleTimeString() : '' }）`}
        style={{
          flexShrink: 0, width: 14, height: 14, borderRadius: '50%',
          border: '2px solid rgba(74,144,226,0.25)',
          borderTopColor: '#4a90e2',
          animation: 'filetree-ocr-spin 0.8s linear infinite',
        }}
      />
    )
  }
  if (status === 'failed') {
    return (
      <span
        title={`OCR 失败：${entry.ocrError || '未知错误'}（在阅读栏点"重新 OCR"可以重试）`}
        style={{
          flexShrink: 0, fontSize: 9, color: '#fff', background: '#C97070',
          padding: '1px 5px', borderRadius: 3, fontWeight: 700, letterSpacing: 0.3,
        }}
      >
        !
      </span>
    )
  }
  if (status === 'partial') {
    return (
      <span
        title="OCR 不完整（历史数据，建议重新 OCR）"
        style={{
          flexShrink: 0, fontSize: 9, color: '#fff', background: '#D4A84B',
          padding: '1px 4px', borderRadius: 3, fontWeight: 500, letterSpacing: 0.5,
        }}
      >
        OCR·半
      </span>
    )
  }
  if (status === 'complete' || entry.ocrFilePath) {
    return (
      <span
        title="OCR 已完成"
        style={{
          flexShrink: 0, fontSize: 9, color: 'var(--success)',
          background: 'rgba(76,175,80,0.1)', padding: '1px 4px',
          borderRadius: 3, fontWeight: 500, letterSpacing: 0.5,
        }}
      >
        OCR
      </span>
    )
  }
  return null
}

// Two-step context menu for entry
function EntryContextMenu({ pos, confirmDelete, onClose, onRemove, onDeleteStep, onDeleteConfirm, onShowInFolder, onCopyCitation, onCopyBibTeX }: {
  pos: MenuPos
  confirmDelete: boolean
  onClose: () => void
  onRemove: () => void
  onDeleteStep: () => void
  onDeleteConfirm: () => void
  onShowInFolder: () => void
  onCopyCitation: () => void
  onCopyBibTeX: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 2026-04-28 · 同 ContextMenu 修法,防底/右边视口剪裁
  const [adjustedPos, setAdjustedPos] = useState(pos)

  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const PAD = 8
    let x = pos.x
    let y = pos.y
    if (x + r.width > vw - PAD) x = Math.max(PAD, vw - r.width - PAD)
    if (y + r.height > vh - PAD) y = Math.max(PAD, vh - r.height - PAD)
    if (x !== adjustedPos.x || y !== adjustedPos.y) setAdjustedPos({ x, y })
    // 注意 deps 故意只放 pos.x/y,confirmDelete 切换会让菜单高度变(出现"确认"按钮),
    // 一并触发重测以防变高后又被切。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y, confirmDelete])

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed', left: adjustedPos.x, top: adjustedPos.y, zIndex: 1000,
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
            onClick={onCopyCitation}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title="复制可粘贴到论文 / 邮件的纯文本引用"
          >
            复制引用（纯文本）
          </div>
          <div
            onClick={onCopyBibTeX}
            style={{ padding: '7px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title="复制 @misc{...} 格式，可粘贴到 Zotero / JabRef / LaTeX"
          >
            复制 BibTeX
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
// 2026-04-25 PERF · 用 memo 包裹 —— folder prop 是 LibraryFolder 对象
// （引用稳定除非内容变化），其他 props 没有，library subscription 内部独立
// 2026-04-28 · 嵌套子分组:FolderItem 递归渲染 child folders + 接收 folder drop
// 2026-04-28 · 多选透传:把 multiSelect / selectedIds / onToggleSelect 传给
//   分组内的 EntryItem,否则分组内的文献没有选中框(用户报)
const FolderItem = memo(function FolderItem({ folder, multiSelect, selectedIds, onToggleSelect }: {
  folder: VirtualFolder
  multiSelect?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}) {
  // Batch 43: 替换 window.confirm
  const { ask: askConfirm, dialog: confirmDialog } = useConfirmDialog()
  // 2026-04-25 PERF · 选择性订阅替代全量解构 —— 之前任何 store 字段变化都触发
  // 所有 FolderItem 重渲，文件多时显著卡顿
  const library = useLibraryStore(s => s.library)
  const moveEntryToFolder = useLibraryStore(s => s.moveEntryToFolder)
  const moveFolderToParent = useLibraryStore(s => s.moveFolderToParent)
  const createFolder = useLibraryStore(s => s.createFolder)
  const renameFolder = useLibraryStore(s => s.renameFolder)
  const deleteFolder = useLibraryStore(s => s.deleteFolder)
  const [expanded, setExpanded] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(folder.name)
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  // 2026-04-28 · 新建子分组的 inline 输入态(同根目录新建分组的体验)
  const [newSubName, setNewSubName] = useState<string | null>(null)

  // 2026-04-25 PERF · useMemo 缓存 filter+sort，library 不变时复用
  const entries = useMemo(
    () => (library?.entries.filter(e => e.folderId === folder.id) || [])
      .sort((a, b) => (a.sortIndex ?? 9999) - (b.sortIndex ?? 9999)),
    [library?.entries, folder.id],
  )
  // 2026-04-28 · 子分组列表(下面会递归 render)
  const childFolders = useMemo(
    () => (library?.folders || []).filter(f => f.parentId === folder.id),
    [library?.folders, folder.id],
  )

  const handleDragStart = (e: DragEvent) => {
    // 2026-04-28 · 让 folder 自身可拖动到其它 folder 形成嵌套
    e.dataTransfer.setData('folder-id', folder.id)
    e.dataTransfer.effectAllowed = 'move'
    e.stopPropagation()
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    // 2026-04-28 · 既支持 entry drop(移入分组)也支持 folder drop(嵌套子分组)
    const entryId = e.dataTransfer.getData('entry-id')
    if (entryId) { moveEntryToFolder(entryId, folder.id); return }
    const draggedFolderId = e.dataTransfer.getData('folder-id')
    if (draggedFolderId && draggedFolderId !== folder.id) {
      moveFolderToParent(draggedFolderId, folder.id)
    }
  }

  const handleRename = () => {
    if (editName.trim()) renameFolder(folder.id, editName.trim())
    setEditing(false)
  }

  const confirmNewSub = () => {
    const name = (newSubName || '').trim()
    if (name) {
      void createFolder(name, folder.id)
      setExpanded(true)  // 父分组确保展开,看得见新子分组
    }
    setNewSubName(null)
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
        draggable
        onDragStart={handleDragStart}
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
            // 2026-04-28 · 新建子分组入口
            { label: '新建子分组', onClick: () => { setExpanded(true); setNewSubName('') } },
            { label: '重命名', onClick: () => { setEditing(true); setEditName(folder.name) } },
            { label: '删除分组', danger: true, onClick: () => {
              const childCount = entries.length + childFolders.length
              const msg = childCount > 0
                ? `删除分组「${folder.name}」？\n\n分组内的 ${entries.length} 篇文献和 ${childFolders.length} 个子分组会被提到上一层（文件本身不会被删除）。`
                : `删除空分组「${folder.name}」？`
              askConfirm({
                title: '删除分组',
                message: msg,
                confirmLabel: '删除',
                danger: true,
                onConfirm: () => deleteFolder(folder.id),
              })
            } },
          ]}
        />
      )}
      {expanded && (
        <div style={{ paddingLeft: 14 }}>
          {/* 2026-04-28 · 新建子分组的 inline 输入框 */}
          {newSubName !== null && (
            <div className="tree-item tree-folder" style={{ gap: 6 }}>
              <span className="icon" style={{ fontSize: 10 }}>▸</span>
              <input
                value={newSubName}
                onChange={e => setNewSubName(e.target.value)}
                onBlur={confirmNewSub}
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmNewSub()
                  if (e.key === 'Escape') setNewSubName(null)
                }}
                placeholder="子分组名称..."
                autoFocus
                style={{
                  flex: 1, border: '1px solid var(--accent)', borderRadius: 4,
                  padding: '1px 6px', fontSize: 13, outline: 'none', background: 'var(--bg)',
                }}
              />
            </div>
          )}
          {/* 子分组先于本层 entries 显示,跟根级 folder/entry 排版一致。
              2026-04-28 · multiSelect props 沿 FolderItem 递归传下去,让分组内的
              文献也能在多选模式下出现选中框。 */}
          {childFolders.map(cf => (
            <FolderItem
              key={cf.id}
              folder={cf}
              multiSelect={multiSelect}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
            />
          ))}
          {entries.map(entry => (
            <EntryItem
              key={entry.id}
              entry={entry}
              multiSelect={multiSelect}
              selected={selectedIds?.has(entry.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </div>
      )}
      {/* Batch 43: ConfirmDialog 替代 window.confirm */}
      {confirmDialog}
    </div>
  )
})

// ===== Library panel (file tree content) =====
function LibraryPanel() {
  // 2026-04-25 PERF · 主组件选择性订阅
  const library = useLibraryStore(s => s.library)
  const importFiles = useLibraryStore(s => s.importFiles)
  const importFolder = useLibraryStore(s => s.importFolder)
  const createFolder = useLibraryStore(s => s.createFolder)
  const moveEntryToFolder = useLibraryStore(s => s.moveEntryToFolder)
  // 2026-04-28 · 批量移动用原子动作,避免 N 个并发 saveLibrary 互相覆盖
  const moveEntriesToFolder = useLibraryStore(s => s.moveEntriesToFolder)
  const removeEntry = useLibraryStore(s => s.removeEntry)
  const deleteEntry = useLibraryStore(s => s.deleteEntry)
  const openEntry = useLibraryStore(s => s.openEntry)
  const [searchQuery, setSearchQuery] = useState('')
  const [fullTextResults, setFullTextResults] = useState<Array<{
    entryId: string; entryTitle: string; type: 'ocr' | 'annotation';
    text: string; pageNumber?: number; annotationId?: string;
  }>>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Web scraper — shelved, code in _shelved_features/

  // Debounced full-text search
  // BUG-FIX SEARCH#1 · each debounced run is tagged with a generation counter;
  // if another query fires (or the component unmounts) before fullTextSearch
  // resolves, the stale results are dropped — prevents setState-on-unmounted
  // and also fixes "I typed 'machine' then 'matrix' and both are racing" where
  // the slower "machine" search overwrites the fresh "matrix" results.
  const searchGenRef = useRef(0)
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setFullTextResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    const gen = ++searchGenRef.current
    searchTimer.current = setTimeout(async () => {
      if (!window.electronAPI?.fullTextSearch || !library) return
      if (gen !== searchGenRef.current) return  // superseded before even starting
      setSearching(true)
      try {
        const results = await window.electronAPI.fullTextSearch(searchQuery, library)
        if (gen !== searchGenRef.current) return  // superseded during the await
        setFullTextResults(results)
      } catch {
        if (gen !== searchGenRef.current) return
        setFullTextResults([])
      }
      if (gen === searchGenRef.current) setSearching(false)
    }, 400)  // 400ms debounce
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      // Bump gen on cleanup so the in-flight run (if any) sees a mismatch
      // and skips its setState. Simpler than a bool flag.
      searchGenRef.current++
    }
  }, [searchQuery, library])
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const newFolderInputRef = useRef<HTMLInputElement>(null)
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)

  const entries = library?.entries || []
  // 2026-04-28 · 嵌套子分组:LibraryPanel 只渲染根级 folder,子级递归在 FolderItem 内部
  const allFolders = library?.folders || []
  const rootFolders = allFolders.filter(f => !f.parentId)

  // 2026-04-25 PERF · useCallback 稳定引用 —— inline arrow 会让所有 EntryItem
  // 的 memo 失效，列表多时显著浪费。函数式 setSelectedIds 让 deps 为空。
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

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
    // 2026-04-28 · 走原子批量,一次 set 一次 saveLibrary,所有 entry 在同一个
    //   newLibrary 里都改完,杜绝并发 IPC 互相覆盖导致"只剩一个"的 bug。
    void moveEntriesToFolder(Array.from(selectedIds), folderId)
    setSelectedIds(new Set())
    setMultiSelect(false)
    setShowMoveMenu(false)
  }

  // Batch OCR: filter to PDF entries that don't already have OCR, then queue them.
  const handleBatchOcr = () => {
    const { ocrQueue, startOcrQueue } = useUiStore.getState()
    if (ocrQueue.status === 'running') {
      alert('已有 OCR 任务在进行中，请等待完成或取消后重试。')
      return
    }
    if (!library) return

    const items = Array.from(selectedIds)
      .map(id => library.entries.find(e => e.id === id))
      .filter((e): e is LibraryEntry => !!e)
      .filter(e => e.absPath.toLowerCase().endsWith('.pdf'))
      .filter(e => e.ocrStatus !== 'complete')
      .map(e => ({ entryId: e.id, title: e.title, absPath: e.absPath }))

    if (items.length === 0) {
      alert('选中的文献中没有可 OCR 的 PDF（可能都已完成 OCR 或非 PDF 格式）')
      return
    }

    // Confirm with the user — batch OCR costs API tokens
    const ok = confirm(`将对 ${items.length} 个 PDF 执行批量 OCR（顺序执行，可随时取消）\n\n继续吗？`)
    if (!ok) return

    startOcrQueue(items)
    setSelectedIds(new Set())
    setMultiSelect(false)
  }

  // 2026-04-25 PERF · 把 filter + filter + sort 三个派生计算合到 useMemo 一次
  // 之前每次 render（任何 library / searchQuery 变化）都重做三遍，文件多时
  // 这是 sidebar 渲染的主要 cost
  const sorted = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const filtered = searchQuery
      ? entries.filter(e =>
          e.title.toLowerCase().includes(q) ||
          e.absPath.toLowerCase().includes(q) ||
          e.tags.some(t => t.includes(searchQuery))
        )
      : entries
    const rootEntries = searchQuery ? filtered : filtered.filter(e => !e.folderId)
    return [...rootEntries].sort((a, b) => {
      const ai = a.sortIndex ?? 9999
      const bi = b.sortIndex ?? 9999
      if (ai !== bi) return ai - bi
      const ta = a.lastOpenedAt || a.addedAt
      const tb = b.lastOpenedAt || b.addedAt
      return tb.localeCompare(ta)
    })
  }, [searchQuery, entries])

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

  const moveFolderToParent = useLibraryStore(s => s.moveFolderToParent)
  const handleRootDrop = (e: DragEvent) => {
    e.preventDefault()
    // 2026-04-28 · 同时支持 entry / folder drop 到根
    const entryId = e.dataTransfer.getData('entry-id')
    if (entryId) { moveEntryToFolder(entryId, undefined); return }
    const folderId = e.dataTransfer.getData('folder-id')
    if (folderId) moveFolderToParent(folderId, undefined)
  }

  return (
    <>
      {/* Search · 2026-04-25 PERF · 用通用 IME-aware ImeInput */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-light)' }}>
        <ImeInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索文献 / 全文搜索..."
          onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
          style={{
            width: '100%', padding: '7px 10px', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-xs)', fontSize: 12, outline: 'none',
            background: 'var(--bg-warm)', color: 'var(--text)', transition: 'border-color 0.2s',
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
              onClick={async () => {
                await openEntryById(r.entryId, {
                  annotationId: r.annotationId,
                  searchHighlight: { query: searchQuery, pageNumber: r.pageNumber },
                })
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
                // 2026-04-28 polish · 加宽到 220px(原继承父按钮宽度 ~80px,深嵌套挤
                //   到换行)。max-height + overflow:auto 防分组很多时溢出屏幕。
                position: 'absolute', top: '100%', left: 0, zIndex: 100,
                minWidth: 220, maxHeight: 320, overflow: 'auto',
                background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 6px 18px rgba(60,40,20,0.15)',
                padding: '4px 0', marginTop: 4,
                whiteSpace: 'nowrap',
              }}>
                <div onClick={() => handleBatchMove(undefined)}
                  style={{
                    padding: '7px 14px', fontSize: 12, cursor: 'pointer',
                    color: 'var(--text-secondary)',
                    transition: 'background 0.12s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  根目录
                </div>
                {(() => {
                  const flat = flattenFoldersWithDepth(allFolders)
                  if (flat.length === 0) return null
                  return (
                    <>
                      <div style={{ height: 1, background: 'var(--border-light)', margin: '2px 0' }} />
                      {/* 2026-04-28 polish · 嵌套层级靠 padding-left + 左侧细线表达,
                            不用 ↳ 这种字符前缀(深嵌套时一连串看着乱)。第一层 12px,
                            每深一级 +12px,左侧加 1px 暖灰竖线作为视觉锚点。 */}
                      {flat.map(({ folder: f, depth }) => (
                        <div key={f.id} onClick={() => handleBatchMove(f.id)}
                          style={{
                            padding: '7px 14px', paddingLeft: 14 + depth * 12,
                            fontSize: 12, cursor: 'pointer',
                            color: 'var(--text)',
                            position: 'relative',
                            transition: 'background 0.12s',
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          {/* depth>0 时画一条左侧细线表示是子级 */}
                          {depth > 0 && (
                            <span style={{
                              position: 'absolute',
                              left: 8 + (depth - 1) * 12 + 6, top: 4, bottom: 4,
                              width: 1,
                              background: 'var(--border-light)',
                              pointerEvents: 'none',
                            }} />
                          )}
                          {f.name}
                        </div>
                      ))}
                    </>
                  )
                })()}
              </div>
            )}
          </div>
          <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={handleBatchOcr} title="对选中的 PDF 批量执行 OCR">
            OCR
          </button>
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
          <div className="empty-state" style={{ padding: '28px 18px', fontSize: 12, lineHeight: 1.75, color: 'var(--text-muted)', textAlign: 'center' }}>
            <span>点上方＋ 或把文件<br />拖进窗口任意位置</span>
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
            {!searchQuery && rootFolders.map(f => (
              <FolderItem
                key={f.id}
                folder={f}
                multiSelect={multiSelect}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
              />
            ))}
            {sorted.map(entry => (
              <EntryItem
                key={entry.id}
                entry={entry}
                multiSelect={multiSelect}
                selected={selectedIds.has(entry.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
            {/* Batch 43 fix · `filtered` 是 useMemo 内 closure 变量外部访问不到（ReferenceError），
                 改用 `sorted`（filtered 排序后的等价数组） */}
            {searchQuery && sorted.length === 0 && (
              <div className="empty-state" style={{ padding: 16, fontSize: 12 }}>无匹配结果</div>
            )}
          </>
        )}
      </div>
    </>
  )
}

// ===== Main sidebar with tabs =====
export default function FileTree() {
  const library = useLibraryStore(s => s.library)
  const sidebarTab = useUiStore(s => s.sidebarTab)
  const setSidebarTab = useUiStore(s => s.setSidebarTab)
  const setActiveMemo = useUiStore(s => s.setActiveMemo)

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
            flex: 1, padding: '10px 0', fontSize: 12,
            fontWeight: sidebarTab === 'library' ? 500 : 400,
            letterSpacing: sidebarTab === 'library' ? '0.8px' : '0.4px',
            border: 'none', cursor: 'pointer',
            background: sidebarTab === 'library' ? 'var(--bg)' : 'var(--bg-warm)',
            color: sidebarTab === 'library' ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: sidebarTab === 'library' ? '1.5px solid var(--accent)' : '1.5px solid transparent',
            transition: 'color 220ms cubic-bezier(0.4, 0, 0.2, 1), background 220ms cubic-bezier(0.4, 0, 0.2, 1), border-color 220ms cubic-bezier(0.4, 0, 0.2, 1), letter-spacing 220ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            文献库
            <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.7, letterSpacing: 0 }}>{entries.length}</span>
          </span>
        </button>
        <button
          onClick={() => { setSidebarTab('memos'); }}
          style={{
            flex: 1, padding: '10px 0', fontSize: 12,
            fontWeight: sidebarTab === 'memos' ? 500 : 400,
            letterSpacing: sidebarTab === 'memos' ? '0.8px' : '0.4px',
            border: 'none', cursor: 'pointer',
            background: sidebarTab === 'memos' ? 'var(--bg)' : 'var(--bg-warm)',
            color: sidebarTab === 'memos' ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: sidebarTab === 'memos' ? '1.5px solid var(--accent)' : '1.5px solid transparent',
            transition: 'color 220ms cubic-bezier(0.4, 0, 0.2, 1), background 220ms cubic-bezier(0.4, 0, 0.2, 1), border-color 220ms cubic-bezier(0.4, 0, 0.2, 1), letter-spacing 220ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
            笔记
            {memos.length > 0 && <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.7, letterSpacing: 0 }}>{memos.length}</span>}
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
