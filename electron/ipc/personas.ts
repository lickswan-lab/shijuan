import { ipcMain, app, shell, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuid } from 'uuid'
import type {
  Persona, PersonaSource, PersonaSkillArtifact, PersonaDimensionKey, Library,
} from '../../src/types/library'
import { atomicWriteJson, safeLoadJsonOrBackup } from './library'
import { multiSourceSearchInline } from './personas-search-helper'
import { chunkSource, bm25Search, type RagChunk } from './personaRagHelper'
// PERF-R8#18 · 用 cosineSimWithNormA + vectorNorm 把 query 端的 norm 提到循环外算一次
//   原 cosineSim 已不再被本文件用,但保留 export 给未来其它调用方
import { embedTexts, cosineSimWithNormA, vectorNorm, getEmbeddingProvider, listEmbeddingProviders, type EmbeddingProviderId } from './personaEmbeddingApi'
import { getApiKeyFor } from './aiApi'

// ===== Paths =====
const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const PERSONAS_DIR = path.join(DATA_DIR, 'agent', 'personas')

// Phase A · per-persona semantic index. Kept separate from the persona JSON so
// that re-saving the persona (e.g. editing a dimension) doesn't blow up the
// embedding blob. Blob size: chunks * dim * 8 bytes ≈ 500 chunks * 1536 dim
// ≈ 6 MB for a mid-size OpenAI index — still tiny per file.
function ragIndexFilePath(personaId: string): string {
  return path.join(PERSONAS_DIR, `${personaId}.rag.json`)
}

interface RagIndexEntry {
  sourceId: string
  sourceTitle: string
  sourceType: PersonaSource['source']
  trust: NonNullable<PersonaSource['trust']>
  chunkIdx: number
  text: string
  embedding: number[]
}

/** Per-source coverage report from the last build. Tells users which sources
 *  actually made it into the index vs. got skipped and why. Kept with the
 *  index file so `persona-rag-status` can return it without rebuilding. */
interface RagSourceCoverage {
  sourceId: string
  sourceTitle: string
  sourceType: PersonaSource['source']
  status: 'indexed' | 'skipped-empty' | 'skipped-short' | 'error'
  chunkCount: number
  reason?: string           // human-readable reason when skipped / errored
}

interface RagIndexFile {
  version: 1
  personaId: string
  provider: EmbeddingProviderId
  model: string
  dim: number
  builtAt: string           // ISO
  /** Snapshot of source identity at build time. Used to detect
   *  "needs rebuild": if the current persona's hydrated source set differs
   *  from this fingerprint, status reports needsRebuild=true. */
  sourceFingerprint: Array<{ id: string; length: number }>
  chunks: RagIndexEntry[]
  /** Phase-C coverage report: one entry per persona.sourcesUsed item at build
   *  time. Populated by buildRagIndexInternal; older indexes without it are
   *  treated as unknown coverage. */
  coverage?: {
    totalSources: number       // sourcesUsed.length at build time
    indexedSources: number     // sources that contributed at least one chunk
    skippedSources: number     // total - indexed - errored
    erroredSources: number     // sources whose chunker / embed failed
    perSource: RagSourceCoverage[]
  }
}

/** Compute a stable fingerprint of the hydrated sources. Used to decide whether
 *  an existing index is still valid. Two sources with the same id + same length
 *  are treated as unchanged (don't diff full content — cheaper). */
function computeSourceFingerprint(persona: Persona): Array<{ id: string; length: number }> {
  return (persona.sourcesUsed || [])
    .filter(s => s.fullContent)
    .map(s => ({ id: s.id, length: s.fullContent!.length }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function fingerprintsEqual(a: Array<{ id: string; length: number }>, b: Array<{ id: string; length: number }>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].length !== b[i].length) return false
  }
  return true
}

async function loadRagIndex(personaId: string): Promise<RagIndexFile | null> {
  try {
    const buf = await fs.readFile(ragIndexFilePath(personaId), 'utf-8')
    const parsed = JSON.parse(buf)
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.chunks)) return null
    return parsed as RagIndexFile
  } catch { return null }
}

/** Shared retrieval path — tries embedding first (if index built + provider key
 *  still available + query embedding succeeds), falls back to BM25 over freshly
 *  chunked sources. Used by both persona-rag-retrieve and
 *  persona-get-system-prompt.
 *
 *  Wave-4: also returns `injectedCitationIds` — the 1-based N numbers that
 *  will appear as [资料 N] markers when the caller builds a system prompt
 *  from these chunks. For a 5-chunk return this is [1,2,3,4,5]; empty when
 *  retrieval yields zero chunks. Callers can pass this straight to
 *  verifyCitations() to check AI citations against what was really injected.
 */
async function retrieveChunksInternal(personaId: string, query: string, topK: number): Promise<{
  chunks: Array<RagChunk & { score: number }>
  totalChunks: number
  retrievalMode: 'embedding' | 'bm25' | 'empty'
  injectedCitationIds: number[]
}> {
  const file = path.join(PERSONAS_DIR, `${personaId}.json`)
  const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
  if (!persona) throw new Error('档案不存在')

  // Try embedding path
  const idx = await loadRagIndex(personaId)
  if (idx && idx.chunks.length > 0 && query.trim()) {
    const apiKey = getApiKeyFor(idx.provider)
    if (apiKey) {
      try {
        const [queryVec] = await embedTexts([query], { providerId: idx.provider, apiKey })
        if (queryVec && queryVec.length === idx.dim) {
          // PERF-R8#18 · query 端 norm 在循环外预先算,N 个 chunk 内不再重算
          const normQuery = vectorNorm(queryVec)
          const scored = idx.chunks.map(c => {
            let score = cosineSimWithNormA(queryVec, normQuery, c.embedding)
            // Re-apply trust boost (same as BM25 path) — otherwise a wiki-heavy
            // index could outrank primary sources just because wiki tends to be
            // more keyword-dense.
            if (c.trust === 'primary') score *= 1.25
            else if (c.trust === 'high') score *= 1.1
            else if (c.trust === 'low') score *= 0.85
            return { chunk: c, score }
          })
          scored.sort((a, b) => b.score - a.score)
          const top = scored.slice(0, topK).filter(s => s.score > 0.1).map(({ chunk, score }) => ({
            sourceId: chunk.sourceId,
            sourceTitle: chunk.sourceTitle,
            sourceType: chunk.sourceType,
            trust: chunk.trust,
            chunkIdx: chunk.chunkIdx,
            text: chunk.text,
            score,
          }))
          return {
            chunks: top,
            totalChunks: idx.chunks.length,
            retrievalMode: 'embedding',
            injectedCitationIds: top.map((_, i) => i + 1),
          }
        }
      } catch {
        // Fall through to BM25 if embedding call failed (rate limit, network, etc.)
      }
    }
  }

  // BM25 fallback — chunk live sources, same as Phase B behavior
  const allChunks: RagChunk[] = []
  for (const s of persona.sourcesUsed || []) {
    if (!s.fullContent) continue
    allChunks.push(...chunkSource(s))
  }
  if (allChunks.length === 0) {
    return { chunks: [], totalChunks: 0, retrievalMode: 'empty', injectedCitationIds: [] }
  }
  if (!query.trim()) {
    return { chunks: [], totalChunks: allChunks.length, retrievalMode: 'bm25', injectedCitationIds: [] }
  }
  const results = bm25Search(allChunks, query, topK)
  return {
    chunks: results,
    totalChunks: allChunks.length,
    retrievalMode: 'bm25',
    injectedCitationIds: results.map((_, i) => i + 1),
  }
}

// ===== Phase C · Auto-build machinery =====
// A single persona should never have two concurrent builds. Builds can take
// 10-60s for embedding-heavy indexes, so we track in-flight ids in this set and
// skip duplicate triggers. On finish (success or failure) we clear the id.
const inFlightBuilds = new Set<string>()

/** Small helper: broadcast a build progress frame to every open window. Same
 *  channel the manual build uses ('persona-rag-build-progress'), so existing
 *  progress UI in PersonasTab keeps working for auto-builds too. The `trigger`
 *  field lets the UI distinguish auto vs. manual and choose whether to show
 *  a toast / intrusive banner. */
function emitBuildProgress(payload: {
  personaId: string
  phase: 'chunk' | 'embed' | 'save' | 'done' | 'error'
  done: number
  total: number
  /** Only set on phase === 'done' — the UI uses this to render the coverage
   *  summary in a toast ("12/15 sources indexed, 3 skipped"). */
  coverage?: RagIndexFile['coverage']
  /** 'auto' — triggered by persona save/import. 'manual' — user clicked build. */
  trigger: 'auto' | 'manual'
  error?: string
}) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('persona-rag-build-progress', payload) } catch {}
  }
}

/** Pick the best available embedding provider. Prefers GLM first (directly
 *  reachable from 大陆, cheaper), then OpenAI. Returns null if no key. */
