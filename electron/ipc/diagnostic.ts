import { ipcMain, app, shell } from 'electron'
import fs from 'fs/promises'
import path from 'path'

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const META_DIR = path.join(DATA_DIR, 'meta')

async function statSafe(p: string): Promise<{ size: number; mtime: Date } | null> {
  try { const s = await fs.stat(p); return { size: s.size, mtime: s.mtime } } catch { return null }
}

async function countFiles(dir: string, predicate: (name: string) => boolean): Promise<number> {
  try {
    const entries = await fs.readdir(dir)
    return entries.filter(predicate).length
  } catch { return 0 }
}

// Find recent error log files (.log / .update-error.log / similar)
async function collectErrorLogs(): Promise<Array<{ name: string; mtime: string; content: string }>> {
  const logs: Array<{ name: string; mtime: string; content: string }> = []
  const candidates: string[] = []

  // 1. Check data dir for any *.log files
  try {
    const entries = await fs.readdir(DATA_DIR)
    for (const name of entries) {
      if (name.endsWith('.log') || name.endsWith('-error.log')) {
        candidates.push(path.join(DATA_DIR, name))
      }
    }
  } catch { /* dir missing, fine */ }

  // 2. Check app path dir (where asar lives) for update-error.log
  try {
    const appPath = app.getAppPath()
    const asarDir = appPath.endsWith('.asar') ? path.dirname(appPath) : appPath
    const entries = await fs.readdir(asarDir)
    for (const name of entries) {
      if (name.includes('update-error') && name.endsWith('.log')) {
        candidates.push(path.join(asarDir, name))
      }
    }
  } catch { /* fine */ }

  // Read each file (cap at 16KB so large logs don't blow up IPC)
  for (const fp of candidates) {
    try {
      const s = await fs.stat(fp)
      const full = await fs.readFile(fp, 'utf-8')
      const content = full.length > 16 * 1024 ? full.slice(-16 * 1024) + '\n... (truncated, showing last 16KB)' : full
      logs.push({ name: path.basename(fp), mtime: s.mtime.toISOString(), content })
    } catch { /* skip unreadable */ }
  }

  // Most-recent first
  logs.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return logs
}

const CRASH_LOG = path.join(DATA_DIR, 'crash.log')

// Append an entry to ~/.lit-manager/crash.log. Keeps last ~64KB (trim from head when bigger).
async function appendCrashLog(text: string): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const now = new Date().toISOString()
    const entry = `\n====== ${now} ======\n${text}\n`
    let existing = ''
    try { existing = await fs.readFile(CRASH_LOG, 'utf-8') } catch { /* new file */ }
    const combined = existing + entry
    const trimmed = combined.length > 64 * 1024
      ? combined.slice(combined.length - 64 * 1024)
      : combined
    await fs.writeFile(CRASH_LOG, trimmed, 'utf-8')
  } catch { /* swallow — don't crash the crash logger */ }
}

export function registerDiagnosticIpc(): void {
  ipcMain.handle('get-diagnostic-info', async () => {
    const libraryStat = await statSafe(LIBRARY_FILE)
    const metaCount = await countFiles(META_DIR, n => n.endsWith('.json'))
    // Count .ocr.txt files is expensive (scattered next to PDFs) — skip for now
    const errorLogs = await collectErrorLogs()

    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      dataDir: DATA_DIR,
      libraryJsonSize: libraryStat?.size ?? 0,
      metaCount,
      ocrFilesCount: 0,  // reserved for future
      errorLogs,
    }
  })

  // Open the data dir in OS file explorer
  ipcMain.handle('open-data-dir', async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true })
    } catch { /* ignore */ }
    shell.openPath(DATA_DIR)
  })

  // Renderer-initiated crash log entries (from ErrorBoundary componentDidCatch)
  ipcMain.on('log-renderer-crash', (_event, payload: { label?: string; message?: string; stack?: string; componentStack?: string }) => {
    const parts = [
      `LABEL: ${payload.label || '(unknown)'}`,
      `MESSAGE: ${payload.message || '(no message)'}`,
      payload.stack ? `STACK:\n${payload.stack}` : '',
      payload.componentStack ? `COMPONENT STACK:\n${payload.componentStack}` : '',
    ].filter(Boolean)
    appendCrashLog(parts.join('\n'))
  })
}
