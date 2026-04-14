import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type { Library, LibraryEntry, PdfMeta, VirtualFolder, Memo, BlockRef, MemoSnapshot, MemoFolder, ReadingLog } from '../types/library'
import { createDefaultLibrary, createDefaultPdfMeta } from '../types/library'

interface LibraryState {
  library: Library | null
  currentEntry: LibraryEntry | null
  currentPdfMeta: PdfMeta | null
  isLoading: boolean

  // Actions
  initLibrary: () => Promise<void>
  importFiles: (folderId?: string) => Promise<number>
  importFolder: (folderId?: string) => Promise<number>
  removeEntry: (id: string) => Promise<void>
  deleteEntry: (id: string) => Promise<{ success: boolean; error?: string }>
  openEntry: (entry: LibraryEntry) => Promise<void>
  updateEntry: (id: string, updates: Partial<LibraryEntry>) => Promise<void>
  savePdfMeta: (meta: PdfMeta) => Promise<void>
  updatePdfMeta: (updater: (meta: PdfMeta) => PdfMeta) => Promise<void>

  // Folder actions
  createFolder: (name: string) => Promise<VirtualFolder>
  renameFolder: (id: string, name: string) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  moveEntryToFolder: (entryId: string, folderId: string | undefined) => Promise<void>
  reorderEntry: (entryId: string, targetId: string, position: 'before' | 'after') => Promise<void>

  // Memo actions
  createMemo: (title: string, folderId?: string) => Promise<Memo>
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

  // Reading log actions
  saveReadingLog: (log: ReadingLog) => void
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  library: null,
  currentEntry: null,
  currentPdfMeta: null,
  isLoading: false,

