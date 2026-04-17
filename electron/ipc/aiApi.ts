import { ipcMain, app, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { HistoryEntry } from '../../src/types/library'

// ===== GLM-OCR service limits (per their docs, 2026-04) =====
// PDF: ≤ 50 MB, ≤ 100 pages. We stay well under both with a 40MB / 80-page soft cap
// so that a PDF right at the edge (with large fonts / embedded images) doesn't 400.
const GLM_OCR_MAX_PAGES = 80
const GLM_OCR_MAX_BYTES = 40 * 1024 * 1024

// Split a PDF buffer into page-count-bounded chunks using pdf-lib.
// Returns array of { chunkBuffer, startPage (1-indexed), endPage (1-indexed) }.
// If chunks after splitting are still > GLM_OCR_MAX_BYTES, we further bisect them.
async function splitPdfForOcr(pdfBuffer: Buffer): Promise<Array<{ buffer: Buffer; startPage: number; endPage: number }>> {
  const { PDFDocument } = await import('pdf-lib')
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
  const totalPages = srcDoc.getPageCount()

  // Build initial chunks by page count. Each chunk spans [startIdx, endIdx) zero-based.
  const initialRanges: Array<[number, number]> = []
  for (let i = 0; i < totalPages; i += GLM_OCR_MAX_PAGES) {
    initialRanges.push([i, Math.min(i + GLM_OCR_MAX_PAGES, totalPages)])
  }

  const results: Array<{ buffer: Buffer; startPage: number; endPage: number }> = []

  async function buildAndMaybeSplit(startIdx: number, endIdx: number): Promise<void> {
    const indices: number[] = []
    for (let i = startIdx; i < endIdx; i++) indices.push(i)
    const newDoc = await PDFDocument.create()
    const copied = await newDoc.copyPages(srcDoc, indices)
    for (const p of copied) newDoc.addPage(p)
    const bytes = await newDoc.save({ useObjectStreams: false })
    const buf = Buffer.from(bytes)
    if (buf.length > GLM_OCR_MAX_BYTES && endIdx - startIdx > 1) {
      // Bisect
      const mid = Math.floor((startIdx + endIdx) / 2)
      await buildAndMaybeSplit(startIdx, mid)
      await buildAndMaybeSplit(mid, endIdx)
    } else {
      results.push({ buffer: buf, startPage: startIdx + 1, endPage: endIdx })
    }
  }

  for (const [s, e] of initialRanges) await buildAndMaybeSplit(s, e)
  return results
}

// Send per-chunk progress to all windows, so the UI can show sub-progress during
// long multi-chunk OCR runs.
function reportOcrProgress(entryId: string | undefined, chunkIndex: number, totalChunks: number, phase: 'start' | 'done' | 'error') {
  const payload = { entryId, chunkIndex, totalChunks, phase }
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('glm-ocr-progress', payload) } catch {}
  }
}

// ===== Provider definitions =====

interface AiProvider {
  id: string
  name: string
  chatUrl: string
  models: { id: string; name: string }[]
  authHeader: (key: string) => Record<string, string>
}

