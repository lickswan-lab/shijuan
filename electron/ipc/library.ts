import { ipcMain, dialog, app, shell, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
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

  // Full-text search across OCR texts and annotations
  ipcMain.handle('full-text-search', async (_event, query: string, libraryData: any) => {
    if (!query || query.length < 2) return []

    const results: Array<{
      entryId: string
      entryTitle: string
      type: 'ocr' | 'annotation'
      text: string        // matched snippet
      pageNumber?: number
      annotationId?: string
    }> = []

    const q = query.toLowerCase()
    const entries = libraryData?.entries || []

    for (const entry of entries) {
      // Search OCR text
      try {
        const ocrPath = entry.absPath.replace(/\.pdf$/i, '.ocr.txt')
        const ocrText = await fs.readFile(ocrPath, 'utf-8')
        const lines = ocrText.split('\n')
        let currentPage = 1
        for (const line of lines) {
          const pageMatch = line.match(/^=== 第 (\d+) 页 ===$/)
          if (pageMatch) { currentPage = parseInt(pageMatch[1]); continue }
          if (line.toLowerCase().includes(q)) {
            // Extract snippet around match
            const idx = line.toLowerCase().indexOf(q)
            const start = Math.max(0, idx - 30)
            const end = Math.min(line.length, idx + query.length + 30)
            results.push({
              entryId: entry.id,
              entryTitle: entry.title,
              type: 'ocr',
              text: (start > 0 ? '...' : '') + line.slice(start, end) + (end < line.length ? '...' : ''),
              pageNumber: currentPage,
            })
            if (results.filter(r => r.entryId === entry.id && r.type === 'ocr').length >= 5) break
          }
        }
      } catch { /* no OCR file */ }

      // Search TXT/MD/DOCX content (read raw file for text types)
      if (/\.(txt|md)$/i.test(entry.absPath)) {
        try {
          const text = await fs.readFile(entry.absPath, 'utf-8')
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.toLowerCase().includes(q)) {
              const idx = line.toLowerCase().indexOf(q)
              const start = Math.max(0, idx - 30)
              const end = Math.min(line.length, idx + query.length + 30)
              results.push({
                entryId: entry.id,
                entryTitle: entry.title,
                type: 'ocr',
                text: (start > 0 ? '...' : '') + line.slice(start, end) + (end < line.length ? '...' : ''),
              })
              if (results.filter(r => r.entryId === entry.id && r.type === 'ocr').length >= 5) break
            }
          }
        } catch { /* file not readable */ }
      }

      // Search annotations
      try {
        const metaContent = await fs.readFile(metaPath(entry.id), 'utf-8')
        const meta = JSON.parse(metaContent) as PdfMeta
        for (const ann of (meta.annotations || [])) {
          // Search selected text
          if (ann.anchor.selectedText.toLowerCase().includes(q)) {
            results.push({
              entryId: entry.id,
              entryTitle: entry.title,
              type: 'annotation',
              text: ann.anchor.selectedText.slice(0, 80),
              pageNumber: ann.anchor.pageNumber,
              annotationId: ann.id,
            })
          }
          // Search history chain content
          for (const h of (ann.historyChain || [])) {
            if (h.content.toLowerCase().includes(q)) {
              const idx = h.content.toLowerCase().indexOf(q)
              const start = Math.max(0, idx - 20)
              const end = Math.min(h.content.length, idx + query.length + 20)
              results.push({
                entryId: entry.id,
                entryTitle: entry.title,
                type: 'annotation',
                text: (start > 0 ? '...' : '') + h.content.slice(start, end) + (end < h.content.length ? '...' : ''),
                pageNumber: ann.anchor.pageNumber,
                annotationId: ann.id,
              })
              break  // one match per annotation is enough
            }
          }
        }
      } catch { /* no meta */ }
    }

    return results.slice(0, 50)  // limit results
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

  // ===== Web Resource Scraping =====
  const DOWNLOAD_EXTS = /\.(pdf|epub|docx?|txt|md|mobi|djvu|html?|zip|rar)$/i

  // Helper: fetch URL content as string, follow redirects
  function fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const doReq = (u: string, depth: number) => {
        if (depth > 5) { reject(new Error('Too many redirects')); return }
        const proto = u.startsWith('https') ? https : http
        const req = proto.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            doReq(res.headers.location!, depth + 1); return
          }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
          let data = ''
          res.setEncoding('utf-8')
          res.on('data', c => data += c)
          res.on('end', () => resolve(data))
        })
        req.on('error', reject)
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')) })
      }
      doReq(url, 0)
    })
  }

  // Scrape a URL for downloadable resources
  ipcMain.handle('scrape-resources', async (_event, url: string) => {
    try {
      const html = await fetchUrl(url)

      // Extract all links from the page
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
      const resources: Array<{ url: string; name: string; ext: string }> = []
      const seen = new Set<string>()

      let match
      while ((match = linkRegex.exec(html)) !== null) {
        let href = match[1]
        const label = match[2].replace(/<[^>]*>/g, '').trim()

        // Resolve relative URLs
        if (href.startsWith('/')) {
          const base = new URL(url)
          href = `${base.protocol}//${base.host}${href}`
        } else if (!href.startsWith('http')) {
          href = new URL(href, url).href
        }

        // Check if it looks like a downloadable file
        const extMatch = href.match(DOWNLOAD_EXTS)
        if (extMatch && !seen.has(href)) {
          seen.add(href)
          const fileName = decodeURIComponent(href.split('/').pop()?.split('?')[0] || label || 'unknown')
          resources.push({
            url: href,
            name: fileName || label,
            ext: extMatch[1].toLowerCase(),
          })
        }
      }

      // Also check for direct download links in common patterns
      const directLinks = html.match(/https?:\/\/[^\s"'<>]+\.(pdf|epub|docx?|txt|md|mobi)/gi) || []
      for (const link of directLinks) {
        if (!seen.has(link)) {
          seen.add(link)
          const fileName = decodeURIComponent(link.split('/').pop()?.split('?')[0] || 'file')
          const ext = link.match(/\.(\w+)$/)?.[1] || ''
          resources.push({ url: link, name: fileName, ext: ext.toLowerCase() })
        }
      }

      return { success: true, resources: resources.slice(0, 50), pageTitle: (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '' }
    } catch (err: any) {
      return { success: false, resources: [], error: err.message }
    }
  })

  // Download a file from URL to local downloads folder, return path
  ipcMain.handle('download-resource', async (_event, fileUrl: string, fileName: string) => {
    const downloadsDir = path.join(DATA_DIR, 'downloads')
    await fs.mkdir(downloadsDir, { recursive: true })
    const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_')
    const destPath = path.join(downloadsDir, safeName)

    return new Promise((resolve) => {
      const doReq = (u: string, depth: number) => {
        if (depth > 5) { resolve({ success: false, error: 'Too many redirects' }); return }
        const proto = u.startsWith('https') ? https : http
        const req = proto.get(u, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            doReq(res.headers.location!, depth + 1); return
          }
          if (res.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${res.statusCode}` }); return
          }
          const file = createWriteStream(destPath)
          const totalSize = parseInt(res.headers['content-length'] || '0', 10)
          let downloaded = 0
          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length
            file.write(chunk)
            // Send progress
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
            if (totalSize > 0 && win) {
              win.webContents.send('download-resource-progress', Math.round((downloaded / totalSize) * 100))
            }
          })
          res.on('end', () => {
            file.end()
            file.on('finish', () => resolve({ success: true, path: destPath }))
          })
          res.on('error', (err) => { file.destroy(); resolve({ success: false, error: err.message }) })
        })
        req.on('error', (err) => resolve({ success: false, error: err.message }))
        req.setTimeout(120000, () => { req.destroy(); resolve({ success: false, error: 'Download timeout' }) })
      }
      doReq(fileUrl, 0)
    })
  })
}
