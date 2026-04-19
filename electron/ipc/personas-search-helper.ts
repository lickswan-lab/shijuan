// Shared multi-source web search used by both:
//   1. `nuwa-search` IPC (renderer triggers "基础层" search, shows user
//      a clickable/removable source list)
//   2. The manual function-calling loop in aiApi.ts (for providers without
//      native web_search tool — OpenAI/DeepSeek/Doubao — we expose a
//      `web_search` function that they call, and we execute it here)
//
// Extracted to a tiny module so aiApi.ts → personas.ts cyclic import is avoided.

import { v4 as uuid } from 'uuid'
import type { PersonaSource } from '../../src/types/library'
import { throttleProvider, bumpProviderInterval, isRateLimitError } from './aiThrottle'

const UA = 'Shijuan/1.3 (https://github.com/lickswan-lab/shijuan; lickswan@gmail.com) Mozilla/5.0'
const FETCH_TIMEOUT_MS = 6000
const MAX_SNIPPET_CHARS = 200

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

async function searchWikipedia(query: string, lang: 'zh' | 'en'): Promise<PersonaSource[]> {
  try {
    const host = lang === 'zh' ? 'zh.wikipedia.org' : 'en.wikipedia.org'
    // Bumped 5 → 12: users need enough breadth to catch disambig neighbors
    // (e.g., "马克思" → Karl, Groucho, ...) and related concepts/works pages.
    const url = `https://${host}/w/api.php?action=opensearch&format=json&limit=12&search=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return []
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

async function searchBaiduBaike(query: string): Promise<PersonaSource[]> {
  try {
    const url = `https://baike.baidu.com/item/${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url, { redirect: 'follow' })
    if (!res.ok) return []
    const html = await res.text()
    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    const title = titleMatch ? titleMatch[1].replace(/_百度百科$/, '').trim() : query
    const descMatch = html.match(/<meta name="description" content="([^"]+)"/i)
    const snippet = descMatch ? descMatch[1].slice(0, MAX_SNIPPET_CHARS) : ''
    if (!snippet) return []
    return [{ id: uuid(), title: `${title}（百度百科）`, snippet, url, source: 'baidu-baike' }]
  } catch {
    return []
  }
}

// ===== Archive.org (free, texts mediatype) =====
// Advanced Search returns JSON. We query by creator name OR title to catch
// works BY the person and works ABOUT the person. Only texts (books/papers).
//
// NB: Archive.org has rate limits but is generous; 6s timeout is fine for
// a one-off persona seed search. Full text retrieval (for fullContent) is
// separate — see fetchArchiveOrgBody in personas.ts.
async function searchArchiveOrg(query: string): Promise<PersonaSource[]> {
  try {
    // Query: (creator:"<q>" OR title:"<q>" OR subject:"<q>") AND mediatype:texts
    // English-language filter removed — we want multilingual hits.
    const q = `(creator:"${query}" OR title:"${query}" OR subject:"${query}") AND mediatype:texts`
    const params = new URLSearchParams({
      q,
      'fl[]': 'identifier,title,creator,date,description',
      rows: '8',
      page: '1',
      output: 'json',
      sort: 'downloads desc',  // popular editions first (proxy for canonicity)
    })
    // Archive.org allows multiple fl[] params; URLSearchParams dedups keys.
    // Build manually to keep them separate. rows bumped 8 → 25 — archive is
    // the top-tier source for social science, more hits = more primary material.
    const qstr = `q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&fl[]=description&rows=25&page=1&output=json&sort=downloads+desc`
    void params  // silence linter
    const url = `https://archive.org/advancedsearch.php?${qstr}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return []
    const data: any = await res.json()
    const docs: any[] = data?.response?.docs || []
    return docs.map((d: any) => {
      const id = String(d.identifier || '')
      const title = String(d.title || id)
      const creator = Array.isArray(d.creator) ? d.creator.join('、') : String(d.creator || '')
      const date = String(d.date || '').slice(0, 10)
      const descRaw = Array.isArray(d.description) ? d.description[0] : d.description
      const descStr = String(descRaw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const snippet = [creator, date, descStr].filter(Boolean).join(' · ').slice(0, MAX_SNIPPET_CHARS)
      return {
        id: uuid(),
        title: `${title}${creator ? ` — ${creator}` : ''}（Archive.org）`,
        snippet,
        url: `https://archive.org/details/${id}`,
        source: 'archive-org' as PersonaSource['source'],
      }
    }).filter(r => r.url)
  } catch {
    return []
  }
}

// ===== Project Gutenberg (via Gutendex API) =====
// Gutendex (https://gutendex.com) is the community-maintained Gutenberg API.
// Full text download URLs are in the `formats` field — we surface one plain-text
// link as url, so fetchSourceBody can pull the whole book.
async function searchProjectGutenberg(query: string): Promise<PersonaSource[]> {
  try {
    const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return []
    const data: any = await res.json()
    const results: any[] = data?.results || []
    return results.slice(0, 15).map((b: any) => {  // bumped 6 → 15
      const title = String(b.title || '')
      const authors = Array.isArray(b.authors) ? b.authors.map((a: any) => a.name).join('、') : ''
      const formats: Record<string, string> = b.formats || {}
      // prefer plain text UTF-8, fall back to other text formats
      const textUrl = formats['text/plain; charset=utf-8']
        || formats['text/plain; charset=us-ascii']
        || formats['text/plain']
        || formats['application/epub+zip']  // last resort, won't be readable
        || `https://www.gutenberg.org/ebooks/${b.id}`
      return {
        id: uuid(),
        title: `${title}${authors ? ` — ${authors}` : ''}（Project Gutenberg）`,
        snippet: `${authors}${b.subjects?.length ? ' · ' + b.subjects.slice(0, 2).join('、') : ''}`.slice(0, MAX_SNIPPET_CHARS),
        url: textUrl,
        source: 'project-gutenberg' as PersonaSource['source'],
      }
    })
  } catch {
    return []
  }
}

