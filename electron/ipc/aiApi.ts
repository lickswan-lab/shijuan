import { ipcMain, app, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import type { HistoryEntry } from '../../src/types/library'
import { atomicWriteJson } from './library'
import {
  schedule,
  bumpProviderInterval,
  isRateLimitError,
  parseRetryAfterHeader,
  startStatusBroadcast,
  getSnapshot,
  setProviderRpmOverride,
  loadRpmOverridesFromDisk,
  type RequestPriority,
} from './aiThrottle'

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
//
// 2026-04-27 Batch 43 · pageRange 参数支持只 OCR 部分页（用户场景：300 页大文件
// 只 OCR 第 50-100 页 / 只 OCR 当前章节）。1-indexed inclusive，不传则 OCR 整本。
async function splitPdfForOcr(
  pdfBuffer: Buffer,
  pageRange?: { startPage: number; endPage: number },
): Promise<Array<{ buffer: Buffer; startPage: number; endPage: number }>> {
  const { PDFDocument } = await import('pdf-lib')
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
  const totalPages = srcDoc.getPageCount()

  // 计算实际起止（1-indexed → 0-indexed）。clamp 到 [0, totalPages]
  let rangeStart = 0
  let rangeEnd = totalPages
  if (pageRange) {
    rangeStart = Math.max(0, Math.min(totalPages, (pageRange.startPage | 0) - 1))
    rangeEnd = Math.max(rangeStart, Math.min(totalPages, pageRange.endPage | 0))
    if (rangeEnd <= rangeStart) {
      // 空范围，直接返回空数组让上层提前 fail
      return []
    }
  }

  // Build initial chunks by page count. Each chunk spans [startIdx, endIdx) zero-based.
  const initialRanges: Array<[number, number]> = []
  for (let i = rangeStart; i < rangeEnd; i += GLM_OCR_MAX_PAGES) {
    initialRanges.push([i, Math.min(i + GLM_OCR_MAX_PAGES, rangeEnd)])
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

type OcrEngineId = 'glm' | 'rapidocr'

interface OcrPdfResult {
  success: boolean
  text?: string
  pageTexts?: string[]
  pageCount?: number
  chunks?: number
  actualStartPage?: number
  actualEndPage?: number
  engine?: OcrEngineId
  error?: string
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
    // Tencent TokenHub is Tencent Cloud's current OpenAI-compatible entry for
    // newer Hunyuan models. The older Hunyuan endpoint still exists, but the
    // official docs now point new model capabilities toward TokenHub.
    id: 'hunyuan',
    name: '腾讯混元 (TokenHub)',
    chatUrl: 'https://tokenhub.tencentmaas.com/v1/chat/completions',
    models: [
      { id: 'hy3-preview', name: 'Hy3 Preview（旗舰 · 256K）' },
      { id: 'hunyuan-2.0-thinking-20251109', name: 'HY 2.0 Think（深度思考）' },
      { id: 'hunyuan-2.0-instruct-20251111', name: 'HY 2.0 Instruct' },
      { id: 'hunyuan-role-latest', name: 'Hunyuan Role（角色扮演）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    apiKeyUrl: 'https://console.cloud.tencent.com/tione/tokenhub',
    freeTierHint: '腾讯云 TokenHub；大陆直连，支持 OpenAI 兼容接口',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5（最新 · 旗舰）' },
      { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini' },
      { id: 'gpt-5.5-nano', name: 'GPT-5.5 Nano（快速）' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
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
      // 2026-04-27 Batch 43 · Anthropic 官方 model id 不带日期后缀（按 platform.claude.com 文档）
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7（最新 · 最强）' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5（快速）' },
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
      { id: 'kimi-k2.6', name: 'Kimi K2.6（最新 · 旗舰）' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' },
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
      // 2026-04-27 Batch 43 · 真实 id 校准（参考 api-docs.deepseek.com）
      // V4 系列双模型：Pro（1.6T 总参 / 49B 激活）+ Flash（284B / 13B），都支持 1M 上下文
      // V3.2 / R1 通过 legacy id 访问，2026-07-24 弃用，但当前仍可用
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（最新 · 旗舰）' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（快速）' },
      { id: 'deepseek-chat', name: 'DeepSeek V3.2（通用 · legacy）' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1（推理 · legacy）' },
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
      // 2026-04-27 Batch 43 · 火山方舟真实 model id 带版本日期后缀
      // 官方文档：https://www.volcengine.com/docs/82379
      // 也可用 endpoint id（ep-xxxxxxxxxxxx）—— 用户在控制台创建 inference endpoint 后填进去
      { id: 'doubao-seed-2-0-pro-260215', name: '豆包 Seed 2.0 Pro（旗舰 · 256K）' },
      { id: 'doubao-seed-code-preview-251028', name: '豆包 Seed Code（编程）' },
      { id: 'doubao-seed-1-8-251228', name: '豆包 Seed 1.8（多模态）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    freeTierHint: '火山方舟控制台；需实名认证',
  },
  {
    // 通义千问 / Qwen (Alibaba DashScope). Uses the OpenAI-compatible endpoint
    // so the same chat completion path works. Qwen3.6 family (2026 Q1):
    //   - Max:   旗舰推理 / 长文本 (主力)
    //   - Plus:  均衡高质量
    //   - Flash: 快速低价
    //   - Coder: 编程特化
    id: 'qwen',
    name: '通义千问 (阿里)',
    chatUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    models: [
      { id: 'qwen3.6-max-preview', name: 'Qwen 3.6 Max（旗舰 · 预览）' },
      { id: 'qwen3.6-plus', name: 'Qwen 3.6 Plus（均衡）' },
      { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash（快速）' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus（编程）' },
      { id: 'qwen-vl-max', name: 'Qwen VL Max（多模态）' },
      { id: 'qwen-long', name: 'Qwen Long（长文档 · 10M）' },
    ],
    authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    freeTierHint: '百炼控制台；新用户有免费额度；大陆直连',
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

// 2026-04-27 Batch 43 · 废弃 model id 自动迁移
//
// 用户的 sj-agentModel / selectedAiModel 持久化在 localStorage，model id 改名后
// 老用户重启后仍持着失效字符串发请求 → API 端 400 Model Not Exist。
// 这里在调用前做一次 normalize，把已知废弃的 id 映射到现行替代，并打日志。
const DEPRECATED_MODEL_MAP: Record<string, Record<string, string>> = {
  deepseek: {
    'deepseek-v4': 'deepseek-v4-pro',  // 用户曾选过的虚构 id（v4 不存在），强制映射到 v4-pro
    // deepseek-chat / deepseek-reasoner 保留为合法选项（V3.2 / R1）：
    // 官方 2026-07-24 才弃用，UI 显式列出，**不在此映射**
  },
  claude: {
    // 旧的带日期 id 全部归一化到不带日期
    'claude-opus-4-7-20260301': 'claude-opus-4-7',
    'claude-sonnet-4-7-20260301': 'claude-sonnet-4-6', // 4.7 sonnet 不存在，回退到 4.6
    'claude-opus-4-6-20250414': 'claude-opus-4-6',
    'claude-sonnet-4-6-20250414': 'claude-sonnet-4-6',
    'claude-haiku-4-5-20241022': 'claude-haiku-4-5',
  },
  doubao: {
    'doubao-seed-2-pro-32k': 'doubao-seed-2-0-pro-260215',
    'doubao-seed-2-code-32k': 'doubao-seed-code-preview-251028',
    'doubao-seed-2-lite-32k': 'doubao-seed-2-0-pro-260215',
    'doubao-seed-2-mini-32k': 'doubao-seed-2-0-pro-260215',
    'doubao-seed-1-6-vision': 'doubao-seed-1-8-251228',
  },
}

function normalizeModelId(providerId: string, modelId: string): string {
  const map = DEPRECATED_MODEL_MAP[providerId]
  if (!map) return modelId
  const renamed = map[modelId]
  if (renamed && renamed !== modelId) {
    console.log(`[aiApi] normalized deprecated model "${providerId}:${modelId}" → "${providerId}:${renamed}"`)
    return renamed
  }
  return modelId
}

// 2026-04-27 Batch 43 · Effort（思考强度）支持
//
// 部分模型支持"思考预算"——给模型更多时间/token 做内部推理后再答。
// 各 provider 的字段位置和取值差异很大，按 2026-04-27 官方文档实测：
//
//   OpenAI（gpt-5 / o-series）
//     顶层：`reasoning_effort: 'low'|'medium'|'high'|'xhigh'`（'none' 也支持）
//
//   Claude（Opus 4.7 / Opus 4.6 / Sonnet 4.6）
//     **Opus 4.7 仅 adaptive，manual budget_tokens 直接 400 拒绝**
//     顶层：`thinking: { type: 'adaptive' }` + `output_config: { effort: 'low'|'medium'|'high'|'xhigh'|'max' }`
//     旧 `budget_tokens` 在 4.6 deprecated 仍可用，4.7 不能用
//
//   Gemini 3.x（OpenAI-compat 端点）
//     顶层：`extra_body: { thinking_config: { thinking_level: 'LOW'|'MEDIUM'|'HIGH' } }`
//     （旧 thinking_budget 数字仍可用作向后兼容）
//
//   DeepSeek V4-Pro / V4-Flash
//     顶层 `reasoning_effort: 'high'|'max'` + `extra_body: { thinking: { type: 'enabled' } }`
//     （low/medium 会被自动映射到 high，所以 UI 选 low 实际仍是高思考）
//
//   通义 Qwen3-Max-Preview
//     顶层 `extra_body: { enable_thinking: true }` + 思考内容通过 reasoning_content 返回
//
//   GLM 5 / Kimi K2.6
//     顶层 `thinking: { type: 'enabled' }`（GLM）/ `enable_thinking: true`（Kimi）
//     —— 这俩是布尔开关而非 effort 档位；high → 开，low/medium → 关
//
// UI 抽象成 'low' | 'medium' | 'high' 三档；不支持的 provider/model 直接忽略 effort（无副作用）。

export type EffortLevel = 'low' | 'medium' | 'high'

export function modelSupportsEffort(providerId: string, modelId: string): boolean {
  const m = modelId.toLowerCase()
  // OpenAI: GPT-5 系列 + o-series 推理模型
  if (providerId === 'openai') {
    return m.startsWith('o') || m.includes('gpt-5')
  }
  // Claude: Opus 4.6 / 4.7 + Sonnet 4.6 / 4.7 支持 adaptive thinking + effort
  // Haiku 4.5 等更早型号不支持
  if (providerId === 'claude') {
    return m.includes('opus-4-7') || m.includes('opus-4-6')
        || m.includes('sonnet-4-7') || m.includes('sonnet-4-6')
  }
  // Gemini 3 / 2.5 系列支持 thinking_level
  if (providerId === 'gemini') {
    return m.includes('gemini-3') || m.includes('gemini-2.5')
  }
  // DeepSeek V4 系列（Pro / Flash）和 legacy reasoner 都接 reasoning_effort
  if (providerId === 'deepseek') {
    return m.includes('v4') || m.includes('reasoner') || m.includes('-r1')
  }
  // Qwen Max-Preview 系列支持 enable_thinking
  if (providerId === 'qwen') {
    return m.includes('max') || m.includes('thinking')
  }
  // Tencent TokenHub exposes Hunyuan thinking controls through OpenAI-compatible
  // reasoning_effort / thinking fields on Hy3 and HY 2.0 Think.
  if (providerId === 'hunyuan') {
    return m.includes('hy3') || m.includes('thinking')
  }
  // GLM-5 / Kimi K2.6 可开 thinking 但只是布尔开关，UI 上把 effort=high 视为"开"
  if (providerId === 'glm') {
    return m.includes('glm-5')
  }
  if (providerId === 'kimi') {
    return m.includes('k2')
  }
  return false
}

// 映射 UI 三档 → Gemini 大写枚举
function effortToGeminiLevel(effort: EffortLevel): 'LOW' | 'MEDIUM' | 'HIGH' {
  return effort.toUpperCase() as 'LOW' | 'MEDIUM' | 'HIGH'
}

// Inject effort field into the request body in-place.
// Mutates `body`. Caller should call BEFORE JSON.stringify.
// Note: Claude 走独立的 callClaudeStream 路径，不通过此函数 ——
// Claude 的 effort 注入在 callClaudeStream / callClaude 内部按 adaptive 模板做。
//
// Batch 43 · hasWebSearch 入参用于检测 thinking + web_search 冲突。
// Kimi K2.6 的 $web_search builtin function **与 thinking 模式不兼容**——
// 同时开会 400/失败。其他 provider 暂未发现此类冲突，但保留参数以备未来扩展。
function injectEffort(body: any, providerId: string, modelId: string, effort?: EffortLevel, hasWebSearch?: boolean) {
  if (!effort) return
  if (!modelSupportsEffort(providerId, modelId)) return
  if (providerId === 'openai') {
    body.reasoning_effort = effort
  } else if (providerId === 'gemini') {
    body.extra_body = body.extra_body || {}
    body.extra_body.thinking_config = { thinking_level: effortToGeminiLevel(effort) }
  } else if (providerId === 'deepseek') {
    // DeepSeek V4 官方 OpenAI 格式：顶层 reasoning_effort + extra_body.thinking
    body.reasoning_effort = effort === 'high' ? 'high' : (effort === 'medium' ? 'high' : 'high')
    // ↑ 实际 DeepSeek 只承认 'high' / 'max'，low/medium 自动映射 high；
    //   显式映射避免 API 端隐含行为
    body.extra_body = body.extra_body || {}
    body.extra_body.thinking = { type: 'enabled' }
  } else if (providerId === 'qwen') {
    body.extra_body = body.extra_body || {}
    body.extra_body.enable_thinking = effort === 'high' || effort === 'medium'
  } else if (providerId === 'hunyuan') {
    // BUG-FIX R8#23 · 腾讯混元 TokenHub 是 OpenAI 兼容接口,thinking 控制只确定接受
    //   顶级 reasoning_effort(OpenAI 标准字段)。原代码同时塞了 body.thinking =
    //   { type: 'enabled'/'disabled' },但这是 Anthropic Messages API 的字段格式,
    //   腾讯官方文档未列出 TokenHub 接受顶级 thinking 字段。
    //   如果 TokenHub 严格 schema 校验未知字段 → 400 失败;若容忍 → 字段被忽略,
    //   effort 仍通过 reasoning_effort 生效。两种结果里"严格校验 → 整请求挂"是
    //   blocker,移除冗余字段是最稳的方向。未来如腾讯发布官方 thinking 字段格式
    //   再补(常见候选:extra_body.enable_thinking 同 Qwen / chat_options.thinking)。
    body.reasoning_effort = effort
  } else if (providerId === 'glm') {
    // GLM-5 thinking 是布尔开关：high → 开，low/medium → 关
    if (effort === 'high') body.thinking = { type: 'enabled' }
  } else if (providerId === 'kimi') {
    // Kimi K2.6: $web_search builtin function 与 thinking 不兼容（官方文档明确）。
    // 用户两个都想要时，**webSearch 优先**，强制关 thinking 避免 API 报错。
    if (hasWebSearch) {
      body.enable_thinking = false
      console.log('[aiApi] Kimi web_search 与 thinking 不兼容，本次请求禁用 thinking')
    } else {
      body.enable_thinking = effort === 'high'
    }
  }
}

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
  // BUG-FIX R8#24 · 把 timer 提到 try 外,clearTimeout 移到 finally。
  //   原代码 clearTimeout 在 try 内 fetch 之后,catch 路径(fetch 抛错时)不清 timer。
  //   1.5s 后 ctrl.abort() 调一个已结束的 controller(noop),没有真副作用,但 Node
  //   仍会持有 timer handle 直到 fire,且与同文件 fetchAndExtract / personas.ts /
  //   onlineSearch.ts / personas-search-helper.ts 的 try-finally 模式不一致。
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: ctrl.signal })
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
  } finally {
    clearTimeout(timer)
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

export async function callChat(
  providerId: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  opts?: { priority?: RequestPriority; effort?: EffortLevel },
): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`)
  // Batch 43 · 废弃 model id 自动迁移（保护持久化了旧 id 的用户）
  model = normalizeModelId(providerId, model)

  // noKey providers (Ollama / Claude CLI) skip the key check.
  const key = provider.noKey ? '' : apiKeys[providerId]
  if (!provider.noKey && !key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`)

  // Claude CLI: spawn `claude -p` instead of HTTP. Still go through scheduler
  // so we respect maxConcurrency=1 (don't spawn 5 claude CLIs at once).
  if (providerId === 'claude_cli') {
    return schedule(providerId, () => callClaudeCli(messages), {
      priority: opts?.priority,
      label: 'callChat:claude_cli',
    })
  }

  // 主进程节流：所有 provider 入口共用 per-provider 队列。撞 429 自动降挡 →
  // 后续所有调用变保守（adaptive RPM × 0.7，5 min 没再撞墙才恢复）。
  return schedule(providerId, async () => {
    // Claude uses a different request/response format
    if (providerId === 'claude') {
      return callClaude(key, model, messages, opts?.effort)
    }

    const body: any = { model, messages, max_tokens: 16384 }
    injectEffort(body, providerId, model, opts?.effort)
    const response = await fetch(provider.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...provider.authHeader(key),
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      if (isRateLimitError(`${response.status} ${text}`)) {
        bumpProviderInterval(providerId, parseRetryAfterHeader(response.headers))
      }
      throw new Error(`${provider.name} API error ${response.status}: ${text.substring(0, 200)}`)
    }

    const data = await response.json()
    return data.choices?.[0]?.message?.content || ''
  }, { priority: opts?.priority, label: `callChat:${providerId}` })
}

async function callClaude(key: string, model: string, messages: Array<{ role: string; content: string }>, effort?: EffortLevel): Promise<string> {
  // Extract system message
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  const body: any = {
    model,
    max_tokens: 4096,
    system: systemMsg,
    messages: chatMessages,
  }
  // Batch 43 · Anthropic adaptive thinking + output_config.effort
  // Opus 4.7 仅支持 adaptive；Opus 4.6 / Sonnet 4.6 也优先用 adaptive（manual budget_tokens 已 deprecated）
  if (effort && modelSupportsEffort('claude', model)) {
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort }
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    if (isRateLimitError(`${response.status} ${text}`)) {
      bumpProviderInterval('claude', parseRetryAfterHeader(response.headers))
    }
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
  opts?: { webSearch?: boolean; priority?: RequestPriority; effort?: EffortLevel },
): Promise<string> {
  const provider = PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`)
  // Batch 43 · 废弃 model id 自动迁移
  model = normalizeModelId(providerId, model)

  const key = provider.noKey ? '' : apiKeys[providerId]
  if (!provider.noKey && !key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`)

  // Claude CLI doesn't stream — synthesize a single chunk with the full output.
  // Still goes through scheduler for concurrency control.
  if (providerId === 'claude_cli') {
    return schedule(providerId, () => callClaudeCli(messages, onChunk, signal), {
      priority: opts?.priority,
      label: 'callChatStream:claude_cli',
    })
  }

  const webSearch = !!opts?.webSearch
  const priority: RequestPriority = opts?.priority || 'interactive'

  // 主进程节流（chokepoint）：整个请求（从建连到读完 SSE）都在 schedule() slot
  // 内，一个 provider 的 maxConcurrency 自然限制了同时飞多少流。撞 429 → 降挡。
  return schedule(providerId, async () => {
    if (providerId === 'claude') {
      return callClaudeStream(key, model, messages, onChunk, signal, webSearch, opts?.effort)
    }

    // Batch 43 · 联网搜索路径分发：
    //   原生（GLM/Claude/Kimi/Gemini）→ 透传 tools，provider 服务端自跑搜索循环
    //   manual loop（OpenAI/DeepSeek/Doubao）→ callWithManualSearchLoop（带 DSML 解析 +
    //     web_search/web_fetch 双工具，能处理 V4 的协议变体）
    //   都不支持（Ollama/Claude CLI）→ 静默忽略 webSearch
    if (webSearch && isManualFunctionCallingProvider(providerId)) {
      return callWithManualSearchLoop(provider, key, model, messages, onChunk, signal)
    }
    let tools: any[] | undefined
    if (webSearch) {
      if (providerHasNativeWebSearch(providerId)) {
        tools = buildWebSearchTools(providerId)
      } else if (providerUsesWebSearchRequestFlag(providerId)) {
        // Qwen enables provider-side search with a request-body flag below.
      } else {
        console.warn(`[aiApi] Provider ${providerId} 不支持 web search（无原生 + 不在 manual loop 名单），忽略 webSearch=true`)
      }
    }

    // Most OpenAI-compatible providers default to a low max_tokens (GLM ~1024,
    // Kimi 1024-2048, Doubao varies). Without a floor, long notes get cut off
    // mid-sentence (user-reported "答复生成不完整"). 8192 fits comfortably in
    // current-gen context windows and is below every provider's hard cap.
    const body: any = { model, messages, stream: true, max_tokens: 16384 }
    if (tools) body.tools = tools
    // Batch 43 · effort 注入（OpenAI/DeepSeek/Gemini/Qwen/GLM/Kimi 各家字段不同）
    // 第 5 个参数 hasWebSearch 让 Kimi 在 webSearch=true 时跳过 thinking（官方冲突）
    injectEffort(body, providerId, model, opts?.effort, !!tools)
    if (webSearch && providerUsesWebSearchRequestFlag(providerId)) {
      body.enable_search = true
      body.search_options = { search_strategy: 'agent' }
    }

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
      if (isRateLimitError(`${response.status} ${text}`)) {
        bumpProviderInterval(providerId, parseRetryAfterHeader(response.headers))
      }
      throw new Error(`${provider.name} API error ${response.status}: ${text.substring(0, 200)}`)
    }

    return parseSSEStream(response, onChunk, (data) => {
      return data.choices?.[0]?.delta?.content || ''
    })
  }, { priority, label: `callChatStream:${providerId}` })
}

// Which providers have a server-side "AI searches by itself" web_search
// capability that we just need to pass a `tools` hint to.
function isManualFunctionCallingProvider(providerId: string): boolean {
  // These need us to run the function-calling loop ourselves.
  // 2026-04-27 Batch 43 · gemini 加入：Gemini 的 OpenAI-compat 端点
  // (https://generativelanguage.googleapis.com/v1beta/openai/...)
  // **不接受** native google_search tool（仅 gemini-3-pro-image-preview 支持）。
  // 文本 chat completions 必须走标准 function calling。所以把 Gemini 从原生
  // web search 名单挪到 manual loop 名单，让 callWithManualSearchLoop 兜底。
  return ['openai', 'deepseek', 'doubao', 'gemini', 'kimi', 'hunyuan'].includes(providerId)
}

function providerUsesWebSearchRequestFlag(providerId: string): boolean {
  return providerId === 'qwen'
}

// Batch 43 · DSML（DeepSeek Markup Language）tool-call 协议解析。
// V4 系列模型有时会把 tool_calls 用 DSML XML 格式塞在 assistant.content 里，
// 而不是标准 OpenAI tool_calls 数组——这是 V4 训练偏好（见 encoding_dsv4 文档）。
// 我们在 manual loop 里检测到 content 含 DSML 块时调用本解析器转回标准结构。
//
// DSML 用**全角竖线 ｜ (U+FF5C)** 作分隔，不是普通 |。格式：
//   <｜DSML｜tool_calls>
//     <｜DSML｜invoke name="web_fetch">
//       <｜DSML｜parameter name="url" string="true">https://...</｜DSML｜parameter>
//     </｜DSML｜invoke>
//   </｜DSML｜tool_calls>
//
// string="true" → 字符串参数原样保留；string="false" → JSON 解析（数字/布尔/对象/数组）

interface ParsedDsmlInvoke {
  toolName: string
  args: Record<string, unknown>
}

function parseDsmlToolCalls(text: string): { invocations: ParsedDsmlInvoke[]; cleanedText: string } {
  const FW = '｜'  // ｜ U+FF5C 全角竖线
  const blockRe = new RegExp(`<${FW}DSML${FW}tool_calls>([\\s\\S]*?)</${FW}DSML${FW}tool_calls>`, 'g')
  const invokeRe = new RegExp(`<${FW}DSML${FW}invoke name="([^"]+)">([\\s\\S]*?)</${FW}DSML${FW}invoke>`, 'g')
  const paramRe = new RegExp(`<${FW}DSML${FW}parameter name="([^"]+)" string="(true|false)">([\\s\\S]*?)</${FW}DSML${FW}parameter>`, 'g')
  const invocations: ParsedDsmlInvoke[] = []
  let cleanedText = text
  let blockMatch: RegExpExecArray | null
  blockRe.lastIndex = 0
  while ((blockMatch = blockRe.exec(text)) !== null) {
    const inner = blockMatch[1]
    cleanedText = cleanedText.replace(blockMatch[0], '')  // 把 DSML 块从 content 里清掉
    invokeRe.lastIndex = 0
    let invokeMatch: RegExpExecArray | null
    while ((invokeMatch = invokeRe.exec(inner)) !== null) {
      const toolName = invokeMatch[1]
      const argsBody = invokeMatch[2]
      const args: Record<string, unknown> = {}
      paramRe.lastIndex = 0
      let paramMatch: RegExpExecArray | null
      while ((paramMatch = paramRe.exec(argsBody)) !== null) {
        const [, paramName, isString, paramValue] = paramMatch
        if (isString === 'true') {
          args[paramName] = paramValue.trim()
        } else {
          // string="false" → 期望是 JSON-valid 值
          try { args[paramName] = JSON.parse(paramValue.trim()) }
          catch { args[paramName] = paramValue.trim() }
        }
      }
      invocations.push({ toolName, args })
    }
  }
  return { invocations, cleanedText: cleanedText.trim() }
}

// Batch 43 · web_fetch 工具实现：抓 URL 内容，HTML 去标签后截断给模型。
// V4 偏好调 web_fetch（直接拉 URL 全文），所以 manual loop 里要同时支持
// web_search（关键词搜）和 web_fetch（拉 URL）两个工具。
async function fetchUrlAsText(url: string, maxChars = 8000): Promise<string> {
  // 简单的 URL 校验防止 SSRF（不允许 file://、localhost、内网地址）
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`无效 URL: ${url}`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`不允许的协议: ${parsed.protocol}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.') || host.startsWith('169.254.')) {
    throw new Error(`不允许内网 / 本地地址: ${host}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShijuanAI/1.3)' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const ct = res.headers.get('content-type') || ''
    if (!ct.includes('text/') && !ct.includes('application/json') && !ct.includes('application/xml')) {
      throw new Error(`不支持的 content-type: ${ct}`)
    }
    const html = await res.text()
    // HTML → text（粗粒度但够用）
    const text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > maxChars ? text.slice(0, maxChars) + '\n\n[…内容已截断]' : text
  } finally {
    clearTimeout(timer)
  }
}

// Batch 43 · Which providers natively support web search (server-side loop).
// 原生意味着：透传 tools 字段后 provider 服务器自跑搜索循环，最终 stream 出文本。
// 2026-04-27 · 移除 gemini —— OpenAI-compat 文本端点不接受 google_search tool
export function providerHasNativeWebSearch(providerId: string): boolean {
  return ['glm', 'claude'].includes(providerId)
}

// Batch 43 · Which providers support web search **at all**（原生或我们 manual loop）。
// 前端用这个判断要不要灰掉联网按钮。manual loop 路径升级版能解析 V4 的 DSML 协议
// 并提供 web_search + web_fetch 双工具，所以 OpenAI/DeepSeek/Doubao 也支持了。
// 不支持的：Ollama / Claude CLI（无 tools 调用接口）。
export function providerSupportsWebSearch(providerId: string): boolean {
  return providerHasNativeWebSearch(providerId) || isManualFunctionCallingProvider(providerId) || providerUsesWebSearchRequestFlag(providerId)
}

// 2026-04-28 · 哪些 provider 的 web search 是**单独计费的付费工具**（除了模型 token 之外）。
// - GLM `web_search_pro`：约 ¥0.03/次（智谱按调用计费）
// - Claude `web_search`：~$0.01/次（Anthropic：$10/1000 次）
// - Kimi `$web_search`：builtin，无额外费用（只算 token）
// - OpenAI/DeepSeek/Doubao 的 manual loop：我们自跑 web_search + web_fetch，
//   只多消耗 token，没有调用方计费的"搜索服务费"
// 前端 🌐 按钮的 tooltip 要按此区分,只有 paid 的才警告"会扣 provider 账户"。
export function providerWebSearchIsPaid(providerId: string): boolean {
  return providerId === 'glm' || providerId === 'claude'
}

// Build the appropriate tools payload per provider for server-side web search.
function buildWebSearchTools(providerId: string): any[] {
  switch (providerId) {
    case 'glm':
      // 2026-04-27 Batch 43 · 按 docs.bigmodel.cn/cn/guide/tools/web-search 修正格式
      // GLM 严格校验：enable / search_result 必须是**字符串** "True" 不是 boolean；
      // search_engine 必须是 'search_pro'（不是 'search_pro_jina'，jina 后缀不存在）；
      // count 官方示例 5（30 可能超限）；require_search 字段不在官方文档里。
      // search_prompt 引导 GLM 主动搜索 —— 没有它 GLM 对用户问题可能判定"不需搜"
      // 导致用户截图里看到的"搜到的资料——一片空白"。
      return [{
        type: 'web_search',
        web_search: {
          enable: 'True',
          search_engine: 'search_pro',
          search_result: 'True',
          search_prompt: '基于用户问题主动搜索互联网，包括预测类、评估类、当前事件、人物动态、最新数据等问题——所有具体的事实问题都应当搜索后再回答，不要凭训练记忆作答。',
          search_recency_filter: 'oneMonth',
          count: '5',
          content_size: 'high',
        },
      }]
    // gemini 已从 native web search 名单移除：OpenAI-compat 不接受 google_search
    // （2026-04-27 文档明确仅 gemini-3-pro-image-preview 支持）。Gemini 现在
    // 通过 isManualFunctionCallingProvider 走 manual loop，不会走到 buildWebSearchTools
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
  const isKimiWebSearch = provider.id === 'kimi'

  // Batch 43 · 双工具：web_search（关键词搜）+ web_fetch（拉 URL 全文）
  // V4 偏好直接调 web_fetch；其他模型一般调 web_search。两个都暴露让 AI 自选。
  const kimiWebSearchTool = {
    type: 'builtin_function',
    function: { name: '$web_search' },
  }
  const webSearchTool = {
    type: 'function',
    function: {
      name: 'web_search',
      description: '通过关键词搜索互联网资料。当需要查询人物、事件、定义、时间、著作等信息但不知道具体 URL 时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（中文或英文）' },
        },
        required: ['query'],
      },
    },
  }
  const webFetchTool = {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取指定 URL 的网页内容并提取为纯文本。当你已经知道目标 URL（比如从 web_search 结果里挑了一个）想看全文时调用。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整的 http(s) URL' },
        },
        required: ['url'],
      },
    },
  }
  const tools = isKimiWebSearch ? [kimiWebSearchTool] : [webSearchTool, webFetchTool]

  // 执行单个工具调用，返回字符串结果
  async function runTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName === '$web_search') {
      return JSON.stringify(args || {})
    }
    if (toolName === 'web_search') {
      const query = String(args.query || '').trim()
      if (!query) return '(未提供搜索关键词)'
      try {
        const sources = await multiSourceSearchInline(query)
        const formatted = sources.slice(0, 5).map(s =>
          `[${s.source}] ${s.title}\n${s.snippet || ''}\n链接: ${s.url}`
        ).join('\n\n')
        return formatted || '(未找到相关资料)'
      } catch (err: any) {
        return `(搜索失败: ${err.message})`
      }
    }
    if (toolName === 'web_fetch') {
      const url = String(args.url || '').trim()
      if (!url) return '(未提供 URL)'
      try {
        const text = await fetchUrlAsText(url)
        return `[抓取自 ${url}]\n\n${text || '(页面无可读文本)'}`
      } catch (err: any) {
        return `(抓取失败: ${err.message})`
      }
    }
    return `(未知工具: ${toolName})`
  }

  const conversation: any[] = messages.map(m => ({ ...m }))
  const MAX_ITER = 2
  let iter = 0

  while (iter < MAX_ITER) {
    // Non-streaming call to detect tool_calls
    const requestBody: any = { model, messages: conversation, tools, stream: false, max_tokens: 16384 }
    if (isKimiWebSearch) {
      requestBody.thinking = { type: 'disabled' }
    }
    const res = await fetch(provider.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...provider.authHeader(key) },
      body: JSON.stringify(requestBody),
      signal,
    })
    if (!res.ok) {
      const t = await res.text()
      if (isRateLimitError(`${res.status} ${t}`)) {
        bumpProviderInterval(provider.id, parseRetryAfterHeader(res.headers))
      }
      throw new Error(`${provider.name} API error ${res.status}: ${t.substring(0, 200)}`)
    }
    const data: any = await res.json()
    const msg = data.choices?.[0]?.message
    let toolCalls: Array<{ id?: string; toolName: string; args: Record<string, unknown> }> = []

    // 路径 1：标准 OpenAI tool_calls JSON 数组（OpenAI / Doubao / DeepSeek 部分情况）
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      toolCalls = msg.tool_calls.map((tc: any) => {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { /* ignore */ }
        return { id: tc.id, toolName: tc.function?.name || '', args }
      })
    }

    // 路径 2：DSML 协议（DeepSeek V4 偏好）—— content 里 <｜DSML｜tool_calls> 块
    const contentStr = typeof msg?.content === 'string' ? msg.content : ''
    if (toolCalls.length === 0 && contentStr) {
      const { invocations, cleanedText } = parseDsmlToolCalls(contentStr)
      if (invocations.length > 0) {
        // 把清理后的 content（去掉 DSML 块）写回 msg，让上下文不再被 XML 污染
        msg.content = cleanedText
        // 给每个 invocation 合成一个 id 让 tool_call_id 配对
        toolCalls = invocations.map((inv, idx) => ({
          id: `dsml-${iter}-${idx}`,
          toolName: inv.toolName,
          args: inv.args,
        }))
      }
    }

    if (toolCalls.length === 0) {
      // 真没工具调用 —— 把 content 当普通回复 emit。注意如果是 DSML 解析失败留下的
      // raw 文本，那不是普通回复，但目前没其他路径，先这么处理
      const text = contentStr
      if (text) onChunk(text)
      return text
    }

    // 同时跑所有工具调用（独立无依赖）
    conversation.push(msg)  // append assistant's tool_call message
    await Promise.all(toolCalls.map(async (tc) => {
      const resultText = await runTool(tc.toolName, tc.args)
      const toolMessage: any = {
        role: 'tool',
        tool_call_id: tc.id || `tool-${iter}`,
        content: resultText,
      }
      if (isKimiWebSearch) toolMessage.name = tc.toolName
      conversation.push(toolMessage)
    }))
    iter++
  }

  // After loop: stream the final answer (no more tools)
  const finalBody: any = { model, messages: conversation, stream: true, max_tokens: 16384 }
  if (isKimiWebSearch) {
    finalBody.thinking = { type: 'disabled' }
  }
  const finalRes = await fetch(provider.chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...provider.authHeader(key) },
    body: JSON.stringify(finalBody),
    signal,
  })
  if (!finalRes.ok) {
    const t = await finalRes.text()
    if (isRateLimitError(`${finalRes.status} ${t}`)) {
      bumpProviderInterval(provider.id, parseRetryAfterHeader(finalRes.headers))
    }
    throw new Error(`${provider.name} API error ${finalRes.status}: ${t.substring(0, 200)}`)
  }
  // Batch 43 · 最终流式答复也可能包 DSML（V4 在生成最终 text 时也偶尔输出 DSML 标签
  // 作为格式残留）。用 wrapper 边流边过滤，把 DSML 标签从输出里抽掉。
  let dsmlBuffer = ''
  return parseSSEStream(finalRes, (chunk) => {
    dsmlBuffer += chunk
    // 简单过滤：只 emit 不含 DSML 全角竖线的部分
    if (dsmlBuffer.includes('｜')) {
      // 暂存 buffer 等更多 chunk 进来再判断
      return
    }
    if (dsmlBuffer) {
      onChunk(dsmlBuffer)
      dsmlBuffer = ''
    }
  }, (data) => data.choices?.[0]?.delta?.content || '')
    .then((full) => {
      // 流结束后清理 buffer 里残留的 DSML 标签
      if (dsmlBuffer) {
        const { cleanedText } = parseDsmlToolCalls(dsmlBuffer)
        if (cleanedText) onChunk(cleanedText)
        dsmlBuffer = ''
      }
      // 整体 full 也清一遍 DSML 块返回（防止下游存到历史里仍带 XML）
      const { cleanedText } = parseDsmlToolCalls(full)
      return cleanedText || full
    })
}