function pickAvailableEmbeddingProvider(explicit?: EmbeddingProviderId): EmbeddingProviderId | null {
  if (explicit && getApiKeyFor(explicit)) return explicit
  if (getApiKeyFor('glm')) return 'glm'
  if (getApiKeyFor('openai')) return 'openai'
  return null
}

/** Core index build — extracted from the ipcMain handler so both manual
 *  triggers (user clicks "build" button) and auto triggers (after persona
 *  save / import) can share the same code path + coverage reporting.
 *
 *  Coverage contract: we walk persona.sourcesUsed once, for each source decide
 *  whether it contributes chunks (indexed) or not (skipped-empty / skipped-short
 *  / error). The `reason` string is user-facing — keep it concrete.
 *
 *  Returns the written index file on success, or throws on hard failure (no
 *  provider key, no chunks at all, embed network error). When it throws with
 *  "no chunks", `err.coverage` is attached so the caller can still surface
 *  per-source reasons in the UI.
 */
async function buildRagIndexInternal(
  personaId: string,
  opts: {
    providerId?: EmbeddingProviderId
    trigger: 'auto' | 'manual'
  },
): Promise<{ indexFile: RagIndexFile; chunkCount: number }> {
  const file = path.join(PERSONAS_DIR, `${personaId}.json`)
  const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
  if (!persona) throw new Error('档案不存在')

  const providerId = pickAvailableEmbeddingProvider(opts.providerId)
  if (!providerId) {
    // TODO (Phase D, local embeddings): if no provider key, fall back to a
    // bundled local MiniLM (via @xenova/transformers). Model ~20MB, 384-dim,
    // slower but no key needed. See personaEmbeddingApi.ts for the stub.
    throw new Error('需要配置 OpenAI 或智谱 GLM 的 API Key 才能建立语义索引')
  }
  const apiKey = getApiKeyFor(providerId)!
  const prov = getEmbeddingProvider(providerId)

  // Walk sourcesUsed once, collecting both chunks AND coverage reasons. A
  // source whose fullContent produces zero chunks is marked "skipped-short"
  // rather than silently dropped — that's the main reason users see "索引了
  // 3 段" when they expected more.
  const allChunks: RagChunk[] = []
  const perSource: RagSourceCoverage[] = []
  const sources = persona.sourcesUsed || []
  for (const s of sources) {
    const baseEntry = {
      sourceId: s.id,
      sourceTitle: s.title,
      sourceType: s.source,
    }
    if (!s.fullContent || !s.fullContent.trim()) {
      perSource.push({
        ...baseEntry,
        status: 'skipped-empty',
        chunkCount: 0,
        reason: '未抓取正文（可能 PDF 提取失败 / 页面拒绝访问 / 还没点 fetch）',
      })
      continue
    }
    let sourceChunks: RagChunk[]
    try {
      sourceChunks = chunkSource(s)
    } catch (err: any) {
      perSource.push({
        ...baseEntry,
        status: 'error',
        chunkCount: 0,
        reason: `分块失败：${err?.message || String(err)}`,
      })
      continue
    }
    if (sourceChunks.length === 0) {
      perSource.push({
        ...baseEntry,
        status: 'skipped-short',
        chunkCount: 0,
        reason: `正文太短（${s.fullContent.length} 字符），分块后无可用片段`,
      })
      continue
    }
    allChunks.push(...sourceChunks)
    perSource.push({
      ...baseEntry,
      status: 'indexed',
      chunkCount: sourceChunks.length,
    })
  }

  if (allChunks.length === 0) {
    const coverage = {
      totalSources: sources.length,
      indexedSources: 0,
      skippedSources: perSource.filter(p => p.status !== 'error').length,
      erroredSources: perSource.filter(p => p.status === 'error').length,
      perSource,
    }
    const err = new Error('无可用原文（没有任何源通过分块）')
    ;(err as any).coverage = coverage
    throw err
  }

  emitBuildProgress({
    personaId, phase: 'chunk', done: allChunks.length, total: allChunks.length,
    trigger: opts.trigger,
  })

  const texts = allChunks.map(c => c.text)
  const vectors = await embedTexts(texts, {
    providerId,
    apiKey,
    onProgress: (done, total) => emitBuildProgress({
      personaId, phase: 'embed', done, total, trigger: opts.trigger,
    }),
  })
  if (vectors.length !== allChunks.length) {
    throw new Error(`返回 embedding 数量不符（${vectors.length} vs ${allChunks.length}）`)
  }

  const coverage = {
    totalSources: sources.length,
    indexedSources: perSource.filter(p => p.status === 'indexed').length,
    skippedSources: perSource.filter(p => p.status === 'skipped-empty' || p.status === 'skipped-short').length,
    erroredSources: perSource.filter(p => p.status === 'error').length,
    perSource,
  }

  const indexFile: RagIndexFile = {
    version: 1,
    personaId,
    provider: providerId,
    model: prov.defaultModel,
    dim: vectors[0]?.length || prov.defaultDim,
    builtAt: new Date().toISOString(),
    sourceFingerprint: computeSourceFingerprint(persona),
    chunks: allChunks.map((c, i) => ({
      sourceId: c.sourceId,
      sourceTitle: c.sourceTitle,
      sourceType: c.sourceType,
      trust: c.trust,
      chunkIdx: c.chunkIdx,
      text: c.text,
      embedding: vectors[i],
    })),
    coverage,
  }
  emitBuildProgress({ personaId, phase: 'save', done: 0, total: 1, trigger: opts.trigger })
  await atomicWriteJson(ragIndexFilePath(personaId), indexFile)
  emitBuildProgress({
    personaId, phase: 'done', done: 1, total: 1,
    coverage, trigger: opts.trigger,
  })
  return { indexFile, chunkCount: allChunks.length }
}

/** Kick off an auto-build in the background if and only if:
 *   1. We have a provider key (no key → no point, UI prompts user instead)
 *   2. There's hydrated content to index (else build would fail with "no sources")
 *   3. No build is already in-flight for this persona
 *   4. Either no index exists OR the existing index is stale (persona updated
 *      after last build, OR source fingerprint no longer matches)
 *
 *  Non-blocking — returns immediately. Finishes via IPC progress frames;
 *  the UI refreshes on 'done' / 'error'. Any exception during build emits
 *  an 'error' frame so the UI can show a red chip with the reason.
 */
async function maybeTriggerAutoBuild(personaId: string): Promise<void> {
  if (inFlightBuilds.has(personaId)) return
  if (!pickAvailableEmbeddingProvider()) return  // no key → quiet skip

  const file = path.join(PERSONAS_DIR, `${personaId}.json`)
  const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
  if (!persona) return
  const hydrated = (persona.sourcesUsed || []).filter(s => s.fullContent && s.fullContent.trim()).length
  if (hydrated === 0) return  // nothing to index

  const idx = await loadRagIndex(personaId)
  if (idx) {
    // Skip auto-rebuild when index is newer than persona AND source fingerprint
    // still matches. Catches the "no-op save" case (user edited something
    // unrelated to sources, like identity text) — we don't want to burn
    // embedding quota on those.
    const personaUpdated = new Date(persona.updatedAt).getTime()
    const indexBuilt = new Date(idx.builtAt).getTime()
    const fpEq = fingerprintsEqual(idx.sourceFingerprint, computeSourceFingerprint(persona))
    if (fpEq && indexBuilt >= personaUpdated) return
  }

  inFlightBuilds.add(personaId)
  // Fire-and-forget. Caller (persona-save handler) returns IPC immediately.
  void (async () => {
    try {
      await buildRagIndexInternal(personaId, { trigger: 'auto' })
    } catch (err: any) {
      emitBuildProgress({
        personaId, phase: 'error', done: 0, total: 0,
        trigger: 'auto',
        error: err?.message || String(err),
        coverage: (err as any)?.coverage,
      })
    } finally {
      inFlightBuilds.delete(personaId)
    }
  })()
}

// Default Claude Code skills directory — per Claude Code spec, skills live at
// ~/.claude/skills/<slug>/SKILL.md. Users can override with a custom dir via
// persona-pick-export-dir, but 99% of exports go here.
const CLAUDE_SKILLS_DEFAULT_DIR = path.join(os.homedir(), '.claude', 'skills')

// Filename convention for per-dimension research notes inside the skill dir,
// matching alchaincyf/nuwa-skill's layout (references/research/01-*.md).
const DIMENSION_FILENAMES: Record<PersonaDimensionKey, string> = {
  writings:      '01-writings.md',
  conversations: '02-conversations.md',
  expression:    '03-expression-dna.md',
  externalViews: '04-external-views.md',
  decisions:     '05-decisions.md',
  timeline:      '06-timeline.md',
}

async function ensureDir() {
  await fs.mkdir(PERSONAS_DIR, { recursive: true })
}

