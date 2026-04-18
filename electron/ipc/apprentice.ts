import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { Library, PdfMeta, HistoryEntry } from '../../src/types/library'
import { atomicWriteFile } from './library'

// ===== Paths =====
const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const META_DIR = path.join(DATA_DIR, 'meta')
const APPRENTICE_DIR = path.join(DATA_DIR, 'agent', 'apprentice')

async function ensureDir(): Promise<void> {
  try { await fs.mkdir(APPRENTICE_DIR, { recursive: true }) } catch {}
}

async function loadLibrary(): Promise<Library | null> {
  try { return JSON.parse(await fs.readFile(LIBRARY_FILE, 'utf-8')) } catch { return null }
}

async function loadMeta(entryId: string): Promise<PdfMeta | null> {
  try { return JSON.parse(await fs.readFile(path.join(META_DIR, `${entryId}.json`), 'utf-8')) } catch { return null }
}

// ===== Week helpers (ISO weeks, Mon-start) =====
// Returns YYYY-Www (e.g. "2026-W16")
export function isoWeekCode(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7          // Sun = 0 → 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)  // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Monday (00:00 local) of the given date
function weekStart(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() || 7
  d.setDate(d.getDate() - (day - 1))
  return d
}

function between(iso: string | undefined | null, start: number, end: number): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return t >= start && t < end
}

function clip(s: string | undefined, n = 100): string {
  if (!s) return ''
  return s.length > n ? s.substring(0, n) + '…' : s
}

// ===== Context structure delivered to the AI =====
export interface ApprenticeContext {
  weekCode: string
  weekStart: string  // ISO
  weekEnd: string    // ISO (exclusive)
  stats: {
    activeDays: number
    entriesOpened: number
    annotationsCreated: number
    historyEntriesCreated: number
    memosEdited: number
  }
  // Reading surface: what was opened and how much
  reading: Array<{
    entryId: string
    title: string
    openCount: number      // days this week user opened it (1 per day max)
    lastOpenedAt: string
    hasAnnotationsThisWeek: boolean
  }>
  // All annotations + history chain entries created this week
  thinking: Array<{
    entryId: string
    entryTitle: string
    annotationId: string
    selectedText: string
    pageNumber: number
    createdAt: string
    entries: Array<{
      type: HistoryEntry['type']
      author: 'user' | 'ai'
      content: string
      createdAt: string
    }>
  }>
  // Memos touched
  memos: Array<{
    memoId: string
    title: string
    blockCount: number
    createdAt: string
    updatedAt: string
    preview: string  // first 200 chars
  }>
  // Wider history for cross-week pattern detection
  wider: {
    // User's all-time stances (up to 30 most recent) — for detecting contradictions
    recentStances: Array<{
      entryId: string
      entryTitle: string
      content: string
      createdAt: string
    }>
    // Entries opened multiple times across 4 weeks but never got deep annotation
    strugglingEntries: Array<{
      entryId: string
      title: string
      opensIn4Weeks: number
      annotationCount: number
    }>
  }
  // The previous week's apprentice log (for continuity)
  previousWeekLog: string | null
}

