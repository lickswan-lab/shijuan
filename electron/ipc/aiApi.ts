import { ipcMain, app, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import type { HistoryEntry } from '../../src/types/library'
import { atomicWriteJson } from './library'
import { throttleProvider, bumpProviderInterval, isRateLimitError } from './aiThrottle'

// ===== GLM-OCR service limits (per their docs, 2026-04) =====
// PDF: ≤ 50 MB, ≤ 100 pages. We stay well under both with a 40MB / 80-page soft cap
// so that a PDF right at the edge (with large fonts / embedded images) doesn't 400.
const GLM_OCR_MAX_PAGES = 80
const GLM_OCR_MAX_BYTES = 40 * 1024 * 1024

// Track in-flight streaming fetches so the UI can cancel them.
// Key: streamId issued by the renderer (uuid). Cleared in the handler's finally block.
const activeAbortControllers = new Map<string, AbortController>()

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
  // When true, the provider doesn't need an API key (e.g. Ollama running on
  // localhost). Chat/Stream handlers skip the key-check and callers can
  // surface it in UI as "available without key".
  noKey?: boolean
  // Where users go to grab an API key. Shown as a "获取 Key" link under the
  // provider's settings card. Free tier hint is a short phrase we show next to
  // the link to reduce "I don't want to pay" friction.
  apiKeyUrl?: string
  freeTierHint?: string
}

// Ollama runs a local daemon exposing an OpenAI-compatible API at
// localhost:11434/v1. Zero API key, zero network — perfect for users who
// want AI features without signing up anywhere. Downside: needs 8GB+ RAM
// for small models; heavier models want 16GB. We surface this clearly in
// the Settings UI so people don't install it and hit OOM.
const OLLAMA_ENDPOINT = 'http://localhost:11434'

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
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    freeTierHint: 'GLM-4-Flash 完全免费；注册送新用户额度',
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
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    freeTierHint: '需付费充值；国内访问不畅',
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
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    freeTierHint: '需付费充值；国内访问不畅',
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
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    freeTierHint: 'AI Studio 有免费额度；国内访问不畅',
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
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    freeTierHint: '新用户送免费额度；长文本能力强',
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
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    freeTierHint: '按用量付费，单价便宜；大陆可直连',
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
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    freeTierHint: '火山方舟控制台；需实名认证',
  },
  {
    // Claude Code CLI — spawn the user's locally-installed `claude` command
    // in non-interactive mode (`claude -p "..."`). Zero key from the user's
    // perspective: authentication was already done when they installed
    // Claude Code. We don't stream — CLI gives a single response — but we
    // synthesize a single onChunk call so the streaming code path still
    // works uniformly. chatUrl is unused (spawn, not fetch).
    id: 'claude_cli',
    name: 'Claude Code（CLI·可选）',
    chatUrl: '',  // unused — handler branches on id
    models: [
      { id: 'claude-code', name: 'Claude Code（使用你的已登录凭证）' },
    ],
    authHeader: () => ({}),
    noKey: true,
  },
  {
    // Ollama: optional zero-key local provider. Models list is populated at
    // runtime from GET /api/tags — the user's locally-installed models.
    // If Ollama isn't running, the provider simply shows up as "unavailable"
    // in Settings rather than blocking any of the other providers.
    //
    // Not a replacement for hosted APIs: quality depends on model size, and
    // decent local models need 8GB+ RAM (small 7B) or 16GB+ (13B+). We
    // surface the hardware caveat in the Settings UI so users don't install
    // it blindly and hit OOM.
    id: 'ollama',
    name: 'Ollama（本地模型·可选）',
    chatUrl: `${OLLAMA_ENDPOINT}/v1/chat/completions`,
    models: [],  // populated at runtime
    authHeader: () => ({}),  // no auth
    noKey: true,
  },
]

// Claude Code CLI integration. Electron's PATH at launch often differs from
// the user's shell PATH (especially on macOS where GUI-launched apps don't
// source .zshrc, and on Windows where Electron inherits a reduced env).
// So "claude" might be installed and working from Terminal but unreachable
// from inside Shijuan. We work around this by probing a list of likely paths
// and caching whichever one works.