// BUG-FIX #E · per-persona serializer for read-modify-write IPC handlers
// (currently used by persona-append-source). Prevents two concurrent
// append-source calls on the same persona from both reading the same
// baseline and losing one. Keyed by personaId; other personas can still
// progress in parallel. Tail-chain pattern — each call chains onto the
// stored promise; the stored promise gets replaced with a swallowed copy
// so a failing run doesn't block successors or leak "unhandled rejection".
// The map entry is pruned when this run is the tail (no successor queued).
const personaAppendLocks: Map<string, Promise<unknown>> = new Map()
function withPersonaAppendLock<T>(personaId: string, fn: () => Promise<T>): Promise<T> {
  const prior = personaAppendLocks.get(personaId) || Promise.resolve()
  const run = prior.catch(() => { /* don't let a prior failure block successors */ }).then(fn)
  const tail = run.catch(() => {})
  personaAppendLocks.set(personaId, tail)
  // Best-effort prune: if nothing newer chained on during this run, drop the
  // map entry so the Map doesn't grow forever with keys for deleted personas.
  void tail.then(() => {
    if (personaAppendLocks.get(personaId) === tail) {
      personaAppendLocks.delete(personaId)
    }
  })
  return run
}

/** Sanitize a skill slug to a safe directory name. Accepts user-provided slugs
 *  from the AI (which may have spaces, CJK, odd punctuation) and produces a
 *  filesystem-safe ASCII-ish name. Falls back to "persona-<id>" if the slug
 *  completely sanitizes to empty. */
function safeSkillSlug(slug: string, personaId: string): string {
  const cleaned = (slug || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')   // keep word chars + CJK + hyphen
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (cleaned) return cleaned
  return `persona-${personaId.slice(0, 8)}`
}

const SKILL_PORTRAIT_EXTS = ['png', 'jpeg', 'jpg', 'webp'] as const

async function copyImportedSkillPortrait(skillDir: string, personaId: string): Promise<void> {
  for (const ext of SKILL_PORTRAIT_EXTS) {
    const source = path.join(skillDir, `portrait.${ext}`)
    try {
      const stat = await fs.stat(source)
      if (!stat.isFile()) continue
      const targetDir = path.join(PERSONAS_DIR, personaId)
      await fs.mkdir(targetDir, { recursive: true })
      await fs.copyFile(source, path.join(targetDir, `portrait.${ext}`))
      return
    } catch {
      // Try the next supported image extension.
    }
  }
}

/** Parse a SKILL.md file. Returns both the raw markdown and a best-effort
 *  extraction of frontmatter fields (name, description, triggers). If the
 *  frontmatter isn't YAML-parseable with our minimal parser, returns the
 *  fullMarkdown untouched and frontmatter=null. */
function parseSkillMarkdown(md: string): {
  fullMarkdown: string
  frontmatter: { name: string; description: string; triggers: string[]; model?: string } | null
  body: string
} {
  // Frontmatter must start at position 0
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) {
    return { fullMarkdown: md, frontmatter: null, body: md }
  }
  const yaml = m[1]
  const body = md.slice(m[0].length)

  // Very small YAML parser — keys: 'name', 'description', 'model' are string
  // scalars; 'triggers' is a block list (leading "  - x" lines). Anything
  // fancier falls back to null.
  const frontmatter: { name: string; description: string; triggers: string[]; model?: string } = {
    name: '', description: '', triggers: [],
  }
  const lines = yaml.split(/\r?\n/)
  let inTriggers = false
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    if (inTriggers) {
      const listItem = line.match(/^\s+-\s+(.*)$/)
      if (listItem) {
        frontmatter.triggers.push(unquoteYaml(listItem[1].trim()))
        continue
      }
      inTriggers = false
      // fall through to normal parse
    }
    if (/^triggers:\s*$/.test(line)) { inTriggers = true; continue }
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const val = unquoteYaml(kv[2].trim())
    if (key === 'name') frontmatter.name = val
    else if (key === 'description') frontmatter.description = val
    else if (key === 'model') frontmatter.model = val || undefined
    else if (key === 'triggers') {
      // Flow list: [a, b, c]
      const flow = val.match(/^\[(.*)\]$/)
      if (flow) {
        frontmatter.triggers = flow[1].split(',').map(x => unquoteYaml(x.trim())).filter(Boolean)
      }
    }
  }

  // require at least a name to consider frontmatter valid
  if (!frontmatter.name) {
    return { fullMarkdown: md, frontmatter: null, body }
  }
  return { fullMarkdown: md, frontmatter, body }
}

function unquoteYaml(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1)
  }
  return s
}

// Shared User-Agent (Wikipedia and Baidu both discourage default Electron UA).
// Include contact-ish info per Wikimedia policy.
const UA = 'Shijuan/1.3 (https://github.com/lickswan-lab/shijuan; lickswan@gmail.com) Mozilla/5.0'

// Cap on fetched page content per source — AI generation prompts have a budget
// of ~20k tokens total, split across 3-8 sources. 4000 chars per source ≈ 1500
// tokens for Chinese content, leaving headroom for the prompt itself.
const MAX_SOURCE_CHARS = 4000
const MAX_SNIPPET_CHARS = 200

// Short timeout per external request so the whole search doesn't hang on one
// slow mirror. We aggregate in parallel so one slow source doesn't block others.
const FETCH_TIMEOUT_MS = 6000

// ===== Low-level fetch helper =====

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
        ...(opts.headers || {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

// ===== Source 1: Wikipedia (zh + en) =====
// REST API: https://zh.wikipedia.org/api/rest_v1/page/summary/{title}
// Search: https://zh.wikipedia.org/w/api.php?action=opensearch&search=...

async function searchWikipedia(query: string, lang: 'zh' | 'en'): Promise<PersonaSource[]> {
  try {
    const host = lang === 'zh' ? 'zh.wikipedia.org' : 'en.wikipedia.org'
    const searchUrl = `https://${host}/w/api.php?action=opensearch&format=json&limit=6&search=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(searchUrl)
    if (!res.ok) return []
    // opensearch returns [query, titles[], descriptions[], urls[]]
    const data: any = await res.json()
    if (!Array.isArray(data) || data.length < 4) return []
    const titles: string[] = data[1] || []
    const descs: string[] = data[2] || []
    const urls: string[] = data[3] || []
    return titles.map((title, i) => ({
      id: uuid(),
      title,
      snippet: (descs[i] || '').slice(0, MAX_SNIPPET_CHARS),
      url: urls[i] || `https://${host}/wiki/${encodeURIComponent(title)}`,
      source: (lang === 'zh' ? 'wikipedia-zh' : 'wikipedia-en') as PersonaSource['source'],
    }))
  } catch {
    return []
  }
}

async function fetchWikipediaExtract(url: string): Promise<string> {
  try {
    // Derive API endpoint from page URL
    const m = url.match(/^https?:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/(.+)$/)
    if (!m) return ''
    const lang = m[1]
    const title = decodeURIComponent(m[2])
    const api = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(title)}`
    const res = await fetchWithTimeout(api)
    if (!res.ok) return ''
    const data: any = await res.json()
    const pages: any = data?.query?.pages || {}
    const pageKey = Object.keys(pages)[0]
    const extract: string = pageKey ? (pages[pageKey]?.extract || '') : ''
    return extract.slice(0, MAX_SOURCE_CHARS)
  } catch {
    return ''
  }
}

// ===== Source 2: 百度百科 (scrape, limited) =====
// Baidu Baike doesn't have a public JSON API for general use; we fetch the
// item page and extract the summary block with a minimal regex. Fragile but
// cheap; when it breaks (layout change) we gracefully return empty.

async function searchBaiduBaike(query: string): Promise<PersonaSource[]> {
  try {
    const url = `https://baike.baidu.com/item/${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url, { redirect: 'follow' })
    if (!res.ok) return []
    const html = await res.text()
    // Strip HTML tags for snippet extraction; look for first meaningful paragraph
    // after the title area.
    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    const title = titleMatch ? titleMatch[1].replace(/_百度百科$/, '').trim() : query
    // Meta description works more reliably than body parsing across Baidu layouts
    const descMatch = html.match(/<meta name="description" content="([^"]+)"/i)
    const snippet = descMatch ? descMatch[1].slice(0, MAX_SNIPPET_CHARS) : ''
    if (!snippet) return []
    return [{
      id: uuid(),
      title: `${title}（百度百科）`,
      snippet,
      url,
      source: 'baidu-baike',
    }]
  } catch {
    return []
  }
}

async function fetchBaiduBaikeBody(url: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'follow' })
    if (!res.ok) return ''
    const html = await res.text()
    // Very rough text extraction: strip tags, collapse whitespace. Good enough
    // to give AI the gist of the page content.
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    // Try to locate the meaty body around 百度百科 content markers
    const startIdx = body.search(/(简介|概述|生平|简史|人物简介)/)
    const start = startIdx > 0 ? startIdx : Math.max(0, body.length > 1000 ? 300 : 0)
    return body.slice(start, start + MAX_SOURCE_CHARS)
  } catch {
    return ''
  }
}

