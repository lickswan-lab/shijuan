import { ipcMain, BrowserWindow, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { callChat } from './aiApi'
import type { Library, PdfMeta, ReadingLogEvent, ReadingLog } from '../../src/types/library'

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const META_DIR = path.join(DATA_DIR, 'meta')

// ===== Helpers =====

async function loadLibrary(): Promise<Library | null> {
  try {
    const content = await fs.readFile(LIBRARY_FILE, 'utf-8')
    return JSON.parse(content)
  } catch { return null }
}

async function loadMeta(entryId: string): Promise<PdfMeta | null> {
  try {
    const content = await fs.readFile(path.join(META_DIR, `${entryId}.json`), 'utf-8')
    return JSON.parse(content)
  } catch { return null }
}

function isInDay(iso: string | undefined | null, dayStart: number, dayEnd: number): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  return t >= dayStart && t < dayEnd
}

function clip(text: string | undefined, max = 80): string {
  if (!text) return ''
  return text.length > max ? text.substring(0, max) + '...' : text
}

const EVENT_TYPE_MAP: Record<string, ReadingLogEvent['type']> = {
  'note': 'note',
  'question': 'question',
  'stance': 'stance',
  'link': 'ai_interaction',
  'ai_interpretation': 'ai_interaction',
  'ai_qa': 'ai_interaction',
  'ai_feedback': 'ai_interaction',
}

// ===== Event collection =====

