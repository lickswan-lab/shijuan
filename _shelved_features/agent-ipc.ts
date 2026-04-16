import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { AgentConversation, HermesSkill, HermesInsight } from '../../src/types/library'

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

// ===== Tool execution helpers =====

async function readLibrary(): Promise<any> {
  try {
    const content = await fs.readFile(LIBRARY_FILE, 'utf-8')
    return JSON.parse(content)
  } catch {
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

// Collect ALL annotations across the entire library (for cross-doc analysis)
async function collectAllAnnotations(library: any): Promise<Array<{
  entryId: string; entryTitle: string; selectedText: string; notes: string[];
  pageNumber: number; createdAt: string;
}>> {
  const results: any[] = []
  for (const entry of (library.entries || [])) {
    const meta = await loadMeta(entry.id)
    if (!meta?.annotations) continue
    for (const ann of meta.annotations) {
      const notes = (ann.historyChain || [])
        .filter((h: any) => h.author === 'user')
        .map((h: any) => h.content?.slice(0, 300) || '')
      results.push({
        entryId: entry.id,
        entryTitle: entry.title,
        selectedText: ann.anchor?.selectedText?.slice(0, 200) || '',
        notes,
        pageNumber: ann.anchor?.pageNumber || 0,
        createdAt: ann.createdAt || '',
      })
    }
  }
  return results
}

async function readOcrText(absPath: string): Promise<string | null> {
  try {
    const ocrPath = absPath.replace(/\.[^.]+$/, '.ocr.txt')
    return await fs.readFile(ocrPath, 'utf-8')
  } catch {
    return null
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
      const text = await readOcrText(entry.absPath)
      if (!text) return JSON.stringify({ error: '该文献无 OCR 文本' })
      // Truncate to ~8000 chars to avoid blowing up context
      return JSON.stringify({ title: entry.title, text: text.slice(0, 8000), truncated: text.length > 8000 })
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
      const days = args.days || 7
      const logs = (library.readingLogs || []).slice(0, days)
      return JSON.stringify({
        count: logs.length,
        logs: logs.map((l: any) => ({
          date: l.date, eventCount: l.events?.length || 0,
          hasSummary: !!l.aiSummary,
          events: (l.events || []).slice(0, 10).map((e: any) => ({
            type: e.type, detail: e.detail, timestamp: e.timestamp,
          })),
        })),
      })
    }

    case 'build_knowledge_map': {
      const allAnns = await collectAllAnnotations(library)
      if (allAnns.length === 0) return JSON.stringify({ error: '文献库中暂无注释' })
      // Group by entry, include notes
      const byEntry: Record<string, any[]> = {}
      for (const a of allAnns) {
        if (!byEntry[a.entryTitle]) byEntry[a.entryTitle] = []
        byEntry[a.entryTitle].push({ text: a.selectedText, notes: a.notes, page: a.pageNumber })
      }
      // Truncate to fit context
      const summary = Object.entries(byEntry).slice(0, 15).map(([title, anns]) =>
        `### ${title}\n${(anns as any[]).slice(0, 8).map(a =>
          `- p${a.page}「${a.text.slice(0, 80)}」${a.notes.length > 0 ? ' → ' + a.notes[0].slice(0, 100) : ''}`
        ).join('\n')}`
      ).join('\n\n')
      return JSON.stringify({ totalEntries: Object.keys(byEntry).length, totalAnnotations: allAnns.length, annotationSummary: summary })
    }

    case 'generate_exam': {
      const allAnns = await collectAllAnnotations(library)
      if (allAnns.length === 0) return JSON.stringify({ error: '文献库中暂无注释，无法生成考题' })
      // Group by entry with note counts to show depth
      const entryStats = new Map<string, { count: number; notes: string[] }>()
      for (const a of allAnns) {
        const stat = entryStats.get(a.entryTitle) || { count: 0, notes: [] }
        stat.count++
        if (a.notes.length > 0) stat.notes.push(...a.notes.slice(0, 2))
        entryStats.set(a.entryTitle, stat)
      }
      const overview = [...entryStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15).map(([title, stat]) =>
        `- 「${title}」: ${stat.count} 条注释，笔记摘录：${stat.notes.slice(0, 3).map(n => n.slice(0, 60)).join('；') || '无'}`
      ).join('\n')
      return JSON.stringify({ totalAnnotations: allAnns.length, entriesAnalyzed: entryStats.size, readingOverview: overview })
    }

    case 'build_paper_outline': {
      const topic = args.topic || ''
      if (!topic) return JSON.stringify({ error: '请提供论文主题' })
      const allAnns = await collectAllAnnotations(library)
      // Filter annotations related to the topic
      const relevant = allAnns.filter(a =>
        a.selectedText.includes(topic) || a.notes.some(n => n.includes(topic)) || a.entryTitle.includes(topic)
      )
      if (relevant.length === 0) return JSON.stringify({ error: `未找到与「${topic}」相关的注释，尝试更宽泛的关键词` })
      const materials = relevant.slice(0, 20).map(a =>
        `- 来自「${a.entryTitle}」p${a.pageNumber}：「${a.selectedText.slice(0, 100)}」${a.notes.length > 0 ? '\n  我的笔记：' + a.notes[0].slice(0, 150) : ''}`
      ).join('\n')
      return JSON.stringify({ topic, relevantCount: relevant.length, materials })
    }

    case 'trace_concept_evolution': {
      const concept = args.concept || ''
      if (!concept) return JSON.stringify({ error: '请提供要追踪的概念' })
      const allAnns = await collectAllAnnotations(library)
      // Find annotations mentioning the concept, sorted by time
      const matches = allAnns
        .filter(a => a.selectedText.includes(concept) || a.notes.some(n => n.includes(concept)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      if (matches.length === 0) return JSON.stringify({ error: `未找到与「${concept}」相关的注释` })
      const timeline = matches.slice(0, 20).map(a => ({
        date: a.createdAt.slice(0, 10),
        time: a.createdAt.slice(11, 16),
        entry: a.entryTitle,
        page: a.pageNumber,
        text: a.selectedText.slice(0, 100),
        myNote: a.notes[0]?.slice(0, 150) || '',
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
      await fs.writeFile(MEMORY_FILE, content, 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Load conversations
  ipcMain.handle('agent-load-conversations', async () => {
    try {
      await ensureAgentDir()
      const content = await fs.readFile(CONVERSATIONS_FILE, 'utf-8').catch(() => '[]')
      return { success: true, conversations: JSON.parse(content) }
    } catch (err: any) {
      return { success: false, error: err.message, conversations: [] }
    }
  })

  // Save conversation
  ipcMain.handle('agent-save-conversation', async (_event, conversation: AgentConversation) => {
    try {
      await ensureAgentDir()
      let conversations: AgentConversation[] = []
      try {
        const content = await fs.readFile(CONVERSATIONS_FILE, 'utf-8')
        conversations = JSON.parse(content)
      } catch {}

      const idx = conversations.findIndex(c => c.id === conversation.id)
      if (idx >= 0) {
        conversations[idx] = conversation
      } else {
        conversations.unshift(conversation)
      }

      // Keep last 50 conversations
      if (conversations.length > 50) conversations = conversations.slice(0, 50)

      await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2), 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
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
      const content = await fs.readFile(INSIGHTS_FILE, 'utf-8').catch(() => '{}')
      return { success: true, insight: JSON.parse(content) as HermesInsight | null }
    } catch {
      return { success: true, insight: null }
    }
  })

  // Save insight
  ipcMain.handle('agent-save-insight', async (_event, insight: HermesInsight) => {
    try {
      await ensureAgentDir()
      await fs.writeFile(INSIGHTS_FILE, JSON.stringify(insight, null, 2), 'utf-8')
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
      const content = await fs.readFile(SKILLS_FILE, 'utf-8').catch(() => '[]')
      return { success: true, skills: JSON.parse(content) as HermesSkill[] }
    } catch {
      return { success: true, skills: [] }
    }
  })

  // Save skills (full array)
  ipcMain.handle('agent-save-skills', async (_event, skills: HermesSkill[]) => {
    try {
      await ensureAgentDir()
      await fs.writeFile(SKILLS_FILE, JSON.stringify(skills, null, 2), 'utf-8')
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
