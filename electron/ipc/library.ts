import { ipcMain, dialog, app, shell } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { Library, PdfMeta } from '../../src/types/library'

// Central storage directory: ~/.lit-manager/
const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const META_DIR = path.join(DATA_DIR, 'meta')

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(META_DIR, { recursive: true })
}

// Serializes all library.json / meta writes so a second save can't race with a
// first one. The lock enforces ordering only — it must NOT swallow errors: the
// caller has to know when a save fails so the UI can surface it, and so we do
// *not* fall back to a non-atomic direct write that could leave a truncated
// library.json if it also fails.
//
// This lock is also used by readingLog.ts (via the exported helpers below) so
// that backend-side midnight log writes are serialized against frontend saves.
let writeLock: Promise<unknown> = Promise.resolve()

// Low-level: write any file atomically via tmp + rename, serialized under the
// same writeLock so agent.ts / readingLog.ts / library writes don't stomp each
// other. Used by atomicWriteJson and callers that need to persist plain text
// (e.g. agent memory).
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const run = writeLock.catch(() => { /* don't let a prior failure block new writes */ }).then(async () => {
    const tmpPath = filePath + '.tmp'
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  })
  // The lock just tracks ordering, not success — swallow errors here so the
  // chain stays alive, but re-expose the real result to the caller via `run`.
  writeLock = run.catch(() => {})
  return run
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  return atomicWriteFile(filePath, JSON.stringify(data, null, 2))
}

// Read a JSON file safely. Missing file → returns defaultValue. Corrupt JSON →
// rename the bad file to `.corrupt-{timestamp}.bak`, warn on console, and
// return defaultValue. This prevents the silent-overwrite bug where a later
// save stamps over a corrupted file and destroys the user's data (as happened
// with library.json before R13; agent conversations/insights/skills had the
// same pattern). The backup lets users recover manually.
export async function safeLoadJsonOrBackup<T>(filePath: string, defaultValue: T): Promise<T> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return defaultValue
    throw e
  }
  try {
    return JSON.parse(content) as T
  } catch (e: any) {
    const backup = `${filePath}.corrupt-${Date.now()}.bak`
    try { await fs.rename(filePath, backup) } catch { /* best effort */ }
    console.warn(`[safeLoadJsonOrBackup] ${path.basename(filePath)} 损坏已备份至 ${path.basename(backup)}: ${e?.message || e}`)
    return defaultValue
  }
}

// Read library.json → run `mutate` on it → write back, all under the shared
// writeLock so it can't interleave with other save-library / save-pdf-meta
// calls (prevents torn-write races between the midnight scheduler and
// frontend edits). Returns the mutated library (or null if the file didn't exist).
//
// Important: this function distinguishes three cases:
//   - ENOENT (no library yet): returns null so the caller can decide whether
//     to create one.
//   - Parse error (library.json corrupt): throws WITHOUT touching the file.
//     Letting mutate() run on a fresh empty Library here would silently
//     overwrite the user's corrupt-but-possibly-recoverable data — the same
//     silent-wipe bug fixed for load-library in batch 17. We leave the
//     corrupt file intact so the next `load-library` on app restart can back
//     it up and alert the user.
//   - Any other read error: throws.
export async function mutateLibraryOnDisk(
  mutate: (lib: Library) => Library | Promise<Library>,
): Promise<Library | null> {
  const run = writeLock.catch(() => {}).then(async () => {
    let content: string
    try {
      content = await fs.readFile(LIBRARY_FILE, 'utf-8')
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null
      throw new Error(`mutateLibraryOnDisk: library.json 读取失败: ${e?.message || e}`)
    }
    let library: Library
    try {
      library = JSON.parse(content) as Library
    } catch (e: any) {
      throw new Error(`mutateLibraryOnDisk: library.json 已损坏，已跳过写入以避免覆盖。请重启应用以触发损坏检测与备份: ${e?.message || e}`)
    }
    const next = await mutate(library)
    const tmpPath = LIBRARY_FILE + '.tmp'
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf-8')
    await fs.rename(tmpPath, LIBRARY_FILE)
    return next
  })
  writeLock = run.catch(() => {})
  return run
}