async function callClaudeStream(
  key: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  webSearch?: boolean,
  effort?: EffortLevel,
): Promise<string> {
  const systemMsg = messages.find(m => m.role === 'system')?.content || ''
  const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  // Batch 43 · max_tokens 提到 16000 给 thinking 留空间（Anthropic 文档示例值）
  // 仅 4.6 / 4.7 系列 + adaptive thinking 时需要这么大；老模型 4096 即可
  const supportsAdaptive = modelSupportsEffort('claude', model)
  const body: any = {
    model,
    max_tokens: supportsAdaptive ? 16000 : 4096,
    stream: true,
    system: systemMsg,
    messages: chatMessages,
  }
  // Adaptive thinking + output_config.effort（Opus 4.7 仅此一种支持的 thinking 模式）
  if (effort && supportsAdaptive) {
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort }
  }
  // Claude's native web search tool (automatic agentic loop handled by Claude
  // itself — we just declare the tool and Claude calls it as needed, with
  // tool_use / tool_result events interleaved in the SSE stream).
  if (webSearch) {
    // Batch 43 · 用旧版 web_search_20250305（稳定）。新版 20260209 含 Dynamic
    // Filtering 但 model 兼容矩阵窄，部分 Claude 模型 tier 上会 400。
    // 等 Anthropic 文档明确 20260209 支持的 model 名单后再切。
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
    if (isRateLimitError(`${response.status} ${text}`)) {
      bumpProviderInterval('claude', parseRetryAfterHeader(response.headers))
    }
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

// ===== RapidOCR local bridge =====
//
// RapidOCR is a Python package. Instead of bundling a heavyweight native stack
// into Electron, Shijuan talks to a tiny Python bridge stored under
// ~/.lit-manager/runtime. Users can install the local engine with:
//   python -m pip install rapidocr onnxruntime pymupdf
//
// PyMuPDF renders PDF pages to temporary PNGs; RapidOCR reads each image and
// returns line text. GLM still remains the cloud OCR path.
const RAPID_OCR_INSTALL_COMMAND = 'python -m pip install rapidocr onnxruntime pymupdf'

const RAPID_OCR_BRIDGE = String.raw`
import argparse
import json
import os
import sys
import tempfile
import traceback

RESULT_PREFIX = "SJ_RESULT "
PROGRESS_PREFIX = "SJ_PROGRESS "

def emit_result(payload):
    print(RESULT_PREFIX + json.dumps(payload, ensure_ascii=False), flush=True)

def emit_progress(payload):
    print(PROGRESS_PREFIX + json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)

def fail(message, detail=None):
    payload = {"success": False, "error": message}
    if detail:
        payload["detail"] = detail
    emit_result(payload)
    sys.exit(0)

def import_rapidocr():
    try:
        from rapidocr import RapidOCR
        import rapidocr
        version = getattr(rapidocr, "__version__", "unknown")
        api = "rapidocr"
        return RapidOCR, version, api
    except Exception as first:
        try:
            from rapidocr_onnxruntime import RapidOCR
            import rapidocr_onnxruntime
            version = getattr(rapidocr_onnxruntime, "__version__", "unknown")
            api = "rapidocr_onnxruntime"
            return RapidOCR, version, api
        except Exception:
            raise first

def probe():
    try:
        RapidOCR, version, api = import_rapidocr()
        try:
            import onnxruntime
            ort_version = getattr(onnxruntime, "__version__", "unknown")
        except Exception as exc:
            fail("RapidOCR 已安装，但缺少 onnxruntime。请执行: python -m pip install onnxruntime", repr(exc))
            return
        try:
            import fitz
            fitz_version = getattr(fitz, "__doc__", "")[:60]
        except Exception as exc:
            fail("RapidOCR PDF 识别需要 PyMuPDF。请执行: python -m pip install pymupdf", repr(exc))
            return
        emit_result({
            "success": True,
            "available": True,
            "version": version,
            "api": api,
            "onnxruntime": ort_version,
            "pymupdf": fitz_version,
        })
    except Exception as exc:
        fail("未检测到 RapidOCR。本地 OCR 需要执行: python -m pip install rapidocr onnxruntime pymupdf", repr(exc))

def extract_txts(output):
    # rapidocr>=3 returns RapidOCROutput with .txts. rapidocr_onnxruntime 1.x
    # returns (result, elapse), where result rows are [box, text, score].
    if output is None:
        return []
    if hasattr(output, "txts"):
        return [str(t) for t in (getattr(output, "txts", None) or []) if str(t).strip()]
    if isinstance(output, tuple) and output:
        rows = output[0]
        if rows is None:
            return []
        txts = []
        for row in rows:
            try:
                if isinstance(row, (list, tuple)) and len(row) >= 2:
                    txts.append(str(row[1]))
            except Exception:
                continue
        return [t for t in txts if t.strip()]
    return []

def ocr_image(engine, image_path):
    out = engine(image_path)
    return "\n".join(extract_txts(out)).strip()

def run_pdf(args):
    try:
        import fitz
        RapidOCR, version, api = import_rapidocr()
        engine = RapidOCR()

        pdf_path = args.pdf
        if not pdf_path or not os.path.exists(pdf_path):
            fail("PDF 文件不存在")
            return

        doc = fitz.open(pdf_path)
        page_count = doc.page_count
        if page_count <= 0:
            fail("PDF 没有可识别页面")
            return

        start = max(1, int(args.start or 1))
        end = int(args.end or page_count)
        end = max(start, min(page_count, end))
        start = min(start, page_count)
        total = end - start + 1
        zoom = max(1.0, float(args.dpi or 180) / 72.0)
        matrix = fitz.Matrix(zoom, zoom)

        page_texts = []
        with tempfile.TemporaryDirectory(prefix="shijuan_rapidocr_") as tmp:
            for page_no in range(start, end + 1):
                emit_progress({"page": page_no, "index": page_no - start, "total": total})
                page = doc.load_page(page_no - 1)
                pix = page.get_pixmap(matrix=matrix, alpha=False)
                img_path = os.path.join(tmp, f"page_{page_no}.png")
                pix.save(img_path)
                text = ocr_image(engine, img_path)
                page_texts.append(text)

        combined = "\n\n".join(
            f"=== 第 {start + i} 页 ===\n\n{text}".strip()
            for i, text in enumerate(page_texts)
        ).strip()

        if not combined:
            fail("RapidOCR 未能提取到文字")
            return

        emit_result({
            "success": True,
            "engine": "rapidocr",
            "api": api,
            "version": version,
            "text": combined,
            "pageTexts": page_texts,
            "pageCount": page_count,
            "chunks": total,
            "actualStartPage": start,
            "actualEndPage": end,
        })
    except Exception as exc:
        fail(str(exc), traceback.format_exc())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--pdf")
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--dpi", type=int, default=180)
    args = parser.parse_args()
    if args.probe:
        probe()
    elif args.pdf:
        run_pdf(args)
    else:
        fail("未指定操作")

if __name__ == "__main__":
    main()
`

interface PythonCandidate {
  command: string
  argsPrefix: string[]
  label: string
}

function pythonCandidates(): PythonCandidate[] {
  if (process.platform === 'win32') {
    return [
      { command: 'python', argsPrefix: [], label: 'python' },
      { command: 'py', argsPrefix: ['-3'], label: 'py -3' },
      { command: 'python3', argsPrefix: [], label: 'python3' },
    ]
  }
  return [
    { command: 'python3', argsPrefix: [], label: 'python3' },
    { command: 'python', argsPrefix: [], label: 'python' },
  ]
}

async function rapidOcrBridgePath(): Promise<string> {
  const dir = path.join(DATA_DIR, 'runtime')
  await fs.mkdir(dir, { recursive: true })
  const bridgePath = path.join(dir, 'rapidocr_bridge.py')
  let current = ''
  try { current = await fs.readFile(bridgePath, 'utf-8') } catch {}
  if (current !== RAPID_OCR_BRIDGE) {
    await fs.writeFile(bridgePath, RAPID_OCR_BRIDGE, 'utf-8')
  }
  return bridgePath
}

async function runRapidOcrBridge(
  extraArgs: string[],
  onProgress?: (payload: any) => void,
): Promise<any> {
  const bridge = await rapidOcrBridgePath()
  const candidates = pythonCandidates()
  let lastError = ''

  for (const candidate of candidates) {
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const proc = spawn(candidate.command, [...candidate.argsPrefix, bridge, ...extraArgs], {
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
          },
        })
        let stdout = ''
        let stderr = ''
        let stderrRemainder = ''
        let settled = false

        const finish = (err?: Error) => {
          if (settled) return
          settled = true
          if (err) { reject(err); return }
          const resultLine = stdout.split(/\r?\n/).reverse().find(line => line.startsWith('SJ_RESULT '))
          if (!resultLine) {
            reject(new Error(`RapidOCR 没有返回结果。${stderr.trim().slice(-800) || stdout.trim().slice(-800)}`))
            return
          }
          try {
            resolve({ ...JSON.parse(resultLine.slice('SJ_RESULT '.length)), python: candidate.label })
          } catch (parseErr: any) {
            reject(new Error(`RapidOCR 返回解析失败: ${parseErr.message}`))
          }
        }

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8') })
        proc.stderr.on('data', (d: Buffer) => {
          const text = d.toString('utf-8')
          stderr += text
          stderrRemainder += text
          const lines = stderrRemainder.split(/\r?\n/)
          stderrRemainder = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('SJ_PROGRESS ')) continue
            try { onProgress?.(JSON.parse(line.slice('SJ_PROGRESS '.length))) } catch {}
          }
        })
        proc.on('error', (err) => finish(err))
        proc.on('close', () => finish())
      })
      return result
    } catch (err: any) {
      lastError = err?.message || String(err)
    }
  }

  throw new Error(`无法启动 Python。请确认已安装 Python 3，并执行 ${RAPID_OCR_INSTALL_COMMAND}。${lastError ? `\n${lastError}` : ''}`)
}

