import { useState, useEffect, useCallback, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useLibraryStore } from '../../store/libraryStore'
import { generateBibTeX, generateRIS } from '../../utils/citations'
import { invalidateAiConfigCache } from '../../utils/aiConfigCache'

const ONLINE_SEARCH_LOCKED = true
const AI_CONTEXT_PRESETS: Array<{ label: string; value: number }> = [
  { label: '1000字', value: 1000 },
  { label: '2000字', value: 2000 },
  { label: '5000字', value: 5000 },
  { label: '10000字', value: 10000 },
  { label: '全文', value: -1 },
]
const AI_CONTEXT_PRESET_VALUES = AI_CONTEXT_PRESETS.map(opt => opt.value)
const DEFAULT_CUSTOM_AI_CONTEXT_WINDOW = 3000

// ===== Auto Update Panel =====
function UpdatePanel() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'>('idle')
  const [info, setInfo] = useState<{ currentVersion: string; latestVersion: string; downloadUrl: string | null; releaseNotes: string; asarSize: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')

  // BUG-FIX R2#ε · update check / download is async and slow; user may close
  // Settings mid-flight. Guard all setState with mountedRef.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const handleCheck = useCallback(async () => {
    if (!window.electronAPI?.checkUpdate) return
    setStatus('checking'); setError('')
    try {
      const result = await window.electronAPI.checkUpdate()
      if (!mountedRef.current) return
      setInfo(result)
      setStatus(result.hasUpdate ? 'available' : 'idle')
    } catch (err: any) {
      if (!mountedRef.current) return
      setError(err.message || '检查失败')
      setStatus('error')
    }
  }, [])

  const handleDownload = useCallback(async () => {
    if (!info?.downloadUrl || !window.electronAPI?.downloadUpdate) return
    setStatus('downloading'); setProgress(0)

    // Listen for progress
    const cleanup = window.electronAPI.onUpdateProgress?.((pct: number) => {
      if (mountedRef.current) setProgress(pct)
    })

    try {
      const result = await window.electronAPI.downloadUpdate(info.downloadUrl)
      cleanup?.()
      if (!mountedRef.current) return
      if (result.success) {
        setStatus('ready')
      } else {
        setError(result.error || '下载失败')
        setStatus('error')
      }
    } catch (err: any) {
      cleanup?.()
      if (!mountedRef.current) return
      setError(err.message || '下载失败')
      setStatus('error')
    }
  }, [info])

  const handleApply = useCallback(async () => {
    if (!window.electronAPI?.applyUpdate) return
    await window.electronAPI.applyUpdate()
  }, [])

  return (
    <div className="settings-section">
      <div className="settings-section-inner">
      <div className="settings-section-heading">
        <div className="settings-section-title">软件更新</div>
        <span className="settings-section-meta">
          当前版本 {info?.currentVersion || '...'}
        </span>
      </div>

      {status === 'idle' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-sm" style={{ fontSize: 11 }} onClick={handleCheck}>
            检查更新
          </button>
          {info && <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ 已是最新版本</span>}
        </div>
      )}

      {status === 'checking' && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="loading-spinner" />检查中...
        </div>
      )}

      {status === 'available' && info && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 500, marginBottom: 6 }}>
            发现新版本 v{info.latestVersion}
            {info.asarSize > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> ({(info.asarSize / 1024 / 1024).toFixed(1)} MB)</span>}
          </div>
          {info.releaseNotes && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6, maxHeight: 60, overflow: 'auto' }}>
              {info.releaseNotes.slice(0, 200)}
            </div>
          )}
          {info.downloadUrl ? (
            <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }} onClick={handleDownload}>
              下载更新
            </button>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              此版本暂无补丁包，请前往 <a href="https://github.com/lickswan-lab/shijuan/releases" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>GitHub Release</a> 下载完整版
            </div>
          )}
        </div>
      )}

      {status === 'downloading' && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
            正在下载 v{info?.latestVersion}... {progress}%
          </div>
          <div style={{ width: '100%', height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {status === 'ready' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ 下载完成</span>
          <button className="btn btn-sm btn-primary" style={{ fontSize: 11 }} onClick={handleApply}>
            立即重启更新
          </button>
        </div>
      )}

      {status === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--danger)' }}>✗ {error}</span>
          <button className="btn btn-sm" style={{ fontSize: 11 }} onClick={handleCheck}>重试</button>
        </div>
      )}
      </div>
    </div>
  )
}

// ===== Diagnostic Panel (collapsible) =====
interface DiagnosticInfo {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
  dataDir: string
  libraryJsonSize: number
  metaCount: number
  ocrFilesCount: number
  errorLogs: Array<{ name: string; mtime: string; content: string }>
}

