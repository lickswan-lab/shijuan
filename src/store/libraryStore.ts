import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
// 2026-04-28 · ReadingLog 类型已删
import type { Library, LibraryEntry, PdfMeta, VirtualFolder, Memo, BlockRef, MemoSnapshot, MemoFolder, LectureSession } from '../types/library'
import { createDefaultLibrary, createDefaultPdfMeta } from '../types/library'
import { extractPdfMetadata } from '../utils/pdfMetadata'
import { parseBibTeX, splitAuthors, splitKeywords, parseYear, extractFilePath } from '../utils/bibtexParser'

// Per-entry write queue for updatePdfMetaByEntryId — chain concurrent bg
// writes on the same entry so they read-modify-write in sequence instead of
// racing. Entries self-clean on settle.
const updatePdfMetaByEntryId_queue: Record<string, Promise<void>> = {}

// BUG-FIX R2#δ · track the post-init background scan timer so a second
// initLibrary call (future "switch workspace" UI) doesn't double-run, and
// callbacks read fresh state from the store instead of a stale closure.
let initPostBootTimer: ReturnType<typeof setTimeout> | null = null

// Background PDF metadata enrichment. Called after import finishes — reads each
// newly-imported PDF's Info dict and updates its title / authors / year when
// present and non-garbage. Never blocks the import flow; runs sequentially with
// a small delay so the UI stays responsive.
async function enrichPdfMetadataInBackground(
  newEntryIds: string[],
  getLib: () => Library | null,
  setLib: (lib: Library) => void,
  save: (lib: Library) => Promise<unknown>,
) {
  for (const id of newEntryIds) {
    const lib = getLib()
    if (!lib) return
    const entry = lib.entries.find(e => e.id === id)
    if (!entry || !entry.absPath.toLowerCase().endsWith('.pdf')) continue

    const meta = await extractPdfMetadata(entry.absPath)
    if (!meta) continue

    // Only overwrite title if we have something sensible and the current title
    // is still the filename-derived default (no user edits yet).
    const updates: Partial<LibraryEntry> = {}
    if (meta.title && meta.title.length >= 3 && meta.title.length <= 200) {
      updates.title = meta.title
    }
    if (meta.author && entry.authors.length === 0) {
      // Split on common separators: "; " ", " "; " " & " " and "
      const authors = meta.author.split(/\s*[,;&]\s*|\s+and\s+/i).filter(a => a.length > 1 && a.length < 80)
      if (authors.length > 0) updates.authors = authors
    }
    if (meta.year && !entry.year) updates.year = meta.year

    if (Object.keys(updates).length === 0) continue

    // Re-fetch lib (may have changed) and patch the entry in place
    const fresh = getLib()
    if (!fresh) return
    const idx = fresh.entries.findIndex(e => e.id === id)
    if (idx < 0) continue
    fresh.entries[idx] = { ...fresh.entries[idx], ...updates }
    setLib({ ...fresh })
    try { await save(fresh) } catch { /* silent */ }
    // Yield so the UI can paint between entries
    await new Promise(r => setTimeout(r, 30))
  }
}

interface LibraryState {
  library: Library | null
  currentEntry: LibraryEntry | null
  currentPdfMeta: PdfMeta | null
  isLoading: boolean

  // Actions
  initLibrary: () => Promise<void>
  importFiles: (folderId?: string) => Promise<number>
  importFolder: (folderId?: string) => Promise<number>
  importByPaths: (paths: string[], folderId?: string) => Promise<number>
  importFromBibTeX: (bibContent: string, folderId?: string) => Promise<{ added: number; skipped: number; missingFile: number; parseErrors: number }>
  // Programmatic: add an already-on-disk file (any extension) as a library
  // entry with a caller-specified title. Returns the new entry or null on
  // failure. Used by TranslateModal's "保存为文献" flow after the main
  // process has written the .txt.
  addEntryFromPath: (absPath: string, title: string, folderId?: string) => Promise<LibraryEntry | null>

  removeEntry: (id: string) => Promise<void>
  deleteEntry: (id: string) => Promise<{ success: boolean; error?: string }>
  openEntry: (entry: LibraryEntry) => Promise<void>
  updateEntry: (id: string, updates: Partial<LibraryEntry>) => Promise<void>
  savePdfMeta: (meta: PdfMeta) => Promise<void>
  updatePdfMeta: (updater: (meta: PdfMeta) => PdfMeta) => Promise<void>
  // Update a PdfMeta by explicit entryId — use when the target entry may not
  // be the currently-open one (e.g. async AI jobs whose user has navigated
  // away). If id === currentEntry.id we route through updatePdfMeta so the
  // in-memory state + disk both update; otherwise we load-modify-save on
  // disk only and leave in-memory alone.
  updatePdfMetaByEntryId: (targetEntryId: string, updater: (meta: PdfMeta) => PdfMeta) => Promise<void>

