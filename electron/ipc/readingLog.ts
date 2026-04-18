import { ipcMain, BrowserWindow, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { callChat } from './aiApi'
import { mutateLibraryOnDisk } from './library'
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

// NOTE: This backend-side prompt is currently not the source of truth. The
// renderer's ReadingLogView calls aiChatStream directly with its own system
// prompt (see src/components/ReadingLog/readingLogPrompt.ts). This IPC
// handler's SUMMARY_SYSTEM_PROMPT is only used if a caller actually invokes
// `reading-log-generate-summary`, which at present nobody does.
//
// If you reactivate that IPC (e.g. for a background scheduler to auto-generate
// summaries), make it accept the system prompt as a parameter rather than
// duplicating the prompt string — otherwise it WILL drift again.
//
// Kept in sync with readingLogPrompt.ts as of batch 26.
const SUMMARY_SYSTEM_PROMPT = `你是拾卷读者的"同伴"——今天跟他/她坐在同一张桌子旁一起读书的同伴。

你要写的不是"今日总结"（那是流水账），而是**一天尺度的观察**：说出他自己没意识到的那一天的阅读模式。

用「你」称呼用户（第二人称），直接、克制、不煽情。

---

**写作原则**（严格执行）:

**1. 观察具体痕迹，不罗列事实**
- ✗ "你今天读了 3 篇文献，写了 5 条注释，主要集中在下午。"
- ✓ "你下午连续在《福柯》第 12 页停了两次——第一次写的是「权力即资本」，第二次把它划掉改成了「资本是权力的表层」。"

**2. 抓一条主线，不要全盘铺开**
- 一天的活动可能散碎。选 1-2 个**最有信息量**的痕迹深挖，而不是把所有事件挨个点名。
- 如果今天真的很平淡（只打开没思考），就诚实写"今天只翻了翻《X》没动笔——是在等什么"。

**3. 引用原文 / 注释必须锚定**
- 引用选中的原文用 \`「原文片段」\`
- 引用用户自己的注释用 **"引号"** + 文献名，如 **"这和昨天《论述》里的说法相反"** (《区分》)

**4. 时间戳用来点缀，不要念时间表**
- ✗ "上午 9:15 你打开了... 下午 2:30 你写了... 晚上 8:40 你..."
- ✓ 如果某个时间点本身有意义（比如"深夜 11 点你回到了早上已经关掉的那篇"）再提。没信息量就别提。

**5. 跟最近几天做对比（如果历史摘要给了）**
- 延续：昨天的疑惑今天是否继续？
- 反转：今天推翻了最近的立场？
- 停滞：某本书连续几天打开都没写东西？
- 如果和最近几天没啥关系，就不提。不要硬挂钩。

**6. 诚实面对数据不足**
- 只有 1-2 条痕迹就不要编 4 段文字。两三句话就够。
- 完全没思考痕迹（只是"打开/关闭"），别凑学术总结——直接说"今天没动笔"。

---

**输出格式**

- 自然段，不用 Markdown 标题/列表。
- 2-4 段，每段最多 3-4 句。
- 数据极少时可以只写 1 段甚至 1 句话。
- 不要写结尾祝福或鼓励（"继续加油"、"期待明天"等）。

---

**严禁**:
- 夸饰词："令人印象深刻"、"非常深入"、"极具洞察力"
- 鸡汤："学无止境"、"坚持就是胜利"
- 套话："作为一名学者"、"从学术角度看"
- 凭空判断："你对 X 有深刻理解"（你不知道他理解到什么程度，只知道他写了什么）
- 排比罗列所有文献名和注释数

你看到的是思考的**痕迹**，不是思考本身。只说痕迹透露的、他自己可能没看见的东西。`

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
  // Read-modify-write happens under the shared writeLock from library.ts so the
  // midnight scheduler can't clobber a concurrent frontend save (and vice versa).
  const updated = await mutateLibraryOnDisk((library) => {
    if (!library.readingLogs) library.readingLogs = []
    const idx = library.readingLogs.findIndex(l => l.date === log.date)
    if (idx >= 0) {
      library.readingLogs[idx] = log
    } else {
      library.readingLogs.unshift(log) // newest first
    }
    return library
  })

  // Tell the renderer to re-sync its in-memory library so a subsequent frontend
  // save doesn't stomp the log we just wrote. No-op if no window is open.
  if (updated) {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('library-changed-on-disk') } catch {}
    }
  }
}

// ===== Midnight scheduler =====

// Use LOCAL date (not UTC) because day boundaries in collectEventsForDate parse
// `${date}T00:00:00` as local time. If we used `.toISOString().slice(0,10)` the
// scheduler would flip at 00:00 UTC — which is 08:00 in China — and daily logs
// would straddle the wrong 24-hour window.
function getLocalDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getYesterdayLocal(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return getLocalDateStr(d)
}

async function maybeGenerateLogForDate(mainWindow: BrowserWindow, date: string): Promise<void> {
  try {
    // Skip if a log for this date is already on disk (startup backfill idempotency)
    const library = await loadLibrary()
    if (library?.readingLogs?.some(l => l.date === date)) return

    const events = await collectEventsForDate(date)
    if (events.length === 0) return

    const log: ReadingLog = {
      id: uuid(),
      date,
      events,
      generatedAt: new Date().toISOString(),
    }
    await saveLogToLibrary(log)
    // Guard: on macOS, the window that was passed in may have been closed while
    // the app kept running; webContents.send throws on destroyed senders.
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reading-log-generated', log)
    }
    console.log(`[reading-log] Generated log for ${date}: ${events.length} events`)
  } catch (err) {
    console.error('[reading-log] Failed to generate daily log:', err)
  }
}

// Singleton: the scheduler runs exactly once for the app lifetime. `activate`
// events on macOS would otherwise stack a new setInterval per re-activation,
// leaking timers and multiplying work every minute.
let schedulerHandle: NodeJS.Timeout | null = null
let schedulerMainWindow: BrowserWindow | null = null
let schedulerLastCheckedDate: string | null = null

export function startMidnightScheduler(mainWindow: BrowserWindow): void {
  // Re-point the window reference so freshly-opened windows receive events.
  schedulerMainWindow = mainWindow

  if (schedulerHandle) {
    // Already running — just update the window target; don't double-schedule.
    return
  }

  schedulerLastCheckedDate = getLocalDateStr()

  // Startup backfill: if app restarted across a midnight boundary and yesterday's
  // log isn't on disk yet, generate it now.
  maybeGenerateLogForDate(mainWindow, getYesterdayLocal())

  schedulerHandle = setInterval(async () => {
    const win = schedulerMainWindow
    if (!win) return
    const today = getLocalDateStr()
    if (today !== schedulerLastCheckedDate) {
      const prevDate = schedulerLastCheckedDate ?? today
      schedulerLastCheckedDate = today
      await maybeGenerateLogForDate(win, prevDate)
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
