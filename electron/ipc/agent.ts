import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { AgentConversation, HermesSkill, HermesInsight } from '../../src/types/library'
import { atomicWriteFile, atomicWriteJson, safeLoadJsonOrBackup } from './library'

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const AGENT_DIR = path.join(DATA_DIR, 'agent')
const MEMORY_FILE = path.join(AGENT_DIR, 'memory.md')
const CONVERSATIONS_FILE = path.join(AGENT_DIR, 'conversations.json')
const INSIGHTS_FILE = path.join(AGENT_DIR, 'insights.json')
const SKILLS_FILE = path.join(AGENT_DIR, 'skills.json')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')

async function ensureAgentDir() {
  await fs.mkdir(AGENT_DIR, { recursive: true })
}

// BUG-FIX R8#3 · agent.ts:289 / 312 · agent-save-conversation / agent-delete-conversation 加 RMW 锁
//   原问题(_BUG_REPORT.md R2 观察项):两个 handler 都是 read-modify-write 但没串行化。
//   两个并发 IPC 调用(双窗口 / 一边自动保存一边手动重命名)会出现:
//     A 读 [a, b, c] → B 读 [a, b, c] → A 写 [a', b, c] → B 写 [a, b', c] (覆盖 A)
//   atomicWriteJson 自身的 writeLock 只保证写串行,不阻止 read 跨过。
//   修法:模块级 promise chain 把整个 RMW 串起来。失败时 catch 把链路 reset
//   让后续调用不被前一次失败卡死。
let conversationsRMWChain: Promise<unknown> = Promise.resolve()
function withConversationsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = conversationsRMWChain.catch(() => { /* prior failure shouldn't block */ }).then(() => fn())
  conversationsRMWChain = next.catch(() => { /* swallow for chain bookkeeping */ })
  return next
}

// ===== Tool execution helpers =====

// BUG-FIX R2#ζ · log corrupt JSON explicitly instead of swallowing silently.
// A corrupt library.json otherwise made Hermes tool calls return "文献库未加载"
// with no indication of why in the console.
async function readLibrary(): Promise<any> {
  let content: string
  try {
    content = await fs.readFile(LIBRARY_FILE, 'utf-8')
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.warn('[agent] readLibrary failed:', err?.message || err)
    return null
  }
  try {
    return JSON.parse(content)
  } catch (err: any) {
    console.error('[agent] library.json corrupt — Hermes tools will return empty:', err?.message || err)
    return null
  }
}

