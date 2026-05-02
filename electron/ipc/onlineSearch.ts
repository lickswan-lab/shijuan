import { app, BrowserWindow, ipcMain, session as electronSession } from 'electron'
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import type {
  OnlineDownloadRequest,
  OnlineDownloadResponse,
  OnlineSiteLoginRequest,
  OnlineSiteLoginResponse,
  OnlineSiteSessionRequest,
  OnlineSiteSessionStatus,
  OnlineSearchRequest,
  OnlineSearchResponse,
  OnlineSearchResult,
} from '../../src/types/onlineSearch'

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads')
const ONLINE_SESSION_PARTITION = 'persist:shijuan-online-sites'
const UA = 'Shijuan/1.3 online-resource-discovery Mozilla/5.0'
const ONLINE_SEARCH_LOCKED = true
const ONLINE_SEARCH_LOCKED_MESSAGE = '在线搜索模式暂时关闭'
const FETCH_TIMEOUT_MS = 12000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const MAX_RESULT_PAGES = 12
const MAX_VERIFY_LINKS = 40

const SUPPORTED_EXTS = ['pdf', 'docx', 'doc', 'epub', 'html', 'htm', 'txt', 'md'] as const
type SupportedExt = typeof SUPPORTED_EXTS[number]

const CONTENT_TYPE_EXT: Array<[RegExp, SupportedExt]> = [
  [/application\/pdf/i, 'pdf'],
  [/application\/epub\+zip/i, 'epub'],
  [/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/i, 'docx'],
  [/application\/msword/i, 'doc'],
  [/text\/markdown/i, 'md'],
  [/text\/plain/i, 'txt'],
  [/text\/html/i, 'html'],
]

interface LinkInfo {
  href: string
  text: string
}

interface VerifiedLink {
  url: string
  title: string
  extension: SupportedExt
  fileName: string
  sourcePageUrl: string
  sourcePageTitle?: string
  contentType?: string
  sizeBytes?: number
  verified: boolean
}

interface FetchOptions {
  useSiteSession?: boolean
}

function getOnlineSession() {
  return electronSession.fromPartition(ONLINE_SESSION_PARTITION)
}

function normalizedHeaders(initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders || {})
  if (!headers.has('User-Agent')) headers.set('User-Agent', UA)
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.6')
  return headers
}

async function cookieHeaderForUrl(url: string): Promise<string> {
  const cookies = await getOnlineSession().cookies.get({ url })
  return cookies
    .filter(c => c.name && c.value != null)
    .map(c => `${c.name}=${c.value}`)
    .join('; ')
}

async function requestHeaders(url: string, init: RequestInit, opts: FetchOptions): Promise<Headers> {
  const headers = normalizedHeaders(init.headers)
  if (opts.useSiteSession && !headers.has('Cookie')) {
    const cookie = await cookieHeaderForUrl(url)
    if (cookie) headers.set('Cookie', cookie)
  }
  return headers
}

async function fetchWithRedirects(url: string, init: RequestInit, opts: FetchOptions): Promise<Response> {
  let currentUrl = url
  let currentInit = init
  const useManualRedirect = !!opts.useSiteSession

  for (let i = 0; i < 8; i++) {
    const headers = await requestHeaders(currentUrl, currentInit, opts)
    const res = await fetch(currentUrl, {
      ...currentInit,
      redirect: useManualRedirect ? 'manual' : 'follow',
      headers,
    })
    if (!useManualRedirect || res.status < 300 || res.status >= 400) return res

    const location = res.headers.get('location')
    if (!location) return res
    const nextUrl = new URL(location, currentUrl).toString()
    const method = String(currentInit.method || 'GET').toUpperCase()
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      const { body: _body, ...rest } = currentInit as any
      currentInit = { ...rest, method: 'GET' }
    }
    currentUrl = nextUrl
  }
  throw new Error('重定向次数过多')
}

function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  opts: FetchOptions = {},
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  return fetchWithRedirects(url, {
    ...init,
    signal: ctrl.signal,
  }, opts).finally(() => clearTimeout(timer))
}