// ===== Source 3: DuckDuckGo HTML =====
// DDG doesn't require an API key; we scrape their HTML endpoint. Results are
// generic (not structured), but give broad coverage for modern / niche figures
// where Wiki / Baidu might be thin.

async function searchDuckDuckGo(query: string): Promise<PersonaSource[]> {
  try {
    const url = `https://html.duckduckgo.com/html?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return []
    const html = await res.text()
    // Simple regex-based extraction — matches DDG's result-link class pattern
    const results: PersonaSource[] = []
    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    let count = 0
    while ((m = resultRegex.exec(html)) && count < 5) {
      const rawUrl = m[1]
      const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      const snippet = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS)
      // DDG wraps links in a redirect; unwrap if /l/?uddg=...
      let cleanUrl = rawUrl
      try {
        const u = new URL(rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl)
        if (u.searchParams.get('uddg')) cleanUrl = decodeURIComponent(u.searchParams.get('uddg')!)
      } catch { /* keep raw */ }
      if (!title || !cleanUrl) continue
      results.push({
        id: uuid(),
        title,
        snippet,
        url: cleanUrl,
        source: 'duckduckgo',
      })
      count++
    }
    return results
  } catch {
    return []
  }
}

async function fetchWebPageText(url: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'follow' })
    if (!res.ok) return ''
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) return ''
    const html = await res.text()
    // Very rough extraction as fallback
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return body.slice(0, MAX_SOURCE_CHARS)
  } catch {
    return ''
  }
}

// ===== Archive.org + Gutenberg full-text fetchers =====
// Both sources are "primary tier" — grabbing a real chapter of the actual work
// trumps any amount of Wikipedia condensation for persona distillation.

async function fetchArchiveOrgBody(detailsUrl: string): Promise<string> {
  try {
    // details URL: https://archive.org/details/<identifier>
    const m = detailsUrl.match(/archive\.org\/details\/([^/?#]+)/)
    if (!m) return ''
    const identifier = m[1]
    // Try djvu.txt first (most common plain-text extraction); fall back to
    // _text.txt (OCR output) or abbyy if djvu missing.
    const candidates = [
      `https://archive.org/download/${identifier}/${identifier}_djvu.txt`,
      `https://archive.org/download/${identifier}/${identifier}.txt`,
      `https://archive.org/download/${identifier}/${identifier}_text.txt`,
    ]
    for (const url of candidates) {
      try {
        const res = await fetchWithTimeout(url, {}, 15000)  // longer TO: books are big
        if (!res.ok) continue
        const ct = res.headers.get('content-type') || ''
        if (!ct.includes('text/plain') && !ct.includes('text/')) continue
        const text = await res.text()
        if (!text || text.length < 500) continue  // too short to be real book text
        return text.slice(0, MAX_SOURCE_CHARS * 4)  // books get 4x budget since they're primary
      } catch { continue }
    }
    return ''
  } catch {
    return ''
  }
}

async function fetchProjectGutenbergBody(plainTextUrl: string): Promise<string> {
  try {
    // plainTextUrl is already the /cache/epub/<id>/pg<id>.txt URL from the
    // search step; just fetch and slice.
    const res = await fetchWithTimeout(plainTextUrl, {}, 15000)
    if (!res.ok) return ''
    const text = await res.text()
    if (!text) return ''
    // Gutenberg files have a ~500-line license header + footer. Strip with
    // the standard `*** START OF THE PROJECT GUTENBERG EBOOK` / `*** END OF`
    // markers when present.
    const startMatch = text.match(/\*\*\*\s*START OF[^*]*\*\*\*/i)
    const endMatch = text.match(/\*\*\*\s*END OF[^*]*\*\*\*/i)
    const startIdx = startMatch ? text.indexOf(startMatch[0]) + startMatch[0].length : 0
    const endIdx = endMatch ? text.indexOf(endMatch[0]) : text.length
    const stripped = text.slice(startIdx, endIdx).trim()
    // Primary source: quadruple char budget
    return (stripped || text).slice(0, MAX_SOURCE_CHARS * 4)
  } catch {
    return ''
  }
}

// Fetch the detail body for a given source. Dispatches by source type.
async function fetchSourceBody(source: PersonaSource): Promise<string> {
  switch (source.source) {
    case 'wikipedia-zh':
    case 'wikipedia-en':
      return fetchWikipediaExtract(source.url)
    case 'baidu-baike':
      return fetchBaiduBaikeBody(source.url)
    case 'duckduckgo':
    case 'glm-web-search':
      // GLM search results are normal web URLs; same generic HTML→text path.
      return fetchWebPageText(source.url)
    case 'archive-org':
      return fetchArchiveOrgBody(source.url)
    case 'project-gutenberg':
      return fetchProjectGutenbergBody(source.url)
    case 'user-file':
    case 'user-url':
    case 'user-prompt':
      // User-ingested sources arrive with fullContent pre-populated by the
      // ingest IPC (nuwa-ingest-file/url/text). fullContent is the source of
      // truth — no re-fetch.
      return source.fullContent || ''
    default:
      return ''
  }
}

// ===== User-background context (Pain point #3) =====
// 当用户"召唤" persona 跳过了 Hermes ReAct 循环——persona 因此不会主动去检索用户的
// 阅读记录。用户反馈他们希望 persona 仍然能"知道"自己在读什么、最近关注什么，
// 以便对话更有针对性。方案：在 persona 的 system prompt 前面插一段用户背景块。
// 这不是"工具"也不是"可检索的参考资料"——就是让 persona 在生成回答时知道说话对象
// 是谁，avoids the "I have no way to know your recent reading, please tell me"
// response pattern.

const LIBRARY_FILE_FOR_CONTEXT = path.join(app.getPath('home'), '.lit-manager', 'library.json')
const APPRENTICE_DIR_FOR_CONTEXT = path.join(app.getPath('home'), '.lit-manager', 'agent', 'apprentice')
const META_DIR_FOR_CONTEXT = path.join(app.getPath('home'), '.lit-manager', 'meta')

/** Build a compact "user background" markdown block to prepend to the persona
 *  system prompt. Gathered best-effort from library.json + meta files +
 *  apprentice logs. Silent failures — a broken library shouldn't block summon.
 */
async function buildUserContextBlock(): Promise<string> {
  try {
    // 1. Library → recent entries (by lastOpenedAt, then addedAt)
    const library = await safeLoadJsonOrBackup<Library | null>(LIBRARY_FILE_FOR_CONTEXT, null)
    if (!library) return ''

    const entries = library.entries || []
    // "Recent reads" — sort by lastOpenedAt desc (fall back to addedAt),
    // filter out those never opened, take top 8.
    const recentReads = entries
      .filter(e => e.lastOpenedAt || e.addedAt)
      .sort((a, b) => {
        const at = a.lastOpenedAt || a.addedAt
        const bt = b.lastOpenedAt || b.addedAt
        return (bt || '').localeCompare(at || '')
      })
      .slice(0, 8)

    const recentReadsStr = recentReads
      .filter(e => e.lastOpenedAt)  // only truly opened, not just imported
      .slice(0, 8)
      .map(e => {
        const authors = (e.authors || []).filter(Boolean).slice(0, 2).join('、')
        const when = e.lastOpenedAt ? new Date(e.lastOpenedAt).toISOString().slice(0, 10) : ''
        return `《${e.title}》${authors ? ` · ${authors}` : ''}${when ? `（${when}）` : ''}`
      })

    // 2. Recent tags/topics — aggregate from recent entries
    const recentTagCounts = new Map<string, number>()
    for (const e of recentReads) {
      for (const t of (e.tags || [])) {
        if (!t || !t.trim()) continue
        recentTagCounts.set(t, (recentTagCounts.get(t) || 0) + 1)
      }
    }
    const topTags = Array.from(recentTagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t]) => t)

    // 3. Total notes count — aggregate annotations from meta/*.json
    let totalNotes = 0
    try {
      const metaFiles = await fs.readdir(META_DIR_FOR_CONTEXT)
      // Bounded scan: read up to 200 meta files to keep this cheap.
      // Typical libraries are 20-80 entries, so this rarely truncates.
      for (const f of metaFiles.slice(0, 200)) {
        if (!f.endsWith('.json')) continue
        try {
          const mpath = path.join(META_DIR_FOR_CONTEXT, f)
          const raw = await fs.readFile(mpath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed?.annotations)) totalNotes += parsed.annotations.length
        } catch { /* skip corrupt */ }
      }
    } catch { /* meta dir may not exist */ }

    // 4. Recent apprentice (weekly) summary — pick the newest .md
    let apprenticeSummary = ''
    try {
      const files = await fs.readdir(APPRENTICE_DIR_FOR_CONTEXT)
      const mdFiles: Array<{ file: string; mtime: number }> = []
      for (const f of files) {
        if (!f.endsWith('.md')) continue
        try {
          const s = await fs.stat(path.join(APPRENTICE_DIR_FOR_CONTEXT, f))
          mdFiles.push({ file: f, mtime: s.mtimeMs })
        } catch { /* skip */ }
      }
      mdFiles.sort((a, b) => b.mtime - a.mtime)
      if (mdFiles[0]) {
        const content = await fs.readFile(
          path.join(APPRENTICE_DIR_FOR_CONTEXT, mdFiles[0].file),
          'utf-8',
        )
        // Grab first ~600 chars as a gist — full weekly reports can be 5k+ chars,
        // and the AI just needs a vibe. Skip leading frontmatter / heading lines.
        const gist = content
          .replace(/^---[\s\S]*?---\s*/m, '')  // strip YAML frontmatter if any
          .trim()
          .slice(0, 600)
        apprenticeSummary = gist
      }
    } catch { /* apprentice dir may not exist */ }

    // Assemble the block. Skip the block entirely if all sources are empty.
    const lines: string[] = []
    if (recentReadsStr.length > 0) {
      lines.push(`- 最近阅读的文献：${recentReadsStr.join('；')}`)
    }
    if (totalNotes > 0) {
      lines.push(`- 累计笔记数：${totalNotes} 条`)
    }
    if (topTags.length > 0) {
      lines.push(`- 最近关注的主题/标签：${topTags.join('、')}`)
    }
    if (apprenticeSummary) {
      lines.push(`- 本周学习记录摘要：\n${apprenticeSummary.replace(/^/gm, '  ')}`)
    }

    if (lines.length === 0) return ''

    return `==== 用户背景（你可参考，但不主动提起，除非用户问）====
这是你正在对话的用户的阅读上下文，便于你针对性回答：
${lines.join('\n')}
===================================

`
  } catch {
    // Silent: a broken library must not block summon. If buildUserContextBlock
    // throws, the caller just uses the bare system prompt.
    return ''
  }
}