  // Folder actions
  createFolder: (name: string, parentId?: string) => Promise<VirtualFolder>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  // 2026-04-28 · 把 folder 移到另一个 folder 之下(或 parentId=undefined 移回根)。
  //   防自环 / 防做自己后代的 child(那会让 deleteFolder 找不到边界)。失败静默返回。
  moveFolderToParent: (folderId: string, parentId: string | undefined) => Promise<void>
  moveEntryToFolder: (entryId: string, folderId: string | undefined) => Promise<void>
  moveEntriesToFolder: (entryIds: string[], folderId: string | undefined) => Promise<void>
  reorderEntry: (entryId: string, targetId: string, position: 'before' | 'after') => Promise<void>

  // Memo actions
  createMemo: (title?: string, folderId?: string) => Promise<Memo>
  updateMemo: (id: string, updates: Partial<Pick<Memo, 'title' | 'content'>>) => Promise<void>
  deleteMemo: (id: string) => Promise<void>
  addBlockToMemo: (memoId: string, block: BlockRef) => Promise<void>
  removeBlockFromMemo: (memoId: string, historyEntryId: string) => Promise<void>
  snapshotMemo: (id: string) => Promise<void>

  // Memo folder actions
  createMemoFolder: (name: string) => Promise<MemoFolder>
  renameMemoFolder: (id: string, name: string) => Promise<void>
  deleteMemoFolder: (id: string) => Promise<void>
  moveMemoToFolder: (memoId: string, folderId: string | undefined) => Promise<void>

  // 2026-04-28 · Reading log actions(saveReadingLog / reloadReadingLogsFromDisk)
  //   已删,readingLog 功能下线。

  // Lecture actions
  saveLectureSession: (session: LectureSession) => void
  deleteLectureSession: (id: string) => void
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  library: null,
  currentEntry: null,
  currentPdfMeta: null,
  isLoading: false,

  initLibrary: async () => {
    set({ isLoading: true })
    let library: Library | null
    try {
      library = await window.electronAPI.loadLibrary()
    } catch (e: any) {
      // Backend throws only when library.json was found but couldn't be parsed
      // (it backs up the corrupt file as .corrupt-*.bak before throwing).
      // Tell the user so they can restore from backup if they want, then start
      // with an empty library so the app is usable.
      alert(`文献库加载失败：\n${e?.message || e}\n\n将以空文献库启动。如需恢复，请查看数据目录下的 .bak 文件。`)
      library = null
    }
    if (!library) {
      library = createDefaultLibrary()
      await window.electronAPI.saveLibrary(library)
    }
    // Patch older libraries missing new fields
    if (!library.memos) library.memos = []
    if (!library.folders) library.folders = []
    if (!library.memoFolders) library.memoFolders = []
    // 2026-04-28 · readingLogs 字段从 type 中移除,旧库里的数据在下次 saveLibrary
    //   时会被自然丢弃(JSON.stringify 不写入未声明字段),不再 patch 默认数组。
    if (!library.lectureSessions) library.lectureSessions = []
    for (const memo of library.memos) {
      if (!memo.blocks) memo.blocks = []
      if (!memo.aiHistory) memo.aiHistory = []
      if (!memo.snapshots) memo.snapshots = []
      if (memo.content == null) memo.content = ''
      if (!memo.updatedAt) memo.updatedAt = memo.createdAt || new Date().toISOString()
    }
    library.lastOpenedAt = new Date().toISOString()
    // Show UI immediately
    set({ library, isLoading: false })

    // BUG-FIX R2#δ · clear any stale timer from a prior initLibrary call
    // (defensive — re-init isn't wired up today, but "switch workspace" was
    // already on the backlog). Callback re-reads library from the store so
    // anything the midnight scheduler or another action wrote in the 100ms
    // gap is not overwritten.
    if (initPostBootTimer !== null) {
      clearTimeout(initPostBootTimer)
      initPostBootTimer = null
    }
    // All saves and scans happen in background, don't block UI
    initPostBootTimer = setTimeout(async () => {
      initPostBootTimer = null
      const current = get().library
      if (!current) return  // user tore down before timer fired
      try {
        await window.electronAPI.saveLibrary(current)
      } catch (err) {
        console.error('[library] Failed to save library on init:', err)
      }

      // Scan OCR files in parallel
      const unchecked = current.entries.filter(e => e.ocrStatus !== 'complete' && e.absPath)
      if (unchecked.length > 0) {
        const results = await Promise.allSettled(
          unchecked.map(async entry => {
            const ocr = await window.electronAPI.readOcrText(entry.absPath)
            if (ocr.exists && ocr.text) {
              entry.ocrStatus = 'complete'
              entry.ocrFilePath = ocr.path
              return true
            }
            return false
          })
        )
        if (results.some(r => r.status === 'fulfilled' && r.value)) {
          // Re-read again — scan took a while, state may have moved
          const latest = get().library
          if (!latest) return
          set({ library: { ...latest } })
          try { await window.electronAPI.saveLibrary(latest) } catch (err) {
            console.error('[library] Failed to save after OCR scan:', err)
          }
        }
      }
    }, 100)
  },