// ===== Core context collector =====
export async function collectApprenticeContext(targetDate: Date): Promise<ApprenticeContext> {
  const library = await loadLibrary()
  if (!library) {
    throw new Error('库未初始化')
  }

  const start = weekStart(targetDate)
  const end = new Date(start.getTime() + 7 * 86400000)
  const startMs = start.getTime()
  const endMs = end.getTime()
  const weekCode = isoWeekCode(start)

  // === 1. Reading activity (entry opens) ===
  const readingMap = new Map<string, { entry: any; days: Set<string> }>()
  const entries = library.entries || []
  for (const e of entries) {
    if (between(e.lastOpenedAt, startMs, endMs)) {
      const day = new Date(e.lastOpenedAt!).toISOString().slice(0, 10)
      if (!readingMap.has(e.id)) readingMap.set(e.id, { entry: e, days: new Set() })
      readingMap.get(e.id)!.days.add(day)
    }
  }

  // === 2. Scan meta files for annotations / history (parallel load) ===
  const thinking: ApprenticeContext['thinking'] = []
  const annotationsThisWeek = new Set<string>()  // entryId
  let historyEntriesCreatedCount = 0
  let annotationsCreatedCount = 0
  const recentStances: ApprenticeContext['wider']['recentStances'] = []

  const metas = await Promise.all(entries.map(async e => ({ entry: e, meta: await loadMeta(e.id) })))
  for (const { entry: e, meta } of metas) {
    if (!meta) continue

    for (const ann of meta.annotations || []) {
      const annCreatedThisWeek = between(ann.createdAt, startMs, endMs)
      if (annCreatedThisWeek) {
        annotationsCreatedCount++
        annotationsThisWeek.add(e.id)
      }
      // Collect history chain entries created this week
      const weeklyEntries = (ann.historyChain || [])
        .filter(he => between(he.createdAt, startMs, endMs))
        .map(he => ({
          type: he.type,
          author: he.author,
          content: clip(he.content, 300),
          createdAt: he.createdAt,
        }))
      if (annCreatedThisWeek || weeklyEntries.length > 0) {
        thinking.push({
          entryId: e.id,
          entryTitle: e.title,
          annotationId: ann.id,
          selectedText: clip(ann.anchor?.selectedText, 150),
          pageNumber: ann.anchor?.pageNumber || 0,
          createdAt: ann.createdAt,
          entries: weeklyEntries,
        })
        historyEntriesCreatedCount += weeklyEntries.length
      }

      // Harvest user stances across all time (for contradiction detection)
      for (const he of ann.historyChain || []) {
        if (he.type === 'stance' && he.author === 'user') {
          recentStances.push({
            entryId: e.id,
            entryTitle: e.title,
            content: clip(he.content, 200),
            createdAt: he.createdAt,
          })
        }
      }
    }
  }
  recentStances.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const recentStancesTop = recentStances.slice(0, 30)

  // === 3. Memos touched ===
  const memos = (library.memos || [])
    .filter(m => between(m.updatedAt, startMs, endMs) || between(m.createdAt, startMs, endMs))
    .map(m => ({
      memoId: m.id,
      title: m.title,
      blockCount: (m.blocks || []).length,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      preview: clip((m.content || '').replace(/\n+/g, ' ').trim(), 200),
    }))

  // === 4. Struggling entries (opened ≥3 times in 4 weeks, <2 annotations) ===
  const fourWeeksAgo = endMs - 28 * 86400000
  const opensIn4WeeksMap = new Map<string, number>()
  // Since we only have lastOpenedAt (not per-open history), use readingLogs if available
  for (const log of library.readingLogs || []) {
    const logDate = new Date(log.date + 'T00:00:00').getTime()
    if (logDate >= fourWeeksAgo && logDate < endMs) {
      for (const ev of log.events || []) {
        if (ev.type === 'open_doc' && ev.entryId) {
          opensIn4WeeksMap.set(ev.entryId, (opensIn4WeeksMap.get(ev.entryId) || 0) + 1)
        }
      }
    }
  }
  const strugglingEntries: ApprenticeContext['wider']['strugglingEntries'] = []
  for (const [entryId, opens] of opensIn4WeeksMap.entries()) {
    if (opens < 3) continue
    const entry = entries.find(e => e.id === entryId)
    if (!entry) continue
    const meta = await loadMeta(entryId)
    const annCount = meta?.annotations?.length || 0
    if (annCount < 2) {
      strugglingEntries.push({ entryId, title: entry.title, opensIn4Weeks: opens, annotationCount: annCount })
    }
  }
  strugglingEntries.sort((a, b) => b.opensIn4Weeks - a.opensIn4Weeks)

  // === 5. Active days ===
  const activeDays = new Set<string>()
  for (const { days } of readingMap.values()) {
    for (const d of days) activeDays.add(d)
  }
  for (const t of thinking) activeDays.add(new Date(t.createdAt).toISOString().slice(0, 10))
  for (const m of memos) activeDays.add(new Date(m.updatedAt).toISOString().slice(0, 10))

  // === 6. Previous week's log for continuity ===
  const prevStart = new Date(start.getTime() - 7 * 86400000)
  const prevWeekCode = isoWeekCode(prevStart)
  let previousWeekLog: string | null = null
  try {
    previousWeekLog = await fs.readFile(path.join(APPRENTICE_DIR, `${prevWeekCode}.md`), 'utf-8')
  } catch { /* may not exist */ }

  // === Build reading list ===
  const reading: ApprenticeContext['reading'] = Array.from(readingMap.values()).map(({ entry, days }) => ({
    entryId: entry.id,
    title: entry.title,
    openCount: days.size,
    lastOpenedAt: entry.lastOpenedAt,
    hasAnnotationsThisWeek: annotationsThisWeek.has(entry.id),
  })).sort((a, b) => b.openCount - a.openCount)

  return {
    weekCode,
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    stats: {
      activeDays: activeDays.size,
      entriesOpened: readingMap.size,
      annotationsCreated: annotationsCreatedCount,
      historyEntriesCreated: historyEntriesCreatedCount,
      memosEdited: memos.length,
    },
    reading,
    thinking,
    memos,
    wider: {
      recentStances: recentStancesTop,
      strugglingEntries: strugglingEntries.slice(0, 5),
    },
    previousWeekLog,
  }
}

// ===== IPC handlers =====
export function registerApprenticeIpc(): void {
  // Collect the context for a given week. `targetDateIso` optional (defaults to now).
  ipcMain.handle('apprentice-collect-context', async (_event, targetDateIso?: string) => {
    try {
      const target = targetDateIso ? new Date(targetDateIso) : new Date()
      const ctx = await collectApprenticeContext(target)
      return { success: true, context: ctx }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // List all existing apprentice log files
  ipcMain.handle('apprentice-list', async () => {
    try {
      await ensureDir()
      const files = await fs.readdir(APPRENTICE_DIR)
      const entries = []
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        try {
          const s = await fs.stat(path.join(APPRENTICE_DIR, f))
          entries.push({
            weekCode: f.replace(/\.md$/, ''),
            size: s.size,
            mtime: s.mtime.toISOString(),
          })
        } catch { /* skip */ }
      }
      entries.sort((a, b) => b.weekCode.localeCompare(a.weekCode))
      return { success: true, entries }
    } catch (err: any) {
      return { success: false, error: err.message, entries: [] }
    }
  })

  // Load a specific week's log
  ipcMain.handle('apprentice-load', async (_event, weekCode: string) => {
    try {
      await ensureDir()
      const content = await fs.readFile(path.join(APPRENTICE_DIR, `${weekCode}.md`), 'utf-8')
      return { success: true, content }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Save a generated log
  ipcMain.handle('apprentice-save', async (_event, weekCode: string, content: string) => {
    try {
      await ensureDir()
      await atomicWriteFile(path.join(APPRENTICE_DIR, `${weekCode}.md`), content)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Delete a log
  ipcMain.handle('apprentice-delete', async (_event, weekCode: string) => {
    try {
      await fs.unlink(path.join(APPRENTICE_DIR, `${weekCode}.md`))
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
