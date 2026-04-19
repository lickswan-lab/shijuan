// 召唤 · 人物档案面板
//
// 进步式生成 + 多源联网 + 严谨评估。主要流程：
//   1. 输入姓名 → 点【搜索】→ 主进程多源搜索（Wiki/百度/DDG）→ 候选资料列表
//   2. 用户勾选/删除资料 → 点【确认并识别身份】→ AI disambig → 候选身份卡片
//   3. 用户选身份 → AI 生成初版档案（可选 webSearch=true 让 Claude/Kimi/GLM
//      再联网补充细节；OpenAI/DeepSeek/豆包 走 manual function-calling loop）
//   4. 自动触发严谨 5 维度拟合度评估
//   5. 用户可：【完善】（再搜+AI refine）、投喂材料（文件/URL/文本）、编辑、删除
//
// 投喂路径的 refine 结果**先预览**，用户【接受】才写入 versions

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import { KATEX_FORGIVING as rehypeKatex, sanitizeMath } from '../../utils/markdownConfig'
import { useUiStore } from '../../store/uiStore'
import type {
  Persona, PersonaSource, PersonaCandidateIdentity, PersonaFitness, PersonaVersion,
  PersonaDimensionKey, PersonaDimension, PersonaSkillArtifact,
} from '../../types/library'
import {
  PERSONA_DIMENSIONS, createEmptyDistillation, defaultTrustForSource,
} from '../../types/library'
import {
  PERSONA_DISAMBIG_SYSTEM_PROMPT, buildDisambigUserMessage, parseDisambig,
  PERSONA_GENERATE_SYSTEM_PROMPT, buildGenerateUserMessage,
  PERSONA_REFINE_SYSTEM_PROMPT, buildRefineUserMessage,
  PERSONA_EVALUATE_SYSTEM_PROMPT, buildEvaluateUserMessage, parseFitness,
} from './personaPrompts'
import {
  buildDistillSystemPrompt, buildDistillUserMessage,
  buildOptimizeDimensionSystemPrompt, buildOptimizeDimensionUserMessage,
  buildEvaluateDimensionUserMessage,
  PERSONA_SYNTHESIZE_SYSTEM_PROMPT, buildSynthesizeUserMessage,
  parseSkillSynthesis, buildSkillFullMarkdown,
} from './personaDistillPrompts'
import {
  RESEARCH_PLANNER_SYSTEM, buildResearchPlannerUserMessage, parsePlannerOutput,
  QUERY_GENERATOR_SYSTEM, buildQueryGeneratorUserMessage, parseQueriesOutput,
} from './personaResearchPrompt'
import {
  parseCitations, normalizeCitations,
  type InjectedChunk, type ParsedCitation,
} from './personaCitationParse'

type Stage =
  | 'idle' | 'searching' | 'picking-sources' | 'disambigging' | 'picking-identity'
  | 'distilling'         // 正跑某一维（流式预览在 streamingText 里）
  | 'distill-paused'     // 还没开始/某一维完成/用户停在中间 → 看进度 / 看某一维 / 进下一维 / 跳过
  | 'synthesizing'       // 6 维完成，跑综合 → skill
  | 'viewing'            // 看档案 / skill
  | 'summoning'          // 召唤对话中
  // Legacy / refine（旧流程仍保留，让老 persona 可以继续完善）
  | 'generating' | 'refine-picking-sources' | 'refining'

const SOURCE_LABEL: Record<PersonaSource['source'], string> = {
  'wikipedia-zh':     '维基中文',
  'wikipedia-en':     '维基英文',
  'baidu-baike':      '百度百科',
  'duckduckgo':       '网络',
  'archive-org':      'Archive · 原著',
  'project-gutenberg':'Gutenberg · 原著',
  'glm-web-search':   'GLM 搜索',
  'user-file':        '你的文件',
  'user-url':         '你的 URL',
  'user-prompt':      '你的笔记',
}

const SOURCE_COLOR: Record<PersonaSource['source'], string> = {
  'wikipedia-zh':     '#3366cc',
  'wikipedia-en':     '#555577',
  'baidu-baike':      '#2577e3',
  'duckduckgo':       '#aa6633',
  'archive-org':      '#8b1a1a',   // deep red — primary-tier signal
  'project-gutenberg':'#55415b',   // aubergine — primary-tier signal
  'glm-web-search':   '#2c8a6f',   // teal — fresh/AI-search signal
  'user-file':        '#66aa44',
  'user-url':         '#449977',
  'user-prompt':      '#995588',
}

// Short model-spec-safe AI call helper for persona workflows.
// Collects streamed chunks (optional listener) and returns final text.
//
// Non-streaming fallback: some provider paths don't emit chunks at all —
// notably the manual function-calling loop (OpenAI / DeepSeek / 豆包 when
// webSearch=true uses non-streaming for the tool-call round), and Claude's
// native web_search sometimes emits only tool_use blocks during search with
// no interim text deltas. In those cases the UI would otherwise stay blank
// for tens of seconds. We flush res.text through onChunk once at the end.
// Detect rate-limit errors across providers — most common offender is GLM
// (智谱 1302 "您的账户已达到速率限制") but also catches HTTP 429 / "rate limit"
// substrings from OpenAI / DeepSeek / 豆包. Used to trigger the auto-retry.
function isRateLimitError(msg: string | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  return /(429|rate.?limit|1302|速率限制|频率)/i.test(m) || m.includes('rate_limit')
}

// === Per-provider throttle: now lives in main process ===
//
// 原来这里有一份 frontend lastScheduledByProvider，但只覆盖 callPersonaAi —
// embeddings / web-search-pro 走主进程独立路径，三家共用 GLM 配额却没共用
// 节流状态 → 4 RPM 配额仍被并发请求炸穿。
//
// 现在所有 GLM HTTP 出口都在主进程 aiThrottle.ts 里 await throttleProvider()，
// 真正的 single-source-of-truth chokepoint。前端只保留 retry（429 自动重试 2 次），
// 因为重试需要在「同一个 React useState 流」里 onChunk 推进度。

async function callPersonaAi(
  modelSpec: string,
  system: string,
  user: string,
  opts?: { webSearch?: boolean; onChunk?: (t: string) => void },
): Promise<string> {
  // Up to 2 retries on rate-limit errors. 主进程节流应该让这条路径不太会撞墙，
  // 但留作保险 — 万一 GLM 实际配额比文档紧、或别的进程也在用同 key，仍能自愈。
  const RATE_LIMIT_BACKOFFS = [15000, 30000]
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFFS.length; attempt++) {
    const streamId = uuid()
    let full = ''
    let gotAnyChunk = false
    const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
      if (sid !== streamId) return
      full += chunk
      gotAnyChunk = true
      if (opts?.onChunk) opts.onChunk(full)
    })
    try {
      const res = await window.electronAPI.aiChatStream(streamId, modelSpec, [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ], { webSearch: opts?.webSearch })
      if (!res.success) throw new Error(res.error || 'AI 调用失败')
      if (res.text) {
        full = res.text
        if (!gotAnyChunk && opts?.onChunk) opts.onChunk(full)
      }
      return full
    } catch (err: any) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const isLast = attempt === RATE_LIMIT_BACKOFFS.length
      if (!isRateLimitError(lastErr.message) || isLast) throw lastErr
      const wait = RATE_LIMIT_BACKOFFS[attempt]
      if (opts?.onChunk) opts.onChunk(`⏳ 触发速率限制，等 ${wait / 1000}s 后自动重试（第 ${attempt + 1}/${RATE_LIMIT_BACKOFFS.length} 次） · 主进程已自动加大 ${modelSpec.split(':')[0]} 间隔`)
      await new Promise(r => setTimeout(r, wait))
    } finally {
      cleanup()
    }
  }
  throw lastErr || new Error('AI 调用失败（未知）')
}

// === Fitness mini-bar ===
function FitnessBar({ fitness, defaultExpanded }: { fitness: PersonaFitness; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(!!defaultExpanded)
  const color =
    fitness.total >= 80 ? 'var(--success)' :
    fitness.total >= 60 ? 'var(--warning)' : 'var(--danger)'
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--bg-warm)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>拟合度</div>
        <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${fitness.total}%`, height: '100%', background: color, transition: 'width 0.3s' }} />
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color, minWidth: 40, textAlign: 'right' }}>{fitness.total}%</div>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{expanded ? '收起' : '展开'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 4, columnGap: 10, marginBottom: 8 }}>
            {([
              ['核心思想',       fitness.breakdown.coreThought,           20],
              ['生平时代锚定',    fitness.breakdown.biographicalAnchor,    20],
              ['世界观广度',     fitness.breakdown.worldviewBreadth,      20],
              ['语言风格线索',    fitness.breakdown.languageStyle,         15],
              ['边界诚实',       fitness.breakdown.epistemicHonesty,      10],
              ['用户材料契合',    fitness.breakdown.userMaterialAlignment, 15],
            ] as Array<[string, number, number]>).map(([label, score, max]) => {
              const ratio = score / max
              const color = ratio >= 0.75 ? 'var(--success)' : ratio >= 0.5 ? 'var(--warning)' : 'var(--danger)'
              return (
                <Fragment key={label}>
                  <span>{label}</span>
                  <span style={{ fontFamily: 'monospace', color }}>{score} / {max}</span>
                </Fragment>
              )
            })}
          </div>
          {fitness.notes.length > 0 && (
            <div style={{ marginTop: 8, padding: '6px 8px', background: 'var(--bg)', borderRadius: 4, fontSize: 10, lineHeight: 1.6 }}>
              {fitness.notes.map((n, i) => <div key={i} style={{ marginBottom: 4 }}>{n}</div>)}
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text-muted)' }}>
            {new Date(fitness.evaluatedAt).toLocaleString('zh-CN')} · {fitness.model}
          </div>
        </div>
      )}
    </div>
  )
}

// === Source candidate row (with checkbox + open + remove) ===
function SourceRow({
  source, checked, onToggle, onRemove,
}: {
  source: PersonaSource
  checked: boolean
  onToggle: () => void
  onRemove: () => void
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '8px 10px', marginBottom: 6, borderRadius: 6,
      background: checked ? 'var(--accent-soft)' : 'var(--bg-warm)',
      border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-light)'}`,
      transition: 'background 0.15s, border-color 0.15s',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginTop: 3, flexShrink: 0, cursor: 'pointer' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{
            fontSize: 9, padding: '1px 6px', borderRadius: 3,
            background: SOURCE_COLOR[source.source], color: '#fff', flexShrink: 0,
          }}>{SOURCE_LABEL[source.source]}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {source.title}
          </span>
        </div>
        {source.snippet && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 4 }}>
            {source.snippet}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, fontSize: 10 }}>
          {source.url && !source.url.startsWith('data:') && (
            <button
              onClick={e => { e.stopPropagation(); window.electronAPI.nuwaOpenUrl?.(source.url) }}
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
            >打开原文</button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onRemove() }}
            style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 0 }}
          >删除此条</button>
        </div>
      </div>
    </div>
  )
}