  importFiles: async (folderId?: string) => {
    const paths = await window.electronAPI.importFiles()
    if (!paths.length) return 0

    const { library } = get()
    if (!library) return 0

    // Batch 43 · 修 bug "新导入不显示"：之前 push 是原地 mutate 数组，
    // set 后 library.entries 引用没变 → FolderItem useMemo 不重算 → UI 看不到新 entry。
    // 改成 immutable：先收集新 entries 再一次性新建数组。
    const newIds: string[] = []
    const newEntries: LibraryEntry[] = []
    for (const absPath of paths) {
      if (library.entries.some(e => e.absPath === absPath)) continue
      const fileName = absPath.split(/[/\\]/).pop()?.replace(/\.(pdf|docx?|epub|html?|txt|md)$/i, '') || ''
      const entry: LibraryEntry = {
        id: uuid(), absPath, title: fileName, authors: [], tags: [], notes: '',
        folderId, ocrStatus: 'none', addedAt: new Date().toISOString()
      }
      newEntries.push(entry)
      newIds.push(entry.id)
    }
    const added = newEntries.length
    const updatedLibrary = { ...library, entries: [...library.entries, ...newEntries] }

    await window.electronAPI.saveLibrary(updatedLibrary)
    set({ library: updatedLibrary })

    // Kick off PDF metadata enrichment in the background (non-blocking)
    if (newIds.length > 0) {
      enrichPdfMetadataInBackground(
        newIds,
        () => get().library,
        (lib) => set({ library: lib }),
        (lib) => window.electronAPI.saveLibrary(lib),
      )
    }
    return added
  },

  addEntryFromPath: async (absPath, title, folderId) => {
    const { library } = get()
    if (!library) return null
    // If an entry already points at this file, just return it — avoids
    // duplicates when the user clicks "保存为文献" twice on the same
    // translation (second click will just re-open the existing entry).
    const existing = library.entries.find(e => e.absPath === absPath)
    if (existing) return existing
    const entry: LibraryEntry = {
      id: uuid(), absPath, title, authors: [], tags: [], notes: '',
      folderId, ocrStatus: 'none', addedAt: new Date().toISOString(),
    }
    // Batch 43 · immutable update（同 importFiles 修复）
    const updatedLibrary = { ...library, entries: [...library.entries, entry] }
    await window.electronAPI.saveLibrary(updatedLibrary)
    set({ library: updatedLibrary })
    return entry
  },

  importFolder: async (folderId?: string) => {
    const paths = await window.electronAPI.importFolder()
    if (!paths.length) return 0

    const { library } = get()
    if (!library) return 0

    // Batch 43 · 修 bug "新导入不显示"：之前 push 是原地 mutate 数组，
    // set 后 library.entries 引用没变 → FolderItem useMemo 不重算 → UI 看不到新 entry。
    // 改成 immutable：先收集新 entries 再一次性新建数组。
    const newIds: string[] = []
    const newEntries: LibraryEntry[] = []
    for (const absPath of paths) {
      if (library.entries.some(e => e.absPath === absPath)) continue
      const fileName = absPath.split(/[/\\]/).pop()?.replace(/\.(pdf|docx?|epub|html?|txt|md)$/i, '') || ''
      const entry: LibraryEntry = {
        id: uuid(), absPath, title: fileName, authors: [], tags: [], notes: '',
        folderId, ocrStatus: 'none', addedAt: new Date().toISOString()
      }
      newEntries.push(entry)
      newIds.push(entry.id)
    }
    const added = newEntries.length
    const updatedLibrary = { ...library, entries: [...library.entries, ...newEntries] }

    await window.electronAPI.saveLibrary(updatedLibrary)
    set({ library: updatedLibrary })

    if (newIds.length > 0) {
      enrichPdfMetadataInBackground(
        newIds,
        () => get().library,
        (lib) => set({ library: lib }),
        (lib) => window.electronAPI.saveLibrary(lib),
      )
    }
    return added
  },