// ===== 智谱 GLM web-search-pro =====
// GLM 提供独立的 /tools 接口，能直接调用 web-search-pro 拿原始搜索结果（带
// title / content / link），不走 chat completions（chat 那条只能让 AI 内部
// 用 search 然后总结，结果出不来）。优势：能补齐其他 6 源的中文长尾盲区
// （比如非著名学者、特定主题的中文长 tail 资料），而且 jina 引擎质量比 DDG
// HTML 爬虫稳定得多。
//
// 端点：POST https://open.bigmodel.cn/api/paas/v4/tools
// 请求：{ request_id, tool: 'web-search-pro', stream: false, messages: [...] }
// 响应：choices[0].message.tool_calls[].search_result: Array<{ title, content,
//        link, media, refer, ... }>
//
// 失败模式静默返回 []：无 key、429、网络错误、tools 接口未启用都不应阻塞
// 其他 6 源的并行搜索。
async function searchGlmWebSearchPro(query: string, apiKey: string): Promise<PersonaSource[]> {
  if (!apiKey) return []
  try {
    // 走主进程节流：与 chat / embedding 共用 GLM 配额
    await throttleProvider('glm')
    const res = await fetchWithTimeout('https://open.bigmodel.cn/api/paas/v4/tools', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        request_id: uuid(),
        tool: 'web-search-pro',
        stream: false,
        messages: [{ role: 'user', content: query }],
      }),
    }, 15000)
    if (!res.ok) {
      // 撞墙 → 把 GLM 间隔翻倍，下次 throttle 自动拉长
      const body = await res.text().catch(() => '')
      if (isRateLimitError(`${res.status} ${body}`)) bumpProviderInterval('glm')
      return []
    }
    const data: any = await res.json()
    const toolCalls: any[] = data?.choices?.[0]?.message?.tool_calls || []
    const out: PersonaSource[] = []
    for (const tc of toolCalls) {
      const items: any[] = tc?.search_result || []
      for (const r of items) {
        const url = String(r?.link || '').trim()
        if (!url) continue
        const title = String(r?.title || r?.media || url).replace(/\s+/g, ' ').trim()
        const snippet = String(r?.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS)
        out.push({
          id: uuid(),
          title: `${title}（GLM 搜索）`,
          snippet,
          url,
          source: 'glm-web-search',
        })
      }
    }
    return out
  } catch {
    return []
  }
}

async function searchDuckDuckGo(query: string): Promise<PersonaSource[]> {
  try {
    const url = `https://html.duckduckgo.com/html?q=${encodeURIComponent(query)}`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return []
    const html = await res.text()
    const results: PersonaSource[] = []
    const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    let count = 0
    while ((m = resultRegex.exec(html)) && count < 5) {
      const rawUrl = m[1]
      const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      const snippet = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS)
      let cleanUrl = rawUrl
      try {
        const u = new URL(rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl)
        if (u.searchParams.get('uddg')) cleanUrl = decodeURIComponent(u.searchParams.get('uddg')!)
      } catch { /* keep raw */ }
      if (!title || !cleanUrl) continue
      results.push({ id: uuid(), title, snippet, url: cleanUrl, source: 'duckduckgo' })
      count++
    }
    return results
  } catch {
    return []
  }
}

export async function multiSourceSearchInline(query: string, opts?: { glmApiKey?: string }): Promise<PersonaSource[]> {
  // All 7 sources fire in parallel. One slow / failing source can't hold up the
  // batch — each has its own timeout + try/catch → []. GLM search is opt-in
  // (requires apiKey passed in by caller from getApiKeyFor('glm')); without
  // a key it short-circuits to [] without hitting the network.
  const glmKey = opts?.glmApiKey || ''
  const [zhWiki, enWiki, baike, archive, gutenberg, ddg, glm] = await Promise.all([
    searchWikipedia(query, 'zh'),
    searchWikipedia(query, 'en'),
    searchBaiduBaike(query),
    searchArchiveOrg(query),
    searchProjectGutenberg(query),
    searchDuckDuckGo(query),
    searchGlmWebSearchPro(query, glmKey),
  ])
  // Priority ordering matches the trust tier — primary-trust sources (Gutenberg,
  // Archive.org) surface above encyclopedias so users see the real goods first.
  // GLM (medium tier, but rich snippets) sits between encyclopedias and DDG.
  const seen = new Set<string>()
  const all: PersonaSource[] = []
  for (const r of [...gutenberg, ...archive, ...zhWiki, ...enWiki, ...glm, ...ddg, ...baike]) {
    if (!r.url || seen.has(r.url)) continue
    seen.add(r.url)
    all.push(r)
  }
  return all
}