// Cache the working claude binary path across probes so we don't re-scan
// every time Settings UI refreshes or a chat message kicks off.
let cachedClaudeCliPath: string | null = null

// Build candidate paths to try. Order matters — PATH first, then common
// install locations. Users with exotic setups (Volta, fnm, specific nvm
// versions) will fail this heuristic; they can add their path manually in
// a future PR if anyone asks.
function claudeCliCandidates(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const appData = process.env.APPDATA || ''
  const localAppData = process.env.LOCALAPPDATA || ''
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files'

  if (process.platform === 'win32') {
    return [
      'claude',
      'claude.cmd',
      'claude.exe',
      appData && path.join(appData, 'npm', 'claude.cmd'),
      appData && path.join(appData, 'npm', 'claude'),
      localAppData && path.join(localAppData, 'Programs', 'claude', 'claude.exe'),
      localAppData && path.join(localAppData, 'npm', 'claude.cmd'),
      home && path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(programFiles, 'Claude Code', 'claude.exe'),
    ].filter(Boolean) as string[]
  }
  // macOS / Linux
  return [
    'claude',
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    home && path.join(home, '.local', 'bin', 'claude'),
    home && path.join(home, '.npm-global', 'bin', 'claude'),
    home && path.join(home, 'bin', 'claude'),
  ].filter(Boolean) as string[]
}

// Try a single binary path with --version. Returns the version string if it
// works, or null. Uses shell: true for bare names (so OS can resolve PATH)
// and shell: false for absolute paths (to avoid an extra cmd.exe/shell layer).
function tryClaudeBinary(candidate: string, timeoutMs = 2000): Promise<string | null> {
  const isAbsolute = candidate.includes(path.sep) || /^[a-zA-Z]:/.test(candidate)
  return new Promise((resolve) => {
    try {
      const proc = spawn(candidate, ['--version'], { shell: !isAbsolute })
      let out = ''
      const timer = setTimeout(() => { try { proc.kill() } catch { /* ignore */ } resolve(null) }, timeoutMs)
      proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8') })
      proc.on('error', () => { clearTimeout(timer); resolve(null) })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0 && out.trim()) resolve(out.trim())
        else resolve(null)
      })
    } catch {
      resolve(null)
    }
  })
}

// Probe Claude Code availability across candidate paths. Caches the working
// path for subsequent calls. If the cached path stops working (e.g. user
// uninstalled), we fall through to re-probing.
async function probeClaudeCli(): Promise<{ available: boolean; version: string | null; path?: string }> {
  // Try cached path first
  if (cachedClaudeCliPath) {
    const v = await tryClaudeBinary(cachedClaudeCliPath)
    if (v) return { available: true, version: v, path: cachedClaudeCliPath }
    cachedClaudeCliPath = null   // cache invalidated
  }
  // Iterate candidates. Short-circuit on first hit.
  for (const candidate of claudeCliCandidates()) {
    const v = await tryClaudeBinary(candidate)
    if (v) {
      cachedClaudeCliPath = candidate
      return { available: true, version: v, path: candidate }
    }
  }
  return { available: false, version: null }
}