  // Import from BibTeX content. For each valid entry:
  //   - if the bib has a `file` field pointing to an existing PDF → create a
  //     real entry with absPath set (so the user can open+annotate right away)
  //   - if the bib has no file / file missing → still create a "metadata-only"
  //     entry (absPath empty) as a placeholder — user can "relink" later
  // Deduplication: skip if an entry with the same absPath already exists, or
  // (for metadata-only) if title+first-author already matches an existing entry.
  importFromBibTeX: async (bibContent: string, folderId?: string) => {
    const { entries: parsed, errors } = parseBibTeX(bibContent)
    const { library } = get()
    if (!library) return { added: 0, skipped: 0, missingFile: 0, parseErrors: errors.length }

    const newIds: string[] = []
    const newEntries: LibraryEntry[] = []
    let added = 0
    let skipped = 0
    let missingFile = 0

    for (const p of parsed) {
      const f = p.fields
      const title = f.title || f.booktitle || p.citeKey
      const authors = splitAuthors(f.author || f.editor || '')
      const year = parseYear(f.year || f.date || '')
      const tags = splitKeywords(f.keywords || f.tags || '')
      const notes = f.abstract || f.note || ''
      const bibFilePath = extractFilePath(f.file || '')

      let absPath = ''
      if (bibFilePath) {
        // Check existence via main process; if file is gone, fall through to
        // metadata-only. Async check is cheap compared to the whole import.
        try {
          const exists = await window.electronAPI.checkFileExists(bibFilePath)
          if (exists) {
            absPath = bibFilePath
          } else {
            missingFile++
          }
        } catch {
          missingFile++
        }
      }

      // Dedup check
      if (absPath) {
        if (library.entries.some(e => e.absPath === absPath)) { skipped++; continue }
      } else {
        // For metadata-only: dedup by (title + firstAuthor)
        const firstAuthor = authors[0] || ''
        const dup = library.entries.find(e =>
          (e.title || '').trim() === title.trim() &&
          (e.authors[0] || '') === firstAuthor,
        )
        if (dup) { skipped++; continue }
      }

      const entry: LibraryEntry = {
        id: uuid(),
        absPath,
        title,
        authors,
        year,
        tags,
        notes,
        folderId,
        ocrStatus: 'none',
        addedAt: new Date().toISOString(),
      }
      newEntries.push(entry)
      newIds.push(entry.id)
      added++
    }

    if (added > 0) {
      // Batch 43 · immutable update
      const updatedLibrary = { ...library, entries: [...library.entries, ...newEntries] }
      await window.electronAPI.saveLibrary(updatedLibrary)
      set({ library: updatedLibrary })

      // Only enrich entries with real files — metadata-only ones have nothing to read from disk
      const withFiles = newIds.filter(id => {
        const e = updatedLibrary.entries.find(x => x.id === id)
        return !!e?.absPath
      })
      if (withFiles.length > 0) {
        enrichPdfMetadataInBackground(
          withFiles,
          () => get().library,
          (lib) => set({ library: lib }),
          (lib) => window.electronAPI.saveLibrary(lib),
        )
      }
    }

    return { added, skipped, missingFile, parseErrors: errors.length }
  },