  initLibrary: async () => {
    set({ isLoading: true })
    let library = await window.electronAPI.loadLibrary()
    if (!library) {
      library = createDefaultLibrary()
      await window.electronAPI.saveLibrary(library)
    }
    // Patch older libraries missing new fields
    if (!library.memos) library.memos = []
    if (!library.folders) library.folders = []
    if (!library.memoFolders) library.memoFolders = []
    if (!library.readingLogs) library.readingLogs = []
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

    // All saves and scans happen in background, don't block UI
    setTimeout(async () => {
      try {
        await window.electronAPI.saveLibrary(library)
      } catch {}

      // Scan OCR files in parallel
      const unchecked = library.entries.filter(e => e.ocrStatus !== 'complete' && e.absPath)
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
          set({ library: { ...library } })
          try { await window.electronAPI.saveLibrary(library) } catch {}
        }
      }
    }, 100)
  },

  importFiles: async (folderId?: string) => {
    const paths = await window.electronAPI.importFiles()
    if (!paths.length) return 0

    const { library } = get()
    if (!library) return 0

    let added = 0
    for (const absPath of paths) {
      if (library.entries.some(e => e.absPath === absPath)) continue
      const fileName = absPath.split(/[/\\]/).pop()?.replace(/\.(pdf|docx?|epub|html?|txt|md)$/i, '') || ''
      const entry: LibraryEntry = {
        id: uuid(), absPath, title: fileName, authors: [], tags: [], notes: '',
        folderId, ocrStatus: 'none', addedAt: new Date().toISOString()
      }
      library.entries.push(entry)
      added++
    }

    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
    return added
  },

  importFolder: async (folderId?: string) => {
    const paths = await window.electronAPI.importFolder()
    if (!paths.length) return 0

    const { library } = get()
    if (!library) return 0

    let added = 0
    for (const absPath of paths) {
      if (library.entries.some(e => e.absPath === absPath)) continue
      const fileName = absPath.split(/[/\\]/).pop()?.replace(/\.(pdf|docx?|epub|html?|txt|md)$/i, '') || ''
      const entry: LibraryEntry = {
        id: uuid(), absPath, title: fileName, authors: [], tags: [], notes: '',
        folderId, ocrStatus: 'none', addedAt: new Date().toISOString()
      }
      library.entries.push(entry)
      added++
    }

    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
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

    // Load or create meta
    let meta = await window.electronAPI.loadPdfMeta(entry.id)
    if (!meta) {
      meta = createDefaultPdfMeta(entry.id)
      await window.electronAPI.savePdfMeta(entry.id, meta)
    }

    // Update last opened
    const { library } = get()
    if (library) {
      const idx = library.entries.findIndex(e => e.id === entry.id)
      if (idx >= 0) {
        library.entries[idx].lastOpenedAt = new Date().toISOString()
        await window.electronAPI.saveLibrary(library)
      }
    }

    set({ currentEntry: entry, currentPdfMeta: meta })
  },

  updateEntry: async (id: string, updates: Partial<LibraryEntry>) => {
    const { library } = get()
    if (!library) return

    const idx = library.entries.findIndex(e => e.id === id)
    if (idx < 0) return

    library.entries[idx] = { ...library.entries[idx], ...updates }
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })

    // If it's the currently open entry, update that too
    if (get().currentEntry?.id === id) {
      set({ currentEntry: library.entries[idx] })
    }
  },

  savePdfMeta: async (meta: PdfMeta) => {
    const { currentEntry } = get()
    if (!currentEntry) return
    await window.electronAPI.savePdfMeta(currentEntry.id, meta)
    set({ currentPdfMeta: meta })
  },

  updatePdfMeta: async (updater: (meta: PdfMeta) => PdfMeta) => {
    const { currentPdfMeta } = get()
    if (!currentPdfMeta) return
    const updated = updater({ ...currentPdfMeta })
    await get().savePdfMeta(updated)
  },

  createFolder: async (name: string) => {
    const { library } = get()
    if (!library) throw new Error('Library not loaded')
    if (!library.folders) library.folders = []
    const folder: VirtualFolder = { id: uuid(), name, createdAt: new Date().toISOString() }
    library.folders.push(folder)
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
    return folder
  },

  renameFolder: async (id: string, name: string) => {
    const { library } = get()
    if (!library) return
    const f = library.folders?.find(f => f.id === id)
    if (f) f.name = name
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  deleteFolder: async (id: string) => {
    const { library } = get()
    if (!library) return
    library.folders = (library.folders || []).filter(f => f.id !== id)
    // Move entries in this folder back to root
    for (const e of library.entries) {
      if (e.folderId === id) e.folderId = undefined
    }
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  moveEntryToFolder: async (entryId: string, folderId: string | undefined) => {
    const { library } = get()
    if (!library) return
    const entry = library.entries.find(e => e.id === entryId)
    if (entry) entry.folderId = folderId
    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  reorderEntry: async (entryId: string, targetId: string, position: 'before' | 'after') => {
    const { library } = get()
    if (!library) return
    if (entryId === targetId) return

    const entry = library.entries.find(e => e.id === entryId)
    const target = library.entries.find(e => e.id === targetId)
    if (!entry || !target) return

    // Put dragged entry in same folder as target
    entry.folderId = target.folderId

    // Get siblings in the same folder, sorted by current sortIndex
    const siblings = library.entries
      .filter(e => e.folderId === target.folderId)
      .sort((a, b) => (a.sortIndex ?? 9999) - (b.sortIndex ?? 9999))

    // Remove the dragged entry from the list
    const without = siblings.filter(e => e.id !== entryId)
    // Find target position
    const targetIdx = without.findIndex(e => e.id === targetId)
    const insertIdx = position === 'before' ? targetIdx : targetIdx + 1
    // Insert
    without.splice(insertIdx, 0, entry)
    // Reassign sortIndex
    without.forEach((e, i) => { e.sortIndex = i })

    await window.electronAPI.saveLibrary(library)
    set({ library: { ...library } })
  },

  // ===== Memo actions =====

  createMemo: async (title: string, folderId?: string) => {
    const { library } = get()
    if (!library) throw new Error('Library not loaded')
    if (!library.memos) library.memos = []
    const memo: Memo = {
      id: uuid(), title, content: '', blocks: [], aiHistory: [],
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

  // ===== Reading log actions =====

  saveReadingLog: (log: ReadingLog) => {
    const { library } = get()
    if (!library) return
    if (!library.readingLogs) library.readingLogs = []
    const idx = library.readingLogs.findIndex(l => l.date === log.date)
    if (idx >= 0) {
      library.readingLogs[idx] = log
    } else {
      library.readingLogs.unshift(log) // newest first
    }
    set({ library: { ...library } })
    window.electronAPI.saveLibrary(library).catch(() => {})
  }
}))