async function probeRapidOcr(): Promise<{ available: boolean; python?: string; version?: string; api?: string; onnxruntime?: string; error?: string; installCommand: string }> {
  try {
    const result = await runRapidOcrBridge(['--probe'])
    if (result.success && result.available !== false) {
      return {
        available: true,
        python: result.python,
        version: result.version,
        api: result.api,
        onnxruntime: result.onnxruntime,
        installCommand: RAPID_OCR_INSTALL_COMMAND,
      }
    }
    return {
      available: false,
      error: result.error || 'RapidOCR 不可用',
      installCommand: RAPID_OCR_INSTALL_COMMAND,
    }
  } catch (err: any) {
    return {
      available: false,
      error: err?.message || String(err),
      installCommand: RAPID_OCR_INSTALL_COMMAND,
    }
  }
}

async function callRapidOcrPdf(
  pdfAbsPath: string,
  opts?: { entryId?: string; startPage?: number; endPage?: number },
): Promise<OcrPdfResult> {
  const args = ['--pdf', pdfAbsPath, '--dpi', '180']
  if (opts?.startPage != null) args.push('--start', String(opts.startPage))
  if (opts?.endPage != null) args.push('--end', String(opts.endPage))

  const result = await runRapidOcrBridge(args, (p) => {
    const total = Math.max(1, Number(p.total || 1))
    const idx = Math.max(0, Number(p.index || 0))
    reportOcrProgress(opts?.entryId, idx, total, 'start')
  })

  if (!result.success) {
    reportOcrProgress(opts?.entryId, 0, 1, 'error')
    throw new Error(result.error || 'RapidOCR 识别失败')
  }
  const total = Math.max(1, Number(result.chunks || result.pageTexts?.length || 1))
  reportOcrProgress(opts?.entryId, total - 1, total, 'done')
  return {
    success: true,
    engine: 'rapidocr',
    text: result.text,
    pageTexts: Array.isArray(result.pageTexts) ? result.pageTexts : undefined,
    pageCount: result.pageCount,
    chunks: result.chunks,
    actualStartPage: result.actualStartPage,
    actualEndPage: result.actualEndPage,
  }
}