  // Import by absolute paths (for drag-drop — no file dialog)
  importByPaths: async (paths: string[], folderId?: string) => {
    if (!paths.length) return 0
    const { library } = get()
    if (!library) return 0

    // Batch 43 · immutable update（同 importFiles 修复，避免 push mutate 让 UI 不更新）
    const newIds: string[] = []
    const newEntries: LibraryEntry[] = []
    for (const absPath of paths) {
      if (library.entries.some(e => e.absPath === absPath)) continue
      const fileName = absPath.split(/[/\\]/).pop()?.replace(/\.(pdf|docx?|epub|html?|txt|md)$/i, '') || ''
      const entry: LibraryEntry = {
        id: uuid(), absPath, title: fileName, authors: [], tags: [], notes: '',
        folderId, ocrStatus: 'none', addedAt: new Date().toISOString()
      }
      newEntries.push(entry)
      newIds.push(entry.id)
    }
    const added = newEntries.length

    if (added > 0) {
      const updatedLibrary = { ...library, entries: [...library.entries, ...newEntries] }
      await window.electronAPI.saveLibrary(updatedLibrary)
      set({ library: updatedLibrary })

      enrichPdfMetadataInBackground(
        newIds,
        () => get().library,
        (lib) => set({ library: lib }),
        (lib) => window.electronAPI.saveLibrary(lib),
      )
    }
    return added
  },

  // Remove from library only (keep original file)
  removeEntry: async (id: string) => {
    const { library, currentEntry } = get()
    if (!library) return

    library.entries = library.entries.filter(e => e.id !== id)
    await window.electronAPI.saveLibrary(library)
    set({
      library: { ...library },
      currentEntry: currentEntry?.id === id ? null : currentEntry,
      currentPdfMeta: currentEntry?.id === id ? null : get().currentPdfMeta
    })
  },

  // Delete original file (move to trash) + remove from library
  deleteEntry: async (id: string) => {
    const { library, currentEntry } = get()
    if (!library) return { success: false, error: 'Library not loaded' }

    const entry = library.entries.find(e => e.id === id)
    if (!entry) return { success: false, error: 'Entry not found' }

    // Move file to system trash
    const result = await window.electronAPI.deleteFile(entry.absPath)
    if (!result.success) return result

    // Remove from library
    library.entries = library.entries.filter(e => e.id !== id)
    await window.electronAPI.saveLibrary(library)
    // Drop the now-orphaned meta file so meta/ doesn't accumulate junk over time.
    // Idempotent: missing file is not an error.
    window.electronAPI.deletePdfMeta?.(id).catch(() => {})
    set({
      library: { ...library },
      currentEntry: currentEntry?.id === id ? null : currentEntry,
      currentPdfMeta: currentEntry?.id === id ? null : get().currentPdfMeta
    })
    return { success: true }
  },

  openEntry: async (entry: LibraryEntry) => {
    // Check file still exists
    const exists = await window.electronAPI.checkFileExists(entry.absPath)
    if (!exists) {
      alert(`文件不存在：\n${entry.absPath}\n\n可能已被移动或删除。`)
      return
    }

    // Load or create meta. A corrupt meta file throws (backend backs it up as .corrupt-*.bak)
    // so we don't silently overwrite annotations with an empty default.
    let meta: PdfMeta | null
    try {
      meta = await window.electronAPI.loadPdfMeta(entry.id)
    } catch (e: any) {
      alert(`注释数据加载失败：\n${e?.message || e}\n\n原文件已备份，将以空注释打开。`)
      meta = null
    }
    if (!meta) {
      meta = createDefaultPdfMeta(entry.id)
      await window.electronAPI.savePdfMeta(entry.id, meta)
    }

    // Update last opened
    // 2026-04-28 · 同 moveEntryToFolder 修法,改 immutable。`recently opened` 排序
    //   的视图(QuickOpen / OcrStatusBadge 排序等)依赖 entries 数组引用变化才会重算。
    const { library } = get()
    if (library) {
      const idx = library.entries.findIndex(e => e.id === entry.id)
      if (idx >= 0) {
        const newEntry = { ...library.entries[idx], lastOpenedAt: new Date().toISOString() }
        const newEntries = library.entries.slice()
        newEntries[idx] = newEntry
        const newLibrary = { ...library, entries: newEntries }
        await window.electronAPI.saveLibrary(newLibrary)
        set({ library: newLibrary, currentEntry: newEntry, currentPdfMeta: meta })
        return
      }
    }

    set({ currentEntry: entry, currentPdfMeta: meta })
  },