function normalizeHttpUrl(raw: string): URL {
  const input = String(raw || '').trim()
  if (!input) throw new Error('请填写网站地址')
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https 网站')
  }
  return url
}

function siteUrlWithoutTemplate(raw: string): string {
  return String(raw || '').replace(/\{query\}/g, '').trim()
}

function siteOriginUrl(raw: string): string {
  const url = normalizeHttpUrl(siteUrlWithoutTemplate(raw))
  return `${url.origin}/`
}

async function siteSessionStatus(siteUrl: string): Promise<OnlineSiteSessionStatus> {
  const origin = siteOriginUrl(siteUrl)
  const cookies = await getOnlineSession().cookies.get({ url: origin })
  return {
    success: true,
    origin,
    hasSession: cookies.length > 0,
    cookieCount: cookies.length,
  }
}

function buildSearchUrl(siteUrl: string, query: string): string {
  const normalized = normalizeHttpUrl(siteUrl)
  const original = String(siteUrl || '').trim()
  if (original.includes('{query}')) {
    return normalizeHttpUrl(original.replace(/\{query\}/g, encodeURIComponent(query))).toString()
  }
  const keys = ['q', 'query', 'keyword', 'keywords', 'search', 'wd', 'kw']
  const existing = keys.find(k => normalized.searchParams.has(k))
  if (existing) {
    normalized.searchParams.set(existing, query)
  } else {
    normalized.searchParams.set('q', query)
  }
  return normalized.toString()
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => {
      const code = parseInt(n, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

function stripTags(html: string): string {
  return decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim())
}

function extractTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = match ? stripTags(match[1]) : ''
  return title || fallback
}

function extractLinks(html: string, baseUrl: string): LinkInfo[] {
  const links: LinkInfo[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    const attrs = match[1]
    const text = stripTags(match[2]).slice(0, 220)
    const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const hrefRaw = decodeHtml(hrefMatch?.[1] || hrefMatch?.[2] || hrefMatch?.[3] || '').trim()
    if (!hrefRaw || hrefRaw.startsWith('#')) continue
    if (/^(javascript|mailto|tel|data|file):/i.test(hrefRaw)) continue
    try {
      const u = new URL(hrefRaw, baseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      u.hash = ''
      links.push({ href: u.toString(), text })
    } catch {
      // Skip malformed links.
    }
  }
  return links
}

function extFromUrl(url: string): SupportedExt | null {
  try {
    const u = new URL(url)
    const cleanPath = decodeURIComponent(u.pathname).toLowerCase()
    const match = cleanPath.match(/\.([a-z0-9]+)$/)
    if (!match) return null
    const ext = match[1] as SupportedExt
    return (SUPPORTED_EXTS as readonly string[]).includes(ext) ? ext : null
  } catch {
    return null
  }
}

function extFromContentType(contentType: string | null): SupportedExt | null {
  if (!contentType) return null
  const hit = CONTENT_TYPE_EXT.find(([re]) => re.test(contentType))
  return hit?.[1] || null
}

function isHtmlExt(ext: SupportedExt | null): boolean {
  return ext === 'html' || ext === 'htm'
}

function looksLikeDownload(link: LinkInfo): boolean {
  const combined = `${link.text} ${link.href}`.toLowerCase()
  return /download|full[-_ ]?text|全文|下载|pdf|epub|docx?|\.txt|\.md/.test(combined)
}

function isLikelyPageUrl(url: string, searchOrigin: string): boolean {
  try {
    const u = new URL(url)
    if (u.origin !== searchOrigin) return false
    if (extFromUrl(url) && !isHtmlExt(extFromUrl(url))) return false
    if (/\b(login|logout|signup|register|cart|account|comment|share)\b/i.test(u.pathname)) return false
    return true
  } catch {
    return false
  }
}

function safeFileName(raw: string, fallbackExt: SupportedExt): string {
  const cleaned = decodeURIComponent(raw || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  const base = cleaned || `download-${Date.now()}`
  const hasExt = /\.(pdf|docx?|epub|html?|txt|md)$/i.test(base)
  return hasExt ? base : `${base}.${fallbackExt}`
}

function fileNameFromUrl(url: string, title: string, ext: SupportedExt): string {
  try {
    const u = new URL(url)
    const fromPath = path.basename(decodeURIComponent(u.pathname || ''))
    if (fromPath && /\.[a-z0-9]+$/i.test(fromPath)) return safeFileName(fromPath, ext)
  } catch {
    // fall through
  }
  return safeFileName(title || `download.${ext}`, ext)
}

function fileNameFromDisposition(disposition: string | null, fallback: string, ext: SupportedExt): string {
  if (!disposition) return fallback
  const utf8 = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (utf8?.[1]) {
    try { return safeFileName(decodeURIComponent(utf8[1]), ext) } catch { return fallback }
  }
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)
  if (plain?.[1]) return safeFileName(plain[1], ext)
  return fallback
}

function stableId(url: string): string {
  let h = 2166136261
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `online-${(h >>> 0).toString(16)}`
}

async function readHtml(url: string, useSiteSession = false): Promise<{ html: string; finalUrl: string; title: string }> {
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.4',
    },
  }, FETCH_TIMEOUT_MS, { useSiteSession })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') || ''
  if (contentType && !/text\/html|application\/xhtml\+xml|application\/xml/i.test(contentType)) {
    throw new Error(`非 HTML 响应: ${contentType}`)
  }
  const reader = res.body?.getReader()
  if (!reader) {
    const html = await res.text()
    return { html: html.slice(0, MAX_HTML_BYTES), finalUrl: res.url || url, title: extractTitle(html, url) }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_HTML_BYTES) break
    chunks.push(value)
  }
  const html = Buffer.concat(chunks).toString('utf-8')
  return { html, finalUrl: res.url || url, title: extractTitle(html, url) }
}