// Spawn the Claude Code CLI in non-interactive mode with the given prompt.
// Uses the path cached by probeClaudeCli; falls back to bare "claude" via
// shell if the cache is cold (this covers the happy path where shell: true
// finds it via PATH).
async function callClaudeCli(messages: Array<{ role: string; content: string }>, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  // Collapse messages into a single prompt. Claude Code CLI's -p mode doesn't
  // take multi-turn structured input, so we serialize: [System] + role-labeled
  // turns. The CLI's own Claude model handles this format gracefully.
  const system = messages.find(m => m.role === 'system')?.content || ''
  const turns = messages.filter(m => m.role !== 'system')
  const turnsText = turns.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
  const prompt = system ? `[System instructions]\n${system}\n\n---\n\n${turnsText}` : turnsText

  // Resolve the binary path: cached, or probe now (lazy probe), or bare fallback
  if (!cachedClaudeCliPath) {
    const probe = await probeClaudeCli()
    if (!probe.available) {
      throw new Error('未找到 claude CLI。请检查 Claude Code 是否已安装，且能在终端运行 `claude --version`')
    }
  }
  const cliPath = cachedClaudeCliPath || 'claude'
  const isAbsolute = cliPath.includes(path.sep) || /^[a-zA-Z]:/.test(cliPath)

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cliPath, ['-p', prompt], { shell: !isAbsolute })
    let stdout = ''
    let stderr = ''
    let aborted = false

    const onAbort = () => {
      aborted = true
      try { proc.kill() } catch { /* ignore */ }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8') })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8') })
    proc.on('error', (err) => {
      reject(new Error(`无法启动 claude CLI：${err.message}（路径：${cliPath}）`))
    })
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort)
      if (aborted) { resolve(stdout.trim() || ''); return }  // caller cancelled
      if (code !== 0) {
        reject(new Error(`claude CLI 返回错误码 ${code}: ${stderr.trim().slice(0, 400) || 'unknown'}`))
        return
      }
      const result = stdout.trim()
      if (onChunk) onChunk(result)
      resolve(result)
    })
  })
}

// Probe the local Ollama daemon. Returns the list of user-installed models if
// the daemon is up, or `{available:false}` if it's not reachable within the
// short timeout. Short timeout is deliberate — Settings UI blocks on this and
// we don't want it hanging for 30s when Ollama isn't installed.
async function probeOllama(): Promise<{ available: boolean; models: Array<{ id: string; name: string }> }> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return { available: false, models: [] }
    const data: any = await res.json()
    const rawModels = Array.isArray(data?.models) ? data.models : []
    const models = rawModels.map((m: any) => ({
      id: String(m.name || m.model || ''),
      name: String(m.name || m.model || ''),
    })).filter((m: any) => m.id)
    return { available: true, models }
  } catch {
    return { available: false, models: [] }
  }
}

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
  await atomicWriteJson(KEYS_FILE, apiKeys)
}

/** Read-only getter for other main-process modules that need a provider's
 *  key (e.g. embedding API in Phase A RAG). Returns undefined if not set. */
export function getApiKeyFor(providerId: string): string | undefined {
  return apiKeys[providerId] || undefined
}

// ===== Chat API call =====