async function callGlmOcr(imageBase64: string): Promise<string> {
  const key = apiKeys['glm']
  if (!key) throw new Error('GLM API Key 未设置（OCR 需要智谱 GLM）')

  // OCR 是后台任务（用户不等屏幕流式响应），background 优先级——交互式 chat
  // 会插队过来，不会被长 OCR 批卡住。
  const response = await schedule('glm', async () => {
    return await fetch(GLM_OCR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'glm-ocr', file: `data:image/png;base64,${imageBase64}` }),
    })
  }, { priority: 'background', label: 'glm-ocr:image' })

  if (!response.ok) {
    const text = await response.text()
    if (isRateLimitError(`${response.status} ${text}`)) {
      bumpProviderInterval('glm', parseRetryAfterHeader(response.headers))
    }
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

  // BUG-FIX #D · Load persisted RPM overrides before starting the status
  // broadcast. Fire-and-forget — if it fails we continue with in-memory
  // defaults and the first setProviderRpmOverride will re-create the file.
  // Must happen before any provider fires a request so effectiveRpm is right.
  void loadRpmOverridesFromDisk().catch(() => { /* already logged inside */ })

  // Start the per-provider throttle status tick. Safe to call repeatedly — it
  // no-ops after the first call. Broadcasts to all BrowserWindows via
  // 'ai-throttle-status' channel once per second (unref'd, doesn't block exit).
  startStatusBroadcast()

  // === Throttle status IPC ===

  // One-shot query: { providerId → { effectiveRpm, queue depth, ... } }.
  // Useful for the initial render before the first tick fires.
  ipcMain.handle('ai-throttle-get-status', async () => {
    return getSnapshot()
  })

  // Explicit subscribe. The 'ai-throttle-status' event is already broadcast to
  // all windows every second via BrowserWindow.send, so the renderer just
  // needs to register a listener and this handler returns the current
  // snapshot so the caller can paint immediately without waiting a tick. We
  // wire in the subscribe/unsubscribe for symmetry with other IPC patterns in
  // the app — the UI-facing preload exposes onAiThrottleStatus(cb).
  ipcMain.handle('ai-throttle-status-subscribe', async (event) => {
    // Send an initial snapshot straight to this sender so they don't wait a tick
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send('ai-throttle-status', getSnapshot())
      }
    } catch { /* window gone */ }
    return { subscribed: true }
  })

  // User setting: override the base RPM for a provider (e.g. paid tier). Pass
  // rpm=null to reset to default. BUG-FIX #D · setProviderRpmOverride now
  // persists the map to ~/.lit-manager/rate-limit-overrides.json on every
  // call, so the override survives restart. Invalid rpm (non-positive / NaN)
  // throws up into the catch below and the UI gets a clean error.
  ipcMain.handle('ai-throttle-set-rpm-override', async (_event, providerId: string, rpm: number | null) => {
    try {
      setProviderRpmOverride(providerId, rpm)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

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

  // Batch 43 · 让前端查询某 provider+model 是否支持 effort（思考强度）
  ipcMain.handle('ai-model-supports-effort', (_e, providerId: string, modelId: string) => {
    return modelSupportsEffort(providerId, modelId)
  })

  // Batch 43 · 让前端查询某 provider 是否支持原生 web search
  // 不支持的 provider 即使 webSearch=true 也会被静默降级到普通流（无搜索）
  ipcMain.handle('ai-provider-has-native-web-search', (_e, providerId: string) => {
    return providerHasNativeWebSearch(providerId)
  })

  // Batch 43 · 让前端查询 provider 是否支持 web search（原生或 manual loop 任一）
  // 这是前端决定联网按钮是否灰掉的依据
  ipcMain.handle('ai-provider-supports-web-search', (_e, providerId: string) => {
    return providerSupportsWebSearch(providerId)
  })

  // 2026-04-28 · 让前端查询 provider 的 web search 是否单独计费(GLM/Claude),
  // 用于在 🌐 按钮 tooltip 警告用户"会扣付费工具的钱"。
  ipcMain.handle('ai-provider-web-search-is-paid', (_e, providerId: string) => {
    return providerWebSearchIsPaid(providerId)
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

  ipcMain.handle('ai-chat', async (_event, providerId: string, model: string, messages: Array<{ role: string; content: string }>, opts?: { effort?: EffortLevel }) => {
    try {
      const result = await callChat(providerId, model, messages, { effort: opts?.effort })
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

  ipcMain.handle('ai-chat-stream', async (event, streamId: string, providerId: string, model: string, messages: Array<{ role: string; content: string }>, opts?: { webSearch?: boolean; effort?: EffortLevel }) => {
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
        // If sender.send throws, renderer has been destroyed (window closed
        // mid-stream). Abort the in-flight request so we don't keep
        // streaming into the void — saves CPU + network + provider quota.
        try {
          if (event.sender.isDestroyed()) {
            controller.abort()
            return
          }
          event.sender.send('ai-stream-chunk', streamId, chunk)
        } catch {
          controller.abort()
        }
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

  // === OCR (cloud GLM + local RapidOCR) ===

  ipcMain.handle('rapid-ocr-probe', async () => {
    return probeRapidOcr()
  })

  ipcMain.handle('rapid-ocr-pdf', async (_event, pdfAbsPath: string, opts?: { entryId?: string; startPage?: number; endPage?: number }) => {
    try {
      const result = await callRapidOcrPdf(pdfAbsPath, opts)
      return result
    } catch (err: any) {
      return { success: false, engine: 'rapidocr', error: err.message }
    }
  })

  ipcMain.handle('glm-ocr', async (_event, imageBase64: string) => {
    try {
      const text = await callGlmOcr(imageBase64)
      return { success: true, text }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('glm-ocr-pdf', async (_event, pdfAbsPath: string, opts?: { entryId?: string; startPage?: number; endPage?: number }) => {
    try {
      const key = apiKeys['glm']
      if (!key) throw new Error('GLM API Key 未设置（OCR 需要智谱 GLM）')
      const entryId = opts?.entryId

      const pdfBuffer = await fs.readFile(pdfAbsPath)

      // 2026-04-27 Batch 43 · 页码范围支持（用户场景：300 页大文件只 OCR 第 50-100 页）
      const hasRange = opts?.startPage != null && opts?.endPage != null
      const pageRange = hasRange ? { startPage: opts!.startPage!, endPage: opts!.endPage! } : undefined

      // Decide whether to split. Quick check: if the raw file is already small and ≤100 pages,
      // we can send it in one shot. Otherwise, split.
      let chunks: Array<{ buffer: Buffer; startPage: number; endPage: number }>
      if (pdfBuffer.length <= GLM_OCR_MAX_BYTES && !pageRange) {
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
        if (pageRange) {
          console.log(`[glm-ocr-pdf] PDF page range ${pageRange.startPage}-${pageRange.endPage} requested`)
        } else {
          console.log('[glm-ocr-pdf] PDF size', Math.round(pdfBuffer.length / 1024 / 1024), 'MB exceeds cap — splitting')
        }
        chunks = await splitPdfForOcr(pdfBuffer, pageRange)
      }
      if (chunks.length === 0) {
        throw new Error('OCR 范围为空 — 请检查起止页码')
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
          // PDF OCR 分 chunk 串行跑，走 background 优先级——不会阻塞用户交互的
          // chat/ask。GLM 队列 serial（maxConcurrency=1），保证 OCR chunk 不会
          // 自相竞争。
          const response = await schedule('glm', async () => {
            return await fetch(GLM_OCR_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
              body: JSON.stringify({ model: 'glm-ocr', file: `data:application/pdf;base64,${pdfBase64}` }),
            })
          }, { priority: 'background', label: `glm-ocr:pdf-chunk-${i}` })
          if (!response.ok) {
            const errText = await response.text()
            if (isRateLimitError(`${response.status} ${errText}`)) {
              bumpProviderInterval('glm', parseRetryAfterHeader(response.headers))
            }
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

      // Batch 43 · 范围 OCR 时返回真实起止页让前端能定位文本到原 PDF 哪几页
      const firstChunk = chunks[0]
      const lastChunk = chunks[chunks.length - 1]
      return {
        success: true,
        text,
        pageTexts: allPageTexts,
        pageCount: totalReportedPages || allPageTexts.length,
        chunks: chunks.length,
        actualStartPage: firstChunk?.startPage ?? 1,
        actualEndPage: lastChunk?.endPage ?? (totalReportedPages || allPageTexts.length),
      }
    } catch (err: any) {
      console.error('[glm-ocr-pdf] Error:', err.message)
      return { success: false, error: err.message }
    }
  })
}
