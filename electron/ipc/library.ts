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

let writeLock: Promise<void> = Promise.resolve()

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  // Serialize writes to prevent race conditions
  writeLock = writeLock.then(async () => {
    const tmpPath = filePath + '.tmp'
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    await fs.rename(tmpPath, filePath)
  }).catch(async () => {
    // Fallback: direct write if atomic fails
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
  })
  return writeLock
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

  // Load the central library
  ipcMain.handle('load-library', async () => {
    await ensureDirs()
    try {
      const content = await fs.readFile(LIBRARY_FILE, 'utf-8')
      return JSON.parse(content) as Library
    } catch {
      return null
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

  // Load meta for an entry
  ipcMain.handle('load-pdf-meta', async (_event, entryId: string) => {
    try {
      const content = await fs.readFile(metaPath(entryId), 'utf-8')
      return JSON.parse(content) as PdfMeta
    } catch {
      return null
    }
  })

  // Save meta for an entry
  ipcMain.handle('save-pdf-meta', async (_event, entryId: string, data: PdfMeta) => {
    await ensureDirs()
    data.updatedAt = new Date().toISOString()
    await atomicWriteJson(metaPath(entryId), data)
    return true
  })

  // Read file buffer (for PDF rendering)
  ipcMain.handle('read-file-buffer', async (_event, filePath: string) => {
    const buffer = await fs.readFile(filePath)
    return buffer
  })

  // Save OCR text file alongside original PDF
  ipcMain.handle('save-ocr-text', async (_event, pdfAbsPath: string, text: string) => {
    const ocrPath = pdfAbsPath.replace(/\.pdf$/i, '.ocr.txt')
    await fs.writeFile(ocrPath, text, 'utf-8')
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
}