// ===== Persona CRUD =====

interface PersonaSummary {
  id: string
  name: string
  canonicalName?: string
  identity?: string
  updatedAt: string
  currentFitnessTotal?: number
}

// ===== IPC handlers =====

export function registerPersonasIpc(): void {
  // List all personas — returns summary (no heavy content)
  ipcMain.handle('persona-list', async (): Promise<{ success: boolean; entries: PersonaSummary[]; error?: string }> => {
    try {
      await ensureDir()
      const files = await fs.readdir(PERSONAS_DIR)
      const entries: PersonaSummary[] = []
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try {
          const full = await fs.readFile(path.join(PERSONAS_DIR, f), 'utf-8')
          const p = JSON.parse(full) as Persona
          entries.push({
            id: p.id,
            name: p.name,
            canonicalName: p.canonicalName,
            identity: p.identity,
            updatedAt: p.updatedAt,
            currentFitnessTotal: p.currentFitness?.total,
          })
        } catch { /* skip corrupt */ }
      }
      entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      return { success: true, entries }
    } catch (err: any) {
      return { success: false, entries: [], error: err.message }
    }
  })

  // Load a single persona in full
  ipcMain.handle('persona-load', async (_event, id: string): Promise<{ success: boolean; persona?: Persona; error?: string }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${id}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
      if (!persona) return { success: false, error: '档案不存在' }
      return { success: true, persona }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Save (create or update) a persona
  ipcMain.handle('persona-save', async (_event, persona: Persona): Promise<{ success: boolean; error?: string }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${persona.id}.json`)
      await atomicWriteJson(file, persona)
      // Phase C: background auto-build. Does NOT block the IPC return.
      // maybeTriggerAutoBuild() short-circuits if: no provider key, no
      // hydrated content, build already in-flight, or index already fresh.
      // On build finish the UI gets a 'persona-rag-build-progress' frame
      // with phase='done' (+ coverage) or phase='error'.
      void maybeTriggerAutoBuild(persona.id).catch(() => {})
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // 2026-04-24 "查看 skill 位置" —— 在系统文件管理器中定位 persona 文件。
  // 优先显示完整 skill 目录（PERSONAS_DIR/<id>/ 含 SKILL.md + dimensions），
  // 不存在则回落到 <id>.json 单文件。
  ipcMain.handle('persona-reveal', async (_event, id: string): Promise<{ success: boolean; path?: string; error?: string }> => {
    try {
      const dir = path.join(PERSONAS_DIR, id)
      const file = path.join(PERSONAS_DIR, `${id}.json`)
      try {
        const stat = await fs.stat(dir)
        if (stat.isDirectory()) {
          shell.showItemInFolder(dir)
          return { success: true, path: dir }
        }
      } catch { /* dir doesn't exist, try file */ }
      await fs.access(file)
      shell.showItemInFolder(file)
      return { success: true, path: file }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('persona-delete', async (_event, id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const file = path.join(PERSONAS_DIR, `${id}.json`)
      await fs.unlink(file)
      // BUG-FIX #1 · persona-delete leaves orphans
      // Previously only deleted <id>.json. The RAG index (<id>.rag.json),
      // user-overridden portrait dir (<DATA_DIR>/agent/personas/<id>/), and
      // saved summon sessions (<DATA_DIR>/agent/summons/<id>/) were left on
      // disk — a user who "deleted" a persona and re-imported a new one with
      // the same name still ended up with stale rag.json / history showing
      // up in obscure places. Clean them all up, best-effort.
      const ragFile = ragIndexFilePath(id)
      const portraitDir = path.join(PERSONAS_DIR, id)
      const summonsSubDir = path.join(app.getPath('home'), '.lit-manager', 'agent', 'summons', id)
      await Promise.all([
        fs.unlink(ragFile).catch((e) => { if (e?.code !== 'ENOENT') console.warn('[persona-delete] rag cleanup:', e?.message) }),
        fs.rm(portraitDir, { recursive: true, force: true }).catch((e) => console.warn('[persona-delete] portrait dir cleanup:', e?.message)),
        fs.rm(summonsSubDir, { recursive: true, force: true }).catch((e) => console.warn('[persona-delete] summons cleanup:', e?.message)),
      ])
      return { success: true }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // Main file is gone, but still try to sweep orphans in case of partial
        // state from earlier failed deletes.
        const ragFile = ragIndexFilePath(id)
        const portraitDir = path.join(PERSONAS_DIR, id)
        const summonsSubDir = path.join(app.getPath('home'), '.lit-manager', 'agent', 'summons', id)
        await Promise.all([
          fs.unlink(ragFile).catch(() => {}),
          fs.rm(portraitDir, { recursive: true, force: true }).catch(() => {}),
          fs.rm(summonsSubDir, { recursive: true, force: true }).catch(() => {}),
        ])
        return { success: true }
      }
      return { success: false, error: err.message }
    }
  })

  // BUG-FIX #E · persona-append-source read-modify-write on the main process
  // Previously PersonasTab's appendSource constructed `{ ...persona, sourcesUsed:
  // [...existing, src] }` using the stale persona prop as baseline and called
  // persona-save. If two appendSource calls fired concurrently (e.g. if the
  // UI was allowed to drop 3 files in a row), both read the same prop, both
  // appended to the same sourcesUsed array, and the second save overwrote the
  // first — one of the new sources was silently dropped.
  //
  // Fix: do the append in the backend, where we can load-then-save under a
  // per-persona mutex. Frontend calls this handler and receives the updated
  // persona; the UI just refreshes state from the return value.
  ipcMain.handle('persona-append-source', async (_event, personaId: string, source: PersonaSource): Promise<{
    success: boolean
    persona?: Persona
    error?: string
  }> => {
    if (!personaId) return { success: false, error: 'personaId 必填' }
    if (!source || typeof source !== 'object') return { success: false, error: 'source 不合法' }
    if (!source.id) return { success: false, error: 'source 缺少 id' }
    return withPersonaAppendLock(personaId, async () => {
      try {
        await ensureDir()
        const file = path.join(PERSONAS_DIR, `${personaId}.json`)
        const latest = await safeLoadJsonOrBackup<Persona | null>(file, null)
        if (!latest) return { success: false, error: '档案不存在' }
        // Skip if source.id already present (idempotent — retries don't dup).
        if ((latest.sourcesUsed || []).some(s => s.id === source.id)) {
          return { success: true, persona: latest }
        }
        const updated: Persona = {
          ...latest,
          sourcesUsed: [...(latest.sourcesUsed || []), source],
          updatedAt: new Date().toISOString(),
        }
        await atomicWriteJson(file, updated)
        void maybeTriggerAutoBuild(personaId).catch(() => {})
        return { success: true, persona: updated }
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) }
      }
    })
  })

  // ===== Web search (aggregated) =====
  // Now also queries GLM web-search-pro as a 7th source (when GLM key present)
  // — the original 6 sources often miss long-tail Chinese material, GLM's
  // jina-backed search fills that gap. See personas-search-helper.ts comment
  // on searchGlmWebSearchPro for the why.
  ipcMain.handle('nuwa-search', async (_event, query: string): Promise<{ success: boolean; sources: PersonaSource[]; error?: string }> => {
    try {
      if (!query || !query.trim()) return { success: true, sources: [] }
      const glmApiKey = getApiKeyFor('glm')
      const sources = await multiSourceSearchInline(query.trim(), { glmApiKey })
      return { success: true, sources }
    } catch (err: any) {
      return { success: false, sources: [], error: err.message }
    }
  })

  ipcMain.handle('nuwa-fetch-page', async (_event, source: PersonaSource): Promise<{ success: boolean; fullContent?: string; error?: string }> => {
    try {
      const fullContent = await fetchSourceBody(source)
      return { success: true, fullContent }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Open a URL in the user's default browser (for "see original" affordance)
  ipcMain.handle('nuwa-open-url', async (_event, url: string): Promise<{ success: boolean }> => {
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  // ===== Skill export =====
  // Writes the persona's skill.fullMarkdown to <outDir>/<slug>/SKILL.md plus,
  // if distillation data is present, the 6 research notes under
  // references/research/NN-*.md. Structure matches alchaincyf/nuwa-skill so the
  // exported directory is a drop-in Claude Code skill.
  ipcMain.handle('persona-export-skill', async (_event, personaId: string, opts?: {
    outDir?: string             // defaults to ~/.claude/skills/
    includeResearch?: boolean   // defaults to true if distillation exists
  }): Promise<{ success: boolean; skillDir?: string; error?: string }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${personaId}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
      if (!persona) return { success: false, error: '档案不存在' }
      if (!persona.skill?.fullMarkdown) {
        return { success: false, error: '该档案没有 skill 产物（可能是 legacy 档案，需先蒸馏升级）' }
      }

      const baseDir = opts?.outDir || CLAUDE_SKILLS_DEFAULT_DIR
      const slug = safeSkillSlug(persona.skill.skillSlug, persona.id)
      const skillDir = path.join(baseDir, slug)

      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), persona.skill.fullMarkdown, 'utf-8')

      // Write per-dimension research notes if available and user didn't opt out
      const withResearch = opts?.includeResearch !== false
      if (withResearch && persona.distillation) {
        const researchDir = path.join(skillDir, 'references', 'research')
        await fs.mkdir(researchDir, { recursive: true })
        for (const [key, dim] of Object.entries(persona.distillation.dimensions)) {
          if (!dim || dim.status !== 'done' || !dim.content) continue
          const fname = DIMENSION_FILENAMES[key as PersonaDimensionKey]
          if (!fname) continue
          await fs.writeFile(path.join(researchDir, fname), dim.content, 'utf-8')
        }
      }

      // Persist exported marker back into the persona record
      const updated: Persona = {
        ...persona,
        exportedAt: new Date().toISOString(),
        exportedPath: skillDir,
        updatedAt: new Date().toISOString(),
      }
      await atomicWriteJson(file, updated)

      return { success: true, skillDir }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Prompt user to pick a directory under which a skill will be created.
  // Returned path is the **parent** dir (the skill subdir <slug> is created by
  // the export step). If user cancels, success:true with undefined path.
  ipcMain.handle('persona-pick-export-dir', async (event): Promise<{ success: boolean; dir?: string }> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || undefined
      const r = await dialog.showOpenDialog(win as any, {
        title: '选择 skill 导出根目录（skill 会建在这个目录下的子文件夹）',
        defaultPath: CLAUDE_SKILLS_DEFAULT_DIR,
        properties: ['openDirectory', 'createDirectory'],
      })
      if (r.canceled || r.filePaths.length === 0) return { success: true }
      return { success: true, dir: r.filePaths[0] }
    } catch {
      return { success: false }
    }
  })

  // ===== Skill import =====
  // Reads a skill directory (containing SKILL.md) or a standalone SKILL.md
  // file, and creates a new Persona with skillMode='imported'. Frontmatter
  // is parsed with our minimal YAML reader; body stays as fullMarkdown for
  // lossless round-trip.
  ipcMain.handle('persona-import-skill', async (_event, absPath: string): Promise<{
    success: boolean
    persona?: Persona
    error?: string
  }> => {
    try {
      await ensureDir()
      // Resolve: if absPath is a directory, look for SKILL.md inside
      const stat = await fs.stat(absPath)
      const skillDir = stat.isDirectory() ? absPath : path.dirname(absPath)
      const skillMdPath = stat.isDirectory() ? path.join(absPath, 'SKILL.md') : absPath
      const md = await fs.readFile(skillMdPath, 'utf-8')

      const parsed = parseSkillMarkdown(md)
      if (!parsed.frontmatter) {
        return { success: false, error: '找不到可解析的 YAML frontmatter（要求至少有 name 字段）' }
      }

      const now = new Date().toISOString()
      const fm = parsed.frontmatter
      const skill: PersonaSkillArtifact = {
        skillSlug: path.basename(stat.isDirectory() ? absPath : path.dirname(absPath)) || safeSkillSlug(fm.name, ''),
        frontmatter: {
          name: fm.name,
          description: fm.description || '',
          triggers: fm.triggers,
          model: fm.model,
        },
        // Structured fields left empty — consumers should read fullMarkdown;
        // these are only populated for skills produced by this app.
        identityCard: '',
        mentalModels: [],
        heuristics: [],
        expressionDna: { vocabulary: [], patterns: [], metaphors: [], rhythm: '' },
        timeline: '',
        values: '',
        intellectualLineage: '',
        honestBoundaries: [],
        tensions: [],
        sourceReferences: [],
        fullMarkdown: parsed.fullMarkdown,
        synthesizedAt: now,
        model: '(imported)',
      }

      const persona: Persona = {
        id: uuid(),
        name: fm.name,
        canonicalName: fm.name,
        identity: fm.description || undefined,
        skillMode: 'imported',
        content: parsed.fullMarkdown,
        sourcesUsed: [],
        versions: [{
          content: parsed.fullMarkdown,
          generatedAt: now,
          model: '(imported)',
          changeNote: '导入自外部 skill 文件',
          skillSnapshot: skill,
        }],
        skill,
        importedFrom: absPath,
        createdAt: now,
        updatedAt: now,
      }

      const saveFile = path.join(PERSONAS_DIR, `${persona.id}.json`)
      await atomicWriteJson(saveFile, persona)
      await copyImportedSkillPortrait(skillDir, persona.id).catch((e) => {
        console.warn('[persona-import-skill] portrait copy skipped:', e?.message)
      })
      // Phase C: imported skills usually have empty sourcesUsed (external
      // skills don't ship their research pool), so auto-build short-circuits
      // at the "no hydrated content" check. Still call it for correctness —
      // if the user later pastes sources via ingest, another save triggers it.
      void maybeTriggerAutoBuild(persona.id).catch(() => {})
      return { success: true, persona }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Let the user pick a SKILL.md file OR a skill directory to import.
  ipcMain.handle('persona-pick-skill-path', async (event): Promise<{ success: boolean; path?: string }> => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender) || undefined
      const r = await dialog.showOpenDialog(win as any, {
        title: '选择 skill 目录或 SKILL.md',
        defaultPath: CLAUDE_SKILLS_DEFAULT_DIR,
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: 'Skill markdown', extensions: ['md'] }],
      })
      if (r.canceled || r.filePaths.length === 0) return { success: true }
      return { success: true, path: r.filePaths[0] }
    } catch {
      return { success: false }
    }
  })

  // ===== RAG retrieval (Phase A embedding + Phase B BM25 fallback) =====
  // Tries semantic (embedding cos sim) first if an index is built + the
  // provider key is still valid; otherwise falls back to BM25 over freshly
  // chunked sources. Reused by persona-get-system-prompt internally.
  //
  // Return shape carries retrievalMode so the UI can show "🧠 语义检索" vs
  // "🔎 关键词检索" as a small trust signal.
  ipcMain.handle('persona-rag-retrieve', async (_event, personaId: string, query: string, topK = 5): Promise<{
    success: boolean
    chunks?: Array<RagChunk & { score: number }>
    totalChunks?: number
    retrievalMode?: 'embedding' | 'bm25' | 'empty'
    error?: string
  }> => {
    try {
      const res = await retrieveChunksInternal(personaId, query, topK)
      return { success: true, ...res }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ===== RAG index build (Phase A) =====
  // Chunks every hydrated source, embeds via chosen provider, writes to
  // <personaId>.rag.json. Streams progress to the window via
  // 'persona-rag-build-progress' events so UI can show a progress bar.
  ipcMain.handle('persona-rag-build', async (_event, personaId: string, opts?: { providerId?: EmbeddingProviderId }): Promise<{
    success: boolean
    builtAt?: string
    chunkCount?: number
    provider?: EmbeddingProviderId
    model?: string
    dim?: number
    /** Phase-C: coverage report for the build. Included on both success (in
     *  the response body + in the 'done' progress frame) and on "no chunks"
     *  failure (so the UI can show users why their sources got dropped). */
    coverage?: RagIndexFile['coverage']
    error?: string
  }> => {
    try {
      await ensureDir()
      if (inFlightBuilds.has(personaId)) {
        // Block duplicate manual builds while an auto-build is in flight.
        // Return a 'coverage-friendly' soft error so UI can say "wait".
        return { success: false, error: '已有索引构建任务在进行中，请等待完成' }
      }
      inFlightBuilds.add(personaId)
      try {
        const { indexFile } = await buildRagIndexInternal(personaId, {
          providerId: opts?.providerId,
          trigger: 'manual',
        })
        return {
          success: true,
          builtAt: indexFile.builtAt,
          chunkCount: indexFile.chunks.length,
          provider: indexFile.provider,
          model: indexFile.model,
          dim: indexFile.dim,
          coverage: indexFile.coverage,
        }
      } finally {
        inFlightBuilds.delete(personaId)
      }
    } catch (err: any) {
      // Emit an 'error' frame so UIs that rendered "building…" can flip to
      // 'failed' even when they don't read the handler return (e.g. when the
      // build is observed via the progress channel only).
      emitBuildProgress({
        personaId, phase: 'error', done: 0, total: 0,
        trigger: 'manual',
        error: err?.message || String(err),
        coverage: (err as any)?.coverage,
      })
      return {
        success: false,
        error: err?.message || String(err),
        coverage: (err as any)?.coverage,
      }
    }
  })

  // ===== RAG index status (Phase A) =====
  // Tells the UI whether an index exists, when it was built, and whether it's
  // stale (source set changed since build).
  ipcMain.handle('persona-rag-status', async (_event, personaId: string): Promise<{
    success: boolean
    built: boolean
    needsRebuild?: boolean
    builtAt?: string
    provider?: EmbeddingProviderId
    model?: string
    dim?: number
    chunkCount?: number
    currentHydratedSources?: number
    availableProviders?: Array<{ id: EmbeddingProviderId; hasKey: boolean; displayName: string; model: string; dim: number }>
    /** Phase-C: true while a manual or auto build is running for this persona.
     *  UI uses this to show a spinner without subscribing to progress events. */
    buildInProgress?: boolean
    /** Phase-C: last build's coverage report (stored in the index file).
     *  Null for older indexes built before coverage tracking landed. */
    coverage?: RagIndexFile['coverage']
    error?: string
  }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${personaId}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
      if (!persona) return { success: false, built: false, error: '档案不存在' }

      const providers = listEmbeddingProviders().map(p => ({
        id: p.id as EmbeddingProviderId, hasKey: !!getApiKeyFor(p.id),
        displayName: p.displayName, model: p.defaultModel, dim: p.defaultDim,
      }))
      const hydratedSources = (persona.sourcesUsed || []).filter(s => s.fullContent).length
      const buildInProgress = inFlightBuilds.has(personaId)

      const idx = await loadRagIndex(personaId)
      if (!idx) {
        return {
          success: true, built: false,
          currentHydratedSources: hydratedSources,
          availableProviders: providers,
          buildInProgress,
        }
      }
      const needsRebuild = !fingerprintsEqual(idx.sourceFingerprint, computeSourceFingerprint(persona))
      return {
        success: true, built: true, needsRebuild,
        builtAt: idx.builtAt, provider: idx.provider, model: idx.model, dim: idx.dim,
        chunkCount: idx.chunks.length, currentHydratedSources: hydratedSources,
        availableProviders: providers,
        buildInProgress,
        coverage: idx.coverage,
      }
    } catch (err: any) {
      return { success: false, built: false, error: err.message }
    }
  })

  // ===== RAG index delete (Phase A) =====
  ipcMain.handle('persona-rag-clear', async (_event, personaId: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await fs.unlink(ragIndexFilePath(personaId)).catch(() => {})
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // ===== Summon system prompt =====
  // Returns the prompt string that should be used as the `system` message when
  // chatting as / with this persona. Three shapes by skillMode:
  //   - distilled / imported: SKILL.md body + a short "please roleplay as..." cap
  //   - legacy: content + a shorter cap (less fidelity, signaled)
  // The cap is minimal — most instructions live in SKILL.md itself (Agentic
  // Protocol, mental models, DNA). The runtime side just needs to set stage.
  //
  // When userQuery is passed, the prompt is augmented with BM25-retrieved
  // original-text snippets from persona.sourcesUsed — this forces the model to
  // cite real source passages instead of reciting pretrained-general knowledge.
  ipcMain.handle('persona-get-system-prompt', async (_event, personaId: string, userQuery?: string): Promise<{
    success: boolean
    systemPrompt?: string
    persona?: { id: string; name: string; canonicalName?: string; skillMode: Persona['skillMode'] }
    retrievedCount?: number
    retrievalMode?: 'embedding' | 'bm25' | 'empty'
    // Wave-3: return the actual chunks injected so the renderer can
    // reverse-parse [资料 N] markers in AI output back to source cards.
    chunks?: Array<{
      n: number
      sourceId: string
      sourceTitle: string
      sourceType: string
      trust: string
      chunkIdx: number
      text: string
      url?: string
    }>
    totalChunks?: number
    // Wave-4: the exact 1-based N's injected this turn (e.g. [1,2,3,4,5] when
    // 5 chunks were returned). Mirrors chunks.map(c => c.n) for convenience so
    // callers don't have to reconstruct the list before passing it to
    // ai-verify-citations. Empty when retrieval yields zero chunks.
    injectedCitationIds?: number[]
    error?: string
  }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${personaId}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
      if (!persona) return { success: false, error: '档案不存在' }

      const displayName = persona.canonicalName || persona.name

      // 2026-04-28 · 附属包加载 · 先前 personaImportSkill 只读 SKILL.md,bundled
      //   persona(plato/aristotle 等)的 6 份附属 md(MENTAL_MODELS / WORKS /
      //   EXPRESSION / TIMELINE / TENSIONS / CONTROVERSIES)完全没进 prompt,
      //   ~1800 行精心写的内容白白浪费。这里 system_prompt 构建时实时读取,
      //   不修改已存的 persona.json,改动最小。
      //
      //   失败容忍:任何文件读不到都跳过(用户可能删了 / persona 是用户自己
      //   蒸馏没有这些文件 → fullMarkdown 已含足够信息)。
      let appendixMd = ''
      if (persona.importedFrom) {
        try {
          const importStat = await fs.stat(persona.importedFrom).catch(() => null)
          // importedFrom 可能是目录(有附属包)或单 SKILL.md 文件(没附属)
          const skillDir = importStat?.isDirectory()
            ? persona.importedFrom
            : path.dirname(persona.importedFrom)
          const APPENDIX_FILES: Array<{ filename: string; section: string }> = [
            { filename: 'MENTAL_MODELS.md', section: '## 心智模型集' },
            { filename: 'WORKS.md',         section: '## 著作概览' },
            { filename: 'EXPRESSION.md',    section: '## 表达 DNA' },
            { filename: 'TIMELINE.md',      section: '## 生平时序' },
            { filename: 'TENSIONS.md',      section: '## 思想张力' },
            { filename: 'CONTROVERSIES.md', section: '## 同时代争论' },
          ]
          const parts: string[] = []
          for (const { filename, section } of APPENDIX_FILES) {
            try {
              const content = await fs.readFile(path.join(skillDir, filename), 'utf-8')
              if (content.trim()) parts.push(`${section}\n\n${content.trim()}`)
            } catch { /* 文件不存在,跳过 */ }
          }
          if (parts.length > 0) {
            // 2026-04-28 · 优先级 #3 · inline cite 指令
            //   附属包内容详尽,但 LLM 默认不会主动标"我用了哪部分"。这里在
            //   附属包开头声明引用格式,让 LLM 输出关键论点时附简短溯源标记
            //   如 (《心智模型集》 · 理念论)。用户能立刻判断"这是蒸馏好的内容"
            //   还是"LLM 凭训练记忆发挥",大幅提升可证伪性。
            //
            //   注意:与 RAG 路径的 [资料 N] 规则不冲突:
            //   - 有 RAG 命中:[资料 N] 引 sourcesUsed 原文(强约束)
            //   - 附属包内容:(《章节》 · 概念) 软约束
            //   两套并存,LLM 看到 prompt 自然分辨出来。
            const citeRule = `> ⚠ 引用约定:回答时若使用下面"附属知识包"里的具体心智模型 / 著作论点 / 思想张力 / 争论立场,请在该论点末尾加一个简短溯源标记,格式如 \`(《心智模型集》 · 理念论)\` 或 \`(《思想张力》 · 早期对话与晚期自我修正)\` ── 让用户能区分"哪些是蒸馏过的资料结论""哪些是你基于一贯立场的推演"。**不需要逐字引用,只标章节路径即可**。\n\n`
            appendixMd = `\n\n---\n\n# 附属知识包\n\n${citeRule}${parts.join('\n\n---\n\n')}`
          }
        } catch { /* importedFrom 异常,跳过 */ }
      }

      let sys: string
      if (persona.skill?.fullMarkdown) {
        sys = `你现在按下面这份 skill 扮演 **${displayName}**。严格遵循其中的 Agentic Protocol、心智模型、启发式与表达 DNA；遇到"诚实边界"里提到的资料空白，直接说"这超出我的已知"，不要编造。以第一人称回答，不要以第三人称谈论该人物。

**输出精简（软约束）**：默认回答控制在必要长度，优先思想动作 + 原文锚点 + 关键论证步骤，省略重复阐述、过渡客套、冗长背景介绍。除非用户明确要求"详尽展开"或"完整论证"，单轮回答尽量精简到 skill 内字数指引的 60% 左右——警句型人物（如老子）更短、论辩型人物（如墨子、孟子）保留必要推理链但去掉枝节。

---

${persona.skill.fullMarkdown}${appendixMd}`
      } else {
        // legacy fallback
        sys = `你现在根据下面这份资料扮演 **${displayName}**，以第一人称回答问题。这份资料不是蒸馏后的 skill，信息密度有限——遇到资料里没写的事项，坦白说"这超出我的已知"，不要编造。

---

${persona.content || '（资料为空）'}`
      }

      // === RAG augmentation ===
      // 三种状态对应三种约束（Wave-2 "无资料硬兜底" 抄 STORM）：
      //   1) chunks > 0      → 注入引文 + 强制 [资料 N] 标注
      //   2) totalChunks > 0 → 有索引但本问题没匹配 → 提醒诚实
      //   3) totalChunks = 0 → 完全无可检索资料 → 硬约束：只能讲方法论 + 立场
      let retrievedCount = 0
      let retrievalMode: 'embedding' | 'bm25' | 'empty' = 'empty'
      let returnedChunks: Array<{
        n: number; sourceId: string; sourceTitle: string; sourceType: string
        trust: string; chunkIdx: number; text: string; url?: string
      }> = []
      let returnedTotalChunks = 0
      if (userQuery && userQuery.trim()) {
        try {
          const r = await retrieveChunksInternal(personaId, userQuery, 5)
          retrievedCount = r.chunks.length
          retrievalMode = r.retrievalMode
          returnedTotalChunks = r.totalChunks
          if (r.chunks.length > 0) {
            // Wave-3: build the [资料 N] mapping. The N here is what the AI
            // will use in citations and what the renderer parses back out.
            const sourceUrlById = new Map<string, string | undefined>()
            for (const s of persona.sourcesUsed || []) sourceUrlById.set(s.id, s.url)
            returnedChunks = r.chunks.map((c, i) => ({
              n: i + 1,
              sourceId: c.sourceId,
              sourceTitle: c.sourceTitle,
              sourceType: c.sourceType,
              trust: c.trust,
              chunkIdx: c.chunkIdx,
              text: c.text,
              url: sourceUrlById.get(c.sourceId),
            }))
            const trustLabel = (t: string) => ({
              primary: '一手/原著', high: '权威', medium: '一般', low: '低权重(慎信)',
            } as Record<string, string>)[t] || t
            const citations = r.chunks.map((c, i) => {
              // 2026-04-28 · sectionPath 让 markdown 源的引用更可溯源
              //   "《MENTAL_MODELS》 · 心智模型集 / 理念论 (Theory of Forms)"
              //   而不是 "《MENTAL_MODELS》 · 片段 3"
              const locStr = c.sectionPath
                ? `${c.sourceType} · ${trustLabel(c.trust)} · ${c.sectionPath}`
                : `${c.sourceType} · ${trustLabel(c.trust)} · 片段 ${c.chunkIdx + 1}`
              return `[资料 ${i + 1}] 《${c.sourceTitle}》（${locStr}）\n> ${c.text.replace(/\n/g, '\n> ')}`
            }).join('\n\n')
            const modeLabel = r.retrievalMode === 'embedding' ? '语义 (embedding)' : '关键词 (BM25)'
            // Wave-4: expanded "严格规则" with reverse-parse warning. The
            // numbered-range wording is intentionally redundant with the item
            // below — LLMs (esp. smaller models) consistently miss one of the
            // two constraint framings, so stating it twice cuts hallucination
            // rates roughly in half in our internal tests.
            sys += `\n\n---\n\n## 本轮对话检索到的原文片段（务必引用 + 标注来源编号）\n\n> 检索方式：${modeLabel} · 从 ${r.totalChunks} 段候选中选 top-${r.chunks.length}\n\n${citations}\n\n---\n\n### 严格规则（本轮引用编号范围：[资料 1] 至 [资料 ${r.chunks.length}]）\n- **只能引用 [资料 1] 到 [资料 ${r.chunks.length}]**；不能编造更大数字，不能凭印象写 [资料 ${r.chunks.length + 1}] 或更高。超出范围的编号会被前端自动标红并提示"模型幻觉"。\n- 回答时，**能引用原文的部分必须**用 \`> blockquote\` 格式引原文，并在引文后加 **[资料 N]** 标注来源编号（格式严格：方括号 + 中文"资料" + 空格 + 数字 + 方括号）。\n- 原文里没有的事实 / 具体观点 / 原话：直接说"我的资料里没有涉及这点"或"这超出我调研的范围"，**不要脑补具体内容**。\n- 这些是按当前问题检索的 top-${r.chunks.length} 片段，可能遗漏相关章节——如果用户追问更多细节，可以说"我需要查更多章节"，不要强行编造。\n- 低权重 (慎信) 来源（百科洗稿）仅作交叉验证，不要作为主要引文。\n- 如果本轮完全没有可用片段，**宁可不写 [资料 N] 标记**，也不要凭空造一个编号。`
          } else if (r.totalChunks > 0) {
            sys += `\n\n---\n\n## ⚠️ 本轮对话未能检索到相关原文片段\n\n用户问题在我的资料池里没有高匹配的片段。请**诚实回答**：\n- 说"我的资料里没有直接涉及这个问题"\n- 可以在扮演边界内（根据我的心智模型 / 一贯立场）尝试推演，但必须标注"这是我基于一贯立场的推演，资料里没有直接原文"\n- **不要编造**具体事件、原话、著作细节`
          } else {
            // Wave-2 "无资料硬兜底" — STORM 风格的 hard-coded fallback。
            // 资料池完全空（或 0 hydrated content）时，LLM 没有任何检索锚点。
            // 明确禁止它给具体事实、原话、年份、地名——这些只能来自模型记忆，会幻觉。
            sys += `\n\n---\n\n## ⛔ 极重要：本档案没有任何可检索原文\n\n你**禁止**做以下事：\n1. 不要给出任何具体年份、事件、地名、人名、原话引用——你的资料池为空，所有具体细节都是模型记忆，可能错误\n2. 不要假装引用 [资料 N]——这次根本没检索到任何资料\n3. 不要回答"X 在 1820 年说过 Y"之类的事实问题\n\n你**只能**做的事：\n1. 讲方法论：你（${displayName}）会用什么思路看这个问题\n2. 讲立场倾向：根据 skill 心智模型，你大致会赞成 / 反对什么\n3. 主动建议用户："要回答这个具体问题，请先在资料池里加入 [具体著作 / 章节] 再来问我"`
          }
        } catch {
          // If retrieval crashed, fall through to bare skill prompt rather
          // than blocking the user.
        }
      }

      // === Pain point #3 · User background injection ===
      // Prepend a compact "who am I talking to" block so the persona is aware
      // of the user's recent reading / notes / weekly log context. Intentionally
      // placed BEFORE the skill body so the AI sees the user context first and
      // can tailor examples / references — but the skill body's "role-play as"
      // directive still dominates because it's the closer instruction to the
      // actual turn. Empty string if library is absent (best-effort).
      const userContext = await buildUserContextBlock()
      const finalSys = userContext ? `${userContext}${sys}` : sys

      return {
        success: true,
        systemPrompt: finalSys,
        retrievedCount,
        retrievalMode,
        chunks: returnedChunks,
        totalChunks: returnedTotalChunks,
        // Wave-4: echo back the N's injected this turn so callers can pass
        // them straight to ai-verify-citations without reconstructing. Derived
        // from returnedChunks — stays in sync even if we ever drop chunks below
        // top-K for low relevance scores.
        injectedCitationIds: returnedChunks.map(c => c.n),
        persona: {
          id: persona.id,
          name: persona.name,
          canonicalName: persona.canonicalName,
          skillMode: persona.skillMode,
        },
      }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
