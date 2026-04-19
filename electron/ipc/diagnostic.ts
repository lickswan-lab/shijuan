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
const CRASH_LOG_MAX_BYTES = 64 * 1024

// Serializes crash-log writes so two simultaneous crash reports (main-process
// throw + renderer ErrorBoundary, or two renderers in quick succession) can't
// do interleaved read-modify-write and lose one of the entries. Module-scoped
// promise chain, same pattern as library.ts's writeLock.
let crashLogLock: Promise<unknown> = Promise.resolve()

// Append an entry to ~/.lit-manager/crash.log. Keeps last ~64KB (trim from head when bigger).
// Prefers fs.appendFile when the file is still small enough that we don't need
// to trim — that's a single syscall and avoids the lost-write race entirely.
// Only falls back to read-modify-write when we actually need to trim.
// Exported so main.ts can log startup-window failures (when no IPC channel exists yet).
export async function appendCrashLog(text: string): Promise<void> {
  const run = crashLogLock.catch(() => {}).then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true })
      const now = new Date().toISOString()
      const entry = `\n====== ${now} ======\n${text}\n`

      // Fast path: file small, just append atomically (single syscall).
      let size = 0
      try { size = (await fs.stat(CRASH_LOG)).size } catch { /* missing — appendFile will create it */ }
      if (size + entry.length <= CRASH_LOG_MAX_BYTES) {
        await fs.appendFile(CRASH_LOG, entry, 'utf-8')
        return
      }

      // Slow path: need to trim. Read + trim + rewrite. Still safe under this
      // lock because no other crash write can interleave.
      let existing = ''
      try { existing = await fs.readFile(CRASH_LOG, 'utf-8') } catch { /* fine */ }
      const combined = existing + entry
      const trimmed = combined.length > CRASH_LOG_MAX_BYTES
        ? combined.slice(combined.length - CRASH_LOG_MAX_BYTES)
        : combined
      await fs.writeFile(CRASH_LOG, trimmed, 'utf-8')
    } catch { /* swallow — don't crash the crash logger */ }
  })
  crashLogLock = run.catch(() => {})
  return run
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