export async function callChat(providerId: string, model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`)

  // noKey providers (Ollama / Claude CLI) skip the key check.
  const key = provider.noKey ? '' : apiKeys[providerId]
  if (!provider.noKey && !key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`)

  // Claude CLI: spawn `claude -p` instead of HTTP
  if (providerId === 'claude_cli') {
    return callClaudeCli(messages)
  }

  // 主进程节流：所有 GLM 入口（chat / embed / web-search-pro）共用同一个
  // chokepoint。撞 429 自动调宽 → 后续所有调用变保守。
  await throttleProvider(providerId)

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
    if (isRateLimitError(`${response.status} ${text}`)) bumpProviderInterval(providerId)
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
//
// Options:
//   webSearch — lets the AI search the live web during generation. Per-provider
//   protocol:
//     Claude: tools: [{type:'web_search_20250305', name:'web_search'}] — Claude
//       handles the search loop autonomously, tool_use + tool_result are
//       interleaved into the stream but the final assistant text is what we emit.
//     Kimi: tools: [{type:'builtin_function', function:{name:'$web_search'}}] —
//       Moonshot runs the search server-side; same deal, final text emitted.
//     GLM (智谱): tools: [{type:'web_search', web_search:{enable:true}}] — Zhipu
//       runs search server-side.
//     Gemini: tools: [{google_search: {}}] via their OpenAI-compat endpoint.
//     OpenAI / DeepSeek / Doubao: no native web_search tool. We run a manual
//       function-calling loop — expose a `web_search` function that we execute
//       (via nuwa-search) when the AI asks, then feed results back and stream
//       the final answer. Capped at 2 iterations to avoid runaway.
//     Ollama / Claude CLI: ignore webSearch flag (not supported); caller's
//       prompt-embedded sources are the only grounding.
export async function callChatStream(
  providerId: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  opts?: { webSearch?: boolean },
): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`)

  const key = provider.noKey ? '' : apiKeys[providerId]
  if (!provider.noKey && !key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`)

  // Claude CLI doesn't stream — synthesize a single chunk with the full output
  if (providerId === 'claude_cli') {
    return callClaudeCli(messages, onChunk, signal)
  }

  // 主进程节流（chokepoint）：所有 GLM 入口共用同一份队列状态
  await throttleProvider(providerId)

  const webSearch = !!opts?.webSearch

  if (providerId === 'claude') {
    return callClaudeStream(key, model, messages, onChunk, signal, webSearch)
  }

  // Build provider-specific tools array if webSearch requested
  const tools: any[] | undefined = webSearch ? buildWebSearchTools(providerId) : undefined

  // Providers with native web_search baked in (server-side loop): Kimi/GLM/Gemini.
  // For these, we just pass tools and read the normal content stream.
  // Providers WITHOUT native web_search: OpenAI/DeepSeek/Doubao — run a manual
  // function-calling loop if user requested webSearch.
  if (webSearch && isManualFunctionCallingProvider(providerId)) {
    return callWithManualSearchLoop(provider, key, model, messages, onChunk, signal)
  }

  const body: any = { model, messages, stream: true }
  if (tools) body.tools = tools

  const response = await fetch(provider.chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...provider.authHeader(key),
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    if (isRateLimitError(`${response.status} ${text}`)) bumpProviderInterval(providerId)
    throw new Error(`${provider.name} API error ${response.status}: ${text.substring(0, 200)}`)
  }

  return parseSSEStream(response, onChunk, (data) => {
    return data.choices?.[0]?.delta?.content || ''
  })
}

// Which providers have a server-side "AI searches by itself" web_search
// capability that we just need to pass a `tools` hint to.
function isManualFunctionCallingProvider(providerId: string): boolean {
  // These need us to run the function-calling loop ourselves.
  return ['openai', 'deepseek', 'doubao'].includes(providerId)
}

// Build the appropriate tools payload per provider for server-side web search.
function buildWebSearchTools(providerId: string): any[] {
  switch (providerId) {
    case 'kimi':
      // Moonshot builtin function
      return [{ type: 'builtin_function', function: { name: '$web_search' } }]
    case 'glm':
      // Zhipu native web_search tool — upgraded from minimal { enable: true }
      // to the full search-pro config: jina engine + 30 results + recent +
      // search_result returned alongside the AI's summary. The richer config
      // gives the distillation prompt much more raw material to work with.
      return [{
        type: 'web_search',
        web_search: {
          enable: true,
          search_engine: 'search_pro_jina',
          search_recency_filter: 'noLimit',
          count: 30,
          search_result: true,
          require_search: true,
        },
      }]
    case 'gemini':
      // Via OpenAI-compat endpoint; Google grounding schema
      return [{ google_search: {} }]
    default:
      // Manual-loop providers pass tools via different path; not used here
      return []
  }
}