function DiagnosticPanel() {
  const [expanded, setExpanded] = useState(false)
  const [info, setInfo] = useState<DiagnosticInfo | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!window.electronAPI?.getDiagnosticInfo) return
    setLoading(true)
    try {
      const data = await window.electronAPI.getDiagnosticInfo()
      setInfo(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  const handleToggle = () => {
    const next = !expanded
    setExpanded(next)
    if (next && !info) load()
  }

  const copyAll = useCallback(() => {
    if (!info) return
    const lines = [
      `拾卷 v${info.appVersion}`,
      `Electron: ${info.electronVersion}`,
      `Platform: ${info.platform} (${info.arch})`,
      `Data: ${info.dataDir}`,
      `library.json: ${(info.libraryJsonSize / 1024).toFixed(1)} KB`,
      `meta files: ${info.metaCount}`,
      '',
      ...info.errorLogs.flatMap(log => [
        `=== ${log.name} (${log.mtime}) ===`,
        log.content,
        '',
      ]),
    ]
    navigator.clipboard?.writeText(lines.join('\n')).catch(() => {})
  }, [info])

  return (
    <div className="settings-section">
      <div className="settings-section-inner">
      <div
        className="settings-section-heading"
        style={{ cursor: 'pointer' }}
        onClick={handleToggle}
      >
        <div className="settings-section-title">诊断信息</div>
        <span className="settings-section-meta">
          {expanded ? '▾ 收起' : '▸ 展开（反馈问题时点开复制）'}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: 10 }}>
          {loading && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>加载中...</div>}
          {info && (
            <>
              <div style={{
                fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8,
                fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
                background: 'var(--bg)', padding: '8px 10px', borderRadius: 4,
                border: '1px solid var(--border-light)',
              }}>
                <div>拾卷 v{info.appVersion} · Electron {info.electronVersion}</div>
                <div>{info.platform} / {info.arch}</div>
                <div>library.json: {(info.libraryJsonSize / 1024).toFixed(1)} KB</div>
                <div>文献元数据: {info.metaCount} 个</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{info.dataDir}</div>
              </div>

              {info.errorLogs.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>
                    ⚠ 错误日志 ({info.errorLogs.length})
                  </div>
                  {info.errorLogs.map((log, i) => (
                    <details key={i} style={{
                      fontSize: 10, background: 'var(--bg)', padding: '6px 10px',
                      borderRadius: 4, border: '1px solid var(--border-light)', marginBottom: 4,
                    }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
                        {log.name} · <span style={{ color: 'var(--text-muted)' }}>{new Date(log.mtime).toLocaleString('zh-CN')}</span>
                      </summary>
                      <pre style={{
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        margin: '6px 0 0', fontSize: 10, color: 'var(--text-muted)',
                        fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
                        maxHeight: 160, overflow: 'auto',
                      }}>{log.content}</pre>
                    </details>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={copyAll}>
                  复制全部信息
                </button>
                <button
                  className="btn btn-sm"
                  style={{ fontSize: 10 }}
                  onClick={() => window.electronAPI?.openDataDir?.()}
                >
                  打开数据目录
                </button>
                <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={load}>
                  刷新
                </button>
              </div>
            </>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

// ===== Data Export Panel =====
// Lives in Settings modal. Two functions:
// 1. Citation export (BibTeX/RIS) — lets users plug shijuan into Zotero / LaTeX
//    pipelines instead of being a dead-end for their library.
// 2. Full-library backup — a single JSON with library.json + all meta + agent
//    memory + apprentice logs. Solves "electronic dies → I lose everything"
//    anxiety. Does not include the PDF binaries themselves (they stay in the
//    user's own folders) or OCR .txt files (they live next to the PDFs).
function DataExportPanel() {
  const library = useLibraryStore(s => s.library)
  const importFromBibTeX = useLibraryStore(s => s.importFromBibTeX)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const entryCount = library?.entries?.length ?? 0
  const memoCount = library?.memos?.length ?? 0

  const handleImportBibTeX = useCallback(async () => {
    if (!window.electronAPI?.pickAndReadBibFile) {
      setStatus('当前版本不支持 BibTeX 导入')
      return
    }
    setBusy(true); setStatus(null)
    try {
      const pick = await window.electronAPI.pickAndReadBibFile()
      if (pick.canceled) { setBusy(false); return }
      if (!pick.success || !pick.content) {
        setStatus(`读取失败：${pick.error || '未知错误'}`)
        setBusy(false)
        return
      }
      const result = await importFromBibTeX(pick.content)
      const parts: string[] = []
      if (result.added > 0) parts.push(`✓ 新增 ${result.added} 条`)
      if (result.skipped > 0) parts.push(`已跳过重复 ${result.skipped} 条`)
      if (result.missingFile > 0) parts.push(`有 ${result.missingFile} 条 PDF 路径无效（已作为元数据导入，可后续关联文件）`)
      if (result.parseErrors > 0) parts.push(`⚠ 解析错误 ${result.parseErrors} 处`)
      if (parts.length === 0) parts.push('未导入任何条目')
      setStatus(parts.join('；'))
    } catch (err: any) {
      setStatus(`导入失败：${err.message}`)
    } finally { setBusy(false) }
  }, [importFromBibTeX])

  const handleExportBibTeX = useCallback(async () => {
    if (!library || entryCount === 0) {
      setStatus('文献库为空，无需导出')
      return
    }
    setBusy(true); setStatus(null)
    try {
      const bib = generateBibTeX(library.entries)
      const result = await window.electronAPI.exportFile(
        `shijuan-${new Date().toISOString().slice(0, 10)}.bib`,
        [{ name: 'BibTeX', extensions: ['bib'] }],
        bib,
      )
      if (result.success) {
        setStatus(`✓ 已导出 ${entryCount} 条文献到 ${result.path}`)
      } else if (result.error) {
        setStatus(`导出失败：${result.error}`)
      }
    } catch (err: any) {
      setStatus(`导出失败：${err.message}`)
    } finally { setBusy(false) }
  }, [library, entryCount])

  const handleExportRIS = useCallback(async () => {
    if (!library || entryCount === 0) {
      setStatus('文献库为空，无需导出')
      return
    }
    setBusy(true); setStatus(null)
    try {
      const ris = generateRIS(library.entries)
      const result = await window.electronAPI.exportFile(
        `shijuan-${new Date().toISOString().slice(0, 10)}.ris`,
        [{ name: 'RIS', extensions: ['ris'] }],
        ris,
      )
      if (result.success) {
        setStatus(`✓ 已导出 ${entryCount} 条文献到 ${result.path}`)
      } else if (result.error) {
        setStatus(`导出失败：${result.error}`)
      }
    } catch (err: any) {
      setStatus(`导出失败：${err.message}`)
    } finally { setBusy(false) }
  }, [library, entryCount])

  const handleExportBackup = useCallback(async () => {
    if (!window.electronAPI?.exportFullBackup) {
      setStatus('当前版本不支持完整备份导出')
      return
    }
    setBusy(true); setStatus(null)
    try {
      const result = await window.electronAPI.exportFullBackup()
      if (result.success && result.stats) {
        const s = result.stats
        setStatus(`✓ 已备份 ${s.entryCount} 文献 / ${s.memoCount} 笔记 / ${s.metaCount} 注释文件 / ${s.apprenticeCount} 学徒记录`)
      } else if (result.error) {
        setStatus(`备份失败：${result.error}`)
      }
    } catch (err: any) {
      setStatus(`备份失败：${err.message}`)
    } finally { setBusy(false) }
  }, [])

  return (
    <div className="settings-section">
      <div className="settings-section-inner">
      <div className="settings-section-title" style={{ marginBottom: 4 }}>
        数据迁移与备份
      </div>
      <div className="settings-section-desc" style={{ marginBottom: 10 }}>
        文献库 {entryCount} 条 · 笔记 {memoCount} 条。<br />
        从 Zotero 迁移：<strong>Zotero 右键文献库 → Export Library → BibTeX（勾选 Export Files）</strong> → 这里点导入
      </div>
      <div className="settings-button-row" style={{ marginBottom: 8 }}>
        <button
          className="btn btn-sm btn-primary"
          style={{ fontSize: 11 }}
          onClick={handleImportBibTeX}
          disabled={busy}
          title="从 Zotero / JabRef / EndNote 导出的 .bib 文件批量导入"
        >
          导入 BibTeX (.bib)
        </button>
      </div>
      <div className="settings-button-row" style={{ marginBottom: status ? 10 : 0 }}>
        <button
          className="btn btn-sm"
          style={{ fontSize: 11 }}
          onClick={handleExportBibTeX}
          disabled={busy || entryCount === 0}
          title="导出 BibTeX 格式，可导入 Zotero / JabRef / LaTeX"
        >
          导出 BibTeX (.bib)
        </button>
        <button
          className="btn btn-sm"
          style={{ fontSize: 11 }}
          onClick={handleExportRIS}
          disabled={busy || entryCount === 0}
          title="导出 RIS 格式，可导入 EndNote / Mendeley"
        >
          导出 RIS (.ris)
        </button>
        <button
          className="btn btn-sm"
          style={{ fontSize: 11 }}
          onClick={handleExportBackup}
          disabled={busy}
          title="导出所有数据为单个 JSON 文件（不含 PDF 和 OCR 文件）"
        >
          完整备份 (.json)
        </button>
      </div>
      {status && (
        <div className="settings-status" style={{ color: status.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>
          {status}
        </div>
      )}
      </div>
    </div>
  )
}

interface ProviderInfo {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
  hasKey: boolean
  noKey?: boolean  // Ollama: no API key needed, hasKey means "daemon running + models pulled"
  apiKeyUrl?: string       // Direct link to the provider's API key page
  freeTierHint?: string    // One-line hint about free tier / availability
}

export default function TopBar() {
  // 2026-04-25 PERF · 选择性订阅
  const showSettings = useUiStore(s => s.showSettings)
  const setShowSettings = useUiStore(s => s.setShowSettings)
  const glmApiKeyStatus = useUiStore(s => s.glmApiKeyStatus)
  // 2026-04-28 · activeReadingLogDate / setActiveReadingLogDate 已删(readingLog 功能下线)
  const setSidebarTab = useUiStore(s => s.setSidebarTab)
  const rightPanel = useUiStore(s => s.rightPanel)
  const setRightPanel = useUiStore(s => s.setRightPanel)
  const annotationPanelCollapsed = useUiStore(s => s.annotationPanelCollapsed)
  const toggleAnnotationPanel = useUiStore(s => s.toggleAnnotationPanel)
  const hermesHasInsight = useUiStore(s => s.hermesHasInsight)
  const darkMode = useUiStore(s => s.darkMode)
  const toggleDarkMode = useUiStore(s => s.toggleDarkMode)
  const mainView = useUiStore(s => s.mainView)
  const setMainView = useUiStore(s => s.setMainView)
  // 2026-04-28 · AI 上下文范围按钮:之前用 useUiStore.getState() 读快照不订阅
  //   store 变更,导致用户点击按钮后高亮不切换(必须刷新页面)。改订阅式读取
  //   让 React 响应 state 变化重新渲染。
  const aiContextWindow = useUiStore(s => s.aiContextWindow)
  const setAiContextWindow = useUiStore(s => s.setAiContextWindow)
  const updateAvailable = useUiStore(s => s.updateAvailable)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  // Collapsible AI providers section — there are 6+ providers and the list
  // dominates the settings modal. Default collapsed; auto-expand if NOTHING
  // is configured (so first-time users see the cards immediately).
  const [providersExpanded, setProvidersExpanded] = useState(false)
  useEffect(() => {
    if (providers.length === 0) return
    // Auto-expand on first load if user hasn't configured anything yet —
    // they almost certainly opened settings to set a key.
    const noneConfigured = providers.every(p => !p.hasKey)
    if (noneConfigured) setProvidersExpanded(true)
  }, [providers.length])

  // In-app "敬请期待" toast — replaces native alert() so the message inherits
  // the app's design tokens (font/colors/border) instead of the OS-default
  // window-chrome dialog. Auto-dismisses after 2.5s; consecutive clicks reset
  // the timer so spam-clicks don't pile up multiple toasts.
  const [lockedHint, setLockedHint] = useState<string | null>(null)
  const isCustomContextWindow = aiContextWindow > 0 && !AI_CONTEXT_PRESET_VALUES.includes(aiContextWindow)
  const [customContextDraft, setCustomContextDraft] = useState(() => (
    isCustomContextWindow ? String(aiContextWindow) : ''
  ))
  const [customContextOpen, setCustomContextOpen] = useState(isCustomContextWindow)

  useEffect(() => {
    if (isCustomContextWindow) {
      setCustomContextDraft(String(aiContextWindow))
      setCustomContextOpen(true)
    }
  }, [aiContextWindow, isCustomContextWindow])

  const commitCustomContextWindow = useCallback((raw = customContextDraft) => {
    const trimmed = raw.trim()
    if (!trimmed) {
      setCustomContextDraft(isCustomContextWindow ? String(aiContextWindow) : '')
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    const next = Math.min(200000, Math.max(100, Math.round(parsed)))
    setCustomContextDraft(String(next))
    setAiContextWindow(next)
  }, [aiContextWindow, customContextDraft, isCustomContextWindow, setAiContextWindow])

  const openCustomContextWindow = useCallback(() => {
    const draft = isCustomContextWindow
      ? String(aiContextWindow)
      : (customContextDraft || String(DEFAULT_CUSTOM_AI_CONTEXT_WINDOW))
    setCustomContextDraft(draft)
    setCustomContextOpen(true)
    commitCustomContextWindow(draft)
  }, [aiContextWindow, commitCustomContextWindow, customContextDraft, isCustomContextWindow])

  useEffect(() => {
    if (!lockedHint) return
    const t = setTimeout(() => setLockedHint(null), 2500)
    return () => clearTimeout(t)
  }, [lockedHint])

  // Load providers when settings opens
  // BUG-FIX R2#ε · cancellation flag so a late aiGetProviders resolve
  // after the user closes Settings doesn't fire setProviders on a
  // component whose Settings subtree just unmounted.
  useEffect(() => {
    if (!showSettings || !window.electronAPI?.aiGetProviders) return
    let cancelled = false
    window.electronAPI.aiGetProviders()
      .then(r => { if (!cancelled) setProviders(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [showSettings])

  const handleSaveKey = async (providerId: string) => {
    const key = keyInputs[providerId]?.trim()
    if (!key) return
    setSaving(providerId)
    try {
      await window.electronAPI.aiSetKey(providerId, key)
      // Also set legacy GLM status if it's GLM
      if (providerId === 'glm') {
        await window.electronAPI.setGlmApiKey(key)
        useUiStore.getState().setGlmApiKeyStatus('set')
      }
      // Refresh providers
      const updated = await window.electronAPI.aiGetProviders()
      setProviders(updated)
      setKeyInputs(prev => ({ ...prev, [providerId]: '' }))
      // 2026-04-25 PERF · 让 aiConfigCache 失效，下次组件 mount/refresh 重新拉
      invalidateAiConfigCache()
    } catch { /* ignore */ }
    setSaving(null)
  }

  const handleRemoveKey = async (providerId: string) => {
    await window.electronAPI.aiRemoveKey(providerId)
    if (providerId === 'glm') {
      useUiStore.getState().setGlmApiKeyStatus('not-set')
    }
    const updated = await window.electronAPI.aiGetProviders()
    setProviders(updated)
    // 2026-04-25 PERF · 失效 aiConfigCache
    invalidateAiConfigCache()
  }

  const configuredCount = providers.filter(p => p.hasKey).length

  return (
    <>
      <div className="top-bar">
        <span className="logo">拾卷</span>
        <div style={{ flex: 1 }} />
        {!ONLINE_SEARCH_LOCKED && (
          <button
            className="btn btn-sm btn-icon"
            onClick={() => setLockedHint('在线搜索模式暂时关闭')}
            title="在线搜索并导入文献"
            style={{ padding: '6px 9px', marginRight: 4, color: 'var(--text-muted)' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </button>
        )}
        {/* Dark mode toggle */}
        <button
          className="btn btn-sm btn-icon"
          onClick={toggleDarkMode}
          title={darkMode ? '切换到亮色模式' : '切换到暗色模式'}
          style={{ padding: '6px 9px', marginRight: 4, color: darkMode ? '#ffc107' : 'var(--text-muted)' }}
        >
          {darkMode ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
        </button>

        {/* Reading graph */}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => setMainView(mainView === 'graph' ? 'reader' : 'graph')}
          title="阅读图谱"
          style={{
            padding: '6px 9px',
            marginRight: 4,
            color: mainView === 'graph' ? 'var(--accent-hover)' : 'var(--text-muted)',
            background: mainView === 'graph' ? 'var(--accent-soft)' : 'transparent',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="12" cy="18" r="3" />
            <path d="M8.6 7.6 10.8 15" />
            <path d="M15.4 7.6 13.2 15" />
            <path d="M9 6h6" />
          </svg>
        </button>

        {/* Hermes Agent button */}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => {
            if (rightPanel === 'agent' && !annotationPanelCollapsed) {
              // Already showing agent → collapse panel and reset to annotation mode
              useUiStore.setState({ rightPanel: 'annotation', annotationPanelCollapsed: true })
            } else {
              setRightPanel('agent')
            }
          }}
          title="学徒 · 研究伙伴"
          style={{
            padding: '6px 9px', marginRight: 4, position: 'relative',
            color: rightPanel === 'agent' && !annotationPanelCollapsed ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
          </svg>
          {hermesHasInsight && (
            <span style={{
              position: 'absolute', top: 2, right: 2, width: 7, height: 7,
              borderRadius: '50%', background: '#e74c3c',
              border: '1.5px solid var(--bg-warm)',
            }} />
          )}
        </button>
        {/* Lecture mode button — TEMPORARILY LOCKED.
            Speech-to-text + provider selection is on hold until we finish the STT
            provider rotation & error-recovery pass. Click triggers a "敬请期待"
            hint rather than opening the panel; visual state is clearly disabled
            (low opacity + small lock badge). To re-enable: restore the onClick
            body to setActiveLecture(...) and remove the locked styling block. */}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => setLockedHint('听课模式正在打磨中，敬请期待')}
          title="听课模式 · 敬请期待（打磨中）"
          style={{
            padding: '6px 9px', marginRight: 4,
            color: 'var(--text-muted)',
            opacity: 0.45,
            cursor: 'not-allowed',
            position: 'relative',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
          {/* Small lock badge in the corner so users see at a glance the feature is gated */}
          <span style={{
            position: 'absolute', right: 2, bottom: 2,
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--bg)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            lineHeight: 0,
          }}>
            <svg width="5" height="6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)' }}>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
        </button>
        {/* 2026-04-28 · 阅读日志按钮已删(readingLog 功能下线) */}
        {/* Settings button */}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => setShowSettings(true)}
          title={updateAvailable ? `设置 · 有新版本 v${updateAvailable.version}` : '设置'}
          style={{
            padding: '6px 9px', position: 'relative',
            ...(glmApiKeyStatus !== 'set' && configuredCount === 0 ? { color: 'var(--warning)' } : { color: 'var(--text-muted)' }),
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          {updateAvailable && (
            <span style={{
              position: 'absolute', top: 2, right: 2, width: 7, height: 7,
              borderRadius: '50%', background: '#e74c3c',
              border: '1.5px solid var(--bg-warm)',
            }} />
          )}
        </button>
      </div>

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
            <div className="settings-modal-body">
              <div className="settings-header">
                <div>
                  <div className="settings-eyebrow">偏好与数据</div>
                  <h3 className="settings-title">设置</h3>
                  <p className="settings-subtitle">
                    管理 AI 模型、上下文范围、数据迁移、更新和诊断信息。OCR 目前需要智谱 GLM；问答可使用任一已配置模型。
                  </p>
                </div>
                <div className="settings-health-card">
                  <span>AI 已配置</span>
                  <strong>{configuredCount}<em>/{providers.length || '...'}</em></strong>
                </div>
              </div>

              <div className="settings-content">

            {/* Collapsible AI providers section — header is always visible and
                summarizes "X 已配置 / Y 个供应商"; click to expand the full
                cards list. Auto-expands on first load when nothing is configured.

                Animation: uses the modern CSS-grid trick (grid-template-rows
                0fr ↔ 1fr) instead of max-height — this animates the *real*
                content height even though it varies with provider count, so
                the panel doesn't get a clipped tail or arrive late. Easing is
                a slight overshoot-free cubic-bezier that feels paper-soft. */}
            <div className={`settings-section settings-provider-group ${providersExpanded ? 'is-expanded' : ''}`}>
              <button
                className="settings-provider-toggle"
                onClick={() => setProvidersExpanded(v => !v)}
                title={providersExpanded ? '收起 AI 供应商列表' : '展开 AI 供应商列表'}
              >
                <div className="settings-provider-toggle-main">
                  <span className="settings-section-title">
                    AI 供应商 · API Key
                  </span>
                  <span className={`settings-provider-chip ${providers.some(p => p.hasKey) ? 'is-ready' : ''}`}>
                    {providers.filter(p => p.hasKey).length} / {providers.length || '...'} 已配置
                  </span>
                  {/* Configured-list summary — fades smoothly when transitioning,
                      kept rendered the whole time so we can opacity-tween it. */}
                  {providers.filter(p => p.hasKey).length > 0 && (
                    <span className="settings-provider-summary" style={{
                      opacity: providersExpanded ? 0 : 1,
                      transform: providersExpanded ? 'translateX(-4px)' : 'translateX(0)',
                      maxWidth: providersExpanded ? 0 : 360,
                      transition: 'opacity 0.22s ease, transform 0.28s ease, max-width 0.32s ease',
                      pointerEvents: providersExpanded ? 'none' : 'auto',
                    }}>
                      · {providers.filter(p => p.hasKey).map(p => p.name).join('、')}
                    </span>
                  )}
                </div>
                {/* Chevron — rotates smoothly with paper-soft easing */}
                <svg
                  className="settings-chevron"
                  width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  style={{
                    transform: providersExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {/* Animated container: grid-rows trick for height, plus opacity +
                  Y-fade on the inner content. Always rendered (no conditional)
                  so the height tween has both endpoints to interpolate. */}
              <div
                className="settings-provider-body"
                style={{ gridTemplateRows: providersExpanded ? '1fr' : '0fr' }}
              >
                <div className="settings-provider-body-clip">
                  <div className="settings-provider-body-inner" style={{
                    opacity: providersExpanded ? 1 : 0,
                    transform: providersExpanded ? 'translateY(0)' : 'translateY(-6px)',
                    transition: providersExpanded
                      ? 'opacity 0.28s ease 0.06s, transform 0.32s ease 0.04s'
                      : 'opacity 0.18s ease, transform 0.22s ease',
                    pointerEvents: providersExpanded ? 'auto' : 'none',
                  }}>
                  <div className="settings-callout">
                    <strong>第一次使用？</strong>
                    任选一家配置即可。推荐 <strong>智谱 GLM</strong>（GLM-4-Flash 免费，注册即送额度）或
                    <strong>DeepSeek</strong>（按量付费便宜，大陆直连）。各卡片下方有"获取 Key"链接直接跳转。
                    不想配 Key？看最下方的 <strong>Ollama</strong>（本地跑）或 <strong>Claude Code CLI</strong>（复用本机登录）。
                  </div>

                  {providers.map(provider => (
              <div
                key={provider.id}
                className={`settings-provider-card ${provider.hasKey ? 'is-configured' : ''}`}
              >
                <div className="settings-provider-card-head">
                  <div className="settings-provider-name">
                    {provider.name}
                    {provider.id === 'glm' && (
                      <>
                        <span className="settings-badge settings-badge-primary">推荐起步</span>
                        <span className="settings-badge settings-badge-muted">OCR 必需</span>
                      </>
                    )}
                    {provider.noKey && <span className="settings-badge settings-badge-success">零 Key · 本地运行</span>}
                  </div>
                  {provider.noKey ? (
                    provider.hasKey ? (
                      <span className="settings-provider-state is-ready">✓ 已连接（{provider.models.length} 个模型）</span>
                    ) : (
                      <span className="settings-provider-state">未检测到</span>
                    )
                  ) : (
                    provider.hasKey ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="settings-provider-state is-ready">✓ 已配置</span>
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: 10, padding: '2px 8px', color: 'var(--text-muted)' }}
                          onClick={() => handleRemoveKey(provider.id)}
                        >
                          移除
                        </button>
                      </div>
                    ) : (
                      <span className="settings-provider-state">未配置</span>
                    )
                  )}
                </div>

                {provider.noKey ? (
                  <>
                    {provider.id === 'ollama' ? (
                      provider.hasKey ? (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.6 }}>
                          已发现本地模型：{provider.models.map(m => m.name).join('、')}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.7 }}>
                          可选：安装 <a href="https://ollama.com/download" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Ollama</a> 后，在终端运行 <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3, fontSize: 10 }}>ollama pull qwen2.5:7b</code> 下一个模型，点下方"刷新"即可使用。<br />
                          <span style={{ color: 'var(--warning)' }}>注意</span>：本地模型运行在你自己电脑上，建议 <strong>8GB+ 内存</strong>（7B 小模型）或 <strong>16GB+</strong>（13B+ 更好模型），<strong>磁盘空间</strong>也会被模型占用（单个 7B 约 4-5GB）。老旧笔记本或内存紧张时不推荐。
                        </div>
                      )
                    ) : provider.id === 'claude_cli' ? (
                      provider.hasKey ? (
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6, lineHeight: 1.6 }}>
                          复用你本机已登录的 Claude Code 凭证。拾卷会调用 <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3, fontSize: 10 }}>claude -p</code> 非交互模式，Token 成本走你 Claude Code 的账号。<span style={{ color: 'var(--text-muted)' }}>（注意：不支持流式输出，回答会整段返回）</span>
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.7 }}>
                          <strong style={{ color: 'var(--warning)' }}>⚠️ 注意：这里指的是命令行工具 Claude Code，不是 Claude Desktop（GUI 聊天 App）。</strong> 两个是不同产品，桌面 GUI 没有对外接口、复用不了。<br />
                          要复用 CLI，需要：<br />
                          1. 终端跑 <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3, fontSize: 10 }}>npm install -g @anthropic-ai/claude-code</code> 装好 CLI<br />
                          2. 跑一次 <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3, fontSize: 10 }}>claude</code> 完成 OAuth 登录<br />
                          3. 验证 <code style={{ background: 'var(--bg)', padding: '0 4px', borderRadius: 3, fontSize: 10 }}>claude --version</code> 能出版本号<br />
                          完成后点下方"刷新检测"。详见 <a href="https://www.anthropic.com/claude-code" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Claude Code 官网</a>。
                        </div>
                      )
                    ) : null}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-sm"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={async () => {
                          setSaving(provider.id)
                          try {
                            const updated = await window.electronAPI.aiGetProviders()
                            setProviders(updated)
                          } catch { /* ignore */ }
                          setSaving(null)
                        }}
                        disabled={saving === provider.id}
                      >
                        {saving === provider.id ? '检测中...' : '刷新检测'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
                      模型：{provider.models.map(m => m.name).join('、')}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        className="settings-key-input"
                        type="password"
                        placeholder={provider.hasKey ? '输入新 Key 可更新' : '输入 API Key'}
                        value={keyInputs[provider.id] || ''}
                        onChange={e => setKeyInputs(prev => ({ ...prev, [provider.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') handleSaveKey(provider.id) }}
                      />
                      <button
                        className="btn btn-sm btn-primary"
                        style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => handleSaveKey(provider.id)}
                        disabled={!keyInputs[provider.id]?.trim() || saving === provider.id}
                      >
                        {saving === provider.id ? '...' : '保存'}
                      </button>
                    </div>

                    {/* Key acquisition helper — lowers the bar for users who don't
                        know where to get an API key. Shown only when unconfigured
                        so it doesn't clutter the UI once saved. */}
                    {!provider.hasKey && provider.apiKeyUrl && (
                      <div style={{
                        marginTop: 6, fontSize: 10, color: 'var(--text-muted)',
                        lineHeight: 1.6,
                      }}>
                        还没有 Key？→ <a
                          href={provider.apiKeyUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                        >在 {provider.name} 官网获取</a>
                        {provider.freeTierHint && (
                          <span style={{ marginLeft: 4, opacity: 0.85 }}>· {provider.freeTierHint}</span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
                  ))}
                  </div>
                </div>
              </div>
            </div>
            {/* End collapsible AI providers section */}

            {/* Speech-to-Text API Keys — hidden, feature in development */}

            {/* Dual-page mode setting — hidden for now, feature in development */}

            {/* AI Context Window Setting */}
            <div className="settings-section">
              <div className="settings-section-inner">
              <div className="settings-section-title">
                AI 上下文范围
              </div>
              <div className="settings-section-desc">
                AI 回答时参考选中文字前后多少字的文献内容。范围越大理解越完整，但消耗更多 token。
              </div>
              <div className="settings-segmented">
                {AI_CONTEXT_PRESETS.map(opt => {
                  const active = aiContextWindow === opt.value
                  return (
                    <button
                      key={opt.value}
                      className={`settings-choice ${active ? 'is-active' : ''}`}
                      onClick={() => {
                        setCustomContextOpen(false)
                        setAiContextWindow(opt.value)
                      }}
                    >
                      {opt.label}
                    </button>
                  )
                })}
                <button
                  className={`settings-choice ${isCustomContextWindow ? 'is-active' : ''}`}
                  onClick={openCustomContextWindow}
                >
                  自定义
                </button>
                {(customContextOpen || isCustomContextWindow) && (
                  <label className="settings-custom-context" title="自定义 AI 参考的前后文字数量">
                    <input
                      type="number"
                      min={100}
                      max={200000}
                      step={100}
                      value={customContextDraft}
                      placeholder="3000"
                      onChange={(e) => setCustomContextDraft(e.currentTarget.value.replace(/[^\d]/g, '').slice(0, 6))}
                      onBlur={() => commitCustomContextWindow()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          commitCustomContextWindow()
                          e.currentTarget.blur()
                        }
                      }}
                    />
                    <span>字</span>
                  </label>
                )}
              </div>
              </div>
            </div>

            {/* Data Export (citations + full backup) */}
            <DataExportPanel />

            {/* Auto Update */}
            <UpdatePanel />

            {/* Diagnostics (collapsible) */}
            <DiagnosticPanel />

              </div>
            </div>

            <div className="settings-footer">
              <div className="settings-footer-links">
                <button
                  className="btn btn-sm settings-quiet-button"
                  style={{ fontSize: 11, padding: '5px 12px' }}
                  onClick={() => {
                    setShowSettings(false)
                    // Slight delay so the close-animation doesn't fight the modal mount.
                    setTimeout(() => useUiStore.getState().setForceOnboarding(true), 60)
                  }}
                  title="再看一遍首启的欢迎引导（不会清空你已配置的 Key）"
                >
                  查看欢迎引导
                </button>
                <button
                  className="btn btn-sm settings-quiet-button"
                  style={{ fontSize: 11, padding: '5px 12px' }}
                  onClick={() => {
                    setShowSettings(false)
                    setTimeout(() => useUiStore.getState().setForceFeatureTour(true), 60)
                  }}
                  title="再看一遍 6 步功能指引（导入 / OCR / 划线 / 注释 / 学徒对话 / 召唤）"
                >
                  查看功能指引
                </button>
              </div>
              <button className="btn btn-primary settings-close-button" onClick={() => setShowSettings(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {/* Locked-feature toast — fixed position, top-center, mirrors app aesthetic
          (warm background, accent left-stripe, serif-friendly text). Replaces
          window.alert() so the message stays inside the app shell. */}
      {lockedHint && (
        <div
          onClick={() => setLockedHint(null)}
          style={{
            position: 'fixed',
            top: 56,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderLeft: '3px solid var(--accent)',
            borderRadius: 6,
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
            padding: '10px 18px 10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            color: 'var(--text)',
            cursor: 'pointer',
            maxWidth: 360,
            animation: 'lockedHintIn 0.18s ease-out',
            userSelect: 'none',
          }}
          title="点击关闭"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)', flexShrink: 0 }}>
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span style={{ lineHeight: 1.5 }}>{lockedHint}</span>
        </div>
      )}
      <style>{`
        @keyframes lockedHintIn {
          from { opacity: 0; transform: translate(-50%, -8px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
      `}</style>
    </>
  )
}