async function verifyLink(link: LinkInfo, sourcePageUrl: string, sourcePageTitle?: string, useSiteSession = false): Promise<VerifiedLink | null> {
  const urlExt = extFromUrl(link.href)
  if (isHtmlExt(urlExt) && !looksLikeDownload(link)) return null

  let verified = false
  let contentType: string | undefined
  let sizeBytes: number | undefined
  let ext = urlExt
  let finalUrl = link.href
  let disposition: string | null = null

  try {
    const head = await fetchWithTimeout(link.href, { method: 'HEAD' }, 8000, { useSiteSession })
    if (head.ok) {
      finalUrl = head.url || link.href
      contentType = head.headers.get('content-type') || undefined
      disposition = head.headers.get('content-disposition')
      const len = Number(head.headers.get('content-length') || '')
      if (Number.isFinite(len) && len > 0) sizeBytes = len
      ext = ext || extFromContentType(contentType || null)
      const returnedHtml = /text\/html/i.test(contentType || '')
      if (returnedHtml && urlExt && !isHtmlExt(urlExt) && !/attachment/i.test(disposition || '')) return null
      verified = true
    }
  } catch {
    // Some servers block HEAD; URL-extension candidates can still be shown.
  }

  if (!ext) return null
  if (isHtmlExt(ext) && !looksLikeDownload(link) && !/attachment/i.test(disposition || '')) return null

  const rawTitle = link.text || path.basename(new URL(finalUrl).pathname) || `在线文件.${ext}`
  const fallbackName = fileNameFromUrl(finalUrl, rawTitle, ext)
  const fileName = safeFileName(fileNameFromDisposition(disposition, fallbackName, ext), ext)
  return {
    url: finalUrl,
    title: rawTitle,
    extension: ext,
    fileName,
    sourcePageUrl,
    sourcePageTitle,
    contentType,
    sizeBytes,
    verified,
  }
}