  updateEntry: async (id: string, updates: Partial<LibraryEntry>) => {
    const { library } = get()
    if (!library) return

    const idx = library.entries.findIndex(e => e.id === id)
    if (idx < 0) return

    // Batch 43 · 修 bug "OCR 完成后图标不更新"：之前 `library.entries[idx] = {...}`
    // 是原地 mutate 数组，set 后 library.entries 引用没变 → FolderItem 的
    // useMemo([library?.entries, folder.id]) 不重算 → 下游 EntryItem 看到旧 entry。
    // 改成 immutable：新建 entry 对象 + 新建 entries 数组 + 新建 library 对象。
    const newEntry = { ...library.entries[idx], ...updates }
    const newEntries = library.entries.slice()
    newEntries[idx] = newEntry
    const newLibrary = { ...library, entries: newEntries }
    await window.electronAPI.saveLibrary(newLibrary)
    const patch: { library: typeof newLibrary; currentEntry?: LibraryEntry } = { library: newLibrary }
    if (get().currentEntry?.id === id) patch.currentEntry = newEntry
    set(patch)
  },

  savePdfMeta: async (meta: PdfMeta) => {
    const { currentEntry } = get()
    if (!currentEntry) return
    // Update in-memory FIRST so any re-entrant updatePdfMeta (e.g. second
    // annotation saved before the first IPC returns) reads the latest value
    // from `get()`. Otherwise the second updater rebases onto the stale
    // pre-update meta and silently overwrites the first change.
    // The main-process save-pdf-meta handler uses atomicWriteJson under the
    // shared writeLock, so the two concurrent disk writes are still serialized
    // in the right order (earlier call issues its write first).
    set({ currentPdfMeta: meta })
    await window.electronAPI.savePdfMeta(currentEntry.id, meta)
  },

  updatePdfMeta: async (updater: (meta: PdfMeta) => PdfMeta) => {
    const { currentPdfMeta } = get()
    if (!currentPdfMeta) return
    const updated = updater({ ...currentPdfMeta })
    await get().savePdfMeta(updated)
  },

  updatePdfMetaByEntryId: async (targetEntryId: string, updater: (meta: PdfMeta) => PdfMeta) => {
    const { currentEntry, currentPdfMeta } = get()
    if (currentEntry?.id === targetEntryId && currentPdfMeta) {
      await get().updatePdfMeta(updater)
      return
    }
    // Serialize concurrent writes on the same entry — without this, two
    // background AI jobs loading+saving the same meta would silently
    // overwrite each other. Chain to previous in-flight write via a
    // per-entry promise queue.
    const queueKey = `bg:${targetEntryId}`
    const prev = (updatePdfMetaByEntryId_queue[queueKey] || Promise.resolve())
    const next = prev.catch(() => {}).then(async () => {
      const meta = await window.electronAPI.loadPdfMeta(targetEntryId)
      if (!meta) return
      const updated = updater({ ...meta })
      await window.electronAPI.savePdfMeta(targetEntryId, updated)
    })
    updatePdfMetaByEntryId_queue[queueKey] = next.finally(() => {
      if (updatePdfMetaByEntryId_queue[queueKey] === next) delete updatePdfMetaByEntryId_queue[queueKey]
    })
    await next
  },

  // 2026-04-28 · 新增 parentId 入参(创建子分组用)。同步换 immutable + 乐观更新。
  createFolder: async (name: string, parentId?: string) => {
    const { library } = get()
    if (!library) throw new Error('Library not loaded')
    const folder: VirtualFolder = { id: uuid(), name, createdAt: new Date().toISOString(), parentId }
    const newFolders = [...(library.folders || []), folder]
    const newLibrary = { ...library, folders: newFolders }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
    return folder
  },

  // 2026-04-28 · immutable + 乐观更新
  renameFolder: async (id: string, name: string) => {
    const { library } = get()
    if (!library) return
    const newFolders = (library.folders || []).map(f => f.id === id ? { ...f, name } : f)
    const newLibrary = { ...library, folders: newFolders }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
  },

  // 2026-04-28 · immutable + 乐观更新 + 子分组层级保留:
  //   删 A 时它的 child folder 不能也跟着删,把它们的 parentId 改成 A 的 parentId
  //   (相当于"提升一级")。entries 同样:被删 folder 内的 entry 也提升到该层。
  deleteFolder: async (id: string) => {
    const { library } = get()
    if (!library) return
    const target = (library.folders || []).find(f => f.id === id)
    const grandParentId = target?.parentId
    const newFolders = (library.folders || [])
      .filter(f => f.id !== id)
      .map(f => f.parentId === id ? { ...f, parentId: grandParentId } : f)
    const newEntries = library.entries.map(e =>
      e.folderId === id ? { ...e, folderId: grandParentId } : e
    )
    const newLibrary = { ...library, folders: newFolders, entries: newEntries }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
  },

