import { useEffect, useMemo, useState } from 'react'
import type { OnlineSearchResult } from '../../types/onlineSearch'
import { useLibraryStore } from '../../store/libraryStore'

const STORAGE_KEY = 'sj-online-search-site-url'
const SESSION_STORAGE_KEY = 'sj-online-search-use-site-session'

function readStoredSiteUrl(): string {
  try { return localStorage.getItem(STORAGE_KEY) || '' } catch { return '' }
}

function readStoredUseSiteSession(): boolean {
  try { return localStorage.getItem(SESSION_STORAGE_KEY) === '1' } catch { return false }
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function resultTitle(result: OnlineSearchResult): string {
  const title = (result.title || '').trim()
  return title || result.fileName || result.url
}

export default function OnlineSearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const addEntryFromPath = useLibraryStore(s => s.addEntryFromPath)
  const [siteUrl, setSiteUrl] = useState(readStoredSiteUrl)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<OnlineSearchResult[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [searchedUrl, setSearchedUrl] = useState('')
  const [scannedPages, setScannedPages] = useState(0)
  const [warnings, setWarnings] = useState<string[]>([])
  const [useSiteSession, setUseSiteSession] = useState(readStoredUseSiteSession)
  const [sessionInfo, setSessionInfo] = useState<{ checking: boolean; cookieCount: number; origin: string; hasSession: boolean }>({
    checking: false,
    cookieCount: 0,
    origin: '',
    hasSession: false,
  })
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [status, setStatus] = useState<{ tone: 'muted' | 'success' | 'danger'; text: string } | null>(null)

  const selectedResults = useMemo(
    () => results.filter(r => selectedIds.has(r.id)),
    [results, selectedIds],
  )

  useEffect(() => {
    try { localStorage.setItem(SESSION_STORAGE_KEY, useSiteSession ? '1' : '0') } catch {}
  }, [useSiteSession])

  const refreshSessionStatus = async (url = siteUrl) => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl || !window.electronAPI?.onlineSiteSessionStatus) {
      setSessionInfo({ checking: false, cookieCount: 0, origin: '', hasSession: false })
      return
    }
    setSessionInfo(prev => ({ ...prev, checking: true }))
    const response = await window.electronAPI.onlineSiteSessionStatus({ siteUrl: trimmedUrl })
    setSessionInfo({
      checking: false,
      cookieCount: response.cookieCount || 0,
      origin: response.origin || '',
      hasSession: !!response.hasSession,
    })
  }

  const handleSiteLogin = async () => {
    const trimmedUrl = siteUrl.trim()
    if (!trimmedUrl) {
      setStatus({ tone: 'danger', text: '请先填写网站地址' })
      return
    }
    if (!window.electronAPI?.onlineSiteLogin) {
      setStatus({ tone: 'danger', text: '当前版本不支持站点登录' })
      return
    }
    const response = await window.electronAPI.onlineSiteLogin({ siteUrl: trimmedUrl })
    if (!response.success) {
      setStatus({ tone: 'danger', text: response.error || '无法打开站点登录窗口' })
      return
    }
    setUseSiteSession(true)
    setStatus({ tone: 'muted', text: '登录窗口已打开，登录完成后回到这里搜索' })
    setTimeout(() => { void refreshSessionStatus(trimmedUrl) }, 1500)
  }

  const handleClearSiteSession = async () => {
    const trimmedUrl = siteUrl.trim()
    if (!trimmedUrl || !window.electronAPI?.onlineSiteSessionClear) return
    const response = await window.electronAPI.onlineSiteSessionClear({ siteUrl: trimmedUrl })
    setSessionInfo({
      checking: false,
      cookieCount: response.cookieCount || 0,
      origin: response.origin || '',
      hasSession: !!response.hasSession,
    })
    setStatus({ tone: response.success ? 'muted' : 'danger', text: response.success ? '已清除此站点的拾卷内登录态' : (response.error || '清除登录态失败') })
  }

  if (!open) return null

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSearch = async () => {
    const trimmedUrl = siteUrl.trim()
    const trimmedQuery = query.trim()
    if (!trimmedUrl || !trimmedQuery) {
      setStatus({ tone: 'danger', text: '请填写网站地址和搜索关键词' })
      return
    }
    if (!window.electronAPI?.onlineSearch) {
      setStatus({ tone: 'danger', text: '当前版本不支持在线搜索' })
      return
    }
    setBusy(true)
    setStatus({ tone: 'muted', text: '正在搜索...' })
    setResults([])
    setSelectedIds(new Set())
    setWarnings([])
    try {
      localStorage.setItem(STORAGE_KEY, trimmedUrl)
    } catch {}
    try {
      const response = await window.electronAPI.onlineSearch({
        siteUrl: trimmedUrl,
        query: trimmedQuery,
        maxPages: 12,
        useSiteSession,
      })
      if (!response.success) {
        setStatus({ tone: 'danger', text: response.error || '搜索失败' })
        return
      }
      setResults(response.results)
      setSearchedUrl(response.searchedUrl || '')
      setScannedPages(response.scannedPages || 0)
      setWarnings(response.warnings || [])
      if (response.usedSiteSession) {
        setSessionInfo(prev => ({
          ...prev,
          checking: false,
          cookieCount: response.sessionCookieCount || 0,
          hasSession: (response.sessionCookieCount || 0) > 0,
        }))
      }
      setSelectedIds(new Set(response.results.map(r => r.id)))
      setStatus({
        tone: response.results.length > 0 ? 'success' : 'muted',
        text: response.results.length > 0
          ? `发现 ${response.results.length} 个可导入文件`
          : '没有发现可直接下载的文件',
      })
    } catch (err: any) {
      setStatus({ tone: 'danger', text: err?.message || '搜索失败' })
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async () => {
    if (selectedResults.length === 0 || importing) return
    if (!window.electronAPI?.onlineDownloadFile) {
      setStatus({ tone: 'danger', text: '当前版本不支持下载导入' })
      return
    }
    setImporting(true)
    let added = 0
    let failed = 0
    const errors: string[] = []
    for (const result of selectedResults) {
      setStatus({ tone: 'muted', text: `正在导入 ${added + failed + 1} / ${selectedResults.length}` })
      const download = await window.electronAPI.onlineDownloadFile({
        url: result.url,
        fileName: result.fileName,
        title: resultTitle(result),
        useSiteSession,
      })
      if (download.success && download.absPath) {
        const entry = await addEntryFromPath(download.absPath, resultTitle(result))
        if (entry) added++
        else {
          failed++
          errors.push(resultTitle(result))
        }
      } else {
        failed++
        errors.push(`${resultTitle(result)}：${download.error || '下载失败'}`)
      }
    }
    setImporting(false)
    setStatus({
      tone: failed > 0 ? 'danger' : 'success',
      text: failed > 0 ? `已导入 ${added} 个，失败 ${failed} 个：${errors.slice(0, 2).join('；')}` : `已导入 ${added} 个文件`,
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(860px, calc(100vw - 48px))',
          maxWidth: 860,
          maxHeight: '82vh',
          padding: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>在线搜索</h3>
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              仅处理公开且你有权访问的文件链接，不绕过登录、付费或 DRM。
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>关闭</button>
        </div>

        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-light)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr auto', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={siteUrl}
              onChange={e => setSiteUrl(e.target.value)}
              onBlur={() => void refreshSessionStatus()}
              onKeyDown={e => { if (e.key === 'Enter') void handleSearch() }}
              placeholder="网站搜索地址，如 https://example.com/search?q={query}"
              style={{
                width: '100%', padding: '8px 10px', border: '1px solid var(--border)',
                borderRadius: 6, background: 'var(--bg-warm)', color: 'var(--text)', outline: 'none',
                marginBottom: 0,
              }}
            />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSearch() }}
              placeholder="搜索关键词"
              style={{
                width: '100%', padding: '8px 10px', border: '1px solid var(--border)',
                borderRadius: 6, background: 'var(--bg-warm)', color: 'var(--text)', outline: 'none',
                marginBottom: 0,
              }}
            />
            <button
              className="btn btn-primary"
              disabled={busy || importing}
              onClick={() => void handleSearch()}
              style={{ height: 34, minWidth: 76, justifyContent: 'center' }}
            >
              {busy ? '搜索中' : '搜索'}
            </button>
          </div>
          <div style={{
            marginTop: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 6,
            background: 'var(--bg)',
            border: '1px solid var(--border-light)',
          }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useSiteSession}
                onChange={e => setUseSiteSession(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              使用站点登录态
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {sessionInfo.checking
                ? '检查中...'
                : sessionInfo.hasSession
                  ? `已保存 ${sessionInfo.cookieCount} 个站点 Cookie`
                  : '尚未在拾卷内登录此站点'}
            </span>
            <button
              className="btn btn-sm"
              disabled={!siteUrl.trim()}
              onClick={() => void handleSiteLogin()}
              style={{ marginLeft: 'auto', fontSize: 10, padding: '4px 8px' }}
            >
              在拾卷内登录站点
            </button>
            <button
              className="btn btn-sm"
              disabled={!siteUrl.trim() || !sessionInfo.hasSession}
              onClick={() => void handleClearSiteSession()}
              style={{ fontSize: 10, padding: '4px 8px' }}
            >
              清除
            </button>
          </div>
          {(searchedUrl || status) && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
              {status && (
                <span style={{
                  fontSize: 11,
                  color: status.tone === 'success' ? 'var(--success)' : status.tone === 'danger' ? 'var(--danger)' : 'var(--text-muted)',
                }}>
                  {status.text}
                </span>
              )}
              {searchedUrl && (
                <button
                  className="btn btn-sm"
                  onClick={() => window.open(searchedUrl, '_blank', 'noopener,noreferrer')}
                  style={{ marginLeft: 'auto', fontSize: 10, padding: '3px 8px' }}
                >
                  打开搜索页
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 220 }}>
          {results.length === 0 ? (
            <div className="empty-state" style={{ minHeight: 260, height: 'auto', padding: 24 }}>
              <span>{busy ? '正在扫描网页...' : '暂无结果'}</span>
              {scannedPages > 0 && <span style={{ fontSize: 11 }}>已扫描 {scannedPages} 页</span>}
            </div>
          ) : (
            <div style={{ padding: '10px 12px' }}>
              {results.map(result => {
                const checked = selectedIds.has(result.id)
                return (
                  <div
                    key={result.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '22px 1fr auto',
                      gap: 10,
                      alignItems: 'center',
                      padding: '10px 10px',
                      borderBottom: '1px solid var(--border-light)',
                      background: checked ? 'var(--accent-soft)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelected(result.id)}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{
                          fontSize: 10,
                          padding: '1px 5px',
                          borderRadius: 4,
                          color: '#fff',
                          background: result.verified ? 'var(--accent)' : 'var(--warning)',
                          textTransform: 'uppercase',
                          flexShrink: 0,
                        }}>
                          {result.extension}
                        </span>
                        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {resultTitle(result)}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {hostOf(result.url)}{formatBytes(result.sizeBytes) ? ` · ${formatBytes(result.sizeBytes)}` : ''} · {result.fileName}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() => window.open(result.url, '_blank', 'noopener,noreferrer')}
                      style={{ fontSize: 10, padding: '4px 8px' }}
                    >
                      打开
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{
          padding: '10px 20px',
          borderTop: '1px solid var(--border-light)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'var(--bg-warm)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {results.length > 0 ? `已选 ${selectedResults.length} / ${results.length}` : warnings[0] || ''}
          </span>
          {warnings.length > 0 && results.length > 0 && (
            <span style={{ fontSize: 10, color: 'var(--warning)' }}>{warnings.length} 个页面未能扫描</span>
          )}
          <button
            className="btn btn-sm"
            disabled={results.length === 0}
            onClick={() => setSelectedIds(new Set(selectedIds.size === results.length ? [] : results.map(r => r.id)))}
            style={{ marginLeft: 'auto' }}
          >
            {selectedIds.size === results.length ? '取消全选' : '全选'}
          </button>
          <button
            className="btn btn-primary"
            disabled={selectedResults.length === 0 || importing || busy}
            onClick={() => void handleImport()}
            style={{ minWidth: 94, justifyContent: 'center' }}
          >
            {importing ? '导入中' : '下载并导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