// Convert entry ID to meta file path
function metaPath(entryId: string): string {
  return path.join(META_DIR, `${entryId}.json`)
}

export function registerLibraryIpc(): void {

  // Show file in system file manager
  ipcMain.on('show-item-in-folder', (_event, absPath: string) => {
    shell.showItemInFolder(absPath)
  })

  // Load the central library.
  // Distinguish missing (first run → null) from corrupt (malformed JSON → throw
  // after backing up the bad file). Silently returning null on parse errors would
  // let the app treat a corrupted library as "fresh install" and immediately
  // overwrite it on the next save, destroying the user's data.
  ipcMain.handle('load-library', async () => {
    await ensureDirs()
    let content: string
    try {
      content = await fs.readFile(LIBRARY_FILE, 'utf-8')
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null
      throw new Error(`library.json 读取失败: ${e?.message || e}`)
    }
    try {
      return JSON.parse(content) as Library
    } catch (e: any) {
      const backup = `${LIBRARY_FILE}.corrupt-${Date.now()}.bak`
      try { await fs.rename(LIBRARY_FILE, backup) } catch { /* best effort */ }
      throw new Error(`library.json 损坏已备份至 ${path.basename(backup)}: ${e?.message || e}`)
    }
  })

  // Save the central library
  ipcMain.handle('save-library', async (_event, data: Library) => {
    await ensureDirs()
    await atomicWriteJson(LIBRARY_FILE, data)
    return true
  })

  // Supported file extensions
  const SUPPORTED_EXTS = ['.pdf', '.docx', '.doc', '.epub', '.html', '.htm', '.txt', '.md']
  const isSupported = (name: string) => SUPPORTED_EXTS.some(ext => name.toLowerCase().endsWith(ext))

  // Import: open file picker (files only, no directory — Windows doesn't support both)
  ipcMain.handle('import-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档', extensions: ['pdf', 'docx', 'doc', 'epub', 'html', 'htm', 'txt', 'md'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Word', extensions: ['docx', 'doc'] },
        { name: 'EPUB', extensions: ['epub'] },
        { name: 'HTML', extensions: ['html', 'htm'] },
        { name: '文本', extensions: ['txt', 'md'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      title: '选择文件或文件夹导入'
    })
    if (result.canceled) return []

    const allFiles: string[] = []

    async function scanDir(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await scanDir(full)
        } else if (isSupported(entry.name)) {
          allFiles.push(full)
        }
      }
    }

    for (const p of result.filePaths) {
      try {
        const stat = await fs.stat(p)
        if (stat.isDirectory()) {
          await scanDir(p)
        } else if (isSupported(p)) {
          allFiles.push(p)
        }
      } catch { /* skip inaccessible */ }
    }

    return allFiles
  })

  // Import folder: scan for documents recursively
  ipcMain.handle('import-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择文件夹（自动扫描其中的文档）'
    })
    if (result.canceled || result.filePaths.length === 0) return []

    const dirPath = result.filePaths[0]
    const files: string[] = []

    async function scan(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await scan(full)
        } else if (isSupported(entry.name)) {
          files.push(full)
        }
      }
    }

    await scan(dirPath)
    return files
  })

  // Scan dropped paths: expand folders recursively, filter supported file types
  ipcMain.handle('scan-dropped-paths', async (_event, rawPaths: string[]) => {
    const allFiles: string[] = []

    async function scanDir(dir: string) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            await scanDir(full)
          } else if (isSupported(entry.name)) {
            allFiles.push(full)
          }
        }
      } catch { /* skip inaccessible dirs */ }
    }

    for (const p of rawPaths) {
      try {
        const stat = await fs.stat(p)
        if (stat.isDirectory()) {
          await scanDir(p)
        } else if (isSupported(p)) {
          allFiles.push(p)
        }
      } catch { /* skip inaccessible */ }
    }

    return allFiles
  })

  // Check if a file still exists at its original path
  ipcMain.handle('check-file-exists', async (_event, absPath: string) => {
    try {
      await fs.access(absPath)
      return true
    } catch {
      return false
    }
  })

  // Load meta for an entry.
  // Distinguishes missing (null) from corrupt (throws). A corrupt meta file would otherwise
  // be silently overwritten by createDefaultPdfMeta on the renderer side — losing all annotations.
  ipcMain.handle('load-pdf-meta', async (_event, entryId: string) => {
    const mp = metaPath(entryId)
    let content: string
    try {
      content = await fs.readFile(mp, 'utf-8')
    } catch {
      return null  // missing — caller will create defaults
    }
    try {
      return JSON.parse(content) as PdfMeta
    } catch (e: any) {
      // Corrupt. Back up the bad file and throw so the caller can surface this to the user
      // instead of silently replacing their annotations with an empty default.
      const backup = `${mp}.corrupt-${Date.now()}.bak`
      try { await fs.rename(mp, backup) } catch { /* best effort */ }
      throw new Error(`meta 文件损坏已备份至 ${path.basename(backup)}: ${e.message}`)
    }
  })

  // Save meta for an entry
  ipcMain.handle('save-pdf-meta', async (_event, entryId: string, data: PdfMeta) => {
    await ensureDirs()
    data.updatedAt = new Date().toISOString()
    await atomicWriteJson(metaPath(entryId), data)
    return true
  })

  // Delete meta file for an entry (used when entry is removed from library).
  // Safe if the file doesn't exist — deletion is idempotent.
  ipcMain.handle('delete-pdf-meta', async (_event, entryId: string) => {
    try {
      await fs.unlink(metaPath(entryId))
      return { success: true }
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { success: true }
      return { success: false, error: err.message }
    }
  })

  // Read file buffer (for PDF rendering)
  ipcMain.handle('read-file-buffer', async (_event, filePath: string) => {
    const buffer = await fs.readFile(filePath)
    return buffer
  })

  // Save OCR text file alongside original PDF.
  // Atomic: a crashed OCR batch can't leave a half-written .ocr.txt that
  // would corrupt the full-text index on next open.
  ipcMain.handle('save-ocr-text', async (_event, pdfAbsPath: string, text: string) => {
    const ocrPath = pdfAbsPath.replace(/\.pdf$/i, '.ocr.txt')
    await atomicWriteFile(ocrPath, text)
    return ocrPath
  })

  // Delete a file from disk (move to trash)
  ipcMain.handle('delete-file', async (_event, absPath: string) => {
    const { shell } = require('electron') as typeof import('electron')
    try {
      await shell.trashItem(absPath)
      // Also try to trash the .ocr.txt if it exists
      const ocrPath = absPath.replace(/\.pdf$/i, '.ocr.txt')
      try { await shell.trashItem(ocrPath) } catch { /* ignore */ }
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Read OCR text file
  ipcMain.handle('read-ocr-text', async (_event, pdfAbsPath: string) => {
    const ocrPath = pdfAbsPath.replace(/\.pdf$/i, '.ocr.txt')
    try {
      const text = await fs.readFile(ocrPath, 'utf-8')
      return { exists: true, text, path: ocrPath }
    } catch {
      return { exists: false, text: null, path: ocrPath }
    }
  })

  // Full-text search across OCR texts and annotations (parallelized)
  ipcMain.handle('full-text-search', async (_event, query: string, libraryData: any) => {
    if (!query || query.length < 2) return []

    type SearchResult = {
      entryId: string; entryTitle: string; type: 'ocr' | 'annotation';
      text: string; pageNumber?: number; annotationId?: string;
    }

    const q = query.toLowerCase()
    const entries = (libraryData?.entries || []) as Array<{ id: string; title: string; absPath: string }>

    // Helper: extract snippet around match
    const snippet = (text: string, idx: number, qLen: number, pad: number = 30) => {
      const s = Math.max(0, idx - pad)
      const e = Math.min(text.length, idx + qLen + pad)
      return (s > 0 ? '...' : '') + text.slice(s, e) + (e < text.length ? '...' : '')
    }

    // Search each entry in parallel (batches of 10)
    const allResults: SearchResult[] = []
    for (let i = 0; i < entries.length && allResults.length < 50; i += 10) {
      const batch = entries.slice(i, i + 10)
      const batchResults = await Promise.all(batch.map(async (entry): Promise<SearchResult[]> => {
        const results: SearchResult[] = []
        // Read OCR + meta in parallel
        const [ocrText, metaText, rawText] = await Promise.all([
          fs.readFile(entry.absPath.replace(/\.pdf$/i, '.ocr.txt'), 'utf-8').catch(() => null),
          fs.readFile(metaPath(entry.id), 'utf-8').catch(() => null),
          /\.(txt|md)$/i.test(entry.absPath) ? fs.readFile(entry.absPath, 'utf-8').catch(() => null) : null,
        ])

        // Search OCR/TXT content
        const textContent = ocrText || rawText
        if (textContent) {
          const lines = textContent.split('\n')
          let page = 1, found = 0
          for (const line of lines) {
            const pm = line.match(/^=== 第 (\d+) 页 ===$/)
            if (pm) { page = parseInt(pm[1]); continue }
            const idx = line.toLowerCase().indexOf(q)
            if (idx >= 0 && found < 3) {
              results.push({ entryId: entry.id, entryTitle: entry.title, type: 'ocr', text: snippet(line, idx, query.length), pageNumber: page })
              found++
            }
          }
        }

        // Search annotations
        if (metaText) {
          try {
            const meta = JSON.parse(metaText) as PdfMeta
            for (const ann of (meta.annotations || []).slice(0, 20)) {
              if (ann.anchor.selectedText.toLowerCase().includes(q)) {
                results.push({ entryId: entry.id, entryTitle: entry.title, type: 'annotation', text: ann.anchor.selectedText.slice(0, 80), pageNumber: ann.anchor.pageNumber, annotationId: ann.id })
              }
              for (const h of (ann.historyChain || [])) {
                const idx = h.content.toLowerCase().indexOf(q)
                if (idx >= 0) {
                  results.push({ entryId: entry.id, entryTitle: entry.title, type: 'annotation', text: snippet(h.content, idx, query.length, 20), pageNumber: ann.anchor.pageNumber, annotationId: ann.id })
                  break
                }
              }
            }
          } catch {}
        }
        return results
      }))
      allResults.push(...batchResults.flat())
    }

    return allResults.slice(0, 50)
  })

  // Export file with save dialog
  ipcMain.handle('export-file', async (_event, defaultName: string, filters: Array<{ name: string; extensions: string[] }>, content: string | Buffer) => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters,
      })
      if (result.canceled || !result.filePath) return { success: false }
      if (typeof content === 'string') {
        await fs.writeFile(result.filePath, content, 'utf-8')
      } else {
        await fs.writeFile(result.filePath, content)
      }
      shell.showItemInFolder(result.filePath)
      return { success: true, path: result.filePath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Let user pick a .bib file and return its raw content. Parsing / entry
  // creation happens in the renderer (see src/utils/bibtexParser.ts + the
  // importFromBibTeX store action) to keep the main process simple.
  ipcMain.handle('pick-and-read-bib-file', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'BibTeX', extensions: ['bib'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        title: '选择 BibTeX 文件（可从 Zotero 导出）',
      })
      if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true }
      const content = await fs.readFile(result.filePaths[0], 'utf-8')
      return { success: true, content, path: result.filePaths[0] }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ===== Full-library backup =====
  // Bundle library.json + all meta/*.json + agent/* + apprentice/* into a
  // single JSON file the user can save anywhere. Intentionally **does not**
  // include OCR .txt files or the PDF binaries themselves — those live next
  // to the user's original PDFs in whatever folder they chose, outside
  // ~/.lit-manager/. The backup's job is to preserve the user's *annotations
  // and memory*, which is the part that can't be reconstructed; PDFs can
  // always be re-imported from their original location.
  //
  // Single-JSON instead of zip to avoid pulling in a zip dep. A few MB of
  // uncompressed JSON is fine — a 500-entry library with heavy annotations
  // runs ~2MB, trivial to save/load.
  ipcMain.handle('export-full-backup', async () => {
    try {
      const result = await dialog.showSaveDialog({
        defaultPath: `shijuan-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: '拾卷备份', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return { success: false }

      const AGENT_DIR = path.join(DATA_DIR, 'agent')
      const APPRENTICE_DIR = path.join(AGENT_DIR, 'apprentice')

      // Load library.json (ENOENT → null, which is legal for "brand-new app has nothing to back up")
      let library: any = null
      try { library = JSON.parse(await fs.readFile(LIBRARY_FILE, 'utf-8')) } catch { /* fine */ }

      // Load all meta/*.json
      const meta: Record<string, any> = {}
      try {
        const files = await fs.readdir(META_DIR)
        for (const f of files) {
          if (!f.endsWith('.json')) continue
          const entryId = f.replace(/\.json$/, '')
          try {
            const content = await fs.readFile(path.join(META_DIR, f), 'utf-8')
            meta[entryId] = JSON.parse(content)
          } catch { /* skip unreadable / corrupt — user will see the gap on restore */ }
        }
      } catch { /* meta dir may not exist */ }

      // Load agent files
      const agent: Record<string, any> = {}
      try {
        const memory = await fs.readFile(path.join(AGENT_DIR, 'memory.md'), 'utf-8').catch(() => null)
        const conversations = await fs.readFile(path.join(AGENT_DIR, 'conversations.json'), 'utf-8').catch(() => null)
        const insights = await fs.readFile(path.join(AGENT_DIR, 'insights.json'), 'utf-8').catch(() => null)
        const skills = await fs.readFile(path.join(AGENT_DIR, 'skills.json'), 'utf-8').catch(() => null)
        if (memory !== null) agent.memory = memory
        if (conversations !== null) try { agent.conversations = JSON.parse(conversations) } catch { /* drop corrupt */ }
        if (insights !== null) try { agent.insights = JSON.parse(insights) } catch { /* drop corrupt */ }
        if (skills !== null) try { agent.skills = JSON.parse(skills) } catch { /* drop corrupt */ }
      } catch { /* agent dir may not exist */ }

      // Load apprentice weekly logs
      const apprentice: Record<string, string> = {}
      try {
        const files = await fs.readdir(APPRENTICE_DIR)
        for (const f of files) {
          if (!f.endsWith('.md')) continue
          const weekCode = f.replace(/\.md$/, '')
          try {
            apprentice[weekCode] = await fs.readFile(path.join(APPRENTICE_DIR, f), 'utf-8')
          } catch { /* skip */ }
        }
      } catch { /* fine */ }

      const backup = {
        version: '1.0',
        appVersion: app.getVersion(),
        exportedAt: new Date().toISOString(),
        // Explicit note for users/devs reading the file manually later
        _readme: '拾卷完整备份。包含 library.json + 所有注释元数据 + Agent 记忆 + 学徒日志。不含 PDF 文件本身和 OCR 文本文件（它们存在您选择的 PDF 目录旁边）。恢复时在拾卷里使用"导入备份"功能。',
        library,
        meta,
        agent,
        apprentice,
      }

      await fs.writeFile(result.filePath, JSON.stringify(backup, null, 2), 'utf-8')
      shell.showItemInFolder(result.filePath)

      // Give caller stats so UI can show "已备份 N 篇文献 + M 条注释文件"
      const entryCount = (library?.entries || []).length
      const memoCount = (library?.memos || []).length
      const metaCount = Object.keys(meta).length
      const apprenticeCount = Object.keys(apprentice).length
      return {
        success: true,
        path: result.filePath,
        stats: { entryCount, memoCount, metaCount, apprenticeCount },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Web Resource Scraping — shelved, code in _shelved_features/
}