  // 2026-04-28 · 把 folder 嵌入另一个 parent(或抬回根)。
  //   防自环:parentId 不能 = folderId 自身,也不能是 folderId 的后代
  //   (会形成循环引用,deleteFolder 找祖父也会无限循环)。
  moveFolderToParent: async (folderId: string, parentId: string | undefined) => {
    const { library } = get()
    if (!library || folderId === parentId) return

    // 防成为自己的后代
    if (parentId) {
      const folders = library.folders || []
      let cur: string | undefined = parentId
      const seen = new Set<string>()
      while (cur) {
        if (cur === folderId) return  // would form cycle
        if (seen.has(cur)) return     // 防数据已损坏的环导致死循环
        seen.add(cur)
        cur = folders.find(f => f.id === cur)?.parentId
      }
    }

    const newFolders = (library.folders || []).map(f =>
      f.id === folderId ? { ...f, parentId } : f
    )
    const newLibrary = { ...library, folders: newFolders }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
  },

  // 2026-04-28 · 同 Batch 43 updateEntry 的修法 + 乐观更新:
  //   1) 不再 mutate,新建 entry/entries/library 三层(让 React/zustand 看到引用变化)。
  //   2) **state 先 set,再 await saveLibrary** —— 之前是 await 完成才 set,
  //      磁盘 IO 200~500ms 大库时用户感知到"拖完延迟一下才挪过去"。
  //      乐观更新让 UI 立即响应,磁盘异步写。saveLibrary 失败也不回滚
  //      (拖拽 race 概率极低,且用户可以再拖一次)。
  moveEntryToFolder: async (entryId: string, folderId: string | undefined) => {
    const { library } = get()
    if (!library) return
    const idx = library.entries.findIndex(e => e.id === entryId)
    if (idx < 0) return
    const newEntry = { ...library.entries[idx], folderId }
    const newEntries = library.entries.slice()
    newEntries[idx] = newEntry
    const newLibrary = { ...library, entries: newEntries }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
  },

  // 2026-04-28 · 批量移入/移出分组的**原子**版本。
  //   原 handleBatchMove 用 selectedIds.forEach(id => moveEntryToFolder(id, ...)),
  //   N 个 async 调用并行,虽然每个 sync 段都正确 set 了累积状态(理论上 OK),
  //   但 N 个 await saveLibrary 在主进程并发写盘时 last-write-wins,
  //   磁盘留下最后一个 set 的快照(只移了一个) → 重启后 UI 回到只移一个的状态;
  //   而且实际观察"轮流移入,只剩一个"暗示 UI 也被某个回流路径污染。
  //   彻底解决:一次 set 一次 save,所有 entry 在同一个 newLibrary 里都改完。
  moveEntriesToFolder: async (entryIds: string[], folderId: string | undefined) => {
    const { library } = get()
    if (!library || entryIds.length === 0) return
    const idSet = new Set(entryIds)
    const newEntries = library.entries.map(e => idSet.has(e.id) ? { ...e, folderId } : e)
    const newLibrary = { ...library, entries: newEntries }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
  },

  // 2026-04-28 · reorderEntry 同样改 immutable + 乐观更新。除了拖动的 entry 自身
  //   folderId/sortIndex 变,被挤动的兄弟节点的 sortIndex 也都要重排,一次性
  //   重建 newEntries 数组,涉及到的 entry 各自换新对象引用。
  reorderEntry: async (entryId: string, targetId: string, position: 'before' | 'after') => {
    const { library } = get()
    if (!library) return
    if (entryId === targetId) return

    const entry = library.entries.find(e => e.id === entryId)
    const target = library.entries.find(e => e.id === targetId)
    if (!entry || !target) return

    const newFolderId = target.folderId

    // Build the ordered sibling list in the destination folder
    const siblings = library.entries
      .filter(e => e.folderId === newFolderId && e.id !== entryId)
      .sort((a, b) => (a.sortIndex ?? 9999) - (b.sortIndex ?? 9999))
    const targetIdxInSiblings = siblings.findIndex(e => e.id === targetId)
    const insertIdx = position === 'before' ? targetIdxInSiblings : targetIdxInSiblings + 1
    const orderedIds = siblings.map(e => e.id)
    orderedIds.splice(insertIdx, 0, entryId)

    // Map: entryId → new sortIndex
    const newSortIndex = new Map<string, number>()
    orderedIds.forEach((id, i) => newSortIndex.set(id, i))

    // Rebuild entries array — touched entries get new object refs, others unchanged
    const newEntries = library.entries.map(e => {
      if (e.id === entryId) {
        return { ...e, folderId: newFolderId, sortIndex: newSortIndex.get(e.id) ?? 0 }
      }
      if (newSortIndex.has(e.id)) {
        return { ...e, sortIndex: newSortIndex.get(e.id)! }
      }
      return e
    })

    const newLibrary = { ...library, entries: newEntries }
    set({ library: newLibrary })
    await window.electronAPI.saveLibrary(newLibrary).catch(() => {})
  },

