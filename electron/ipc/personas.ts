import { ipcMain, app, shell, dialog, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { v4 as uuid } from 'uuid'
import type {
  Persona, PersonaSource, PersonaSkillArtifact, PersonaDimensionKey,
} from '../../src/types/library'
import { atomicWriteJson, safeLoadJsonOrBackup } from './library'
import { multiSourceSearchInline } from './personas-search-helper'
import { chunkSource, bm25Search, type RagChunk } from './personaRagHelper'
import { embedTexts, cosineSim, getEmbeddingProvider, listEmbeddingProviders, type EmbeddingProviderId } from './personaEmbeddingApi'
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
 *  persona-get-system-prompt. */
async function retrieveChunksInternal(personaId: string, query: string, topK: number): Promise<{
  chunks: Array<RagChunk & { score: number }>
  totalChunks: number
  retrievalMode: 'embedding' | 'bm25' | 'empty'
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
          const scored = idx.chunks.map(c => {
            let score = cosineSim(queryVec, c.embedding)
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
          return { chunks: top, totalChunks: idx.chunks.length, retrievalMode: 'embedding' }
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
    return { chunks: [], totalChunks: 0, retrievalMode: 'empty' }
  }
  if (!query.trim()) {
    return { chunks: [], totalChunks: allChunks.length, retrievalMode: 'bm25' }
  }
  const results = bm25Search(allChunks, query, topK)
  return { chunks: results, totalChunks: allChunks.length, retrievalMode: 'bm25' }
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
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('persona-delete', async (_event, id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const file = path.join(PERSONAS_DIR, `${id}.json`)
      await fs.unlink(file)
      return { success: true }
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { success: true }
      return { success: false, error: err.message }
    }
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
  ipcMain.handle('persona-rag-build', async (event, personaId: string, opts?: { providerId?: EmbeddingProviderId }): Promise<{
    success: boolean
    builtAt?: string
    chunkCount?: number
    provider?: EmbeddingProviderId
    model?: string
    dim?: number
    error?: string
  }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${personaId}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
      if (!persona) return { success: false, error: '档案不存在' }

      // Pick provider: explicit > whichever has a key. Prefer GLM for Chinese
      // users first (大陆直连), then OpenAI.
      let providerId = opts?.providerId
      if (!providerId) {
        if (getApiKeyFor('glm')) providerId = 'glm'
        else if (getApiKeyFor('openai')) providerId = 'openai'
        else return { success: false, error: '需要配置 OpenAI 或智谱 GLM 的 API Key 才能建立语义索引' }
      }
      const apiKey = getApiKeyFor(providerId)
      if (!apiKey) return { success: false, error: `${providerId} 未配置 API Key` }
      const prov = getEmbeddingProvider(providerId)

      // Chunk all hydrated sources
      const allChunks: RagChunk[] = []
      for (const s of persona.sourcesUsed || []) {
        if (!s.fullContent) continue
        allChunks.push(...chunkSource(s))
      }
      if (allChunks.length === 0) {
        return { success: false, error: '无可用原文（sourcesUsed 中没有 fullContent）' }
      }

      // Stream progress back to all windows
      const sendProgress = (phase: 'chunk' | 'embed' | 'save' | 'done', done: number, total: number) => {
        const payload = { personaId, phase, done, total }
        for (const win of BrowserWindow.getAllWindows()) {
          try { win.webContents.send('persona-rag-build-progress', payload) } catch {}
        }
      }
      sendProgress('chunk', allChunks.length, allChunks.length)

      // Embed in batches
      const texts = allChunks.map(c => c.text)
      const vectors = await embedTexts(texts, {
        providerId,
        apiKey,
        onProgress: (done, total) => sendProgress('embed', done, total),
      })
      if (vectors.length !== allChunks.length) {
        return { success: false, error: `返回 embedding 数量不符（${vectors.length} vs ${allChunks.length}）` }
      }

      const index: RagIndexFile = {
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
      }
      sendProgress('save', 0, 1)
      await atomicWriteJson(ragIndexFilePath(personaId), index)
      sendProgress('done', 1, 1)

      return {
        success: true,
        builtAt: index.builtAt,
        chunkCount: index.chunks.length,
        provider: providerId,
        model: index.model,
        dim: index.dim,
      }
    } catch (err: any) {
      return { success: false, error: err.message || String(err) }
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

      const idx = await loadRagIndex(personaId)
      if (!idx) {
        return { success: true, built: false, currentHydratedSources: hydratedSources, availableProviders: providers }
      }
      const needsRebuild = !fingerprintsEqual(idx.sourceFingerprint, computeSourceFingerprint(persona))
      return {
        success: true, built: true, needsRebuild,
        builtAt: idx.builtAt, provider: idx.provider, model: idx.model, dim: idx.dim,
        chunkCount: idx.chunks.length, currentHydratedSources: hydratedSources,
        availableProviders: providers,
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
    error?: string
  }> => {
    try {
      await ensureDir()
      const file = path.join(PERSONAS_DIR, `${personaId}.json`)
      const persona = await safeLoadJsonOrBackup<Persona | null>(file, null)
      if (!persona) return { success: false, error: '档案不存在' }

      const displayName = persona.canonicalName || persona.name
      let sys: string
      if (persona.skill?.fullMarkdown) {
        sys = `你现在按下面这份 skill 扮演 **${displayName}**。严格遵循其中的 Agentic Protocol、心智模型、启发式与表达 DNA；遇到"诚实边界"里提到的资料空白，直接说"这超出我的已知"，不要编造。以第一人称回答，不要以第三人称谈论该人物。

---

${persona.skill.fullMarkdown}`
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
            const citations = r.chunks.map((c, i) =>
              `[资料 ${i + 1}] 《${c.sourceTitle}》（${c.sourceType} · ${trustLabel(c.trust)} · 片段 ${c.chunkIdx + 1}）\n> ${c.text.replace(/\n/g, '\n> ')}`
            ).join('\n\n')
            const modeLabel = r.retrievalMode === 'embedding' ? '语义 (embedding)' : '关键词 (BM25)'
            sys += `\n\n---\n\n## 本轮对话检索到的原文片段（务必引用 + 标注来源编号）\n\n> 检索方式：${modeLabel} · 从 ${r.totalChunks} 段候选中选 top-${r.chunks.length}\n\n${citations}\n\n---\n\n### 使用规则（硬性）\n- 回答时，**能引用原文的部分必须**用 \`> blockquote\` 格式引原文，并在引文后加 **[资料 N]** 标注来源编号（格式严格：方括号 + 中文"资料" + 空格 + 数字 + 方括号）\n- 原文里没有的事实 / 具体观点 / 原话：直接说"我的资料里没有涉及这点"或"这超出我调研的范围"，**不要脑补具体内容**\n- 这些是按当前问题检索的 top-${r.chunks.length} 片段，可能遗漏相关章节——如果用户追问更多细节，可以说"我需要查更多章节"，不要强行编造\n- 低权重 (慎信) 来源（百科洗稿）仅作交叉验证，不要作为主要引文\n- **不要伪造编号**：只能用 [资料 1] ~ [资料 ${r.chunks.length}]，超出范围的编号会被前端识别为伪造`
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

      return {
        success: true,
        systemPrompt: sys,
        retrievedCount,
        retrievalMode,
        chunks: returnedChunks,
        totalChunks: returnedTotalChunks,
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