const PROVIDERS: AiProvider[] = [
  {
    id: 'glm',
    name: '智谱 GLM',
    chatUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1（旗舰）' },
      { id: 'glm-5', name: 'GLM-5' },
      { id: 'glm-5-turbo', name: 'GLM-5-Turbo（Agent）' },
      { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash（免费）' },
      { id: 'glm-4-flash', name: 'GLM-4-Flash' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4（旗舰）' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano（快速）' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex（编程）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
  {
    id: 'claude',
    name: 'Claude',
    chatUrl: 'https://api.anthropic.com/v1/messages',
    models: [
      { id: 'claude-opus-4-6-20250414', name: 'Claude Opus 4.6（最强）' },
      { id: 'claude-sonnet-4-6-20250414', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20241022', name: 'Claude Haiku 4.5（快速）' },
    ],
    authHeader: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    chatUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro（旗舰）' },
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite（快速）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
  {
    id: 'kimi',
    name: 'Kimi (月之暗面)',
    chatUrl: 'https://api.moonshot.cn/v1/chat/completions',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5（最新）' },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K' },
      { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    chatUrl: 'https://api.deepseek.com/chat/completions',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3.2 Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1（推理）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
  {
    id: 'doubao',
    name: '豆包 (字节)',
    chatUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    models: [
      { id: 'doubao-seed-2-pro-32k', name: '豆包 2.0 Pro（旗舰）' },
      { id: 'doubao-seed-2-lite-32k', name: '豆包 2.0 Lite' },
      { id: 'doubao-seed-2-mini-32k', name: '豆包 2.0 Mini（快速）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
  },
]

// ===== API Key storage =====

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const KEYS_FILE = path.join(DATA_DIR, 'api-keys.json')

let apiKeys: Record<string, string> = {}  // providerId -> key

async function loadApiKeys() {
  try {
    const content = await fs.readFile(KEYS_FILE, 'utf-8')
    apiKeys = JSON.parse(content)
  } catch {
    apiKeys = {}
  }
}

async function saveApiKeys() {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(KEYS_FILE, JSON.stringify(apiKeys, null, 2), 'utf-8')
}

// ===== Chat API call =====

export async function callChat(providerId: string, model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`)

  const key = apiKeys[providerId]
  if (!key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`)

  // Claude uses a different request/response format
  if (providerId === 'claude') {
    return callClaude(key, model, messages)
  }

  const response = await fetch(provider.chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...provider.authHeader(key),
    },
    body: JSON.stringify({ model, messages }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${provider.name} API error ${response.status}: ${text.substring(0, 200)}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

async function callClaude(key: string, model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  // Extract system message
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemMsg,
      messages: chatMessages,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Claude API error ${response.status}: ${text.substring(0, 200)}`)
  }

  const data = await response.json()
  return data.content?.[0]?.text || ''
}

// ===== Streaming Chat =====

export async function callChatStream(
  providerId: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`)

  const key = apiKeys[providerId]
  if (!key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`)

  if (providerId === 'claude') {
    return callClaudeStream(key, model, messages, onChunk)
  }

  // OpenAI-compatible streaming
  const response = await fetch(provider.chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...provider.authHeader(key),
    },
    body: JSON.stringify({ model, messages, stream: true }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${provider.name} API error ${response.status}: ${text.substring(0, 200)}`)
  }

  return parseSSEStream(response, onChunk, (data) => {
    return data.choices?.[0]?.delta?.content || ''
  })
}

async function callClaudeStream(
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
): Promise<string> {
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      system: systemMsg,
      messages: chatMessages,
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Claude API error ${response.status}: ${text.substring(0, 200)}`)
  }

  return parseSSEStream(response, onChunk, (data) => {
    // Claude SSE: content_block_delta events have delta.text
    if (data.type === 'content_block_delta') {
      return data.delta?.text || ''
    }
    return ''
  })
}

async function parseSSEStream(
  response: Response,
  onChunk: (text: string) => void,
  extractText: (data: any) => string,
): Promise<string> {
  let full = ''
  const decoder = new TextDecoder()
  let buffer = ''

  const body = response.body as any
  if (!body) throw new Error('Response body is null')

  // Node.js: response.body is an async iterable (ReadableStream)
  try {
    for await (const rawChunk of body) {
      const text = typeof rawChunk === 'string' ? rawChunk : decoder.decode(rawChunk, { stream: true })
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue

        try {
          const data = JSON.parse(payload)
          const chunk = extractText(data)
          if (chunk) {
            full += chunk
            onChunk(chunk)
          }
        } catch { /* ignore parse errors */ }
      }
    }
  } catch (err: any) {
    // If async iteration fails, the partial text is still usable
    if (!full) throw err
  }

  return full
}

// ===== GLM OCR (stays GLM-specific) =====

const GLM_OCR_URL = 'https://open.bigmodel.cn/api/paas/v4/layout_parsing'

async function callGlmOcr(imageBase64: string): Promise<string> {
  const key = apiKeys['glm']
  if (!key) throw new Error('GLM API Key 未设置（OCR 需要智谱 GLM）')

  const response = await fetch(GLM_OCR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: 'glm-ocr', file: `data:image/png;base64,${imageBase64}` }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GLM-OCR API error ${response.status}: ${text}`)
  }

  const data = await response.json()
  let text = data.md_results || ''
  if (!text && data.layout_details) {
    const blocks: string[] = []
    for (const page of data.layout_details) {
      for (const block of page) { if (block.content) blocks.push(block.content) }
    }
    text = blocks.join('\n\n')
  }
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
  text = text
    .replace(/\$\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
    .replace(/\$\\\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (!text) throw new Error('OCR 未能提取到文字')
  return text
}

// ===== Register IPC =====

export function registerAiApiIpc(): void {
  // Load keys on startup
  loadApiKeys()

  // Get all providers info (for settings UI)
  ipcMain.handle('ai-get-providers', async () => {
    const providers = PROVIDERS.map(p => ({
      id: p.id,
      name: p.name,
      models: p.models,
      hasKey: !!apiKeys[p.id],
    }))
    // Include STT provider status
    providers.push(
      { id: 'xfyun_stt', name: '讯飞转写', models: [], hasKey: !!apiKeys['xfyun_stt'] },
      { id: 'aliyun_stt', name: '阿里云转写', models: [], hasKey: !!apiKeys['aliyun_stt'] },
    )
    return providers
  })

  // Set API key for a provider
  ipcMain.handle('ai-set-key', async (_event, providerId: string, key: string) => {
    apiKeys[providerId] = key
    await saveApiKeys()
    return true
  })

  // Remove API key
  ipcMain.handle('ai-remove-key', async (_event, providerId: string) => {
    delete apiKeys[providerId]
    await saveApiKeys()
    return true
  })

  // Get a specific key value (for STT providers etc.)
  ipcMain.handle('ai-get-key', async (_event, providerId: string) => {
    return apiKeys[providerId] || null
  })

  // Get configured providers (which have keys)
  ipcMain.handle('ai-get-configured', async () => {
    return PROVIDERS
      .filter(p => !!apiKeys[p.id])
      .map(p => ({ id: p.id, name: p.name, models: p.models }))
  })

  // === Legacy GLM-compatible handlers (keep for backward compat) ===

  ipcMain.handle('set-glm-api-key', async (_event, key: string) => {
    apiKeys['glm'] = key
    await saveApiKeys()
    return true
  })

  ipcMain.handle('get-glm-api-key-status', async () => {
    return apiKeys['glm'] ? 'set' : 'not-set'
  })

  // === Chat (generic, any provider) ===

  ipcMain.handle('ai-chat', async (_event, providerId: string, model: string, messages: Array<{ role: string; content: string }>) => {
    try {
      const result = await callChat(providerId, model, messages)
      return { success: true, text: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // === Legacy handlers (use new generic backend) ===

  ipcMain.handle('glm-interpret', async (_event, text: string, context: string) => {
    try {
      const result = await callChat('glm', 'glm-4-flash', [
        { role: 'system', content: '你是学术文献阅读助手。请用中文解释以下学术文本的含义，帮助读者理解。要求：1）解释关键概念；2）理清论证逻辑；3）指出隐含假设；4）如涉及理论家，说明其思想形成的背景。语言要通俗易懂。' },
        { role: 'user', content: context ? `请解释这段文字：\n\n「${text}」\n\n上下文：${context}` : `请解释这段文字：\n\n「${text}」` }
      ])
      return { success: true, text: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('glm-instant-feedback', async (_event, userNote: string, selectedText: string, ocrContext: string, otherAnnotations: Array<{ text: string; note: string; entryTitle: string }>) => {
    try {
      let otherNotesContext = ''
      if (otherAnnotations.length > 0) {
        const items = otherAnnotations.slice(0, 15).map(a => `[${a.entryTitle}]「${a.text}」→ ${a.note}`).join('\n')
        otherNotesContext = `\n\n用户在其他文献中的历史注释：\n${items}`
      }
      const result = await callChat('glm', 'glm-4-flash', [
        { role: 'system', content: `你是学术文献阅读助手。用户正在阅读论文并写下了一条注释。请给出简短的即时反馈（1-3句话）。\n优先级：1.指出矛盾或呼应 2.补充隐含假设 3.延伸思考方向\n要求：没有有价值的反馈就回复空字符串。不要复述。语气简洁克制。中文回复。` },
        { role: 'user', content: `论文原文片段：「${selectedText}」\n\n${ocrContext ? `页面上下文：${ocrContext.substring(0, 800)}\n\n` : ''}用户写的注释：${userNote}${otherNotesContext}` }
      ])
      return { success: true, text: result.trim() || null }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('glm-ask', async (_event, question: string, selectedText: string, history: HistoryEntry[], modelSpec?: string) => {
    try {
      // Parse modelSpec: "providerId:modelId" or just "modelId" (legacy, defaults to glm)
      let providerId = 'glm'
      let model = 'glm-4-flash'
      if (modelSpec && modelSpec.includes(':')) {
        const [p, m] = modelSpec.split(':', 2)
        providerId = p
        model = m
      } else if (modelSpec) {
        // Legacy: just model name, assume glm
        model = modelSpec
      }

      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: `你是学术文献阅读助手。用户正在阅读一段学术文本，请基于文本内容回答用户的问题。\n\n参考文本：\n「${selectedText}」` }
      ]
      for (const entry of history) {
        if (entry.type === 'ai_qa') {
          if (entry.userQuery) messages.push({ role: 'user', content: entry.userQuery })
          messages.push({ role: 'assistant', content: entry.content })
        } else if (['note', 'annotation', 'question', 'stance'].includes(entry.type)) {
          messages.push({ role: 'user', content: `[我的笔记] ${entry.content}` })
        } else if (entry.type === 'ai_interpretation' || entry.type === 'ai_feedback') {
          messages.push({ role: 'assistant', content: entry.content })
        }
      }
      messages.push({ role: 'user', content: question })

      const result = await callChat(providerId, model, messages)
      return { success: true, text: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // === Streaming chat ===

  ipcMain.handle('ai-chat-stream', async (event, streamId: string, providerId: string, model: string, messages: Array<{ role: string; content: string }>) => {
    try {
      // Parse model spec if combined format
      let pId = providerId
      let mId = model
      if (providerId.includes(':')) {
        const [p, m] = providerId.split(':', 2)
        pId = p; mId = m
      }

      const result = await callChatStream(pId, mId, messages, (chunk) => {
        try { event.sender.send('ai-stream-chunk', streamId, chunk) } catch {}
      })
      event.sender.send('ai-stream-done', streamId, result)
      return { success: true, text: result }
    } catch (err: any) {
      event.sender.send('ai-stream-error', streamId, err.message)
      return { success: false, error: err.message }
    }
  })

  // === OCR (GLM only) ===

  ipcMain.handle('glm-ocr', async (_event, imageBase64: string) => {
    try {
      const text = await callGlmOcr(imageBase64)
      return { success: true, text }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('glm-ocr-pdf', async (_event, pdfAbsPath: string, opts?: { entryId?: string }) => {
    try {
      const key = apiKeys['glm']
      if (!key) throw new Error('GLM API Key 未设置（OCR 需要智谱 GLM）')
      const entryId = opts?.entryId

      const pdfBuffer = await fs.readFile(pdfAbsPath)

      // Decide whether to split. Quick check: if the raw file is already small and ≤100 pages,
      // we can send it in one shot. Otherwise, split.
      let chunks: Array<{ buffer: Buffer; startPage: number; endPage: number }>
      if (pdfBuffer.length <= GLM_OCR_MAX_BYTES) {
        // Cheap page count via pdf-lib (only on medium-small PDFs)
        try {
          const { PDFDocument } = await import('pdf-lib')
          const probe = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
          if (probe.getPageCount() <= GLM_OCR_MAX_PAGES) {
            chunks = [{ buffer: pdfBuffer, startPage: 1, endPage: probe.getPageCount() }]
          } else {
            console.log('[glm-ocr-pdf] PDF has', probe.getPageCount(), 'pages — splitting')
            chunks = await splitPdfForOcr(pdfBuffer)
          }
        } catch {
          // pdf-lib couldn't parse — try as single chunk; let the API give us a real error
          chunks = [{ buffer: pdfBuffer, startPage: 1, endPage: 0 }]
        }
      } else {
        console.log('[glm-ocr-pdf] PDF size', Math.round(pdfBuffer.length / 1024 / 1024), 'MB exceeds cap — splitting')
        chunks = await splitPdfForOcr(pdfBuffer)
      }

      console.log(`[glm-ocr-pdf] Processing ${chunks.length} chunk(s) for ${path.basename(pdfAbsPath)}`)

      const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
      const allPageTexts: string[] = []
      const chunkTextParts: string[] = []
      let totalReportedPages = 0

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        reportOcrProgress(entryId, i, chunks.length, 'start')

        try {
          const pdfBase64 = chunk.buffer.toString('base64')
          const response = await fetch(GLM_OCR_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
            body: JSON.stringify({ model: 'glm-ocr', file: `data:application/pdf;base64,${pdfBase64}` }),
          })
          if (!response.ok) {
            const errText = await response.text()
            throw new Error(`GLM-OCR API error ${response.status}: ${errText}`)
          }
          const data = await response.json()

          // Prefer layout_details (per-page) so we can merge pageTexts accurately.
          // md_results is the fallback whole-doc markdown.
          let chunkText = ''
          const chunkPageTexts: string[] = []
          if (data.layout_details && Array.isArray(data.layout_details)) {
            for (const page of data.layout_details) {
              const pageText = page.map((b: any) => b.content || '').filter(Boolean).join('\n\n')
              chunkPageTexts.push(pageText)
            }
            chunkText = chunkPageTexts.join('\n\n')
          } else {
            chunkText = data.md_results || ''
          }

          // Normalize circled numbers and excessive blank lines
          chunkText = chunkText
            .replace(/\$\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
            .replace(/\$\\\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
            .replace(/\n{4,}/g, '\n\n\n').trim()

          allPageTexts.push(...chunkPageTexts)
          totalReportedPages += data.data_info?.num_pages || chunkPageTexts.length

          // Insert a visible chunk boundary if we actually split the PDF — helps downstream
          // text highlights / annotation anchors stay aligned with page numbers.
          if (chunks.length > 1 && chunkText) {
            chunkTextParts.push(`=== 第 ${chunk.startPage}-${chunk.endPage} 页 ===\n\n${chunkText}`)
          } else if (chunkText) {
            chunkTextParts.push(chunkText)
          }

          reportOcrProgress(entryId, i, chunks.length, 'done')
        } catch (err: any) {
          reportOcrProgress(entryId, i, chunks.length, 'error')
          // If we had no success yet, fail the whole thing; otherwise keep partial result
          if (allPageTexts.length === 0 && chunkTextParts.length === 0) throw err
          console.warn(`[glm-ocr-pdf] chunk ${i + 1}/${chunks.length} failed: ${err.message}`)
          chunkTextParts.push(`=== 第 ${chunk.startPage}-${chunk.endPage} 页（OCR 失败：${err.message}）===`)
        }
      }

      const text = chunkTextParts.join('\n\n\n').trim()
      if (!text) throw new Error('OCR 未能提取到文字')

      return {
        success: true,
        text,
        pageTexts: allPageTexts,
        pageCount: totalReportedPages || allPageTexts.length,
        chunks: chunks.length,
      }
    } catch (err: any) {
      console.error('[glm-ocr-pdf] Error:', err.message)
      return { success: false, error: err.message }
    }
  })
}