// Manual function-calling loop for providers that don't have a native web_search tool.
// Flow:
//   1. First call (non-streaming) with tools=[web_search]. Check response.
//      - If assistant calls web_search: execute, append tool_result, loop.
//      - If assistant responds with plain text: skip straight to streaming call.
//   2. Second call (streaming) with the tool results injected into messages,
//      so the AI's final answer streams to the user normally.
// Cap at 2 search iterations to prevent runaway loops on weird queries.
async function callWithManualSearchLoop(
  provider: AiProvider,
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  // Lazy-import search from personas module to avoid a dependency cycle.
  // We call the same HTTP sources the `nuwa-search` IPC uses but inline.
  const { multiSourceSearchInline } = await import('./personas-search-helper')

  const webSearchTool = {
    type: 'function',
    function: {
      name: 'web_search',
      description: '通过互联网搜索真实资料。当需要查询人物、事件、定义、时间、著作等实时或具体信息时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（中文或英文）' },
        },
        required: ['query'],
      },
    },
  }

  const conversation: any[] = messages.map(m => ({ ...m }))
  const MAX_ITER = 2
  let iter = 0

  while (iter < MAX_ITER) {
    // Non-streaming call to detect tool_calls
    const res = await fetch(provider.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...provider.authHeader(key) },
      body: JSON.stringify({ model, messages: conversation, tools: [webSearchTool], stream: false }),
      signal,
    })
    if (!res.ok) {
      const t = await res.text()
      throw new Error(`${provider.name} API error ${res.status}: ${t.substring(0, 200)}`)
    }
    const data: any = await res.json()
    const msg = data.choices?.[0]?.message
    const toolCalls = msg?.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      // No search requested — just emit what we got as if streaming
      const text = msg?.content || ''
      if (text) onChunk(text)
      return text
    }

    // Run each search in parallel, feed results back
    conversation.push(msg)  // append assistant's tool_call message
    await Promise.all(toolCalls.map(async (tc: any) => {
      let query = ''
      try { query = JSON.parse(tc.function?.arguments || '{}').query || '' } catch { /* ignore */ }
      let resultText = ''
      if (query) {
        try {
          const sources = await multiSourceSearchInline(query)
          resultText = sources.slice(0, 5).map(s =>
            `[${s.source}] ${s.title}\n${s.snippet || ''}\n链接: ${s.url}`
          ).join('\n\n')
          if (!resultText) resultText = '(未找到相关资料)'
        } catch (err: any) {
          resultText = `(搜索失败: ${err.message})`
        }
      } else {
        resultText = '(未提供搜索关键词)'
      }
      conversation.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultText,
      })
    }))
    iter++
  }

  // After loop: stream the final answer (no more tools)
  const finalRes = await fetch(provider.chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...provider.authHeader(key) },
    body: JSON.stringify({ model, messages: conversation, stream: true }),
    signal,
  })
  if (!finalRes.ok) {
    const t = await finalRes.text()
    throw new Error(`${provider.name} API error ${finalRes.status}: ${t.substring(0, 200)}`)
  }
  return parseSSEStream(finalRes, onChunk, (data) => data.choices?.[0]?.delta?.content || '')
}