async function discoverFromPage(pageUrl: string, searchOrigin: string, useSiteSession = false): Promise<{
  links: LinkInfo[]
  pageLinks: string[]
  pageTitle: string
  finalUrl: string
}> {
  const { html, finalUrl, title } = await readHtml(pageUrl, useSiteSession)
  const links = extractLinks(html, finalUrl)
  const pageLinks = links
    .map(l => l.href)
    .filter(href => isLikelyPageUrl(href, searchOrigin))
  return { links, pageLinks, pageTitle: title, finalUrl }
}

export async function runSearch(req: OnlineSearchRequest): Promise<OnlineSearchResponse> {
  const query = String(req.query || '').trim()
  if (query.length < 1) throw new Error('请输入搜索关键词')
  const searchedUrl = buildSearchUrl(req.siteUrl, query)
  const searchOrigin = new URL(searchedUrl).origin
  const useSiteSession = !!req.useSiteSession
  const sessionStatus = useSiteSession ? await siteSessionStatus(req.siteUrl) : null
  const maxPages = Math.max(1, Math.min(req.maxPages || MAX_RESULT_PAGES, MAX_RESULT_PAGES))
  const warnings: string[] = []
  if (useSiteSession && !sessionStatus?.hasSession) {
    warnings.push('已开启站点登录态，但这个站点暂无拾卷内登录 Cookie')
  }
  const discovered = new Map<string, VerifiedLink>()
  const queuedPages: string[] = [searchedUrl]
  const seenPages = new Set<string>()
  let scannedPages = 0
  let verifyCount = 0

  while (queuedPages.length > 0 && scannedPages < maxPages) {
    const pageUrl = queuedPages.shift()!
    if (seenPages.has(pageUrl)) continue
    seenPages.add(pageUrl)
    scannedPages++

    let page
    try {
      page = await discoverFromPage(pageUrl, searchOrigin, useSiteSession)
    } catch (err: any) {
      if (scannedPages === 1) throw new Error(`搜索页读取失败：${err?.message || err}`)
      warnings.push(`跳过页面：${pageUrl}`)
      continue
    }

    for (const link of page.pageLinks) {
      if (!seenPages.has(link) && queuedPages.length < maxPages * 2) queuedPages.push(link)
    }

    for (const link of page.links) {
      if (verifyCount >= MAX_VERIFY_LINKS) break
      const urlExt = extFromUrl(link.href)
      if (!urlExt && !looksLikeDownload(link)) continue
      verifyCount++
      const verified = await verifyLink(link, page.finalUrl, page.pageTitle, useSiteSession)
      if (verified && !discovered.has(verified.url)) discovered.set(verified.url, verified)
    }
  }

  const results: OnlineSearchResult[] = Array.from(discovered.values()).map(item => ({
    id: stableId(item.url),
    title: item.title,
    url: item.url,
    fileName: item.fileName,
    extension: item.extension,
    sourcePageUrl: item.sourcePageUrl,
    sourcePageTitle: item.sourcePageTitle,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    verified: item.verified,
  }))

  return {
    success: true,
    searchedUrl,
    scannedPages,
    usedSiteSession: useSiteSession,
    sessionCookieCount: sessionStatus?.cookieCount || 0,
    results,
    warnings,
  }
}

async function uniquePath(fileName: string): Promise<string> {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true })
  const parsed = path.parse(fileName)
  let candidate = path.join(DOWNLOAD_DIR, fileName)
  let i = 2
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(DOWNLOAD_DIR, `${parsed.name} (${i})${parsed.ext}`)
      i++
    } catch {
      return candidate
    }
  }
}