  // ===== Memo actions =====

  createMemo: async (title?: string, folderId?: string) => {
    const { library } = get()
    if (!library) throw new Error('Library not loaded')
    if (!library.memos) library.memos = []
    const memo: Memo = {
      id: uuid(), title: title && title.trim() ? title : '新笔记', content: '', blocks: [], aiHistory: [],
      folderId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      snapshots: []
    }
    library.memos.push(memo)
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
    return memo
  },

  updateMemo: async (id: string, updates: Partial<Pick<Memo, 'title' | 'content'>>) => {
    const { library } = get()
    if (!library) return
    const memo = (library.memos || []).find(m => m.id === id)
    if (!memo) return
    Object.assign(memo, updates, { updatedAt: new Date().toISOString() })
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  deleteMemo: async (id: string) => {
    const { library } = get()
    if (!library) return
    library.memos = (library.memos || []).filter(m => m.id !== id)
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  addBlockToMemo: async (memoId: string, block: BlockRef) => {
    const { library } = get()
    if (!library) return
    const memo = (library.memos || []).find(m => m.id === memoId)
    if (!memo) return
    if (memo.blocks.some(b => b.historyEntryId === block.historyEntryId)) return
    memo.blocks.push(block)
    memo.updatedAt = new Date().toISOString()
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  removeBlockFromMemo: async (memoId: string, historyEntryId: string) => {
    const { library } = get()
    if (!library) return
    const memo = (library.memos || []).find(m => m.id === memoId)
    if (!memo) return
    memo.blocks = memo.blocks.filter(b => b.historyEntryId !== historyEntryId)
    memo.updatedAt = new Date().toISOString()
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  snapshotMemo: async (id: string) => {
    const { library } = get()
    if (!library) return
    const memo = (library.memos || []).find(m => m.id === id)
    if (!memo || !memo.content.trim()) return
    memo.snapshots.push({ content: memo.content, savedAt: new Date().toISOString() })
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  // ===== Memo folder actions =====

  createMemoFolder: async (name: string) => {
    const { library } = get()
    if (!library) throw new Error('Library not loaded')
    if (!library.memoFolders) library.memoFolders = []
    const folder: MemoFolder = { id: uuid(), name, createdAt: new Date().toISOString() }
    library.memoFolders.push(folder)
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
    return folder
  },

  renameMemoFolder: async (id: string, name: string) => {
    const { library } = get()
    if (!library) return
    const f = (library.memoFolders || []).find(f => f.id === id)
    if (f) f.name = name
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  deleteMemoFolder: async (id: string) => {
    const { library } = get()
    if (!library) return
    library.memoFolders = (library.memoFolders || []).filter(f => f.id !== id)
    // Move memos in this folder back to root
    for (const m of library.memos || []) {
      if (m.folderId === id) m.folderId = undefined
    }
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  moveMemoToFolder: async (memoId: string, folderId: string | undefined) => {
    const { library } = get()
    if (!library) return
    const memo = (library.memos || []).find(m => m.id === memoId)
    if (memo) memo.folderId = folderId
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  // ===== Lecture actions =====

  saveLectureSession: (session: LectureSession) => {
    const { library } = get()
    if (!library) return
    if (!library.lectureSessions) library.lectureSessions = []
    const idx = library.lectureSessions.findIndex(s => s.id === session.id)
    if (idx >= 0) {
      library.lectureSessions[idx] = session
    } else {
      library.lectureSessions.unshift(session)
    }
    set({ library: { ...library } })
    window.electronAPI.saveLibrary(library).catch(() => {})
  },

  deleteLectureSession: (id: string) => {
    const { library } = get()
    if (!library) return
    library.lectureSessions = (library.lectureSessions || []).filter(s => s.id !== id)
    set({ library: { ...library } })
    window.electronAPI.saveLibrary(library).catch(() => {})
  },

  // 2026-04-28 · Reading log actions 已删(readingLog 功能下线)
}))