async function callClaudeStream(
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  webSearch?: boolean,
): Promise<string> {
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  const body: any = {
    model,
    max_tokens: 4096,
    stream: true,
    system: systemMsg,
    messages: chatMessages,
  }
  // Claude's native web search tool (automatic agentic loop handled by Claude
  // itself — we just declare the tool and Claude calls it as needed, with
  // tool_use / tool_result events interleaved in the SSE stream).
  if (webSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Claude API error ${response.status}: ${text.substring(0, 200)}`)
  }

  return parseSSEStream(response, onChunk, (data) => {
    // Claude SSE: content_block_delta events have delta.text for text, or
    // delta.partial_json for tool_use arguments (ignored — we only stream text
    // to the user; tool calls happen server-side).
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

  // Get all providers info (for settings UI). Ollama is special-cased: its
  // "hasKey" means "local daemon is running with at least one model pulled",
  // and models come from a live probe rather than a static list.
  ipcMain.handle('ai-get-providers', async () => {
    // Probe both local providers in parallel so the Settings UI doesn't wait sequentially
    const [ollamaProbe, cliProbe] = await Promise.all([probeOllama(), probeClaudeCli()])
    const providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }>; hasKey: boolean; noKey?: boolean; apiKeyUrl?: string; freeTierHint?: string }> =
      PROVIDERS.map(p => {
        if (p.id === 'ollama') {
          return {
            id: p.id,
            name: p.name,
            models: ollamaProbe.models,
            hasKey: ollamaProbe.available && ollamaProbe.models.length > 0,
            noKey: true,
          }
        }
        if (p.id === 'claude_cli') {
          return {
            id: p.id,
            name: p.name,
            models: p.models,
            hasKey: cliProbe.available,
            noKey: true,
          }
        }
        return {
          id: p.id,
          name: p.name,
          models: p.models,
          hasKey: !!apiKeys[p.id],
          apiKeyUrl: p.apiKeyUrl,
          freeTierHint: p.freeTierHint,
        }
      })
    // STT providers (xfyun/aliyun) were part of the dormant Lecture subsystem
    // and have been removed from Settings UI. Keys may still exist in
    // api-keys.json from older versions — they just won't show up here.
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

  // Get configured providers. "Configured" means: key is set, OR for Ollama/
  // CLI the local backend is reachable.
  ipcMain.handle('ai-get-configured', async () => {
    const [ollamaProbe, cliProbe] = await Promise.all([probeOllama(), probeClaudeCli()])
    const result: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> = []
    for (const p of PROVIDERS) {
      if (p.id === 'ollama') {
        if (ollamaProbe.available && ollamaProbe.models.length > 0) {
          result.push({ id: p.id, name: p.name, models: ollamaProbe.models })
        }
      } else if (p.id === 'claude_cli') {
        if (cliProbe.available) {
          result.push({ id: p.id, name: p.name, models: p.models })
        }
      } else if (apiKeys[p.id]) {
        result.push({ id: p.id, name: p.name, models: p.models })
      }
    }
    return result
  })

  // Probe Ollama on demand (used by Settings "refresh" button).
  ipcMain.handle('ollama-probe', async () => {
    return await probeOllama()
  })

  // Probe Claude CLI on demand.
  ipcMain.handle('claude-cli-probe', async () => {
    return await probeClaudeCli()
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
      // 即时反馈是拾卷里最高频的 AI 交互——用户每加一条注释都触发一次。
      // 质量差会变骚扰，质量好会让人觉得"有个同伴在读"。
      // 核心策略：宁可返回空字符串（默不作声），也不要说废话。返回 null 后前端不显示气泡。
      const result = await callChat('glm', 'glm-4-flash', [
        { role: 'system', content: `你是坐在读者旁边的同伴。他在文献里标了一段话、写下了一条注释。你只在真有话说时开口——没有就闭嘴。

**只在这四种情况开口**：
1. 他的注释和**其他文献中的旧注释**形成呼应或矛盾 → 指出具体是哪条
2. 原文里有他没注意到的**隐含假设**或**概念歧义**，直接影响他的判断
3. 他的注释其实把原文读反了或读窄了（罕见，但遇到要说）
4. 他抛了个开放问题，你能给出一个**具体方向**（不是笼统鼓励）

**任何一条都不成立时，返回空字符串。**

**格式约束**：
- 最多 2 句话。超过 2 句是失败。
- 直接说内容，不要前置"这是一个..."、"我注意到..."。
- 引用他旧注释时用文献名：**《X》里你写过「...」，和这条方向相反**。
- 引用原文用「」。

**严禁**（返回空字符串更好）：
- "这是一个值得深入思考的问题"
- "很有见地"/"很有洞察"/"很深刻"
- "你可以从 X、Y、Z 三个角度..."（三个都说等于没说）
- 把他的注释换个说法复述回去
- "建议你..."（他没问你建议）
- 夸饰词：非常、极其、显著、深入

**示例**：
- 好: \`《区分》里你把"权力"写成资本的效果；这里写"资本即权力"方向反了。\`
- 好: \`"规训"这里指空间安排，不是主动惩罚——他在书后半段区分了这两个词。\`
- 好: \`（返回空字符串——没有能加的）\`
- 坏: \`这是一个非常重要的问题，涉及 XX 的本质，建议你从 A、B、C 三方面思考。\`

中文回复。宁可沉默，不说废话。` },
        { role: 'user', content: `原文片段：「${selectedText}」\n\n${ocrContext ? `页面上下文：${ocrContext.substring(0, 800)}\n\n` : ''}他写的注释：${userNote}${otherNotesContext}` }
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

  ipcMain.handle('ai-chat-stream', async (event, streamId: string, providerId: string, model: string, messages: Array<{ role: string; content: string }>, opts?: { webSearch?: boolean }) => {
    const controller = new AbortController()
    activeAbortControllers.set(streamId, controller)
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
      }, controller.signal, opts)
      event.sender.send('ai-stream-done', streamId, result)
      return { success: true, text: result }
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        event.sender.send('ai-stream-error', streamId, '已取消')
        return { success: false, error: '已取消', aborted: true }
      }
      event.sender.send('ai-stream-error', streamId, err.message)
      return { success: false, error: err.message }
    } finally {
      activeAbortControllers.delete(streamId)
    }
  })

  // Cancel an in-flight streaming request (Stop button, component unmount, etc.).
  // Returns true if we found and aborted a matching stream.
  ipcMain.handle('ai-abort-stream', (_event, streamId: string) => {
    const ctrl = activeAbortControllers.get(streamId)
    if (!ctrl) return false
    try { ctrl.abort() } catch {}
    activeAbortControllers.delete(streamId)
    return true
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

          // === Block extraction: preserve images, formulas, tables ===
          // Previous impl only kept `b.content`, which dropped every image block
          // (images come back with empty `content` and a separate `image_url` /
          // `img` / `url` field). For image-heavy literature that meant the OCR
          // output was text-only — users couldn't see any figures. Now we:
          //   1. Iterate each block and emit markdown for its type:
          //      - image → `![](url)`
          //      - formula → `$$latex$$`
          //      - table → html/markdown table
          //      - anything else → fall back to `content`
          //   2. If layout_details somehow gives us NO text and md_results is
          //      richer, use md_results as the source of truth. GLM-OCR's
          //      md_results already renders images/formulas inline.
          const extractBlock = (b: any): string => {
            if (!b || typeof b !== 'object') return ''
            const imgUrl = b.image_url || b.img_url || b.img || b.image || b.url
            const isImage = b.type === 'image' || b.type === 'figure' || b.type === 'photo'
            if (isImage || (imgUrl && !b.content)) {
              if (imgUrl) return `![](${imgUrl})`
              // Image block with no URL — leave a placeholder so users know a
              // figure was detected but not extractable.
              return `![图片（OCR 未能提取）]()`
            }
            if (b.type === 'formula' || b.type === 'equation') {
              const latex = b.latex || b.formula || b.content
              if (latex) return `$$${String(latex).replace(/^\$+|\$+$/g, '')}$$`
            }
            if (b.type === 'table') {
              if (b.html) return b.html
              if (b.markdown) return b.markdown
            }
            return b.content || ''
          }

          let chunkText = ''
          const chunkPageTexts: string[] = []
          if (data.layout_details && Array.isArray(data.layout_details)) {
            for (const page of data.layout_details) {
              const pageText = (page as any[]).map(extractBlock).filter(Boolean).join('\n\n')
              chunkPageTexts.push(pageText)
            }
            chunkText = chunkPageTexts.join('\n\n')
          }
          // Fallback: if layout_details extraction was empty OR md_results is
          // noticeably richer (likely has figures/formulas we missed), prefer
          // md_results. Threshold: md_results at least 20% longer than what we
          // built from blocks. This catches the common "images in md_results
          // but not in layout blocks" case without destroying page mapping
          // when layout_details already had everything.
          const layoutLen = chunkText.length
          const mdLen = (data.md_results || '').length
          if (data.md_results && (layoutLen === 0 || mdLen > layoutLen * 1.2)) {
            chunkText = data.md_results
            // If we switched to md_results, we lose the per-page split. Put the
            // full md into the first page slot and leave the rest as empty
            // placeholders so page count still matches.
            if (chunkPageTexts.length > 0) {
              chunkPageTexts[0] = data.md_results
              for (let pi = 1; pi < chunkPageTexts.length; pi++) chunkPageTexts[pi] = ''
            } else {
              chunkPageTexts.push(data.md_results)
            }
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