// ===== Main =====
export default function PersonasTab() {
  const { selectedAiModel } = useUiStore()
  const [list, setList] = useState<Array<{ id: string; name: string; canonicalName?: string; identity?: string; updatedAt: string; currentFitnessTotal?: number }>>([])
  const [current, setCurrent] = useState<Persona | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState('')

  // Search stage state
  const [candidates, setCandidates] = useState<PersonaSource[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Disambig stage state
  const [identities, setIdentities] = useState<PersonaCandidateIdentity[]>([])

  // Refine stage state (preview before commit) — legacy path
  const [refineDraft, setRefineDraft] = useState<{ content: string; fitness?: PersonaFitness; changeNote: string; sourcesUsedIds: string[] } | null>(null)

  // Distillation flow state
  // activeDimension = which dimension's detail is shown on the right rail
  // (also the dimension being distilled when stage==='distilling').
  const [activeDimension, setActiveDimension] = useState<PersonaDimensionKey | null>(null)

  // Summon dialog state — a lightweight in-tab chat with the distilled persona
  // (AgentPanel will later get its own summon entry; this inline dialog is the
  // MVP affordance so the distillation flow is useful the moment it finishes).
  const [summonSystemPrompt, setSummonSystemPrompt] = useState('')
  // Wave-3: each message tracks the chunks injected at send-time + the
  // citations parsed from the response. Lets the UI show "📚 引用：" cards
  // for what was actually cited (and flag hallucinated [资料 N] numbers).
  const [summonMessages, setSummonMessages] = useState<Array<{
    role: 'user' | 'assistant'
    content: string
    injectedChunks?: InjectedChunk[]   // on user msg: what RAG injected for this query
    citations?: ParsedCitation[]        // on assistant msg: parsed back from response
    retrievalMode?: 'embedding' | 'bm25' | 'empty'
    totalChunks?: number
  }>>([])
  const [summonInput, setSummonInput] = useState('')
  const [summonBusy, setSummonBusy] = useState(false)
  const [summonStreaming, setSummonStreaming] = useState('')
  // Phase B: chunks available for BM25 retrieval on this persona. Populated on
  // handleOpenSummon; shown as a small badge so the user can see whether RAG is
  // actually backing the dialog or they're chatting with the bare skill body.
  const [summonRagInfo, setSummonRagInfo] = useState<{ totalChunks: number; hydratedSources: number } | null>(null)

  // Importing flag (while user picks file + main process parses)
  const [importing, setImporting] = useState(false)

  // Batch-run state for 一键蒸馏 / 一键优化 / 一键重新蒸馏
  const [batchRunning, setBatchRunning] = useState<null | { mode: 'distill-pending' | 'optimize-done' | 'rerun-all'; doneIdx: number; totalIdx: number; currentKey: PersonaDimensionKey | null }>(null)
  const batchAbortRef = useRef(false)

  // Auto-refine iteration progress (for the current dim being distilled).
  // Null = no iteration in flight; {iter, fitness, maxIter} = current state.
  const [refineProgress, setRefineProgress] = useState<null | { iter: number; fitness: number; maxIter: number; phase: 'distill' | 'optimize' | 'evaluate' }>(null)

  // Source-pool management state (visible in distill-paused stage)
  const [sourcePoolExpanded, setSourcePoolExpanded] = useState(false)
  const [webSearching, setWebSearching] = useState(false)

  // AI 自主迭代调研：dzhng 递归减半 + STORM Question→Query 两层。
  // null = 未运行；否则展示当前轮次/阶段/累计新增数。
  const [deepResearching, setDeepResearching] = useState<null | {
    round: number
    maxRounds: number
    phase: 'planning' | 'querying' | 'searching' | 'done' | 'error'
    message: string
    newSources: number
    dedupedSources: number
  }>(null)
  const deepResearchAbortRef = useRef(false)

  // Phase A: semantic-index build state for the current persona.
  // ragStatus — last-fetched status for current.id (null = not fetched yet for this persona)
  // ragBuildProgress — live progress frames during build (phase + done/total)
  const [ragStatus, setRagStatus] = useState<null | {
    exists: boolean
    provider?: string
    model?: string
    dim?: number
    chunks?: number
    builtAt?: string
    needsRebuild?: boolean
    fingerprintMismatch?: boolean
  }>(null)
  const [ragBuildProgress, setRagBuildProgress] = useState<null | {
    phase: 'chunk' | 'embed' | 'save' | 'done' | 'error'
    done?: number
    total?: number
    message?: string
  }>(null)

  // User ingest state
  const [ingestType, setIngestType] = useState<'text' | 'url' | 'file'>('text')
  const [ingestText, setIngestText] = useState('')
  const [ingestUrl, setIngestUrl] = useState('')
  const [ingestExpanded, setIngestExpanded] = useState(false)

  const loadListRef = useRef<() => void>(() => {})

  // Load list on mount
  const loadList = useCallback(async () => {
    if (!window.electronAPI?.personaList) return
    const r = await window.electronAPI.personaList()
    if (r.success) setList(r.entries)
  }, [])
  loadListRef.current = loadList
  useEffect(() => { loadList() }, [loadList])

  // Helper: fetch full content for selected sources in parallel
  const hydrateSelectedSources = useCallback(async (sources: PersonaSource[]): Promise<PersonaSource[]> => {
    const selected = sources.filter(s => selectedIds.has(s.id))
    const hydrated = await Promise.all(selected.map(async s => {
      if (s.fullContent) return s
      try {
        const r = await window.electronAPI.nuwaFetchPage?.(s)
        if (r?.success && r.fullContent) {
          return { ...s, fullContent: r.fullContent, fetchedAt: new Date().toISOString() }
        }
      } catch { /* ignore */ }
      return s
    }))
    return hydrated
  }, [selectedIds])

  // === Step 1: Search + auto-disambig ===
  // The old flow made the user do picking-sources (prune the search results)
  // BEFORE disambig — but they have no basis to decide which sources match the
  // person they meant when they haven't even confirmed who it is yet. New flow:
  //   1. Search (snippets only, no fetch of full content — context can't blow up)
  //   2. Auto-fire disambig on the snippets
  //   3. If 1 candidate with confidence ≥ 60 → skip picking-identity, dive
  //      straight into distillation. All searched sources join the pool; user
  //      manages them in the distilling stage (the one place for source mgmt).
  //   4. If multiple plausible candidates → picking-identity to let user choose.
  //   5. If disambig fails outright → auto-fall back to using nameInput as a
  //      basic identity so user isn't stuck.
  const handleSearch = useCallback(async () => {
    if (!nameInput.trim() || stage === 'searching' || stage === 'disambigging') return
    setErrorMsg(null)
    setStage('searching')
    try {
      const r = await window.electronAPI.nuwaSearch?.(nameInput.trim())
      if (!r?.success) throw new Error(r?.error || '搜索失败')
      if (r.sources.length === 0) {
        setErrorMsg('没找到任何资料。可能姓名拼写不准，或该人物在公开网络上资料很少。你可以试试投喂自己的材料。')
        setStage('idle')
        return
      }
      // Hold all search results as initial source pool candidates. User will
      // manage them post-distill-entry (add/remove/web-research more).
      setCandidates(r.sources)
      setSelectedIds(new Set(r.sources.map(s => s.id)))

      // Immediately auto-disambig using snippets only (no hydrate → no context
      // bloat). Most clear names ("黑格尔", "马斯克", "Paul Graham") will return
      // exactly one high-confidence candidate and we'll fast-path into distill.
      setStage('disambigging')
      try {
        const resp = await callPersonaAi(
          selectedAiModel,
          PERSONA_DISAMBIG_SYSTEM_PROMPT,
          buildDisambigUserMessage(nameInput.trim(), r.sources),
          { webSearch: false },
        )
        const parsed = parseDisambig(resp)
        if (!parsed || !parsed.candidates || parsed.candidates.length === 0) {
          // Disambig bombed — fall back: use user input as canonical name,
          // all sources go into the pool, user can manually edit later.
          const fallback: PersonaCandidateIdentity = {
            canonicalName: nameInput.trim(),
            identity: '',
            basedOnSourceIds: r.sources.map(s => s.id),
            confidence: 40,
          }
          await handleStartDistillation(fallback)
          return
        }
        // Fast-path: single unambiguous candidate → skip picking-identity
        const top = parsed.candidates[0]
        if (parsed.candidates.length === 1 && top.confidence >= 60) {
          await handleStartDistillation(top)
          return
        }
        // Otherwise show candidates and let user pick
        setIdentities(parsed.candidates)
        setStage('picking-identity')
      } catch (err: any) {
        // Same fallback as malformed response — keep going, don't force user
        // to manually intervene for a model hiccup
        const fallback: PersonaCandidateIdentity = {
          canonicalName: nameInput.trim(),
          identity: '',
          basedOnSourceIds: r.sources.map(s => s.id),
          confidence: 30,
        }
        setErrorMsg(`AI 识别身份出问题：${err.message}。已按你输入的姓名直接进蒸馏，你可以在蒸馏阶段随时改资料池。`)
        await handleStartDistillation(fallback)
      }
    } catch (err: any) {
      setErrorMsg(err.message || '搜索出错')
      setStage('idle')
    }
  }, [nameInput, stage, selectedAiModel])

  // Legacy handleDisambig — kept for the (now rarely-reached) picking-sources
  // path. Only triggered if user somehow lands in picking-sources stage via
  // a refine-style entry; the new main flow (handleSearch) does its own
  // disambig inline and skips this step entirely.
  const handleDisambig = useCallback(async () => {
    if (selectedIds.size === 0) {
      setErrorMsg('至少选一条参考资料')
      return
    }
    setErrorMsg(null)
    setStage('disambigging')
    try {
      // Use snippets only — no hydrate — to keep disambig context small.
      const snippetSources = candidates.filter(s => selectedIds.has(s.id))
      const resp = await callPersonaAi(
        selectedAiModel,
        PERSONA_DISAMBIG_SYSTEM_PROMPT,
        buildDisambigUserMessage(nameInput.trim(), snippetSources),
        { webSearch: false },
      )
      const parsed = parseDisambig(resp)
      if (!parsed || !parsed.candidates || parsed.candidates.length === 0) {
        throw new Error('AI 没返回可识别的身份。请重新选资料或换模型。')
      }
      setIdentities(parsed.candidates)
      setStage('picking-identity')
    } catch (err: any) {
      setErrorMsg(`${err.message}  —— 或点下方「手动输入身份」直接进入蒸馏。`)
      setStage('picking-sources')
    }
  }, [candidates, selectedIds, nameInput, selectedAiModel])

  // Fallback when disambig fails — user types canonical name + a one-line
  // identity, then we enter distillation directly without an AI identity step.
  // Uses all currently-selected sources as the seed source pool.
  // Not wrapped in useCallback — it's a rarely-hit path and forward-references
  // handleStartDistillation (which appears later in this component).
  const handleManualIdentity = async () => {
    if (selectedIds.size === 0) { setErrorMsg('至少选一条参考资料再手动输入身份'); return }
    const cName = window.prompt('规范名\n（例：卡尔·马克思 / 埃隆·马斯克 / 黑格尔）', nameInput.trim())
    if (!cName || !cName.trim()) return
    const ident = window.prompt(
      '一句话身份（≤ 30 字，告诉 AI 这人是谁）\n（例：19 世纪德国哲学家、政治经济学家 / SpaceX 和 Tesla 创始人）',
      '',
    )
    if (ident === null) return  // user cancelled; empty string is OK (AI will infer)
    const manualId: PersonaCandidateIdentity = {
      canonicalName: cName.trim(),
      identity: ident.trim(),
      lifespan: undefined,
      basedOnSourceIds: Array.from(selectedIds),
      confidence: 50,
    }
    setErrorMsg(null)
    await handleStartDistillation(manualId)
  }

  // === Step 3: Generate initial ===
  const handleGenerate = useCallback(async (identity: PersonaCandidateIdentity) => {
    setErrorMsg(null)
    setStage('generating')
    setStreamingText('')
    try {
      const usedSources = candidates.filter(s => identity.basedOnSourceIds.includes(s.id) || selectedIds.has(s.id))
      const genText = await callPersonaAi(
        selectedAiModel,
        PERSONA_GENERATE_SYSTEM_PROMPT,
        buildGenerateUserMessage(identity.canonicalName, identity.identity, usedSources),
        {
          webSearch: true,  // let AI web-search too (native or manual loop per provider)
          onChunk: (t) => setStreamingText(t),
        },
      )
      // Evaluate fitness (separate AI call)
      const evalText = await callPersonaAi(
        selectedAiModel,
        PERSONA_EVALUATE_SYSTEM_PROMPT,
        buildEvaluateUserMessage(identity.canonicalName, genText, usedSources, false),
        { webSearch: false },
      )
      const fitness = parseFitness(evalText)
      if (fitness) fitness.model = selectedAiModel

      const now = new Date().toISOString()
      const version: PersonaVersion = {
        content: genText,
        generatedAt: now,
        model: selectedAiModel,
        fitness: fitness || undefined,
        changeNote: '初版',
        sourcesUsedIds: usedSources.map(s => s.id),
      }
      const persona: Persona = {
        id: uuid(),
        name: nameInput.trim(),
        canonicalName: identity.canonicalName,
        identity: identity.identity,
        // The legacy single-shot generate path still exists until the distillation
        // flow replaces it (phase 5). New personas created through this path are
        // marked skillMode='legacy' so the UI can later offer "upgrade to
        // distilled skill" without accidentally treating them as skill-capable.
        skillMode: 'legacy',
        content: genText,
        sourcesUsed: usedSources,
        versions: [version],
        currentFitness: fitness || undefined,
        createdAt: now,
        updatedAt: now,
      }
      await window.electronAPI.personaSave?.(persona)
      setCurrent(persona)
      setStage('viewing')
      setStreamingText('')
      await loadListRef.current()
    } catch (err: any) {
      setErrorMsg(err.message)
      setStage('picking-identity')
      setStreamingText('')
    }
  }, [candidates, selectedIds, nameInput, selectedAiModel])

  // =================================================================
  // === Distillation flow (new primary path) ===
  // =================================================================
  // When user picks an identity from the disambig step, we no longer kick off
  // a one-shot generate. Instead, we create a distilled-mode Persona with an
  // empty 6-dimension scaffold and land in the distill-intro stage, from
  // which the user runs each dimension in turn (or skips it).
  //
  // Per-dimension run = two AI calls: buildDistill* (generative, may web_search)
  // then PERSONA_EVALUATE_SYSTEM_PROMPT (pure eval, no web_search) with the
  // dimension-scoped user message (封顶 ≤ 55% while any dim still missing).
  //
  // After all dimensions are either done or skipped, the synthesize step folds
  // them into a PersonaSkillArtifact whose fullMarkdown is a drop-in SKILL.md
  // per alchaincyf/nuwa-skill layout.

  /** Hydrate + trust-tag all current.sourcesUsed for distill prompts. */
  const prepareDistillSources = useCallback(async (): Promise<PersonaSource[]> => {
    if (!current) return []
    return Promise.all(current.sourcesUsed.map(async s => {
      let full = s.fullContent
      if (!full && s.url && !s.url.startsWith('data:')) {
        try {
          const r = await window.electronAPI.nuwaFetchPage?.(s)
          if (r?.success && r.fullContent) full = r.fullContent
        } catch { /* ignore, fall through with snippet-only */ }
      }
      return { ...s, fullContent: full, trust: s.trust || defaultTrustForSource(s.source) }
    }))
  }, [current])

  // Start a distillation. Purely parameterized — takes identity + source pool
  // + original input name rather than reading state. This avoids stale closure
  // when handleSearch fires setCandidates + calls this in the same tick (React
  // state isn't updated yet).
  //
  // No sync hydrate here: snippets are enough for persona creation; full text
  // will be lazy-fetched per-dim by prepareDistillSources / runDimensionForPersona.
  // User sees distill-paused stage immediately (no 30s wait for 13 sources to
  // each fetch their full content).
  const handleStartDistillation = async (
    identity: PersonaCandidateIdentity,
    sourcePool?: PersonaSource[],     // if omitted, reads from candidates state
    originalInputName?: string,        // if omitted, reads from nameInput state
  ) => {
    setErrorMsg(null)
    try {
      const pool = sourcePool ?? candidates
      const inputName = originalInputName ?? nameInput.trim()
      // Include sources the AI tied to this identity, plus any explicit user
      // selections. If basedOnSourceIds is empty (fallback path with no AI
      // verdict), use the entire pool.
      let usedSources = pool.filter(s =>
        identity.basedOnSourceIds.includes(s.id) || selectedIds.has(s.id))
      if (usedSources.length === 0) usedSources = pool
      usedSources = usedSources.map(s => ({
        ...s,
        trust: s.trust || defaultTrustForSource(s.source),
      }))

      const now = new Date().toISOString()
      const persona: Persona = {
        id: uuid(),
        name: inputName,
        canonicalName: identity.canonicalName,
        identity: identity.identity,
        skillMode: 'distilled',
        content: '',   // will mirror skill.fullMarkdown once synthesized
        sourcesUsed: usedSources,
        versions: [],
        distillation: createEmptyDistillation(),
        createdAt: now,
        updatedAt: now,
      }
      await window.electronAPI.personaSave?.(persona)
      setCurrent(persona)
      setCandidates(usedSources)       // sync UI state so 资料池 shows same sources
      setActiveDimension(null)
      setStage('distill-paused')
      await loadListRef.current()
    } catch (err: any) {
      setErrorMsg(err.message)
    }
  }

  // Core dimension runner. Takes a Persona snapshot + key + mode, returns an
  // updated Persona (or the original w/ 'error' status marked). **Does not
  // touch React state** — caller wires setCurrent / setStage / save. This
  // separation lets handleRunBatch chain sequential runs with a local persona
  // variable (avoids the stale-closure trap where for-loop reads an
  // old `current` after setCurrent has fired).
  //
  // Mode:
  //   - 'distill':  fresh generation (ignores any existing dim.content)
  //   - 'optimize': incremental improvement on dim.content (noop if empty)
  const runDimensionForPersona = useCallback(async (
    p: Persona,
    key: PersonaDimensionKey,
    mode: 'distill' | 'optimize',
    onStream?: (t: string) => void,
  ): Promise<Persona> => {
    if (!p.distillation) return p
    const existingContent = p.distillation.dimensions[key]?.content || ''
    const effectiveMode = mode === 'optimize' && existingContent ? 'optimize' : 'distill'

    // Hydrate + tag sources
    const sources: PersonaSource[] = await Promise.all(p.sourcesUsed.map(async s => {
      let full = s.fullContent
      if (!full && s.url && !s.url.startsWith('data:')) {
        try {
          const r = await window.electronAPI.nuwaFetchPage?.(s)
          if (r?.success && r.fullContent) full = r.fullContent
        } catch { /* ignore */ }
      }
      return { ...s, fullContent: full, trust: s.trust || defaultTrustForSource(s.source) }
    }))

    const canonical = p.canonicalName || p.name
    const identity = p.identity || ''

    const systemPrompt = effectiveMode === 'optimize'
      ? buildOptimizeDimensionSystemPrompt(key, canonical)
      : buildDistillSystemPrompt(key, canonical)
    const userMsg = effectiveMode === 'optimize'
      ? buildOptimizeDimensionUserMessage(key, canonical, identity, existingContent, sources)
      : buildDistillUserMessage(key, canonical, identity, sources)

    try {
      const content = await callPersonaAi(selectedAiModel, systemPrompt, userMsg, {
        webSearch: true,
        onChunk: onStream,
      })

      // Evaluate
      const hasUserMat = sources.some(s => s.source.startsWith('user-'))
      const evalText = await callPersonaAi(
        selectedAiModel,
        PERSONA_EVALUATE_SYSTEM_PROMPT,
        buildEvaluateDimensionUserMessage(canonical, key, content, sources, hasUserMat),
        { webSearch: false },
      )
      const fitness = parseFitness(evalText)
      if (fitness) { fitness.model = selectedAiModel; fitness.scope = 'dimension' }

      const now = new Date().toISOString()
      const doneDim: PersonaDimension = {
        key, status: 'done', content,
        sourcesUsedIds: sources.map(s => s.id),
        fitness: fitness || undefined,
        distilledAt: now,
        model: selectedAiModel,
      }
      const updated: Persona = {
        ...p,
        distillation: {
          ...p.distillation,
          dimensions: { ...p.distillation.dimensions, [key]: doneDim },
        },
        updatedAt: now,
      }
      await window.electronAPI.personaSave?.(updated)
      return updated
    } catch (err: any) {
      const now = new Date().toISOString()
      const errDim: PersonaDimension = {
        ...p.distillation.dimensions[key],
        status: 'error',
        errorMsg: err.message,
      }
      const updated: Persona = {
        ...p,
        distillation: {
          ...p.distillation,
          dimensions: { ...p.distillation.dimensions, [key]: errDim },
        },
        updatedAt: now,
      }
      await window.electronAPI.personaSave?.(updated).catch(() => {})
      throw Object.assign(err, { updatedPersona: updated })
    }
  }, [selectedAiModel])

  // Auto-refine loop: for a given dim, run initial distill (or optimize if
  // content already exists), then iteratively call optimize until one of:
  //   - fitness ≥ threshold  (default 55%, since single-dim hard cap is 55)
  //   - iteration count hits maxIter (default 4)
  //   - fitness improvement between iters < plateauDelta (default 3 points)
  //   - batchAbortRef is set (user pressed 中止)
  //
  // Per user directive: "蒸馏不在乎时间 为了效果可以进行很久（30分钟）".
  // One iteration is 2 AI calls (distill/optimize + evaluate), typically 30s-3min.
  // 4 iters × 2 calls = ~8 AI calls × 6 dimensions for a full persona. Matches
  // the 30-minute budget while allowing fitness to climb from Wiki-snippet level
  // (~18%) toward the single-dim ceiling (~40-55% with good user-provided sources).
  const runDimensionWithAutoRefine = useCallback(async (
    p: Persona,
    key: PersonaDimensionKey,
    opts?: {
      maxIter?: number           // default 4
      threshold?: number         // default 55 — stop if reach this
      plateauDelta?: number      // default 3 — stop if improvement less than this
      onStream?: (t: string) => void
      onIter?: (iter: number, fitness: number, phase: 'distill' | 'optimize' | 'evaluate') => void
    },
  ): Promise<Persona> => {
    const maxIter = opts?.maxIter ?? 4
    const threshold = opts?.threshold ?? 55
    const plateauDelta = opts?.plateauDelta ?? 3

    const existingContent = p.distillation?.dimensions[key]?.content || ''
    const startMode: 'distill' | 'optimize' = existingContent ? 'optimize' : 'distill'

    opts?.onIter?.(0, 0, startMode)
    let persona = await runDimensionForPersona(p, key, startMode, opts?.onStream)
    let prevFitness = persona.distillation?.dimensions[key].fitness?.total ?? 0
    opts?.onIter?.(0, prevFitness, 'evaluate')

    for (let i = 1; i <= maxIter; i++) {
      if (batchAbortRef.current) break
      if (prevFitness >= threshold) break

      opts?.onIter?.(i, prevFitness, 'optimize')
      let next: Persona
      try {
        next = await runDimensionForPersona(persona, key, 'optimize', opts?.onStream)
      } catch (err: any) {
        // optimize threw; return best so far rather than losing it
        if (err.updatedPersona) persona = err.updatedPersona
        throw err
      }
      const newFitness = next.distillation?.dimensions[key].fitness?.total ?? 0
      opts?.onIter?.(i, newFitness, 'evaluate')

      // Always accept the latest iteration's content (not worse-off since
      // optimize prompt forbids shrinking) even if fitness plateaued — the
      // optimize step may have added concrete details that didn't affect the
      // evaluator's score but still helps the user.
      persona = next

      // Plateau detection: next iteration probably won't help
      if (newFitness <= prevFitness + plateauDelta) break
      prevFitness = newFitness
    }

    return persona
  }, [runDimensionForPersona])

  // Thin wrapper: single-dimension distill from UI click, wires React state.
  // Uses auto-refine so every click gets multi-pass improvement (per user
  // directive "蒸馏不在乎时间 · 内部再优化一层层增加拟合度"). maxIter=3 keeps
  // single-dim run under ~10min for a typical GLM-5.1 pace.
  const handleRunDimension = useCallback(async (key: PersonaDimensionKey) => {
    if (!current || !current.distillation) return
    setErrorMsg(null)
    setActiveDimension(key)
    setStreamingText('')
    setStage('distilling')
    setRefineProgress(null)
    // immediate-feedback running marker
    const runningSnapshot: Persona = {
      ...current,
      distillation: {
        ...current.distillation,
        dimensions: {
          ...current.distillation.dimensions,
          [key]: { ...current.distillation.dimensions[key], status: 'running' },
        },
      },
    }
    setCurrent(runningSnapshot)
    try {
      const updated = await runDimensionWithAutoRefine(runningSnapshot, key, {
        maxIter: 3, threshold: 55, plateauDelta: 3,
        onStream: setStreamingText,
        onIter: (iter, fit, phase) => setRefineProgress({ iter, fitness: fit, maxIter: 3, phase }),
      })
      setCurrent(updated)
      setStage('distill-paused')
      setStreamingText('')
      setRefineProgress(null)
      await loadListRef.current()
    } catch (err: any) {
      if (err.updatedPersona) setCurrent(err.updatedPersona)
      setErrorMsg(err.message)
      setStage('distill-paused')
      setStreamingText('')
      setRefineProgress(null)
    }
  }, [current, runDimensionWithAutoRefine])

  // Single-dimension optimize — same wiring, different mode.
  const handleOptimizeDimension = useCallback(async (key: PersonaDimensionKey) => {
    if (!current || !current.distillation) return
    const existing = current.distillation.dimensions[key]?.content
    if (!existing) {
      setErrorMsg('这一维还没有基础版本可优化，先跑一次蒸馏')
      return
    }
    setErrorMsg(null)
    setActiveDimension(key)
    setStreamingText('')
    setStage('distilling')
    const runningSnapshot: Persona = {
      ...current,
      distillation: {
        ...current.distillation,
        dimensions: {
          ...current.distillation.dimensions,
          [key]: { ...current.distillation.dimensions[key], status: 'running' },
        },
      },
    }
    setCurrent(runningSnapshot)
    try {
      const updated = await runDimensionForPersona(runningSnapshot, key, 'optimize', setStreamingText)
      setCurrent(updated)
      setStage('distill-paused')
      setStreamingText('')
      await loadListRef.current()
    } catch (err: any) {
      if (err.updatedPersona) setCurrent(err.updatedPersona)
      setErrorMsg(err.message)
      setStage('distill-paused')
      setStreamingText('')
    }
  }, [current, runDimensionForPersona])

  // Batch runner — sequentially process all matching dimensions. Uses a local
  // persona variable so setCurrent race conditions can't miss an update.
  // Modes:
  //   - 'distill-pending': fresh distill on every pending / error / skipped dim
  //   - 'optimize-done':   optimize on every done dim
  //   - 'rerun-all':       fresh distill on every dim regardless of status
  const handleRunBatch = useCallback(async (mode: 'distill-pending' | 'optimize-done' | 'rerun-all') => {
    if (!current || !current.distillation || batchRunning) return
    const allKeys = PERSONA_DIMENSIONS.map(d => d.key)
    const targetKeys = allKeys.filter(k => {
      const st = current.distillation!.dimensions[k].status
      if (mode === 'distill-pending') return st === 'pending' || st === 'error' || st === 'skipped'
      if (mode === 'optimize-done')   return st === 'done'
      return true  // rerun-all
    })
    if (targetKeys.length === 0) {
      setErrorMsg(mode === 'optimize-done' ? '还没有已完成的维度可优化' : '没有待处理的维度')
      return
    }

    setErrorMsg(null)
    batchAbortRef.current = false
    setBatchRunning({ mode, doneIdx: 0, totalIdx: targetKeys.length, currentKey: targetKeys[0] })
    setStage('distilling')

    let localPersona: Persona = current
    for (let i = 0; i < targetKeys.length; i++) {
      if (batchAbortRef.current) break
      const key = targetKeys[i]
      setBatchRunning({ mode, doneIdx: i, totalIdx: targetKeys.length, currentKey: key })
      setActiveDimension(key)
      setStreamingText('')

      // mark running in UI snapshot
      const runningSnapshot: Persona = {
        ...localPersona,
        distillation: {
          ...localPersona.distillation!,
          dimensions: {
            ...localPersona.distillation!.dimensions,
            [key]: { ...localPersona.distillation!.dimensions[key], status: 'running' },
          },
        },
      }
      setCurrent(runningSnapshot)

      try {
        // Each dim in a batch runs 2 auto-refine iterations — a compromise
        // between per-dim quality and total batch duration (6 dims × ~2 iters
        // × ~3 min ≈ 36 min, in the "30 minute is fine" range user specified).
        // For full depth on a single dim, user clicks it directly (maxIter=3).
        if (mode === 'optimize-done') {
          // optimize-done batch: just one optimize pass per dim, not auto-refine
          // (auto-refine starts with optimize in this case, so maxIter=1 works)
          localPersona = await runDimensionWithAutoRefine(runningSnapshot, key, {
            maxIter: 1, threshold: 60, plateauDelta: 3,
            onStream: setStreamingText,
            onIter: (iter, fit, phase) => setRefineProgress({ iter, fitness: fit, maxIter: 1, phase }),
          })
        } else {
          localPersona = await runDimensionWithAutoRefine(runningSnapshot, key, {
            maxIter: 2, threshold: 55, plateauDelta: 3,
            onStream: setStreamingText,
            onIter: (iter, fit, phase) => setRefineProgress({ iter, fitness: fit, maxIter: 2, phase }),
          })
        }
        setCurrent(localPersona)
      } catch (err: any) {
        if (err.updatedPersona) { localPersona = err.updatedPersona; setCurrent(localPersona) }
        setErrorMsg(`维度 ${key} 失败：${err.message}（已继续下一维）`)
        // Fall through to next dimension rather than aborting the whole batch.
      }

      // (Per-provider throttling now lives in 主进程 aiThrottle — every AI HTTP
      //  call (chat / embed / web-search-pro) goes through that single chokepoint.
      //  Adding sleeps here would only stack on top of the queue.)
    }

    setBatchRunning(null)
    setStreamingText('')
    setStage('distill-paused')
    await loadListRef.current()
  }, [current, batchRunning, runDimensionForPersona])

  const handleAbortBatch = useCallback(() => {
    batchAbortRef.current = true
  }, [])

  // Per-dimension / bulk ingest: attach one or more user-provided files to
  // the persona's source pool. Files join the shared pool — they're not tagged
  // as exclusive to any dim. Next 重跑 / 优化 / 一键 on any dim picks them up.
  //
  // The dimKey arg is only used for the error message context ("你为时间线加
  // 了 3 个文件") — no behavioral tagging. Pass null for bulk import.
  const handleIngestFiles = useCallback(async (files: FileList | File[]) => {
    if (!current) return
    const fileArr = Array.from(files)
    if (fileArr.length === 0) return
    const newSources: PersonaSource[] = []
    const failed: string[] = []
    for (const file of fileArr) {
      try {
        const text = await file.text()
        if (!text.trim()) { failed.push(`${file.name}（空文件）`); continue }
        newSources.push({
          id: uuid(),
          title: file.name,
          snippet: text.slice(0, 200),
          url: '',
          source: 'user-file',
          fullContent: text.slice(0, 20000),
          fetchedAt: new Date().toISOString(),
          trust: 'primary',
        })
      } catch (err: any) {
        failed.push(`${file.name}（${err.message}）`)
      }
    }
    if (newSources.length === 0) {
      alert(`所有文件读取失败：${failed.join('、')}`)
      return
    }
    const updated: Persona = {
      ...current,
      sourcesUsed: [...current.sourcesUsed, ...newSources],
      updatedAt: new Date().toISOString(),
    }
    await window.electronAPI.personaSave?.(updated)
    setCurrent(updated)
    setSourcePoolExpanded(true)
    setErrorMsg(null)
    if (failed.length > 0) {
      alert(`✅ ${newSources.length} 个文件已加入资料池\n\n⚠️ 另有 ${failed.length} 个失败：${failed.slice(0, 3).join('、')}`)
    } else {
      alert(`✅ ${newSources.length} 个文件已加入资料池`)
    }
  }, [current])

  // Kept for the per-dim row + button — thin wrapper that defers to bulk ingest.
  const handleIngestForDimension = useCallback(async (_key: PersonaDimensionKey, files: FileList | File[]) => {
    await handleIngestFiles(files)
  }, [handleIngestFiles])

  // Pick files in-library (拾卷 library entries that have OCR text) and attach
  // their OCR content as user-file sources. This is the killer move for social-
  // science personas: if the user already has Hegel / Foucault / Marx PDFs
  // imported and OCR'd in their library, those become top-tier primary sources.
  // absPath is what the OCR IPC keys off of — can't use entryId directly.
  const [libPicker, setLibPicker] = useState<{
    open: boolean
    entries: Array<{ id: string; absPath: string; title: string; authors: string[]; hasOcr: boolean; selected: boolean }>
  }>({ open: false, entries: [] })

  const handleOpenLibraryPicker = useCallback(async () => {
    if (!current) return
    setErrorMsg(null)
    try {
      const lib = await window.electronAPI.loadLibrary?.()
      if (!lib) { setErrorMsg('无法读取拾卷库'); return }
      // Default selection heuristic: pre-select entries whose title or author
      // mentions the persona's canonical name — saves a ton of clicking for
      // users who have many books in their library.
      const nameHint = (current.canonicalName || current.name).trim()
      const entries = (lib.entries || [])
        .map(e => {
          const hasOcr = e.ocrStatus === 'complete' || e.ocrStatus === 'partial'
          const titleMatches = nameHint && e.title && e.title.includes(nameHint)
          const authorMatches = nameHint && Array.isArray(e.authors) && e.authors.some((a: string) => a.includes(nameHint))
          return {
            id: e.id,
            absPath: e.absPath,
            title: e.title || '(无标题)',
            authors: e.authors || [],
            hasOcr,
            selected: hasOcr && (titleMatches || authorMatches),
          }
        })
        // Only offer entries with OCR available — others give no text
        .filter(e => e.hasOcr)
      if (entries.length === 0) {
        setErrorMsg('拾卷库里还没有 OCR 过的文献——先导入 PDF 并 OCR 后再来')
        return
      }
      setLibPicker({ open: true, entries })
    } catch (err: any) {
      setErrorMsg(err.message)
    }
  }, [current])

  // Remove a source from the pool (can't undo — but source.url visit works if
  // user regrets and wants the info back).
  const handleRemoveSource = useCallback(async (sourceId: string) => {
    if (!current) return
    const updated: Persona = {
      ...current,
      sourcesUsed: current.sourcesUsed.filter(s => s.id !== sourceId),
      updatedAt: new Date().toISOString(),
    }
    await window.electronAPI.personaSave?.(updated)
    setCurrent(updated)
  }, [current])

  // Re-run multi-source web search during distillation. User can add more
  // seed material (especially new Archive.org / Gutenberg hits) without going
  // back to picking-sources. Prompt uses custom query input so user can
  // search for specific chapters / themes, not just the person's name.
  const handleSearchMoreSources = useCallback(async () => {
    if (!current || webSearching) return
    const name = current.canonicalName || current.name
    // Default is empty — force user to enter a **specific topic**. Searching
    // just the name again hits the exact same 6-source pipeline and gets
    // 100% deduped against existing pool. The value of re-search is finding
    // deeper material on a specific angle.
    const q = window.prompt(
      `再次联网搜索——请输入具体主题 / 章节 / 时段（**不要只搜人名**，会重复）\n\n有效搜索示例：\n  "${name} 辩证法 原文"\n  "${name} 对康德的批评"\n  "${name} 晚年访谈"\n  "${name} 1820 柏林"\n\n搜什么：`,
      '',
    )
    if (!q || !q.trim()) return
    setWebSearching(true)
    setErrorMsg(null)
    try {
      const r = await window.electronAPI.nuwaSearch?.(q.trim())
      if (!r?.success) {
        alert(`搜索失败：${r?.error || '未知原因'}`)
        return
      }
      if (r.sources.length === 0) {
        alert('没找到任何结果——换个关键词试试')
        return
      }
      // Skip sources whose URL we already have
      const existingUrls = new Set(current.sourcesUsed.map(s => s.url))
      const fresh = r.sources.filter(s => s.url && !existingUrls.has(s.url))
      if (fresh.length === 0) {
        alert(`搜到 ${r.sources.length} 条，但全部已在资料池里——换个更具体的关键词`)
        return
      }
      const tagged = fresh.map(s => ({ ...s, trust: s.trust || defaultTrustForSource(s.source) }))
      const updated: Persona = {
        ...current,
        sourcesUsed: [...current.sourcesUsed, ...tagged],
        updatedAt: new Date().toISOString(),
      }
      await window.electronAPI.personaSave?.(updated)
      setCurrent(updated)
      setSourcePoolExpanded(true)
      alert(`✅ 已加入 ${tagged.length} 条新资料${r.sources.length - fresh.length > 0 ? `（${r.sources.length - fresh.length} 条已存在，自动去重）` : ''}`)
    } catch (err: any) {
      alert(`搜索出错：${err.message}`)
    } finally {
      setWebSearching(false)
    }
  }, [current, webSearching])

  // AI 自主迭代调研 — dzhng/deep-research 的递归减半 + STORM 的 Q→Q 两层。
  //
  // 每轮 = planner（识别缺口）→ query-gen（变查询）→ search（拉资料 + 入池）。
  // breadth 减半收敛，避免越搜越发散。stopReason 出现就提前退出。
  const handleDeepResearch = useCallback(async () => {
    if (!current || deepResearching) return
    const MAX_ROUNDS = 2
    deepResearchAbortRef.current = false
    let working = current
    let totalNew = 0
    let totalDeduped = 0

    try {
      let breadth = 6
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        if (deepResearchAbortRef.current) break

        // ---- Phase 1: planning ----
        setDeepResearching({
          round, maxRounds: MAX_ROUNDS, phase: 'planning',
          message: `第 ${round} 轮：让 AI 看池子（${working.sourcesUsed.length} 条）找缺口…`,
          newSources: totalNew, dedupedSources: totalDeduped,
        })
        const plannerOut = await callPersonaAi(
          selectedAiModel,
          RESEARCH_PLANNER_SYSTEM,
          buildResearchPlannerUserMessage(working, working.sourcesUsed),
        )
        if (deepResearchAbortRef.current) break
        const { gaps, stopReason } = parsePlannerOutput(plannerOut)
        if (stopReason) {
          setDeepResearching({
            round, maxRounds: MAX_ROUNDS, phase: 'done',
            message: `✅ AI 判断：${stopReason}（共加 ${totalNew} 条，去重 ${totalDeduped}）`,
            newSources: totalNew, dedupedSources: totalDeduped,
          })
          break
        }
        if (gaps.length === 0) {
          setDeepResearching({
            round, maxRounds: MAX_ROUNDS, phase: 'done',
            message: `⚠️ AI 没识别出缺口（共加 ${totalNew} 条）`,
            newSources: totalNew, dedupedSources: totalDeduped,
          })
          break
        }

        const targetGaps = gaps.slice(0, breadth)

        // ---- Phase 2: query generation (parallel per gap) ----
        setDeepResearching({
          round, maxRounds: MAX_ROUNDS, phase: 'querying',
          message: `第 ${round} 轮：${targetGaps.length} 个缺口 → 生成搜索查询…`,
          newSources: totalNew, dedupedSources: totalDeduped,
        })
        const personName = working.canonicalName || working.name
        const queryResults = await Promise.all(targetGaps.map(async gap => {
          try {
            const out = await callPersonaAi(
              selectedAiModel,
              QUERY_GENERATOR_SYSTEM,
              buildQueryGeneratorUserMessage(personName, gap),
            )
            return parseQueriesOutput(out)
          } catch {
            return [] as string[]
          }
        }))
        if (deepResearchAbortRef.current) break
        const allQueries = Array.from(new Set(queryResults.flat())).slice(0, breadth * 2)
        if (allQueries.length === 0) {
          setDeepResearching({
            round, maxRounds: MAX_ROUNDS, phase: 'done',
            message: `⚠️ 这一轮没生成查询，结束`,
            newSources: totalNew, dedupedSources: totalDeduped,
          })
          break
        }

        // ---- Phase 3: searching (parallel per query) ----
        setDeepResearching({
          round, maxRounds: MAX_ROUNDS, phase: 'searching',
          message: `第 ${round} 轮：并发搜索 ${allQueries.length} 个查询…`,
          newSources: totalNew, dedupedSources: totalDeduped,
        })
        const searchResults = await Promise.all(allQueries.map(async q => {
          try {
            const r = await window.electronAPI.nuwaSearch?.(q)
            return r?.success ? r.sources : []
          } catch {
            return []
          }
        }))
        if (deepResearchAbortRef.current) break

        // Dedupe by URL against working pool + within this batch
        const existingUrls = new Set(working.sourcesUsed.map(s => s.url).filter(Boolean))
        const seenInBatch = new Set<string>()
        const fresh: PersonaSource[] = []
        let dupCount = 0
        for (const arr of searchResults) {
          for (const s of arr) {
            if (!s.url) continue
            if (existingUrls.has(s.url) || seenInBatch.has(s.url)) {
              dupCount++
              continue
            }
            seenInBatch.add(s.url)
            fresh.push({ ...s, trust: s.trust || defaultTrustForSource(s.source) })
          }
        }
        totalDeduped += dupCount

        if (fresh.length > 0) {
          working = {
            ...working,
            sourcesUsed: [...working.sourcesUsed, ...fresh],
            updatedAt: new Date().toISOString(),
          }
          await window.electronAPI.personaSave?.(working)
          setCurrent(working)
          totalNew += fresh.length
        }

        setDeepResearching({
          round, maxRounds: MAX_ROUNDS, phase: 'done',
          message: `第 ${round} 轮完成：+${fresh.length} 新资料（${dupCount} 去重）。累计新增 ${totalNew}。`,
          newSources: totalNew, dedupedSources: totalDeduped,
        })

        // halve breadth for next round (dzhng 收敛模式)
        breadth = Math.max(2, Math.floor(breadth / 2))
        // Early exit if a round produced nothing new — likely diminishing returns
        if (fresh.length === 0 && round < MAX_ROUNDS) {
          setDeepResearching({
            round, maxRounds: MAX_ROUNDS, phase: 'done',
            message: `第 ${round} 轮 0 新增，提前结束（共加 ${totalNew} 条）`,
            newSources: totalNew, dedupedSources: totalDeduped,
          })
          break
        }
      }

      setSourcePoolExpanded(true)
      setTimeout(() => setDeepResearching(null), 4000)
    } catch (err: any) {
      setDeepResearching({
        round: 0, maxRounds: MAX_ROUNDS, phase: 'error',
        message: `❌ 调研出错：${err?.message || '未知'}（已加 ${totalNew} 条）`,
        newSources: totalNew, dedupedSources: totalDeduped,
      })
      setTimeout(() => setDeepResearching(null), 6000)
    }
  }, [current, deepResearching, selectedAiModel])

  // Phase A: fetch semantic-index status for current persona. Called when a
  // persona is opened / switched so the UI can show whether an index exists.
  // Contract matches persona-rag-status IPC handler: { success, built,
  // needsRebuild, builtAt, provider, model, dim, chunkCount,
  // currentHydratedSources, availableProviders }.
  const refreshRagStatus = useCallback(async (personaId: string) => {
    if (!window.electronAPI?.personaRagStatus) { setRagStatus(null); return }
    try {
      const r = await window.electronAPI.personaRagStatus(personaId)
      if (r?.success) {
        setRagStatus({
          exists: !!r.built,
          provider: r.provider,
          model: r.model,
          dim: r.dim,
          chunks: r.chunkCount,
          builtAt: r.builtAt,
          needsRebuild: r.needsRebuild,
          fingerprintMismatch: r.needsRebuild,
        })
      } else {
        setRagStatus({ exists: false })
      }
    } catch { setRagStatus({ exists: false }) }
  }, [])

  // Phase A: build / rebuild the embedding index for the current persona.
  // The user kicks this off manually. We stream phase/progress frames to the
  // UI via the persona-rag-build-progress IPC event. Progress payload shape
  // (from preload): { personaId, phase, done, total } delivered as a single
  // object to the callback.
  const handleBuildRagIndex = useCallback(async () => {
    if (!current || !window.electronAPI?.personaRagBuild) return
    if (current.sourcesUsed.length === 0) {
      alert('资料池为空——先加几份资料再建索引')
      return
    }
    const cleanup = window.electronAPI.onPersonaRagBuildProgress?.((payload) => {
      if (!payload || payload.personaId !== current.id) return
      setRagBuildProgress({
        phase: payload.phase,
        done: payload.done,
        total: payload.total,
      })
    }) || (() => {})
    setRagBuildProgress({ phase: 'chunk', message: '准备中…' })
    try {
      const r = await window.electronAPI.personaRagBuild(current.id)
      if (!r?.success) {
        alert(`建索引失败：${r?.error || '未知原因'}\n\n提示：需要在设置里配置 OpenAI 或智谱 GLM 的 API Key`)
        setRagBuildProgress(null)
        return
      }
      setRagBuildProgress({
        phase: 'done', done: r.chunkCount, total: r.chunkCount,
        message: `✅ 已建 ${r.chunkCount} 段 · ${r.provider}/${r.model}`,
      })
      await refreshRagStatus(current.id)
      setTimeout(() => setRagBuildProgress(null), 2500)
    } catch (err: any) {
      alert(`建索引出错：${err.message}`)
      setRagBuildProgress(null)
    } finally {
      cleanup()
    }
  }, [current, refreshRagStatus])

  // Phase A: whenever the current persona changes (or its source pool changes),
  // refresh the semantic-index status so the 🧠 button label stays in sync.
  useEffect(() => {
    if (!current?.id) { setRagStatus(null); return }
    refreshRagStatus(current.id)
  }, [current?.id, current?.sourcesUsed.length, refreshRagStatus])

  // Phase A: clear the semantic index (useful if user wants to switch
  // provider or the index is corrupted).
  const handleClearRagIndex = useCallback(async () => {
    if (!current || !window.electronAPI?.personaRagClear) return
    if (!window.confirm('确定删除语义索引？下次召唤会退回 BM25 关键词检索（质量较低）。')) return
    const r = await window.electronAPI.personaRagClear(current.id)
    if (r?.success) {
      await refreshRagStatus(current.id)
    } else {
      alert(`删除失败：${r?.error || '未知原因'}`)
    }
  }, [current, refreshRagStatus])

  const handleConfirmLibraryPicker = useCallback(async () => {
    if (!current) return
    const picked = libPicker.entries.filter(e => e.selected)
    if (picked.length === 0) { setLibPicker({ open: false, entries: [] }); return }
    setErrorMsg(null)
    const newSources: PersonaSource[] = []
    const failed: string[] = []
    for (const entry of picked) {
      try {
        // readOcrText keys on absPath (OCR file lives alongside the PDF at
        // <absPath>.replace('.pdf', '.ocr.txt'))
        const r = await window.electronAPI.readOcrText?.(entry.absPath)
        if (!r?.exists || !r.text) { failed.push(entry.title); continue }
        newSources.push({
          id: uuid(),
          title: `《${entry.title}》${entry.authors.length > 0 ? ' · ' + entry.authors.join('、') : ''}`,
          snippet: r.text.slice(0, 200),
          url: '',
          source: 'user-file',
          fullContent: r.text.slice(0, 20000),
          fetchedAt: new Date().toISOString(),
          trust: 'primary',
        })
      } catch {
        failed.push(entry.title)
      }
    }
    if (newSources.length > 0) {
      const updated: Persona = {
        ...current,
        sourcesUsed: [...current.sourcesUsed, ...newSources],
        updatedAt: new Date().toISOString(),
      }
      await window.electronAPI.personaSave?.(updated)
      setCurrent(updated)
      setSourcePoolExpanded(true)
    }
    setLibPicker({ open: false, entries: [] })
    if (newSources.length > 0 && failed.length === 0) {
      alert(`✅ ${newSources.length} 部文献的 OCR 文本已加入资料池（primary 级）`)
    } else if (newSources.length > 0) {
      alert(`✅ ${newSources.length} 部已加入\n\n⚠️ ${failed.length} 部跳过（OCR 为空）：${failed.slice(0, 3).join('、')}`)
    } else if (failed.length > 0) {
      alert(`全部失败——这些文献可能 OCR 不完整：${failed.slice(0, 3).join('、')}`)
    }
  }, [current, libPicker])

  // Skip a dimension outright — records 'skipped' status.
  const handleSkipDimension = useCallback(async (key: PersonaDimensionKey) => {
    if (!current || !current.distillation) return
    const now = new Date().toISOString()
    const skippedDim: PersonaDimension = {
      key,
      status: 'skipped',
      content: current.distillation.dimensions[key].content || '',
      sourcesUsedIds: current.distillation.dimensions[key].sourcesUsedIds || [],
      distilledAt: now,
    }
    const updated: Persona = {
      ...current,
      distillation: {
        ...current.distillation,
        dimensions: { ...current.distillation.dimensions, [key]: skippedDim },
      },
      updatedAt: now,
    }
    await window.electronAPI.personaSave?.(updated)
    setCurrent(updated)
    setStage('distill-paused')
  }, [current])

  // Synthesize: roll the 6 dimension notes up into a SkillArtifact + fullMarkdown
  // + overall fitness, then land in 'viewing'.
  const handleSynthesize = useCallback(async () => {
    if (!current || !current.distillation) return
    const doneDims = Object.values(current.distillation.dimensions).filter(d => d.status === 'done')
    if (doneDims.length < 2) {
      setErrorMsg('至少要完成 2 个维度才能综合 skill')
      return
    }
    if (doneDims.length < 3) {
      if (!window.confirm(`只有 ${doneDims.length} 个维度完成——综合出来的 skill 保真度会很低，确定继续？`)) return
    }

    setErrorMsg(null)
    setStage('synthesizing')
    setStreamingText('')
    try {
      const notes: Partial<Record<PersonaDimensionKey, string>> = {}
      for (const d of PERSONA_DIMENSIONS) {
        const dim = current.distillation.dimensions[d.key]
        if (dim?.status === 'done' && dim.content) notes[d.key] = dim.content
      }

      const synthText = await callPersonaAi(
        selectedAiModel,
        PERSONA_SYNTHESIZE_SYSTEM_PROMPT,
        buildSynthesizeUserMessage(current.canonicalName || current.name, current.identity || '', notes),
        { webSearch: false, onChunk: t => setStreamingText(t) },
      )
      const synth = parseSkillSynthesis(synthText)
      if (!synth) throw new Error('综合结果无法解析为 skill JSON——请重试或换个模型')

      const fullMarkdown = buildSkillFullMarkdown(synth)

      // Overall fitness on the synthesized skill
      const hasUserMat = current.sourcesUsed.some(s => s.source.startsWith('user-'))
      const evalText = await callPersonaAi(
        selectedAiModel,
        PERSONA_EVALUATE_SYSTEM_PROMPT,
        buildEvaluateUserMessage(current.canonicalName || current.name, fullMarkdown, current.sourcesUsed, hasUserMat),
        { webSearch: false },
      )
      const fitness = parseFitness(evalText)
      if (fitness) { fitness.model = selectedAiModel; fitness.scope = 'synthesized' }

      const now = new Date().toISOString()
      const skill: PersonaSkillArtifact = {
        ...synth,
        fullMarkdown,
        synthesizedAt: now,
        model: selectedAiModel,
      }
      const version: PersonaVersion = {
        content: fullMarkdown,
        generatedAt: now,
        model: selectedAiModel,
        fitness: fitness || undefined,
        changeNote: '综合蒸馏完成',
        sourcesUsedIds: current.sourcesUsed.map(s => s.id),
        distillationSnapshot: current.distillation,
        skillSnapshot: skill,
      }
      const updated: Persona = {
        ...current,
        skill,
        content: fullMarkdown,
        currentFitness: fitness || undefined,
        versions: [...current.versions, version],
        updatedAt: now,
      }
      await window.electronAPI.personaSave?.(updated)
      setCurrent(updated)
      setStage('viewing')
      setStreamingText('')
      await loadListRef.current()
    } catch (err: any) {
      setErrorMsg(err.message)
      setStage('distill-paused')
      setStreamingText('')
    }
  }, [current, selectedAiModel])

  // =================================================================
  // === Skill import / export ===
  // =================================================================
  const handleExportSkill = useCallback(async (opts?: { pickDir?: boolean }) => {
    if (!current) return
    setErrorMsg(null)
    try {
      let outDir: string | undefined
      if (opts?.pickDir) {
        const r = await window.electronAPI.personaPickExportDir?.()
        if (!r?.success) return
        if (!r.dir) return  // user cancelled
        outDir = r.dir
      }
      const r = await window.electronAPI.personaExportSkill?.(current.id, { outDir })
      if (!r?.success) {
        setErrorMsg(r?.error || '导出失败')
        return
      }
      // Reload to pick up exportedAt/exportedPath marker
      const reloaded = await window.electronAPI.personaLoad?.(current.id)
      if (reloaded?.success && reloaded.persona) setCurrent(reloaded.persona)
      window.alert(`已导出到：${r.skillDir}`)
    } catch (err: any) {
      setErrorMsg(err.message)
    }
  }, [current])

  const handleImportSkill = useCallback(async () => {
    setErrorMsg(null)
    setImporting(true)
    try {
      const pick = await window.electronAPI.personaPickSkillPath?.()
      if (!pick?.success) return
      if (!pick.path) return  // user cancelled
      const r = await window.electronAPI.personaImportSkill?.(pick.path)
      if (!r?.success || !r.persona) {
        setErrorMsg(r?.error || '导入失败')
        return
      }
      await loadListRef.current()
      setCurrent(r.persona)
      setStage('viewing')
    } catch (err: any) {
      setErrorMsg(err.message)
    } finally {
      setImporting(false)
    }
  }, [])

  // =================================================================
  // === Summon: chat with the distilled / imported persona in-tab ===
  // =================================================================
  const handleOpenSummon = useCallback(async () => {
    if (!current) return
    setErrorMsg(null)
    try {
      const r = await window.electronAPI.personaGetSystemPrompt?.(current.id)
      if (!r?.success || !r.systemPrompt) {
        setErrorMsg(r?.error || '无法构建召唤 system prompt')
        return
      }
      setSummonSystemPrompt(r.systemPrompt)
      setSummonMessages([])
      setSummonInput('')
      setSummonStreaming('')
      // Probe how many chunks RAG can retrieve from. Empty query returns 0
      // chunks but populates totalChunks + we count hydrated sources ourselves.
      const hydratedSources = (current.sourcesUsed || []).filter(s => s.fullContent).length
      try {
        const probe = await window.electronAPI.personaRagRetrieve?.(current.id, '', 1)
        setSummonRagInfo({ totalChunks: probe?.totalChunks ?? 0, hydratedSources })
      } catch { setSummonRagInfo({ totalChunks: 0, hydratedSources }) }
      setStage('summoning')
    } catch (err: any) {
      setErrorMsg(err.message)
    }
  }, [current])

  const handleSummonSend = useCallback(async () => {
    if (!summonInput.trim() || summonBusy || !current) return
    const userQuery = summonInput.trim()
    setSummonInput('')
    setSummonBusy(true)
    setSummonStreaming('')
    try {
      // Re-fetch system prompt each send with the current user query so the
      // backend can retrieve top-5 original-text snippets from sourcesUsed —
      // every turn gets fresh RAG. Wave-3: also gets back the chunks list
      // so we can reverse-parse [资料 N] in the response.
      const sysRes = await window.electronAPI.personaGetSystemPrompt?.(current.id, userQuery)
      const sysPrompt = sysRes?.success && sysRes.systemPrompt ? sysRes.systemPrompt : summonSystemPrompt
      const injectedChunks: InjectedChunk[] = sysRes?.success && sysRes.chunks ? sysRes.chunks : []
      const retrievalMode = sysRes?.retrievalMode
      const totalChunks = sysRes?.totalChunks

      // Append user message with the injected-chunks snapshot (so the UI
      // can show "🔎 检索 to top-K" badge tied to this exact turn).
      const userMsg = {
        role: 'user' as const, content: userQuery,
        injectedChunks, retrievalMode, totalChunks,
      }
      const next = [...summonMessages, userMsg]
      setSummonMessages(next)

      const messagesForAi = [
        { role: 'system', content: sysPrompt },
        ...next.map(m => ({ role: m.role, content: m.content })),
      ]
      const streamId = uuid()
      let full = ''
      const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
        if (sid !== streamId) return
        full += chunk
        setSummonStreaming(full)
      })
      try {
        const res = await window.electronAPI.aiChatStream(streamId, selectedAiModel, messagesForAi)
        if (!res.success) throw new Error(res.error || '召唤对话失败')
        if (res.text) full = res.text
      } finally {
        cleanup()
      }
      // Wave-3: reverse-parse citations from the response.
      const citations = parseCitations(full, injectedChunks)
      setSummonMessages([...next, {
        role: 'assistant',
        content: full,
        citations,
      }])
      setSummonStreaming('')
    } catch (err: any) {
      setErrorMsg(err.message)
    } finally {
      setSummonBusy(false)
    }
  }, [summonInput, summonBusy, summonMessages, summonSystemPrompt, selectedAiModel, current])

  const handleCloseSummon = useCallback(() => {
    setStage('viewing')
    setSummonStreaming('')
  }, [])

  // =================================================================
  // === Legacy upgrade: move a legacy persona to distilled mode ===
  // =================================================================
  const handleUpgradeToDistilled = useCallback(async () => {
    if (!current) return
    if (current.skillMode !== 'legacy') return
    if (!window.confirm('升级为蒸馏版会保留现有档案作为历史版本，然后启动 6 维蒸馏流程。现有内容不会丢失。确认？')) return
    const now = new Date().toISOString()
    const updated: Persona = {
      ...current,
      skillMode: 'distilled',
      distillation: createEmptyDistillation(),
      updatedAt: now,
    }
    await window.electronAPI.personaSave?.(updated)
    setCurrent(updated)
    setActiveDimension(null)
    setStage('distill-paused')
  }, [current])

  // =================================================================
  // === Step 4 (legacy): Refine — either from new search or from user-ingested material ===
  // =================================================================
  // The draft is shown for user confirmation before writing into versions[].
  const runRefine = useCallback(async (newSources: PersonaSource[], changeNote: string) => {
    if (!current) return
    setErrorMsg(null)
    setStage('refining')
    setStreamingText('')
    try {
      const refined = await callPersonaAi(
        selectedAiModel,
        PERSONA_REFINE_SYSTEM_PROMPT,
        buildRefineUserMessage(current.canonicalName || current.name, current.content, newSources, changeNote),
        { webSearch: true, onChunk: t => setStreamingText(t) },
      )
      const hasUserMat = newSources.some(s => s.source.startsWith('user-'))
      const evalText = await callPersonaAi(
        selectedAiModel,
        PERSONA_EVALUATE_SYSTEM_PROMPT,
        buildEvaluateUserMessage(current.canonicalName || current.name, refined, [...current.sourcesUsed, ...newSources], hasUserMat),
        { webSearch: false },
      )
      const fitness = parseFitness(evalText)
      if (fitness) fitness.model = selectedAiModel

      setRefineDraft({
        content: refined,
        fitness: fitness || undefined,
        changeNote,
        sourcesUsedIds: newSources.map(s => s.id),
      })
      // Hold new sources in candidates state so we can merge on accept
      setCandidates(prev => [...prev, ...newSources])
      setStage('viewing')
      setStreamingText('')
    } catch (err: any) {
      setErrorMsg(err.message)
      setStage('viewing')
      setStreamingText('')
    }
  }, [current, selectedAiModel])

  const handleAcceptRefine = useCallback(async () => {
    if (!current || !refineDraft) return
    const now = new Date().toISOString()
    const newSources = candidates.filter(c => refineDraft.sourcesUsedIds.includes(c.id) && !current.sourcesUsed.some(s => s.id === c.id))
    const newVersion: PersonaVersion = {
      content: refineDraft.content,
      generatedAt: now,
      model: selectedAiModel,
      fitness: refineDraft.fitness,
      changeNote: refineDraft.changeNote,
      sourcesUsedIds: refineDraft.sourcesUsedIds,
    }
    const updated: Persona = {
      ...current,
      content: refineDraft.content,
      sourcesUsed: [...current.sourcesUsed, ...newSources],
      versions: [...current.versions, newVersion],
      currentFitness: refineDraft.fitness || current.currentFitness,
      updatedAt: now,
    }
    await window.electronAPI.personaSave?.(updated)
    setCurrent(updated)
    setRefineDraft(null)
    await loadListRef.current()
  }, [current, refineDraft, candidates, selectedAiModel])

  const handleRejectRefine = () => setRefineDraft(null)

  // === Refine trigger: re-search web ===
  const handleWebRefine = useCallback(async () => {
    if (!current) return
    setErrorMsg(null)
    setStage('searching')
    try {
      const r = await window.electronAPI.nuwaSearch?.(current.canonicalName || current.name)
      if (!r?.success || r.sources.length === 0) {
        setErrorMsg('重新搜索未找到新资料')
        setStage('viewing')
        return
      }
      // Filter out already-used URLs
      const existingUrls = new Set(current.sourcesUsed.map(s => s.url))
      const newSources = r.sources.filter(s => !existingUrls.has(s.url))
      if (newSources.length === 0) {
        setErrorMsg('重新搜索没发现新的资料（已有的都用过了）')
        setStage('viewing')
        return
      }
      setCandidates(newSources)
      setSelectedIds(new Set(newSources.map(s => s.id)))
      setStage('refine-picking-sources')
    } catch (err: any) {
      setErrorMsg(err.message)
      setStage('viewing')
    }
  }, [current])

  // Refine path's confirm button — hydrate full content then feed runRefine directly,
  // skipping disambig (identity is already chosen).
  const handleConfirmRefineSources = useCallback(async () => {
    if (!current) return
    if (selectedIds.size === 0) { setErrorMsg('至少选一条参考资料'); return }
    setErrorMsg(null)
    try {
      const hydrated = await hydrateSelectedSources(candidates)
      await runRefine(hydrated.filter(s => selectedIds.has(s.id)), '再次联网补充')
    } catch (err: any) {
      setErrorMsg(err.message)
      setStage('viewing')
    }
  }, [current, candidates, selectedIds, hydrateSelectedSources, runRefine])

  // === Refine trigger: user ingest text/url/file ===
  const handleIngestSubmit = useCallback(async () => {
    if (!current) return
    let source: PersonaSource | null = null
    try {
      if (ingestType === 'text') {
        if (!ingestText.trim()) return
        source = {
          id: uuid(),
          title: '你的笔记片段',
          snippet: ingestText.slice(0, 120),
          url: '',
          source: 'user-prompt',
          fullContent: ingestText,
          fetchedAt: new Date().toISOString(),
        }
      } else if (ingestType === 'url') {
        if (!ingestUrl.trim()) return
        const tmpSource: PersonaSource = {
          id: uuid(), title: ingestUrl, snippet: '',
          url: ingestUrl.trim(), source: 'user-url',
        }
        const r = await window.electronAPI.nuwaFetchPage?.(tmpSource)
        if (!r?.success || !r.fullContent) {
          setErrorMsg('URL 抓取失败')
          return
        }
        source = { ...tmpSource, fullContent: r.fullContent, snippet: r.fullContent.slice(0, 200), fetchedAt: new Date().toISOString() }
      } else if (ingestType === 'file') {
        // File ingest uses a standard file input
        setErrorMsg('请点下方"选择文件"按钮')
        return
      }
      if (!source) return
      setIngestText('')
      setIngestUrl('')
      await runRefine([source], ingestType === 'text' ? '吸收笔记片段' : '吸收 URL 内容')
    } catch (err: any) {
      setErrorMsg(err.message)
    }
  }, [current, ingestType, ingestText, ingestUrl, runRefine])

  const handleFileIngest = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !current) return
    e.target.value = ''  // allow re-pick same file
    try {
      const text = await file.text()
      if (!text.trim()) { setErrorMsg('文件内容为空或无法读取'); return }
      const source: PersonaSource = {
        id: uuid(),
        title: file.name,
        snippet: text.slice(0, 200),
        url: '',
        source: 'user-file',
        fullContent: text.slice(0, 20000),   // cap per-file content
        fetchedAt: new Date().toISOString(),
      }
      await runRefine([source], `吸收文件 ${file.name}`)
    } catch (err: any) {
      setErrorMsg(`读取文件失败: ${err.message}`)
    }
  }, [current, runRefine])

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm('删除这份人物档案？')) return
    await window.electronAPI.personaDelete?.(id)
    if (current?.id === id) { setCurrent(null); setStage('idle') }
    await loadListRef.current()
  }, [current])

  const handleLoadPersona = useCallback(async (id: string) => {
    const r = await window.electronAPI.personaLoad?.(id)
    if (r?.success && r.persona) {
      setCurrent(r.persona)
      setStage('viewing')
      setCandidates(r.persona.sourcesUsed)
      setSelectedIds(new Set())
      setIdentities([])
      setRefineDraft(null)
      setRagStatus(null)          // clear stale status from previous persona
      setRagBuildProgress(null)
      refreshRagStatus(id)
    }
  }, [refreshRagStatus])

  const resetToIdle = () => {
    setCurrent(null)
    setStage('idle')
    setNameInput('')
    setCandidates([])
    setSelectedIds(new Set())
    setIdentities([])
    setRefineDraft(null)
    setStreamingText('')
    setErrorMsg(null)
  }

  // ===== Render =====
  // Single-column layout — a left rail + right detail created two cramped
  // vertical strips in the narrow Hermes panel. Instead: a chip row at top
  // (scrolls horizontally when full), content takes the whole width.
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Persona gallery — a self-contained mini-panel at the top.
          Previously a cramped single-row chip bar; user feedback: 太小 / 不是板块感.
          Now: card-style container with its own background + border + label
          header, chips are bigger and readable. Scrolls horizontally when full. */}
      {(list.length > 0 || current) && (
        <div style={{
          margin: '10px 12px 4px', padding: '10px 12px 12px',
          background: 'var(--bg-warm)', border: '1px solid var(--border-light)',
          borderRadius: 10, flexShrink: 0,
        }}>
          <div style={{
            fontSize: 10, color: 'var(--text-muted)', marginBottom: 8,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>我的名家</span>
            <span style={{ opacity: 0.6 }}>· {list.length}</span>
          </div>
          <div style={{
            display: 'flex', gap: 8, overflowX: 'auto', overflowY: 'hidden',
            paddingBottom: 2,
          }}>
            <button
              onClick={resetToIdle}
              style={{
                padding: '7px 16px', fontSize: 12.5, fontWeight: 500,
                border: '1px dashed var(--accent)', borderRadius: 16,
                background: 'transparent', color: 'var(--accent)',
                cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-soft)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >＋ 新召唤</button>
            {list.map(p => {
              const isActive = current?.id === p.id
              return (
                <div key={p.id} style={{
                  display: 'inline-flex', alignItems: 'center',
                  borderRadius: 16, flexShrink: 0,
                  border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: isActive ? 'var(--accent-soft)' : 'var(--bg)',
                  transition: 'border-color 0.15s, background 0.15s',
                }}>
                  <button
                    onClick={() => handleLoadPersona(p.id)}
                    style={{
                      padding: '7px 6px 7px 14px', fontSize: 12.5, fontWeight: isActive ? 600 : 500,
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: isActive ? 'var(--accent-hover)' : 'var(--text)',
                      whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                    title={p.identity || p.canonicalName || p.name}
                  >
                    {p.canonicalName || p.name}
                    {typeof p.currentFitnessTotal === 'number' && (
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 8,
                        background: p.currentFitnessTotal >= 60 ? 'var(--success)' : p.currentFitnessTotal >= 30 ? 'var(--warning)' : 'var(--text-muted)',
                        color: '#fff', fontWeight: 500,
                      }}>{p.currentFitnessTotal}%</span>
                    )}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(p.id) }}
                    title="删除此档案"
                    style={{
                      padding: '3px 10px 3px 4px', fontSize: 14, lineHeight: 1,
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', opacity: 0.5,
                      transition: 'opacity 0.15s, color 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--danger)' }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.color = 'var(--text-muted)' }}
                  >×</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Main content area — full-width single column */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 22px' }}>
        {errorMsg && (
          <div style={{ padding: '8px 12px', marginBottom: 12, background: 'rgba(231, 76, 60, 0.1)', border: '1px solid var(--danger)', borderRadius: 6, fontSize: 11, color: 'var(--danger)' }}>
            {errorMsg}
          </div>
        )}

        {/* === Idle / search entry ===
            Designed for breathing room — title + subtitle have generous vertical
            rhythm; search is a single rounded pill with an embedded submit button;
            sources shown as three quiet chips instead of inline bold text. */}
        {stage === 'idle' && !current && (
          <div style={{
            maxWidth: 560,
            margin: '0 auto',
            padding: '72px 28px 40px',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
          }}>
            {/* Glyph — decorative */}
            <div style={{
              width: 44, height: 44, marginBottom: 22,
              borderRadius: 22, background: 'var(--accent-soft)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--accent)',
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>
              </svg>
            </div>

            {/* Title */}
            <div style={{
              fontSize: 22, fontWeight: 600, color: 'var(--text)',
              marginBottom: 10, letterSpacing: '0.02em',
            }}>召唤一位人物</div>

            {/* Subtitle — a single calm sentence, no bold pile-up */}
            <div style={{
              fontSize: 13, color: 'var(--text-secondary)',
              lineHeight: 1.75, textAlign: 'center',
              maxWidth: 440, marginBottom: 32,
            }}>
              输入名字，拾卷用 6 维度蒸馏召唤他的 skill——既能在这里和他对话，也能导出给 Claude Code 使用。
            </div>

            {/* Search — pill-shaped input with embedded button */}
            <form
              onSubmit={e => { e.preventDefault(); handleSearch() }}
              style={{
                width: '100%', maxWidth: 440,
                display: 'flex', alignItems: 'center',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 24,
                padding: '4px 4px 4px 18px',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
            >
              <input
                type="text"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                placeholder="如：黑格尔、马克斯·韦伯、阿西莫夫"
                style={{
                  flex: 1, padding: '10px 0', fontSize: 14,
                  border: 'none', outline: 'none',
                  background: 'transparent', color: 'var(--text)',
                }}
                autoFocus
              />
              <button
                type="submit"
                disabled={!nameInput.trim()}
                style={{
                  padding: '8px 20px', fontSize: 13, fontWeight: 500,
                  border: 'none', borderRadius: 20,
                  background: nameInput.trim() ? 'var(--accent)' : 'var(--border)',
                  color: nameInput.trim() ? '#fff' : 'var(--text-muted)',
                  cursor: nameInput.trim() ? 'pointer' : 'not-allowed',
                  transition: 'background 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >搜索</button>
            </form>

            {/* Source chips — three quiet hints side by side */}
            <div style={{
              marginTop: 28, display: 'flex', gap: 10, flexWrap: 'wrap',
              justifyContent: 'center',
            }}>
              {[
                { label: '维基百科', color: '#3366cc' },
                { label: '百度百科', color: '#2577e3' },
                { label: '网络搜索', color: '#888' },
              ].map(s => (
                <div key={s.label} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', fontSize: 10.5,
                  background: 'var(--bg-warm)',
                  border: '1px solid var(--border-light)',
                  borderRadius: 12,
                  color: 'var(--text-muted)',
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: 3, background: s.color }} />
                  {s.label}
                </div>
              ))}
            </div>

            {/* Footnote about the distillation flow */}
            <div style={{
              marginTop: 32, fontSize: 11, color: 'var(--text-muted)',
              textAlign: 'center', lineHeight: 1.7, maxWidth: 420,
              opacity: 0.8,
            }}>
              6 维度 = 著作 · 访谈 · 表达 DNA · 他者 · 决策 · 时间线<br />
              每维独立蒸馏+评估，综合后产出符合 Claude Code 规范的 SKILL.md
            </div>

            {/* Import-existing-skill entry — small secondary affordance */}
            <div style={{ marginTop: 22, fontSize: 11, color: 'var(--text-muted)' }}>
              已经有 SKILL.md 文件？
              <button
                onClick={handleImportSkill}
                disabled={importing}
                style={{
                  marginLeft: 6, padding: '2px 8px', fontSize: 11,
                  background: 'transparent', color: 'var(--accent)',
                  border: '1px solid var(--border-light)', borderRadius: 10,
                  cursor: importing ? 'wait' : 'pointer',
                }}
              >{importing ? '导入中…' : '导入 skill →'}</button>
            </div>
          </div>
        )}
        {stage === 'searching' && !current && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <span className="loading-spinner" style={{ marginRight: 8 }} />
            正在从多源搜索 "{nameInput}"…
          </div>
        )}

        {/* === Picking sources ===
            Shared by two entry points:
              - 'picking-sources': fresh 新召唤 → confirm goes to disambig (identity TBD)
              - 'refine-picking-sources': existing persona hit【再次联网补充】→ confirm goes
                straight to runRefine (identity already chosen, skip disambig). */}
        {(stage === 'picking-sources' || stage === 'refine-picking-sources') && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              {stage === 'refine-picking-sources' ? '再次联网搜到的补充资料' : `找到 ${candidates.length} 条参考资料`}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.7 }}>
              {stage === 'refine-picking-sources' ? (
                <>勾选要让 AI 吸收的新资料，已有资料会自动排除。<br />确认后 AI 会在现有档案基础上增补/修订，<b>不会</b>重新识别身份。</>
              ) : (
                <>勾选要用的资料。可以删除不相关的（比如不是你要的人），打开原文核实。<br />AI 只会基于你勾选的资料写档案。</>
              )}
            </div>
            {candidates.map(s => (
              <SourceRow
                key={s.id}
                source={s}
                checked={selectedIds.has(s.id)}
                onToggle={() => setSelectedIds(prev => {
                  const n = new Set(prev)
                  if (n.has(s.id)) n.delete(s.id); else n.add(s.id)
                  return n
                })}
                onRemove={() => {
                  setCandidates(prev => prev.filter(c => c.id !== s.id))
                  setSelectedIds(prev => { const n = new Set(prev); n.delete(s.id); return n })
                }}
              />
            ))}
            <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                onClick={() => stage === 'refine-picking-sources' ? setStage('viewing') : resetToIdle()}
                style={{ padding: '6px 14px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
              >取消</button>
              {/* Manual-identity fallback — only surfaced in the fresh picking
                  flow (not refine). Useful when disambig AI chokes on sources. */}
              {stage === 'picking-sources' && (
                <button
                  onClick={handleManualIdentity}
                  disabled={selectedIds.size === 0}
                  style={{ padding: '6px 14px', fontSize: 12, border: '1px dashed var(--border)', borderRadius: 4, background: 'transparent', color: selectedIds.size > 0 ? 'var(--text-secondary)' : 'var(--text-muted)', cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed' }}
                  title="跳过 AI 识别，你自己输入规范名和身份，直接进蒸馏"
                >
                  手动输入身份
                </button>
              )}
              <button
                onClick={stage === 'refine-picking-sources' ? handleConfirmRefineSources : handleDisambig}
                disabled={selectedIds.size === 0}
                style={{ padding: '6px 14px', fontSize: 12, border: 'none', borderRadius: 4, background: selectedIds.size > 0 ? 'var(--accent)' : 'var(--border)', color: selectedIds.size > 0 ? '#fff' : 'var(--text-muted)', cursor: selectedIds.size > 0 ? 'pointer' : 'not-allowed' }}
              >
                {stage === 'refine-picking-sources' ? `让 AI 吸收（勾选 ${selectedIds.size} 条）` : `AI 识别身份（勾选 ${selectedIds.size} 条）`}
              </button>
            </div>
          </div>
        )}

        {/* === Disambigging === */}
        {stage === 'disambigging' && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <span className="loading-spinner" style={{ marginRight: 8 }} />
            AI 正在识别身份…
          </div>
        )}

        {/* === Picking identity === */}
        {stage === 'picking-identity' && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              "{nameInput}" 可能是以下哪位？
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
              AI 基于你勾选的资料识别出的候选身份。选一个进入 6 维度蒸馏流程。
            </div>
            {identities.map((id, i) => (
              <div
                key={i}
                onClick={() => handleStartDistillation(id)}
                style={{
                  padding: '12px 14px', marginBottom: 10, borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--bg-warm)', cursor: 'pointer',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-soft)'; e.currentTarget.style.borderColor = 'var(--accent)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-warm)'; e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{id.canonicalName}</span>
                  {id.lifespan && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{id.lifespan}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>确定度 {id.confidence}%</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{id.identity}</div>
              </div>
            ))}
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <button onClick={() => setStage('picking-sources')} style={{ padding: '5px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                ← 返回选资料
              </button>
            </div>
          </div>
        )}

        {/* === Distilling (one dimension in flight) === */}
        {stage === 'distilling' && current && current.distillation && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span className="loading-spinner" style={{ width: 12, height: 12, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {batchRunning
                  ? `一键${batchRunning.mode === 'optimize-done' ? '优化' : batchRunning.mode === 'rerun-all' ? '重新蒸馏' : '蒸馏'} ${batchRunning.doneIdx + 1}/${batchRunning.totalIdx}：${PERSONA_DIMENSIONS.find(d => d.key === (batchRunning.currentKey || activeDimension))?.fullLabel}`
                  : `正在蒸馏：${PERSONA_DIMENSIONS.find(d => d.key === activeDimension)?.fullLabel}`}
              </span>
              {batchRunning && (
                <button onClick={handleAbortBatch}
                        style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 10, border: '1px solid var(--danger)', borderRadius: 3, background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                  中止批量
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              AI 会调用 web_search（若模型支持）补充资料，完成后独立评估此维度拟合度。
              <span style={{ opacity: 0.7 }}> 若联网搜索中，可能 10-30 秒才开始出文字。</span>
            </div>
            {/* 6 维进度条 */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
              {PERSONA_DIMENSIONS.map(d => {
                const dim = current.distillation!.dimensions[d.key]
                const isActive = d.key === activeDimension
                const color = dim.status === 'done'   ? 'var(--success)'
                            : dim.status === 'running'? 'var(--accent)'
                            : dim.status === 'error'  ? 'var(--danger)'
                            : dim.status === 'skipped'? 'var(--text-muted)'
                            :                           'var(--border)'
                return (
                  <div key={d.key} title={d.fullLabel}
                       style={{ flex: 1, height: 5, borderRadius: 2, background: color, opacity: isActive ? 1 : 0.6 }} />
                )
              })}
            </div>
            {streamingText ? (
              <div className="annotation-markdown" style={{ fontSize: 12.5, lineHeight: 1.75, background: 'var(--bg-warm)', padding: '12px 16px', borderRadius: 8, border: '1px solid var(--border-light)', maxHeight: 'calc(100vh - 280px)', overflow: 'auto' }}>
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {sanitizeMath(streamingText)}
                </ReactMarkdown>
              </div>
            ) : (
              // Placeholder shown while AI is silent — either it's web-searching
              // or it's a non-streaming provider path (manual function-call loop).
              <div style={{ padding: '24px 20px', background: 'var(--bg-warm)', borderRadius: 8, border: '1px dashed var(--border)', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.85, textAlign: 'center' }}>
                <div style={{ marginBottom: 8, fontSize: 13 }}>🔍 AI 正在思考…</div>
                <div style={{ opacity: 0.85 }}>
                  某些场景不会实时流式输出：<br />
                  · 调用 web_search 工具时（搜完一次返回结果）<br />
                  · OpenAI / DeepSeek / 豆包 在带工具调用的场景下用非流式模式<br />
                  完成后文本会一次性出现。
                </div>
              </div>
            )}
          </div>
        )}

        {/* === Distill paused: progress overview + per-dim detail + synthesize CTA === */}
        {stage === 'distill-paused' && current && current.distillation && (() => {
          const dims = PERSONA_DIMENSIONS.map(d => ({ def: d, dim: current.distillation!.dimensions[d.key] }))
          const doneCount = dims.filter(x => x.dim.status === 'done').length
          const skippedCount = dims.filter(x => x.dim.status === 'skipped').length
          const erroredCount = dims.filter(x => x.dim.status === 'error').length
          const allSettled = dims.every(x => x.dim.status === 'done' || x.dim.status === 'skipped')
          const active = activeDimension ? current.distillation!.dimensions[activeDimension] : null
          const activeDef = activeDimension ? PERSONA_DIMENSIONS.find(d => d.key === activeDimension) : null

          const statusGlyph = (s: PersonaDimension['status']) => (
            s === 'done'    ? '●' :
            s === 'running' ? '◐' :
            s === 'error'   ? '✕' :
            s === 'skipped' ? '⊘' : '○'
          )
          const statusColor = (s: PersonaDimension['status']) => (
            s === 'done'    ? 'var(--success)' :
            s === 'running' ? 'var(--accent)' :
            s === 'error'   ? 'var(--danger)' :
            s === 'skipped' ? 'var(--text-muted)' : 'var(--text-muted)'
          )

          return (
            <div>
              {/* Header */}
              <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
                    {current.canonicalName || current.name}
                  </span>
                  {current.identity && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{current.identity}</span>}
                  <button
                    onClick={() => handleDelete(current.id)}
                    style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 10, background: 'none', border: '1px solid var(--danger)', borderRadius: 3, color: 'var(--danger)', cursor: 'pointer' }}
                  >删除</button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                  蒸馏进度：{doneCount} / 6 完成
                  {skippedCount > 0 && ` · ${skippedCount} 跳过`}
                  {erroredCount > 0 && ` · ${erroredCount} 出错`}
                </div>
              </div>

              {/* Source-pool control bar + expandable list — resolves the user
                  feedback that 资料 only appears in picking-sources. Here in
                  distilling stage, users can: see the whole pool, remove bad
                  entries, web-search for more, ingest batch files, pull library
                  entries. Everything about source management happens here. */}
              {(() => {
                const primaryCount = current.sourcesUsed.filter(s => s.trust === 'primary' || s.source.startsWith('user-')).length
                const totalSources = current.sourcesUsed.length
                const encyclopediaOnly = primaryCount === 0 && totalSources > 0
                // GLM web-search-pro contribution: count sources tagged
                // 'glm-web-search'. 0 with key configured may indicate the
                // tools endpoint failed silently (rate limit / cold topic) —
                // the user should know the search ran but came up empty.
                const glmCount = current.sourcesUsed.filter(s => s.source === 'glm-web-search').length
                return (
                  <div style={{
                    padding: '10px 12px', marginBottom: 10, borderRadius: 8,
                    background: encyclopediaOnly ? 'rgba(231, 76, 60, 0.06)' : 'var(--bg-warm)',
                    border: `1px ${encyclopediaOnly ? 'solid var(--danger)' : 'solid var(--border-light)'}`,
                  }}>
                    <div style={{ fontSize: 11, color: 'var(--text)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>资料池 {totalSources}</span>
                      <span style={{ color: 'var(--text-muted)' }}>· 一手/原文 {primaryCount}</span>
                      {glmCount > 0 ? (
                        <span style={{
                          padding: '1px 6px', borderRadius: 3,
                          background: '#2c8a6f', color: '#fff',
                          fontSize: 9, fontWeight: 500,
                        }} title="本资料池里有 GLM web-search-pro 工具直接拉来的搜索结果">
                          🤖 GLM 搜索 +{glmCount}
                        </span>
                      ) : (
                        <span style={{
                          padding: '1px 6px', borderRadius: 3,
                          background: 'transparent', color: 'var(--text-muted)',
                          fontSize: 9, fontWeight: 400, border: '1px dashed var(--border-light)',
                        }} title="GLM 搜索工具未贡献结果。可能：(1) 设置里没配 GLM key；(2) 这个资料池是旧搜索的结果，没用 GLM；(3) 调了但 GLM 返回 0 条。">
                          GLM 搜索: 未启用 / 0
                        </span>
                      )}
                      {encyclopediaOnly && (
                        <span style={{ color: 'var(--danger)', fontWeight: 500 }}>
                          · 只有百科级资料，蒸馏会很浅
                        </span>
                      )}
                      <button
                        onClick={() => setSourcePoolExpanded(!sourcePoolExpanded)}
                        style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
                      >
                        {sourcePoolExpanded ? '收起列表' : '查看列表 ↓'}
                      </button>
                    </div>

                    {/* Action row: 5 ways to add sources, always visible.
                        AI 深度搜索 = 让 AI 自己看池子→识别缺口→生成查询→并发联网，
                        递归 2 轮收敛。其余按钮是单次行动入口。 */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: sourcePoolExpanded ? 10 : 0 }}>
                      <button
                        onClick={handleDeepResearch}
                        disabled={!!batchRunning || webSearching || !!deepResearching}
                        style={{ padding: '5px 12px', fontSize: 11, border: '1px solid #2c8a6f', borderRadius: 4, background: deepResearching ? 'transparent' : '#2c8a6f', color: batchRunning || webSearching || deepResearching ? 'var(--text-muted)' : '#fff', cursor: batchRunning || webSearching || deepResearching ? 'wait' : 'pointer', fontWeight: 500 }}
                        title="AI 自主调研：让 AI 看资料池→识别缺口→生成搜索查询→并发联网拉新资料。最多 2 轮，每轮 breadth 减半（dzhng 递归算法）。">
                        {deepResearching ? '调研中…' : '🤖 AI 深度搜索'}
                      </button>
                      <button
                        onClick={handleSearchMoreSources}
                        disabled={!!batchRunning || webSearching || !!deepResearching}
                        style={{ padding: '5px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-soft)', color: batchRunning || webSearching || deepResearching ? 'var(--text-muted)' : 'var(--accent)', cursor: batchRunning || webSearching || deepResearching ? 'wait' : 'pointer' }}
                        title="再次联网搜索（Wiki / 百度 / DDG / Archive.org / Gutenberg），追加到资料池">
                        {webSearching ? '搜索中…' : '🌐 再次联网'}
                      </button>
                      <label style={{ padding: '5px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--accent)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}
                             title="一次导入多个 .txt / .md / .html 文件">
                        + 批量文件
                        <input type="file" multiple accept=".txt,.md,.html"
                               disabled={!!batchRunning}
                               onChange={async e => {
                                 if (e.target.files) await handleIngestFiles(e.target.files)
                                 e.target.value = ''
                               }}
                               style={{ display: 'none' }} />
                      </label>
                      <button
                        onClick={handleOpenLibraryPicker}
                        disabled={!!batchRunning}
                        style={{ padding: '5px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}
                        title="从拾卷库里挑已 OCR 的文献作为一手资料">
                        📚 从拾卷库挑
                      </button>
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center', opacity: 0.75 }}>
                        加完资料后点「一键优化」让 AI 吸收
                      </span>
                    </div>

                    {/* Deep-research progress strip. Shows round/phase/message
                        with an abort button while running. */}
                    {deepResearching && (
                      <div style={{
                        marginTop: 8, padding: '8px 10px', borderRadius: 6,
                        background: deepResearching.phase === 'error' ? 'rgba(231, 76, 60, 0.08)' : 'rgba(44, 138, 111, 0.08)',
                        border: `1px solid ${deepResearching.phase === 'error' ? 'var(--danger)' : '#2c8a6f'}`,
                        fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      }}>
                        <span style={{
                          padding: '1px 6px', borderRadius: 3,
                          background: '#2c8a6f', color: '#fff', fontSize: 9, fontWeight: 500,
                          flexShrink: 0,
                        }}>
                          🤖 第 {deepResearching.round}/{deepResearching.maxRounds} 轮 · {deepResearching.phase}
                        </span>
                        <span style={{ flex: 1, minWidth: 200, color: 'var(--text)' }}>
                          {deepResearching.message}
                        </span>
                        {(deepResearching.phase === 'planning' || deepResearching.phase === 'querying' || deepResearching.phase === 'searching') && (
                          <button
                            onClick={() => { deepResearchAbortRef.current = true }}
                            style={{ padding: '3px 10px', fontSize: 10, border: '1px solid var(--danger)', borderRadius: 3, background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}
                          >中止</button>
                        )}
                      </div>
                    )}

                    {/* Phase A: semantic-index management row.
                        Lives inside the 资料池 block because building an index
                        is a property of the raw source pool, not the distilled
                        persona. Shows status + a build/rebuild button.
                        If no provider key configured, button is disabled with
                        a tooltip pointing user to 设置. */}
                    {(() => {
                      const building = ragBuildProgress && ragBuildProgress.phase !== 'done' && ragBuildProgress.phase !== 'error'
                      const hasIdx = !!(ragStatus && ragStatus.exists)
                      const needsRebuild = !!(ragStatus && ragStatus.needsRebuild)
                      const stale = !!(ragStatus && ragStatus.fingerprintMismatch)
                      let statusLine = ''
                      let statusColor = 'var(--text-muted)'
                      if (building) {
                        const { phase, done, total, message } = ragBuildProgress!
                        const phaseLabel = phase === 'chunk' ? '切块中' : phase === 'embed' ? '向量化中' : phase === 'save' ? '保存中' : phase
                        statusLine = `🔄 ${phaseLabel}${typeof done === 'number' && typeof total === 'number' ? `：${done}/${total}` : ''}${message ? ` · ${message}` : ''}`
                        statusColor = 'var(--accent)'
                      } else if (hasIdx && stale) {
                        statusLine = `⚠️ 语义索引已过期（资料变化）· 原 ${ragStatus!.chunks} 段 · ${ragStatus!.provider} · 建议重建`
                        statusColor = 'var(--warning)'
                      } else if (hasIdx) {
                        const at = ragStatus!.builtAt ? new Date(ragStatus!.builtAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
                        statusLine = `🧠 语义索引 · ${ragStatus!.chunks} 段 · ${ragStatus!.provider}${ragStatus!.model ? '/' + ragStatus!.model : ''} · ${at}`
                        statusColor = 'var(--success)'
                      } else {
                        statusLine = '💤 未建语义索引（召唤会退回 BM25 关键词检索，中文效果一般）'
                        statusColor = 'var(--text-muted)'
                      }
                      const buttonLabel = building ? '建索引中…'
                        : (hasIdx && (needsRebuild || stale)) ? '🧠 重建索引'
                        : hasIdx ? '🧠 已建 · 重建'
                        : '🧠 建立语义索引'
                      return (
                        <div style={{
                          marginTop: 8, padding: '8px 10px', borderRadius: 6,
                          background: 'var(--bg)', border: '1px dashed var(--border-light)',
                          fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                        }}>
                          <span style={{ color: statusColor, flex: 1, minWidth: 200 }}>
                            {statusLine}
                          </span>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              onClick={handleBuildRagIndex}
                              disabled={!!building || !!batchRunning || totalSources === 0}
                              style={{
                                padding: '4px 10px', fontSize: 11,
                                border: `1px solid ${hasIdx && !needsRebuild && !stale ? 'var(--border)' : 'var(--accent)'}`,
                                borderRadius: 4,
                                background: hasIdx && !needsRebuild && !stale ? 'transparent' : 'var(--accent-soft)',
                                color: building || batchRunning || totalSources === 0 ? 'var(--text-muted)'
                                  : hasIdx && !needsRebuild && !stale ? 'var(--text-secondary)' : 'var(--accent)',
                                cursor: building || batchRunning || totalSources === 0 ? 'wait' : 'pointer',
                              }}
                              title="用 OpenAI / 智谱 GLM 把原文切段向量化，召唤时按语义相似度检索（比 BM25 关键词质量高很多）。依赖你在设置里已配置 OpenAI 或 GLM 的 API key。"
                            >
                              {buttonLabel}
                            </button>
                            {hasIdx && (
                              <button
                                onClick={handleClearRagIndex}
                                disabled={!!building || !!batchRunning}
                                style={{
                                  padding: '4px 10px', fontSize: 11,
                                  border: '1px solid var(--border-light)', borderRadius: 4,
                                  background: 'transparent', color: 'var(--text-muted)',
                                  cursor: building || batchRunning ? 'not-allowed' : 'pointer',
                                }}
                                title="删除索引文件，下次召唤退回 BM25"
                              >
                                删
                              </button>
                            )}
                          </div>
                        </div>
                      )
                    })()}

                    {/* Expanded list — shows each source with its trust tier + a
                        remove button. This is what the user was missing when
                        they said "参考资料应该出现在蒸馏的环节". */}
                    {sourcePoolExpanded && (
                      <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 6, padding: '4px 2px' }}>
                        {totalSources === 0 && (
                          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', textAlign: 'center' }}>
                            资料池为空——用上面任一入口添加。
                          </div>
                        )}
                        {current.sourcesUsed.map(s => {
                          const trustColor = s.trust === 'primary' ? 'var(--success)'
                                           : s.trust === 'high'    ? 'var(--accent)'
                                           : s.trust === 'low'     ? 'var(--danger)'
                                           :                         'var(--text-muted)'
                          return (
                            <div key={s.id} style={{
                              display: 'flex', alignItems: 'flex-start', gap: 6,
                              padding: '6px 8px', marginBottom: 4, borderRadius: 4,
                              background: 'var(--bg)', border: '1px solid var(--border-light)',
                              fontSize: 10.5,
                            }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
                                  <span style={{ padding: '1px 6px', borderRadius: 3, background: SOURCE_COLOR[s.source], color: '#fff', fontSize: 9, fontWeight: 500 }}>
                                    {SOURCE_LABEL[s.source]}
                                  </span>
                                  <span style={{ padding: '1px 5px', borderRadius: 3, background: 'transparent', color: trustColor, fontSize: 9, fontWeight: 500, border: `1px solid ${trustColor}` }}>
                                    {s.trust === 'primary' ? '一手' : s.trust === 'high' ? '高可信' : s.trust === 'low' ? '低可信' : '中等'}
                                  </span>
                                  <span style={{ fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
                                    {s.title}
                                  </span>
                                </div>
                                {s.snippet && (
                                  <div style={{ color: 'var(--text-muted)', lineHeight: 1.5, fontSize: 10 }}>
                                    {s.snippet.slice(0, 120)}{s.snippet.length > 120 ? '…' : ''}
                                  </div>
                                )}
                              </div>
                              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                {s.url && !s.url.startsWith('data:') && (
                                  <button onClick={e => { e.stopPropagation(); window.electronAPI.nuwaOpenUrl?.(s.url) }}
                                          style={{ padding: '2px 6px', fontSize: 9, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' }}>
                                    原文
                                  </button>
                                )}
                                <button onClick={e => { e.stopPropagation(); handleRemoveSource(s.id) }}
                                        disabled={!!batchRunning}
                                        style={{ padding: '2px 6px', fontSize: 9, background: 'none', border: 'none', color: 'var(--danger)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                                  删
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Batch-run bar — always visible above the dim list. Gives
                  user 3 one-click options so they don't have to click each
                  dimension individually. */}
              {(() => {
                const pendingLike = dims.filter(x => x.dim.status === 'pending' || x.dim.status === 'error' || x.dim.status === 'skipped').length
                const doneCount2 = dims.filter(x => x.dim.status === 'done').length
                return (
                  <div style={{
                    display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
                    padding: '10px 12px', marginBottom: 10, borderRadius: 8,
                    background: 'var(--bg-warm)', border: '1px solid var(--border-light)',
                  }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 4 }}>批量：</span>
                    <button
                      onClick={() => handleRunBatch('distill-pending')}
                      disabled={!!batchRunning || pendingLike === 0}
                      style={{ padding: '5px 12px', fontSize: 11, border: 'none', borderRadius: 4, background: pendingLike > 0 && !batchRunning ? 'var(--accent)' : 'var(--border)', color: pendingLike > 0 && !batchRunning ? '#fff' : 'var(--text-muted)', cursor: pendingLike > 0 && !batchRunning ? 'pointer' : 'not-allowed', fontWeight: 500 }}
                      title="跑所有 待蒸馏 / 出错 / 跳过 的维度"
                    >
                      一键蒸馏{pendingLike > 0 && `（${pendingLike}）`}
                    </button>
                    <button
                      onClick={() => handleRunBatch('optimize-done')}
                      disabled={!!batchRunning || doneCount2 === 0}
                      style={{ padding: '5px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'transparent', color: doneCount2 > 0 && !batchRunning ? 'var(--accent)' : 'var(--text-muted)', cursor: doneCount2 > 0 && !batchRunning ? 'pointer' : 'not-allowed' }}
                      title="对所有已完成的维度跑增量优化（在现有基础上改进）"
                    >
                      一键优化{doneCount2 > 0 && `（${doneCount2}）`}
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm('重新蒸馏会覆盖所有 6 个维度（已完成的也重新来）。继续？')) handleRunBatch('rerun-all')
                      }}
                      disabled={!!batchRunning}
                      style={{ padding: '5px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}
                      title="全部 6 维从头蒸馏（覆盖现有）"
                    >
                      一键重新蒸馏
                    </button>
                    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
                      {batchRunning
                        ? `批量运行中 ${batchRunning.doneIdx}/${batchRunning.totalIdx}`
                        : pendingLike > 0 && doneCount2 === 0 ? '或逐维点击 ↓' : null}
                    </span>
                  </div>
                )
              })()}

              {/* Dimension list */}
              <div>
                {dims.map(({ def, dim }) => {
                  const isActive = activeDimension === def.key
                  return (
                    <div key={def.key}
                         onClick={() => setActiveDimension(def.key)}
                         style={{
                           padding: '10px 12px', marginBottom: 6, borderRadius: 6,
                           border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border-light)'}`,
                           background: isActive ? 'var(--accent-soft)' : 'var(--bg-warm)',
                           cursor: 'pointer', transition: 'border-color 0.15s, background 0.15s',
                         }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 15, color: statusColor(dim.status), width: 14, textAlign: 'center' }}>
                          {statusGlyph(dim.status)}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)' }}>
                            {def.label}
                            <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>{def.briefHint}</span>
                          </div>
                          {dim.fitness && (
                            <>
                              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontWeight: 600, color: dim.fitness.total >= 40 ? 'var(--success)' : dim.fitness.total >= 20 ? 'var(--warning)' : 'var(--danger)' }}>
                                  {dim.fitness.total}%
                                </span>
                                <span>·</span>
                                <span>{dim.fitness.notes.length} 条点评</span>
                              </div>
                              {/* 6-dim breakdown tiny heat bars — gives at-a-glance
                                  sense of WHERE the fitness loss is. */}
                              <div style={{ display: 'flex', gap: 2, marginTop: 4, maxWidth: 280 }} title="核心思想 / 生平锚定 / 世界观广度 / 语言风格 / 边界诚实 / 用户材料">
                                {([
                                  ['核心', dim.fitness.breakdown.coreThought, 20],
                                  ['生平', dim.fitness.breakdown.biographicalAnchor, 20],
                                  ['世界观', dim.fitness.breakdown.worldviewBreadth, 20],
                                  ['语言', dim.fitness.breakdown.languageStyle, 15],
                                  ['诚实', dim.fitness.breakdown.epistemicHonesty, 10],
                                  ['材料', dim.fitness.breakdown.userMaterialAlignment, 15],
                                ] as Array<[string, number, number]>).map(([label, score, max]) => {
                                  const r = score / max
                                  const c = r >= 0.6 ? 'var(--success)' : r >= 0.3 ? 'var(--warning)' : r > 0 ? 'var(--danger)' : 'var(--border)'
                                  return (
                                    <div key={label}
                                         title={`${label} ${score}/${max}`}
                                         style={{ flex: 1, height: 4, background: c, borderRadius: 1, opacity: r > 0 ? 1 : 0.4 }} />
                                  )
                                })}
                              </div>
                            </>
                          )}
                          {dim.status === 'error' && dim.errorMsg && (
                            <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 3 }}>
                              {dim.errorMsg}
                            </div>
                          )}
                        </div>
                        {/* Trailing action buttons — state-dependent */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                          {dim.status === 'pending' && (
                            <button onClick={e => { e.stopPropagation(); handleRunDimension(def.key) }}
                                    disabled={!!batchRunning}
                                    style={{ padding: '4px 10px', fontSize: 11, border: 'none', borderRadius: 3, background: batchRunning ? 'var(--border)' : 'var(--accent)', color: batchRunning ? 'var(--text-muted)' : '#fff', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                              开始蒸馏
                            </button>
                          )}
                          {dim.status === 'done' && (
                            <>
                              <button onClick={e => { e.stopPropagation(); handleOptimizeDimension(def.key) }}
                                      disabled={!!batchRunning}
                                      title="在现有内容基础上增量改进"
                                      style={{ padding: '3px 10px', fontSize: 10, border: '1px solid var(--accent)', borderRadius: 3, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--accent)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                                优化
                              </button>
                              <button onClick={e => { e.stopPropagation(); handleRunDimension(def.key) }}
                                      disabled={!!batchRunning}
                                      title="从零重新蒸馏此维（覆盖现有）"
                                      style={{ padding: '3px 10px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--text-muted)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                                重跑
                              </button>
                            </>
                          )}
                          {dim.status === 'error' && (
                            <button onClick={e => { e.stopPropagation(); handleRunDimension(def.key) }}
                                    disabled={!!batchRunning}
                                    style={{ padding: '3px 10px', fontSize: 10, border: '1px solid var(--danger)', borderRadius: 3, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--danger)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                              重试
                            </button>
                          )}
                          {dim.status === 'skipped' && (
                            <button onClick={e => { e.stopPropagation(); handleRunDimension(def.key) }}
                                    disabled={!!batchRunning}
                                    style={{ padding: '3px 10px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--text-muted)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                              重新蒸馏
                            </button>
                          )}
                          {/* Ingest file as per-dim source — works for any status.
                              File is added to the shared pool; user then triggers
                              optimize/rerun to have AI pick it up. */}
                          <label title="为此维附加资料文件（.txt / .md / .html）"
                                 style={{ padding: '3px 10px', fontSize: 10, border: '1px dashed var(--border)', borderRadius: 3, background: 'transparent', color: batchRunning ? 'var(--text-muted)' : 'var(--text-muted)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}
                                 onClick={e => e.stopPropagation()}>
                            + 资料
                            <input
                              type="file"
                              accept=".txt,.md,.html"
                              disabled={!!batchRunning}
                              onChange={async e => {
                                const f = e.target.files?.[0]
                                e.target.value = ''
                                if (f) await handleIngestForDimension(def.key, f)
                              }}
                              style={{ display: 'none' }}
                            />
                          </label>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Active dimension detail */}
              {active && activeDef && active.content && (
                <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--bg-warm)', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                    {activeDef.fullLabel}
                  </div>
                  {active.fitness && <FitnessBar fitness={active.fitness} defaultExpanded />}
                  <div className="annotation-markdown" style={{ fontSize: 12, lineHeight: 1.75, marginTop: 10, maxHeight: 360, overflow: 'auto', background: 'var(--bg)', padding: '10px 12px', borderRadius: 4 }}>
                    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {sanitizeMath(active.content)}
                    </ReactMarkdown>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    {active.status !== 'skipped' && (
                      <button onClick={() => handleSkipDimension(activeDimension!)}
                              disabled={!!batchRunning}
                              style={{ padding: '4px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text-muted)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                        标记为跳过
                      </button>
                    )}
                    {active.status === 'done' && (
                      <button onClick={() => handleOptimizeDimension(activeDimension!)}
                              disabled={!!batchRunning}
                              style={{ padding: '4px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 3, background: 'var(--accent-soft)', color: 'var(--accent)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                        优化此维
                      </button>
                    )}
                    <button onClick={() => handleRunDimension(activeDimension!)}
                            disabled={!!batchRunning}
                            style={{ padding: '4px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 3, background: 'transparent', color: 'var(--accent)', cursor: batchRunning ? 'not-allowed' : 'pointer' }}>
                      {active.status === 'done' ? '重跑此维' : '重新蒸馏'}
                    </button>
                  </div>
                </div>
              )}

              {/* Intro help text — only show when nothing's been attempted yet */}
              {doneCount === 0 && erroredCount === 0 && !active?.content && (
                <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--bg-warm)', borderRadius: 8, border: '1px dashed var(--border)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.75 }}>
                  <b style={{ color: 'var(--text-secondary)' }}>6 维度蒸馏说明</b><br />
                  每个维度是一次独立的 AI 调用——专门从勾选的资料里抽取该维度的信息（比如"著作"只找长文本、"表达 DNA"只看碎片表达）。<br />
                  每维完成后会自动评估该维的扮演保真度。你可以<b>按顺序做</b>，也可以<b>跳过不关心的维度</b>，也可以<b>随时重跑</b>。<br />
                  全部完成（或跳过）后，点底部的「综合成 skill」折叠成可用的 SKILL.md。
                </div>
              )}

              {/* Synthesize CTA — active when ≥ 2 dimensions have ended */}
              {(allSettled || doneCount >= 2) && (
                <div style={{ marginTop: 20, padding: '14px 16px', background: allSettled ? 'var(--accent-soft)' : 'var(--bg-warm)', borderRadius: 8, border: `1px solid ${allSettled ? 'var(--accent)' : 'var(--border)'}` }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
                    {allSettled ? '可以综合 skill 了' : '提前综合（可选）'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.7 }}>
                    已完成 {doneCount} / 6 维度。
                    {doneCount < 3 && '资料不足时综合出的 skill 拟合度会比较低，建议继续完成更多维度再综合。'}
                    {doneCount >= 3 && !allSettled && '也可以等 6 维全部完成再综合——质量会更高。'}
                  </div>
                  <button onClick={handleSynthesize}
                          style={{ padding: '8px 18px', fontSize: 12, fontWeight: 500, border: 'none', borderRadius: 4, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
                    综合成 skill →
                  </button>
                </div>
              )}
            </div>
          )
        })()}

        {/* === Synthesizing (streaming JSON → skill) === */}
        {stage === 'synthesizing' && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              正在综合 skill…
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
              AI 把 6 维研究折叠成心智模型、启发式、表达 DNA、时间线、诚实边界等结构化字段，然后生成 SKILL.md。
            </div>
            {streamingText && (
              <div style={{ fontSize: 10.5, fontFamily: 'ui-monospace, monospace', lineHeight: 1.65, background: 'var(--bg-warm)', padding: 12, borderRadius: 6, maxHeight: 'calc(100vh - 280px)', overflow: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
                {streamingText}
              </div>
            )}
          </div>
        )}

        {/* === Generating (legacy one-shot) === */}
        {stage === 'generating' && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="loading-spinner" style={{ width: 10, height: 10 }} />
              AI 正在撰写档案（可能会再联网补充细节）…
            </div>
            {streamingText && (
              <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.8, background: 'var(--bg-warm)', padding: '14px 18px', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {sanitizeMath(streamingText)}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {/* === Viewing / refining === */}
        {stage === 'viewing' && current && (
          <div>
            {/* Header */}
            <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--border-light)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text)' }}>
                  {current.canonicalName || current.name}
                </span>
                {current.identity && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{current.identity}</span>}
                <span style={{
                  fontSize: 9, padding: '1px 8px', borderRadius: 10, fontWeight: 500,
                  background: current.skillMode === 'distilled' ? 'var(--success)' : current.skillMode === 'imported' ? 'var(--accent)' : 'var(--text-muted)',
                  color: '#fff', whiteSpace: 'nowrap',
                }}>
                  {current.skillMode === 'distilled' ? '蒸馏' : current.skillMode === 'imported' ? '导入' : '旧档案'}
                </span>
                <button
                  onClick={() => handleDelete(current.id)}
                  style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 10, background: 'none', border: '1px solid var(--danger)', borderRadius: 3, color: 'var(--danger)', cursor: 'pointer' }}
                >删除</button>
              </div>
              {current.currentFitness && <FitnessBar fitness={current.currentFitness} />}
              {current.exportedPath && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                  上次导出：{current.exportedPath}（{new Date(current.exportedAt!).toLocaleString('zh-CN')}）
                </div>
              )}
              {current.importedFrom && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                  来源：{current.importedFrom}
                </div>
              )}
            </div>

            {/* Action row — mode-aware */}
            {current.skillMode === 'legacy' ? (
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                <button onClick={handleWebRefine} style={{ padding: '6px 12px', fontSize: 11, border: '1px solid var(--accent)', borderRadius: 4, background: 'var(--accent-soft)', color: 'var(--accent-hover)', cursor: 'pointer' }}>
                  再次联网补充
                </button>
                <button onClick={() => setIngestExpanded(!ingestExpanded)} style={{ padding: '6px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: ingestExpanded ? 'var(--bg-warm)' : 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  {ingestExpanded ? '收起投喂' : '投喂资料'}
                </button>
                <button onClick={handleUpgradeToDistilled} style={{ padding: '6px 12px', fontSize: 11, border: '1px dashed var(--accent)', borderRadius: 4, background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>
                  升级为蒸馏版 ↑
                </button>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>
                  {current.versions.length} 个版本 · 更新于 {new Date(current.updatedAt).toLocaleString('zh-CN')}
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                {/* 召唤对话功能暂锁：召回流程还在打磨（资料覆盖率 + 速率限制），
                    暂时不开放给用户用，避免体验差。等下个 batch 优化好再放开。 */}
                <button disabled
                        style={{ padding: '6px 14px', fontSize: 11, fontWeight: 500, border: '1px dashed var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'not-allowed' }}
                        title="召唤对话功能正在打磨：资料检索覆盖率 + 速率限制策略还需要再迭代一轮，先锁着避免体验落差">
                  🔒 召唤对话（敬请期待）
                </button>
                <button onClick={() => handleExportSkill()} style={{ padding: '6px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}
                        title="导出到 ~/.claude/skills/<slug>/">
                  导出 skill
                </button>
                <button onClick={() => handleExportSkill({ pickDir: true })} style={{ padding: '6px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  导出到…
                </button>
                {current.skillMode === 'distilled' && current.distillation && (
                  <button onClick={() => { setActiveDimension(null); setStage('distill-paused') }} style={{ padding: '6px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    回蒸馏流程
                  </button>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', alignSelf: 'center' }}>
                  {current.versions.length} 版本
                </span>
              </div>
            )}

            {/* Ingest panel (legacy only) */}
            {current.skillMode === 'legacy' && ingestExpanded && (
              <div style={{ marginBottom: 14, padding: 12, background: 'var(--bg-warm)', borderRadius: 6, border: '1px solid var(--border-light)' }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  {(['text', 'url', 'file'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setIngestType(t)}
                      style={{ padding: '4px 10px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, background: ingestType === t ? 'var(--accent)' : 'transparent', color: ingestType === t ? '#fff' : 'var(--text-muted)', cursor: 'pointer' }}
                    >
                      {t === 'text' ? '文本' : t === 'url' ? 'URL' : '文件'}
                    </button>
                  ))}
                </div>
                {ingestType === 'text' && (
                  <textarea
                    value={ingestText}
                    onChange={e => setIngestText(e.target.value)}
                    placeholder="粘贴你的笔记、一段文本、书摘、章节节选…"
                    rows={5}
                    style={{ width: '100%', padding: '6px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                )}
                {ingestType === 'url' && (
                  <input
                    type="url"
                    value={ingestUrl}
                    onChange={e => setIngestUrl(e.target.value)}
                    placeholder="https://example.com/article"
                    style={{ width: '100%', padding: '6px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', outline: 'none' }}
                  />
                )}
                {ingestType === 'file' && (
                  <label style={{ display: 'inline-block', padding: '8px 14px', fontSize: 11, border: '1px dashed var(--border)', borderRadius: 4, cursor: 'pointer', color: 'var(--text-muted)', background: 'var(--bg)' }}>
                    选择文件（.txt / .md）
                    <input
                      type="file"
                      accept=".txt,.md,.html"
                      onChange={handleFileIngest}
                      style={{ display: 'none' }}
                    />
                  </label>
                )}
                {ingestType !== 'file' && (
                  <button
                    onClick={handleIngestSubmit}
                    disabled={(ingestType === 'text' && !ingestText.trim()) || (ingestType === 'url' && !ingestUrl.trim())}
                    style={{ marginTop: 8, padding: '5px 14px', fontSize: 11, border: 'none', borderRadius: 4, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}
                  >
                    让 AI 吸收
                  </button>
                )}
              </div>
            )}

            {/* Refine preview (legacy path, pending confirmation) */}
            {current.skillMode === 'legacy' && refineDraft && (
              <div style={{ marginBottom: 14, padding: '10px 12px', background: 'rgba(255, 193, 7, 0.08)', border: '1px solid var(--warning)', borderRadius: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
                  AI 生成了新版（{refineDraft.changeNote}）—— 请确认
                </div>
                <div className="annotation-markdown" style={{ fontSize: 12, lineHeight: 1.7, maxHeight: 300, overflow: 'auto', background: 'var(--bg)', padding: '10px 12px', borderRadius: 4, marginBottom: 8 }}>
                  <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                    {sanitizeMath(refineDraft.content)}
                  </ReactMarkdown>
                </div>
                {refineDraft.fitness && <FitnessBar fitness={refineDraft.fitness} />}
                <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button onClick={handleRejectRefine} style={{ padding: '5px 14px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>拒绝</button>
                  <button onClick={handleAcceptRefine} style={{ padding: '5px 14px', fontSize: 11, border: 'none', borderRadius: 3, background: 'var(--success)', color: '#fff', cursor: 'pointer' }}>接受并保存</button>
                </div>
              </div>
            )}

            {/* Current content */}
            <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.85, color: 'var(--text)' }}>
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {sanitizeMath(current.content)}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* === Refining === */}
        {stage === 'refining' && (
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="loading-spinner" style={{ width: 10, height: 10 }} />
              AI 正在完善档案…
            </div>
            {streamingText && (
              <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.8, background: 'var(--bg-warm)', padding: '14px 18px', borderRadius: 8, border: '1px solid var(--border-light)' }}>
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {sanitizeMath(streamingText)}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {/* === Summoning: inline chat with the skill ===
            Intended as a lightweight MVP dialog. AgentPanel will later expose
            its own cross-conversation summon entry (phase 6) — this panel's
            history won't carry over there; it's scoped to the detail view. */}
        {stage === 'summoning' && current && (
          <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 180px)' }}>
            <div style={{ paddingBottom: 10, marginBottom: 10, borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
                召唤 · {current.canonicalName || current.name}
              </span>
              {current.identity && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{current.identity}</span>}
              <button onClick={handleCloseSummon}
                      style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                关闭对话
              </button>
            </div>

            <div style={{ flex: 1, overflow: 'auto', marginBottom: 12, paddingRight: 4 }}>
              {summonMessages.length === 0 && !summonStreaming && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7, padding: '12px 14px', background: 'var(--bg-warm)', borderRadius: 6, border: '1px dashed var(--border)' }}>
                  {summonRagInfo && summonRagInfo.totalChunks > 0 ? (
                    <div style={{ marginBottom: 6, color: 'var(--accent)' }}>
                      🔎 <b>RAG 已启用</b>：{summonRagInfo.hydratedSources} 份原文共 {summonRagInfo.totalChunks} 段可检索，每次提问会 BM25 选出 top-5 段注入对话，AI 会用 <code>[资料 N]</code> 标注引文来源。
                    </div>
                  ) : summonRagInfo ? (
                    <div style={{ marginBottom: 6, color: 'var(--warning)' }}>
                      ⚠️ <b>RAG 无可用原文</b>：此档案没有 hydrated 的 fullContent（可能是 imported skill 或 legacy 档案），对话只基于 skill 心智模型——AI 无法引原文，深度有限。
                    </div>
                  ) : null}
                  这是本档案的独立召唤对话——以该作者的思维方式回应。对话<b>不会</b>保存到历史（下次关闭后丢失）；如果想长期对话，用 Hermes 面板里的"召唤"入口。<br />
                  提问示例："你怎么看 X？""你当年为什么做 Y 的决定？""这段文字你会怎么批注？"
                </div>
              )}
              {summonMessages.map((m, i) => {
                // Wave-3: split citations into real (chunk found) vs hallucinated
                // (AI cited [资料 N] for an N never injected) so we can flag them.
                const realCites = (m.citations || []).filter(c => c.chunk)
                const fakeCites = (m.citations || []).filter(c => !c.chunk)
                return (
                  <div key={i} style={{
                    marginBottom: 10, padding: '10px 14px', borderRadius: 8,
                    background: m.role === 'user' ? 'var(--bg-warm)' : 'var(--accent-soft)',
                    border: '1px solid var(--border-light)',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span>{m.role === 'user' ? '你' : current.canonicalName || current.name}</span>
                      {/* Wave-3: per-turn retrieval badge on user msg */}
                      {m.role === 'user' && m.injectedChunks && m.injectedChunks.length > 0 && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 3,
                          background: m.retrievalMode === 'embedding' ? '#2c8a6f' : '#aa6633',
                          color: '#fff', fontSize: 9, fontWeight: 500,
                        }} title={`本次提问从 ${m.totalChunks} 段候选里 ${m.retrievalMode === 'embedding' ? '语义检索' : 'BM25 检索'} 出 ${m.injectedChunks.length} 段注入对话`}>
                          🔎 {m.retrievalMode === 'embedding' ? '语义' : 'BM25'} top-{m.injectedChunks.length}
                        </span>
                      )}
                      {m.role === 'user' && m.injectedChunks && m.injectedChunks.length === 0 && m.totalChunks !== undefined && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 3,
                          background: m.totalChunks === 0 ? 'var(--danger)' : 'var(--warning)',
                          color: '#fff', fontSize: 9, fontWeight: 500,
                        }} title={m.totalChunks === 0 ? '资料池里没有可检索的原文 — 触发"无资料硬兜底"，AI 只能讲方法论' : '资料池里有内容但本问题没匹配到'}>
                          ⛔ {m.totalChunks === 0 ? '无可检索资料' : '0 匹配'}
                        </span>
                      )}
                    </div>
                    <div className="annotation-markdown" style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--text)' }}>
                      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {sanitizeMath(m.role === 'assistant' ? normalizeCitations(m.content) : m.content)}
                      </ReactMarkdown>
                    </div>
                    {/* Wave-3: citation cards under assistant msg — only what was
                        actually cited, with hallucinated [资料 N] flagged in red. */}
                    {m.role === 'assistant' && (realCites.length > 0 || fakeCites.length > 0) && (
                      <div style={{
                        marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border-light)',
                      }}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 500 }}>
                          📚 引用核验（{realCites.length} 条真实{fakeCites.length > 0 ? ` · ${fakeCites.length} 条伪造` : ''}）
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {realCites.map(c => {
                            const trustColor = c.chunk!.trust === 'primary' ? 'var(--success)'
                                             : c.chunk!.trust === 'high'    ? 'var(--accent)'
                                             : c.chunk!.trust === 'low'     ? 'var(--danger)'
                                             :                                'var(--text-muted)'
                            return (
                              <div key={c.n} style={{
                                padding: '5px 8px', borderRadius: 4,
                                background: 'var(--bg)', border: '1px solid var(--border-light)',
                                fontSize: 10.5,
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' }}>
                                  <span style={{
                                    padding: '1px 5px', borderRadius: 3,
                                    background: 'var(--accent)', color: '#fff', fontSize: 9, fontWeight: 600,
                                  }}>资料 {c.n}</span>
                                  <span style={{ padding: '1px 5px', borderRadius: 3, background: 'transparent', color: trustColor, fontSize: 9, fontWeight: 500, border: `1px solid ${trustColor}` }}>
                                    {c.chunk!.trust === 'primary' ? '一手' : c.chunk!.trust === 'high' ? '高可信' : c.chunk!.trust === 'low' ? '低可信' : '中等'}
                                  </span>
                                  <span style={{ fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
                                    {c.chunk!.sourceTitle}
                                  </span>
                                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>· 片段 {c.chunk!.chunkIdx + 1}</span>
                                  {c.occurrences > 1 && (
                                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>· 引 {c.occurrences} 次</span>
                                  )}
                                  {c.chunk!.url && !c.chunk!.url.startsWith('data:') && (
                                    <button onClick={e => { e.stopPropagation(); window.electronAPI.nuwaOpenUrl?.(c.chunk!.url!) }}
                                            style={{ marginLeft: 'auto', padding: 0, fontSize: 9, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}>
                                      原文
                                    </button>
                                  )}
                                </div>
                                <div style={{ color: 'var(--text-muted)', fontSize: 10, lineHeight: 1.5, fontStyle: 'italic' }}>
                                  {c.chunk!.text.slice(0, 140)}{c.chunk!.text.length > 140 ? '…' : ''}
                                </div>
                              </div>
                            )
                          })}
                          {fakeCites.map(c => (
                            <div key={`fake-${c.n}`} style={{
                              padding: '5px 8px', borderRadius: 4,
                              background: 'rgba(231, 76, 60, 0.06)', border: '1px solid var(--danger)',
                              fontSize: 10.5, color: 'var(--danger)',
                            }} title="AI 引用了一个不存在的资料编号 — 这是幻觉，请不要信这部分内容">
                              ⚠️ [资料 {c.n}] · AI 编号超出注入范围（共 {(m.citations || []).length} 条引用，{fakeCites.length} 条伪造）
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              {summonStreaming && (
                <div style={{ marginBottom: 10, padding: '10px 14px', borderRadius: 8, background: 'var(--accent-soft)', border: '1px solid var(--border-light)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>
                    {current.canonicalName || current.name}
                    <span className="loading-spinner" style={{ marginLeft: 6, width: 8, height: 8 }} />
                  </div>
                  <div className="annotation-markdown" style={{ fontSize: 12.5, lineHeight: 1.75, color: 'var(--text)' }}>
                    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {sanitizeMath(summonStreaming)}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <textarea
                value={summonInput}
                onChange={e => setSummonInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSummonSend() }
                }}
                placeholder="输入你想问他的问题（Ctrl/Cmd + Enter 发送）"
                rows={3}
                disabled={summonBusy}
                style={{ flex: 1, padding: '8px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)', outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
              />
              <button
                onClick={handleSummonSend}
                disabled={summonBusy || !summonInput.trim()}
                style={{ padding: '8px 16px', fontSize: 12, border: 'none', borderRadius: 4, background: summonBusy || !summonInput.trim() ? 'var(--border)' : 'var(--accent)', color: summonBusy || !summonInput.trim() ? 'var(--text-muted)' : '#fff', cursor: summonBusy || !summonInput.trim() ? 'not-allowed' : 'pointer', alignSelf: 'stretch' }}
              >
                {summonBusy ? '...' : '发送'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===== Library picker modal =====
          Triggered by 「📚 从拾卷库挑」in distill-paused's source-pool bar.
          Lists only entries that are OCR'd. Entries whose title/authors mention
          the persona's canonical name are pre-selected as a convenience. */}
      {libPicker.open && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }}
             onClick={() => setLibPicker({ open: false, entries: [] })}>
          <div onClick={e => e.stopPropagation()}
               style={{
                 background: 'var(--bg)', borderRadius: 12,
                 border: '1px solid var(--border)',
                 maxWidth: 560, width: '100%', maxHeight: '80vh',
                 display: 'flex', flexDirection: 'column',
                 overflow: 'hidden',
               }}>
            <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                从拾卷库挑文献
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.6 }}>
                选中的文献会作为**一手资料**（OCR 文本）注入蒸馏池。只列 OCR 过的文献。
                和人物名字匹配的已默认勾选。
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '8px 18px' }}>
              {libPicker.entries.map(e => (
                <div key={e.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '8px 10px', marginBottom: 4, borderRadius: 6,
                  background: e.selected ? 'var(--accent-soft)' : 'transparent',
                  border: `1px solid ${e.selected ? 'var(--accent)' : 'var(--border-light)'}`,
                  cursor: 'pointer',
                }} onClick={() => setLibPicker(p => ({
                  ...p,
                  entries: p.entries.map(x => x.id === e.id ? { ...x, selected: !x.selected } : x),
                }))}>
                  <input type="checkbox" checked={e.selected} readOnly style={{ marginTop: 3 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', marginBottom: 2 }}>
                      {e.title}
                    </div>
                    {e.authors.length > 0 && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        {e.authors.join('、')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border-light)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setLibPicker({ open: false, entries: [] })}
                style={{ padding: '6px 14px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                取消
              </button>
              <button
                onClick={handleConfirmLibraryPicker}
                style={{ padding: '6px 14px', fontSize: 12, border: 'none', borderRadius: 4, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontWeight: 500 }}>
                加入资料池（{libPicker.entries.filter(e => e.selected).length} 部）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