async function loadMeta(entryId: string): Promise<any> {
  try {
    const metaPath = path.join(DATA_DIR, 'meta', `${entryId}.json`)
    const content = await fs.readFile(metaPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

function clipText(value: any, max = 300): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// Collect user-touched evidence across the library. This is intentionally NOT
// full-text RAG: cross-document insight should grow out of what the user has
// read, marked, annotated, or cited, instead of silently mining unread pages.
async function collectAllEvidence(library: any): Promise<Array<{
  type: 'annotation' | 'mark' | 'memo-block' | 'memo'
  entryId?: string
  entryTitle?: string
  memoId?: string
  memoTitle?: string
  selectedText: string
  notes: string[]
  pageNumber?: number
  createdAt: string
  updatedAt?: string
  weight: number
}>> {
  const results: any[] = []

  for (const entry of (library.entries || [])) {
    const meta = await loadMeta(entry.id)
    for (const ann of meta?.annotations || []) {
      const notes = (ann.historyChain || [])
        .filter((h: any) => h.author === 'user')
        .map((h: any) => clipText(h.content, 300))
        .filter(Boolean)
      results.push({
        type: 'annotation',
        entryId: entry.id,
        entryTitle: entry.title,
        selectedText: clipText(ann.anchor?.selectedText, 240),
        notes,
        pageNumber: ann.anchor?.pageNumber || 0,
        createdAt: ann.createdAt || '',
        updatedAt: ann.updatedAt,
        weight: 3 + Math.min(notes.length, 3),
      })
    }
    for (const mark of meta?.marks || []) {
      results.push({
        type: 'mark',
        entryId: entry.id,
        entryTitle: entry.title,
        selectedText: clipText(mark.selectedText, 240),
        notes: [`${mark.type === 'bold' ? '高光' : '划线'}标记${mark.color ? ` · ${mark.color}` : ''}`],
        pageNumber: mark.pageNumber || 0,
        createdAt: mark.createdAt || '',
        weight: 2,
      })
    }
  }

  for (const memo of (library.memos || [])) {
    const memoContent = clipText(memo.content, 500)
    if (memoContent) {
      results.push({
        type: 'memo',
        memoId: memo.id,
        memoTitle: memo.title,
        selectedText: memoContent,
        notes: [],
        createdAt: memo.createdAt || '',
        updatedAt: memo.updatedAt,
        weight: 2 + Math.min(Math.floor(memoContent.length / 120), 4),
      })
    }
    for (const block of memo.blocks || []) {
      results.push({
        type: 'memo-block',
        entryId: block.entryId,
        entryTitle: block.entryTitle,
        memoId: memo.id,
        memoTitle: memo.title,
        selectedText: clipText(block.selectedText, 220),
        notes: [clipText(block.blockContent, 300)].filter(Boolean),
        createdAt: memo.updatedAt || memo.createdAt || '',
        weight: 4,
      })
    }
  }

  return results
}

// Back-compat helper for older tools that still think in "annotations".
async function collectAllAnnotations(library: any): Promise<Array<{
  entryId: string; entryTitle: string; selectedText: string; notes: string[];
  pageNumber: number; createdAt: string;
}>> {
  return (await collectAllEvidence(library))
    .filter((item: any) => item.entryId)
    .map((item: any) => ({
      entryId: item.entryId,
      entryTitle: item.entryTitle,
      selectedText: item.selectedText,
      notes: item.notes,
      pageNumber: item.pageNumber || 0,
      createdAt: item.createdAt,
    }))
}

async function readOcrText(absPath: string): Promise<string | null> {
  try {
    const ocrPath = absPath.replace(/\.[^.]+$/, '.ocr.txt')
    return await fs.readFile(ocrPath, 'utf-8')
  } catch {
    return null
  }
}

function toTime(value: any): number {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

async function buildReadingState(library: any, days = 14): Promise<any> {
  const safeDays = Math.max(1, Math.min(Number(days) || 14, 90))
  const cutoff = Date.now() - safeDays * 86400000
  const evidence = await collectAllEvidence(library)
  const recentEvidence = evidence.filter(item => Math.max(toTime(item.createdAt), toTime(item.updatedAt)) >= cutoff)
  const evidenceByEntry = new Map<string, { count: number; weight: number; latest: number }>()
  for (const item of evidence) {
    if (!item.entryId) continue
    const prev = evidenceByEntry.get(item.entryId) || { count: 0, weight: 0, latest: 0 }
    prev.count += 1
    prev.weight += item.weight || 1
    prev.latest = Math.max(prev.latest, toTime(item.updatedAt), toTime(item.createdAt))
    evidenceByEntry.set(item.entryId, prev)
  }

  const entries = (library.entries || []).map((entry: any) => {
    const stats = entry.readingStats || {}
    const ev = evidenceByEntry.get(entry.id) || { count: 0, weight: 0, latest: 0 }
    const lastAt = Math.max(toTime(stats.lastAt), toTime(entry.lastOpenedAt), ev.latest)
    return {
      id: entry.id,
      title: entry.title,
      authors: entry.authors || [],
      tags: entry.tags || [],
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      totalMinutes: Math.round((stats.totalMs || 0) / 60000),
      sessionCount: stats.sessionCount || 0,
      evidenceCount: ev.count,
      evidenceWeight: ev.weight,
      touchedRecently: lastAt >= cutoff,
      depth: ev.weight >= 10 ? 'deep' : ev.weight >= 4 ? 'active' : ev.count > 0 ? 'light' : 'opened',
    }
  })

  const activeEntries = entries
    .filter((entry: any) => entry.touchedRecently)
    .sort((a: any, b: any) => (toTime(b.lastAt) - toTime(a.lastAt)) || (b.evidenceWeight - a.evidenceWeight))
    .slice(0, 20)

  const topEvidenceEntries = entries
    .filter((entry: any) => entry.evidenceCount > 0)
    .sort((a: any, b: any) => b.evidenceWeight - a.evidenceWeight)
    .slice(0, 12)

  const openedWithoutEvidence = entries
    .filter((entry: any) => entry.totalMinutes > 0 && entry.evidenceCount === 0)
    .sort((a: any, b: any) => b.totalMinutes - a.totalMinutes)
    .slice(0, 8)

  const memos = (library.memos || [])
    .filter((memo: any) => Math.max(toTime(memo.updatedAt), toTime(memo.createdAt)) >= cutoff)
    .sort((a: any, b: any) => toTime(b.updatedAt) - toTime(a.updatedAt))
    .slice(0, 12)
    .map((memo: any) => ({
      id: memo.id,
      title: memo.title,
      updatedAt: memo.updatedAt,
      blockCount: (memo.blocks || []).length,
      preview: clipText(memo.content, 180),
    }))

  return {
    windowDays: safeDays,
    activeEntryCount: activeEntries.length,
    touchedEvidenceCount: evidence.length,
    recentEvidenceCount: recentEvidence.length,
    activeEntries,
    topEvidenceEntries,
    openedWithoutEvidence,
    recentEvidence: recentEvidence
      .sort((a, b) => Math.max(toTime(b.updatedAt), toTime(b.createdAt)) - Math.max(toTime(a.updatedAt), toTime(a.createdAt)))
      .slice(0, 20)
      .map(item => ({
        type: item.type,
        entryTitle: item.entryTitle,
        memoTitle: item.memoTitle,
        text: clipText(item.selectedText, 120),
        note: clipText(item.notes?.[0], 120),
        createdAt: item.createdAt,
      })),
    memos,
    principle: 'This state is derived from user-touched evidence: opens, reading stats, annotations, marks, memo blocks, and memo edits.',
  }
}

// ===== Tool executor =====
// Each tool returns a JSON string result for the agent

async function executeTool(toolName: string, argsJson: string): Promise<string> {
  const library = await readLibrary()
  if (!library) return JSON.stringify({ error: '文献库未加载' })

  let args: any = {}
  try { args = JSON.parse(argsJson) } catch { args = {} }

  switch (toolName) {
    case 'search_library': {
      const query = (args.query || '').toLowerCase()
      const results = (library.entries || [])
        .filter((e: any) =>
          e.title?.toLowerCase().includes(query) ||
          (e.tags || []).some((t: string) => t.toLowerCase().includes(query)) ||
          (e.authors || []).some((a: string) => a.toLowerCase().includes(query))
        )
        .slice(0, 20)
        .map((e: any) => ({
          id: e.id, title: e.title, authors: e.authors, tags: e.tags,
          addedAt: e.addedAt, lastOpenedAt: e.lastOpenedAt,
        }))
      return JSON.stringify({ count: results.length, entries: results })
    }

    case 'get_entry_detail': {
      const entry = (library.entries || []).find((e: any) => e.id === args.entryId)
      if (!entry) return JSON.stringify({ error: '文献未找到' })
      return JSON.stringify(entry)
    }

    case 'get_annotations': {
      const meta = await loadMeta(args.entryId)
      if (!meta) return JSON.stringify({ annotations: [], count: 0 })
      const annotations = (meta.annotations || []).map((a: any) => ({
        id: a.id,
        selectedText: a.anchor?.selectedText,
        pageNumber: a.anchor?.pageNumber,
        historyChain: (a.historyChain || []).map((h: any) => ({
          type: h.type, content: h.content?.slice(0, 500),
          author: h.author, createdAt: h.createdAt,
        })),
      }))
      return JSON.stringify({ count: annotations.length, annotations })
    }

    case 'get_document_text': {
      const entry = (library.entries || []).find((e: any) => e.id === args.entryId)
      if (!entry) return JSON.stringify({ error: '文献未找到' })
      const evidence = (await collectAllEvidence(library))
        .filter(item => item.entryId === entry.id)
        .sort((a, b) => (b.weight - a.weight) || (toTime(b.createdAt) - toTime(a.createdAt)))

      if (args.scope === 'full' && args.confirmedByUser === true) {
        const text = await readOcrText(entry.absPath)
        if (!text) return JSON.stringify({ error: '该文献无 OCR 文本' })
        return JSON.stringify({
          title: entry.title,
          scope: 'full_ocr_explicit',
          warning: 'Full OCR was returned only because the user explicitly asked for full-text work.',
          text: text.slice(0, 8000),
          truncated: text.length > 8000,
        })
      }

      if (evidence.length === 0) {
        return JSON.stringify({
          title: entry.title,
          scope: 'user_touched',
          evidence: [],
          note: '该文献尚无用户标记/注释/笔记引用；按拾卷证据边界，不主动读取未触达全文。',
        })
      }

      return JSON.stringify({
        title: entry.title,
        scope: 'user_touched',
        evidenceCount: evidence.length,
        evidence: evidence.slice(0, 30).map(item => ({
          type: item.type,
          page: item.pageNumber,
          text: item.selectedText,
          notes: item.notes,
          createdAt: item.createdAt,
        })),
      })
    }

    case 'list_memos': {
      const memos = (library.memos || []).map((m: any) => ({
        id: m.id, title: m.title, folderId: m.folderId,
        blockCount: m.blocks?.length || 0,
        updatedAt: m.updatedAt,
      }))
      return JSON.stringify({ count: memos.length, memos })
    }

    case 'read_memo': {
      const memo = (library.memos || []).find((m: any) => m.id === args.memoId)
      if (!memo) return JSON.stringify({ error: '笔记未找到' })
      return JSON.stringify({
        id: memo.id, title: memo.title, content: memo.content?.slice(0, 5000),
        blocks: memo.blocks, updatedAt: memo.updatedAt,
      })
    }

    case 'get_reading_activity': {
      return JSON.stringify(await buildReadingState(library, args.days || 14))
    }

    case 'get_reading_state': {
      return JSON.stringify(await buildReadingState(library, args.days || 14))
    }

    case 'build_knowledge_map': {
      const evidence = await collectAllEvidence(library)
      if (evidence.length === 0) return JSON.stringify({ error: '文献库中暂无用户触达证据' })
      // Group by entry/memo, include notes.
      const byEntry: Record<string, any[]> = {}
      for (const item of evidence) {
        const title = item.entryTitle || `笔记：${item.memoTitle || '未命名笔记'}`
        if (!byEntry[title]) byEntry[title] = []
        byEntry[title].push({ type: item.type, text: item.selectedText, notes: item.notes, page: item.pageNumber, weight: item.weight })
      }
      // Truncate to fit context
      const summary = Object.entries(byEntry).slice(0, 15).map(([title, anns]) =>
        `### ${title}\n${(anns as any[]).slice(0, 8).map(a =>
          `- ${a.type}${a.page ? ` p${a.page}` : ''}「${clipText(a.text, 90)}」${a.notes.length > 0 ? ' → ' + clipText(a.notes[0], 110) : ''}`
        ).join('\n')}`
      ).join('\n\n')
      return JSON.stringify({
        totalNodes: Object.keys(byEntry).length,
        totalEvidence: evidence.length,
        evidenceSummary: summary,
        principle: 'Only user-touched evidence is included: annotations, marks, memo blocks, and memo text.',
      })
    }

    case 'generate_exam': {
      const allAnns = await collectAllEvidence(library)
      if (allAnns.length === 0) return JSON.stringify({ error: '文献库中暂无用户触达证据，无法生成考题' })
      // Group by entry with evidence counts to show depth
      const entryStats = new Map<string, { count: number; notes: string[] }>()
      for (const a of allAnns) {
        const title = a.entryTitle || `笔记：${a.memoTitle || '未命名笔记'}`
        const stat = entryStats.get(title) || { count: 0, notes: [] }
        stat.count++
        if (a.notes.length > 0) stat.notes.push(...a.notes.slice(0, 2))
        entryStats.set(title, stat)
      }
      const overview = [...entryStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15).map(([title, stat]) =>
        `- 「${title}」: ${stat.count} 条注释，笔记摘录：${stat.notes.slice(0, 3).map(n => n.slice(0, 60)).join('；') || '无'}`
      ).join('\n')
      return JSON.stringify({ totalEvidence: allAnns.length, entriesAnalyzed: entryStats.size, readingOverview: overview })
    }

    case 'build_paper_outline': {
      const topic = args.topic || ''
      if (!topic) return JSON.stringify({ error: '请提供论文主题' })
      const allAnns = await collectAllEvidence(library)
      // Filter annotations related to the topic
      const relevant = allAnns.filter(a =>
        a.selectedText.includes(topic) || a.notes.some(n => n.includes(topic)) || (a.entryTitle || '').includes(topic) || (a.memoTitle || '').includes(topic)
      )
      if (relevant.length === 0) return JSON.stringify({ error: `未找到与「${topic}」相关的用户触达证据，尝试更宽泛的关键词` })
      const materials = relevant.slice(0, 20).map(a =>
        `- 来自「${a.entryTitle || a.memoTitle}」${a.pageNumber ? `p${a.pageNumber}` : ''}：「${clipText(a.selectedText, 110)}」${a.notes.length > 0 ? '\n  我的笔记：' + clipText(a.notes[0], 160) : ''}`
      ).join('\n')
      return JSON.stringify({ topic, relevantCount: relevant.length, materials })
    }

    case 'trace_concept_evolution': {
      const concept = args.concept || ''
      if (!concept) return JSON.stringify({ error: '请提供要追踪的概念' })
      const allAnns = await collectAllEvidence(library)
      // Find annotations mentioning the concept, sorted by time
      const matches = allAnns
        .filter(a => a.selectedText.includes(concept) || a.notes.some(n => n.includes(concept)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      if (matches.length === 0) return JSON.stringify({ error: `未找到与「${concept}」相关的用户触达证据` })
      const timeline = matches.slice(0, 20).map(a => ({
        date: a.createdAt.slice(0, 10),
        time: a.createdAt.slice(11, 16),
        entry: a.entryTitle || a.memoTitle,
        page: a.pageNumber,
        evidenceType: a.type,
        text: clipText(a.selectedText, 110),
        myNote: clipText(a.notes[0], 160),
      }))
      return JSON.stringify({ concept, matchCount: matches.length, timeline })
    }

    default:
      return JSON.stringify({ error: `未知工具: ${toolName}` })
  }
}

// ===== Register IPC handlers =====

export function registerAgentIpc(): void {
  // Load agent memory
  ipcMain.handle('agent-load-memory', async () => {
    try {
      await ensureAgentDir()
      const content = await fs.readFile(MEMORY_FILE, 'utf-8').catch(() => '')
      return { success: true, content }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Save agent memory
  ipcMain.handle('agent-save-memory', async (_event, content: string) => {
    try {
      await ensureAgentDir()
      await atomicWriteFile(MEMORY_FILE, content)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Load conversations
  ipcMain.handle('agent-load-conversations', async () => {
    try {
      await ensureAgentDir()
      const conversations = await safeLoadJsonOrBackup<AgentConversation[]>(CONVERSATIONS_FILE, [])
      return { success: true, conversations }
    } catch (err: any) {
      return { success: false, error: err.message, conversations: [] }
    }
  })

  // Save conversation. Read-modify-write the list via safeLoadJsonOrBackup so
  // a corrupt conversations.json gets backed up (not silently overwritten,
  // which would wipe prior history on the next save).
  // BUG-FIX R8#3 · 整个 RMW 序列在 withConversationsLock 内,防并发覆写。
  ipcMain.handle('agent-save-conversation', async (_event, conversation: AgentConversation) => {
    return withConversationsLock(async () => {
      try {
        await ensureAgentDir()
        let conversations = await safeLoadJsonOrBackup<AgentConversation[]>(CONVERSATIONS_FILE, [])

        const idx = conversations.findIndex(c => c.id === conversation.id)
        if (idx >= 0) {
          conversations[idx] = conversation
        } else {
          conversations.unshift(conversation)
        }

        // Keep last 50 conversations
        if (conversations.length > 50) conversations = conversations.slice(0, 50)

        await atomicWriteJson(CONVERSATIONS_FILE, conversations)
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })
  })

  // Delete a conversation by id
  // BUG-FIX R8#3 · 同样走 withConversationsLock 防 save+delete 交叉。
  ipcMain.handle('agent-delete-conversation', async (_event, conversationId: string) => {
    return withConversationsLock(async () => {
      try {
        await ensureAgentDir()
        const conversations = await safeLoadJsonOrBackup<AgentConversation[]>(CONVERSATIONS_FILE, [])
        const next = conversations.filter(c => c.id !== conversationId)
        await atomicWriteJson(CONVERSATIONS_FILE, next)
        return { success: true }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })
  })

  // Execute tool
  ipcMain.handle('agent-execute-tool', async (_event, toolName: string, argsJson: string) => {
    try {
      const result = await executeTool(toolName, argsJson)
      return { success: true, result }
    } catch (err: any) {
      return { success: false, result: JSON.stringify({ error: err.message }) }
    }
  })

  // ===== Insights =====

  // Load cached insight
  ipcMain.handle('agent-load-insight', async () => {
    try {
      await ensureAgentDir()
      const insight = await safeLoadJsonOrBackup<HermesInsight | null>(INSIGHTS_FILE, null)
      return { success: true, insight }
    } catch {
      return { success: true, insight: null }
    }
  })

  // Save insight
  ipcMain.handle('agent-save-insight', async (_event, insight: HermesInsight) => {
    try {
      await ensureAgentDir()
      await atomicWriteJson(INSIGHTS_FILE, insight)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ===== Skills =====

  // Load skills
  ipcMain.handle('agent-load-skills', async () => {
    try {
      await ensureAgentDir()
      const skills = await safeLoadJsonOrBackup<HermesSkill[]>(SKILLS_FILE, [])
      return { success: true, skills }
    } catch {
      return { success: true, skills: [] }
    }
  })

  // Save skills (full array)
  ipcMain.handle('agent-save-skills', async (_event, skills: HermesSkill[]) => {
    try {
      await ensureAgentDir()
      await atomicWriteJson(SKILLS_FILE, skills)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