export async function runDownload(req: OnlineDownloadRequest): Promise<OnlineDownloadResponse> {
  const url = normalizeHttpUrl(req.url).toString()
  const urlExt = extFromUrl(url)
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'application/pdf,application/epub+zip,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html,*/*;q=0.4' },
  }, 30000, { useSiteSession: !!req.useSiteSession })
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)

  const contentType = res.headers.get('content-type')
  const disposition = res.headers.get('content-disposition')
  const ext = urlExt || extFromContentType(contentType)
  if (!ext) throw new Error(`不是可导入的文档类型：${contentType || 'unknown'}`)
  if (/text\/html/i.test(contentType || '') && urlExt && !isHtmlExt(urlExt) && !/attachment/i.test(disposition || '')) {
    throw new Error('站点返回的是网页而不是文档，可能需要登录或没有下载权限')
  }
  const length = Number(res.headers.get('content-length') || '')
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
    throw new Error('文件超过 200MB，已取消下载')
  }
  if (!res.body) throw new Error('下载响应为空')

  const fileName = safeFileName(
    fileNameFromDisposition(disposition, req.fileName || fileNameFromUrl(res.url || url, req.title || '', ext), ext),
    ext,
  )
  const absPath = await uniquePath(fileName)
  const tmpPath = `${absPath}.tmp`
  let bytes = 0
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > MAX_DOWNLOAD_BYTES) body.destroy(new Error('文件超过 200MB，已取消下载'))
  })
  try {
    await pipeline(body, createWriteStream(tmpPath))
    await fs.rename(tmpPath, absPath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw err
  }

  return {
    success: true,
    absPath,
    fileName: path.basename(absPath),
    title: req.title || path.basename(absPath, path.extname(absPath)),
  }
}

export async function openSiteLoginWindow(req: OnlineSiteLoginRequest): Promise<OnlineSiteLoginResponse> {
  const origin = siteOriginUrl(req.siteUrl)
  const targetUrl = req.loginUrl ? normalizeHttpUrl(req.loginUrl).toString() : origin
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: `站点登录 - ${new URL(origin).hostname}`,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      session: getOnlineSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  await win.loadURL(targetUrl)
  return { success: true, origin }
}

async function clearSiteSession(siteUrl: string): Promise<OnlineSiteSessionStatus> {
  const origin = siteOriginUrl(siteUrl)
  const ses = getOnlineSession()
  const cookies = await ses.cookies.get({ url: origin })
  await Promise.all(cookies.map(cookie => {
    const domain = (cookie.domain || new URL(origin).hostname).replace(/^\./, '')
    const cookieUrl = `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`
    return ses.cookies.remove(cookieUrl, cookie.name).catch(() => {})
  }))
  return siteSessionStatus(siteUrl)
}

export function registerOnlineSearchIpc(): void {
  ipcMain.handle('online-search', async (_event, req: OnlineSearchRequest): Promise<OnlineSearchResponse> => {
    try {
      if (ONLINE_SEARCH_LOCKED) return { success: false, results: [], error: ONLINE_SEARCH_LOCKED_MESSAGE }
      return await runSearch(req)
    } catch (err: any) {
      return { success: false, results: [], error: err?.message || String(err) }
    }
  })

  ipcMain.handle('online-download-file', async (_event, req: OnlineDownloadRequest): Promise<OnlineDownloadResponse> => {
    try {
      if (ONLINE_SEARCH_LOCKED) return { success: false, error: ONLINE_SEARCH_LOCKED_MESSAGE }
      return await runDownload(req)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('online-site-login', async (_event, req: OnlineSiteLoginRequest): Promise<OnlineSiteLoginResponse> => {
    try {
      if (ONLINE_SEARCH_LOCKED) return { success: false, error: ONLINE_SEARCH_LOCKED_MESSAGE }
      return await openSiteLoginWindow(req)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('online-site-session-status', async (_event, req: OnlineSiteSessionRequest): Promise<OnlineSiteSessionStatus> => {
    try {
      if (ONLINE_SEARCH_LOCKED) return { success: false, error: ONLINE_SEARCH_LOCKED_MESSAGE, hasSession: false, cookieCount: 0 }
      return await siteSessionStatus(req.siteUrl)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle('online-site-session-clear', async (_event, req: OnlineSiteSessionRequest): Promise<OnlineSiteSessionStatus> => {
    try {
      if (ONLINE_SEARCH_LOCKED) return { success: false, error: ONLINE_SEARCH_LOCKED_MESSAGE, hasSession: false, cookieCount: 0 }
      return await clearSiteSession(req.siteUrl)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })
}