async function collectEventsForDate(date: string): Promise<ReadingLogEvent[]> {
  const library = await loadLibrary()
  if (!library) return []

  const dayStart = new Date(`${date}T00:00:00`).getTime()
  const dayEnd = new Date(`${date}T23:59:59.999`).getTime() + 1

  const events: ReadingLogEvent[] = []

  // 1. Entry opens
  for (const entry of library.entries || []) {
    if (isInDay(entry.lastOpenedAt, dayStart, dayEnd)) {
      events.push({
        id: uuid(),
        timestamp: entry.lastOpenedAt!,
        type: 'open_doc',
        entryId: entry.id,
        entryTitle: entry.title,
        detail: `打开了「${entry.title}」`,
      })
    }
  }

  // 2. Per-entry annotations & marks
  const metaResults = await Promise.allSettled(
    (library.entries || []).map(async entry => {
      const meta = await loadMeta(entry.id)
      if (!meta) return
      // Annotations
      for (const ann of meta.annotations || []) {
        if (isInDay(ann.createdAt, dayStart, dayEnd)) {
          events.push({
            id: uuid(),
            timestamp: ann.createdAt,
            type: 'annotate',
            entryId: entry.id,
            entryTitle: entry.title,
            annotationId: ann.id,
            detail: `在「${entry.title}」中添加了注释`,
            selectedText: clip(ann.anchor?.selectedText),
          })
        }
        // History chain entries
        for (const he of ann.historyChain || []) {
          if (!isInDay(he.createdAt, dayStart, dayEnd)) continue
          const evType = EVENT_TYPE_MAP[he.type] || 'note'
          const label = he.author === 'ai'
            ? (he.type === 'ai_interpretation' ? 'AI 解读' : he.type === 'ai_feedback' ? 'AI 反馈' : 'AI 回复')
            : (he.type === 'question' ? '提出质疑' : he.type === 'stance' ? '记录立场' : '写了笔记')
          events.push({
            id: uuid(),
            timestamp: he.createdAt,
            type: evType,
            entryId: entry.id,
            entryTitle: entry.title,
            annotationId: ann.id,
            detail: `在「${entry.title}」的注释中${label}`,
            selectedText: clip(he.content),
          })
        }
      }
      // Text marks
      for (const mark of meta.marks || []) {
        if (isInDay(mark.createdAt, dayStart, dayEnd)) {
          events.push({
            id: uuid(),
            timestamp: mark.createdAt,
            type: 'mark_text',
            entryId: entry.id,
            entryTitle: entry.title,
            detail: `在「${entry.title}」中标记了文字`,
            selectedText: clip(mark.selectedText),
          })
        }
      }
    })
  )
  // Ignore errors from individual meta loads
  void metaResults

  // 3. Memos
  for (const memo of library.memos || []) {
    if (isInDay(memo.createdAt, dayStart, dayEnd)) {
      events.push({
        id: uuid(),
        timestamp: memo.createdAt,
        type: 'memo_create',
        memoId: memo.id,
        memoTitle: memo.title,
        detail: `创建了思考笔记「${memo.title}」`,
      })
    }
    if (isInDay(memo.updatedAt, dayStart, dayEnd) && memo.updatedAt !== memo.createdAt) {
      events.push({
        id: uuid(),
        timestamp: memo.updatedAt,
        type: 'memo_edit',
        memoId: memo.id,
        memoTitle: memo.title,
        detail: `编辑了思考笔记「${memo.title}」`,
      })
    }
    // Memo AI history
    for (const he of memo.aiHistory || []) {
      if (isInDay(he.createdAt, dayStart, dayEnd)) {
        events.push({
          id: uuid(),
          timestamp: he.createdAt,
          type: 'ai_interaction',
          memoId: memo.id,
          memoTitle: memo.title,
          detail: `在笔记「${memo.title}」中与 AI 对话`,
          selectedText: clip(he.content),
        })
      }
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Merge: same document + same type within 5min → combine with count
  // Different types stay as separate events (keeps detail without being overwhelming)
  const MERGE_GAP_MS = 5 * 60 * 1000
  const merged: ReadingLogEvent[] = []

  for (const ev of events) {
    const prev = merged[merged.length - 1]
    const gap = prev ? new Date(ev.timestamp).getTime() - new Date(prev.timestamp).getTime() : Infinity
    const sameTarget = prev
      && ev.type === prev.type
      && (ev.entryId || ev.memoId) === (prev.entryId || prev.memoId)

    if (prev && sameTarget && gap <= MERGE_GAP_MS) {
      // Merge: update count
      const countMatch = prev.detail.match(/×(\d+)$/)
      const count = countMatch ? parseInt(countMatch[1]) + 1 : 2
      prev.detail = prev.detail.replace(/×\d+$/, '').replace(/\(\d+条\)$/, '').trim() + `×${count}`
      if (ev.selectedText && (!prev.selectedText || ev.selectedText.length > prev.selectedText.length)) {
        prev.selectedText = ev.selectedText
      }
    } else {
      merged.push({ ...ev })
    }
  }

  return merged
}

// ===== AI Summary =====

const SUMMARY_SYSTEM_PROMPT = `你是一位学术阅读助手，正在和用户对话。请基于用户今天的阅读活动记录，生成一份简洁的每日阅读总结。

重要：用「你」称呼用户（第二人称），像朋友和学术伙伴在跟用户聊天回顾今天的阅读。不要用「我」。禁止使用「亲爱的」等过于亲昵的称呼，直接用「你」即可。

要求：
1. 用2-4段中文概述今天的阅读和思考活动
2. 提及具体的时间点（如"上午9点"、"下午2点"），让总结与时间线对应
3. 如果用户在多篇文献间有关联性的注释或思考，指出这些联系
4. 如果发现用户的注释中有值得深入思考的问题或矛盾，简要提及
5. 语气温和、鼓励，像一位学术伙伴在跟你聊天
6. 不要列举每一个事件，而是抓住重点和亮点
7. 如果提供了历史日志摘要，可以提及与之前阅读的延续或变化`

async function generateSummary(
  events: ReadingLogEvent[],
  date: string,
  recentLogs: ReadingLog[],
  model: string
): Promise<string> {
  const timeline = events.map(e => {
    const t = new Date(e.timestamp)
    const timeStr = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`
    return `${timeStr} - ${e.detail}${e.selectedText ? `（"${e.selectedText}"）` : ''}`
  }).join('\n')

  let userMsg = `日期：${date}\n\n今日活动时间线：\n${timeline}`

  if (recentLogs.length > 0) {
    const history = recentLogs.slice(0, 3).map(l =>
      `${l.date}: ${(l.aiSummary || '无总结').substring(0, 200)}`
    ).join('\n\n')
    userMsg += `\n\n最近几天的阅读总结（供参考关联）：\n${history}`
  }

  // Parse model spec: "providerId:modelId"
  let providerId = 'glm'
  let modelId = 'glm-4-flash'
  if (model.includes(':')) {
    const [p, m] = model.split(':', 2)
    providerId = p
    modelId = m
  }

  return await callChat(providerId, modelId, [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: userMsg },
  ])
}

// ===== Save log =====

async function saveLogToLibrary(log: ReadingLog): Promise<void> {
  const library = await loadLibrary()
  if (!library) return
  if (!library.readingLogs) library.readingLogs = []

  const idx = library.readingLogs.findIndex(l => l.date === log.date)
  if (idx >= 0) {
    library.readingLogs[idx] = log
  } else {
    library.readingLogs.unshift(log) // newest first
  }

  const tmpPath = LIBRARY_FILE + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify(library, null, 2), 'utf-8')
  await fs.rename(tmpPath, LIBRARY_FILE)
}

// ===== Midnight scheduler =====

export function startMidnightScheduler(mainWindow: BrowserWindow): void {
  let lastCheckedDate = new Date().toISOString().slice(0, 10)

  setInterval(async () => {
    const today = new Date().toISOString().slice(0, 10)
    if (today !== lastCheckedDate) {
      const yesterday = lastCheckedDate
      lastCheckedDate = today

      try {
        const events = await collectEventsForDate(yesterday)
        if (events.length > 0) {
          const log: ReadingLog = {
            id: uuid(),
            date: yesterday,
            events,
            generatedAt: new Date().toISOString(),
          }
          await saveLogToLibrary(log)
          mainWindow.webContents.send('reading-log-generated', log)
          console.log(`[reading-log] Generated log for ${yesterday}: ${events.length} events`)
        }
      } catch (err) {
        console.error('[reading-log] Failed to generate daily log:', err)
      }
    }
  }, 60_000) // Check every minute
}

// ===== Register IPC =====

export function registerReadingLogIpc(): void {
  ipcMain.handle('reading-log-collect-events', async (_event, date: string) => {
    try {
      const events = await collectEventsForDate(date)
      return { success: true, events }
    } catch (err: any) {
      return { success: false, events: [], error: err.message }
    }
  })

  ipcMain.handle('reading-log-generate-summary', async (_event, params: {
    events: ReadingLogEvent[]
    date: string
    recentLogs: ReadingLog[]
    model: string
  }) => {
    try {
      const text = await generateSummary(params.events, params.date, params.recentLogs, params.model)
      return { success: true, text }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('reading-log-save', async (_event, log: ReadingLog) => {
    try {
      await saveLogToLibrary(log)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
