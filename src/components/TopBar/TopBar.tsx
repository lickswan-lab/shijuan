import { useState, useEffect, useCallback } from 'react'
import { useUiStore } from '../../store/uiStore'

// ===== Auto Update Panel =====
function UpdatePanel() {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'>('idle')
  const [info, setInfo] = useState<{ currentVersion: string; latestVersion: string; downloadUrl: string | null; releaseNotes: string; asarSize: number } | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')

  const handleCheck = useCallback(async () => {
    if (!window.electronAPI?.checkUpdate) return
    setStatus('checking'); setError('')
    try {
      const result = await window.electronAPI.checkUpdate()
      setInfo(result)
      setStatus(result.hasUpdate ? 'available' : 'idle')
    } catch (err: any) {
      setError(err.message || '检查失败')
      setStatus('error')
    }
  }, [])

  const handleDownload = useCallback(async () => {
    if (!info?.downloadUrl || !window.electronAPI?.downloadUpdate) return
    setStatus('downloading'); setProgress(0)

    // Listen for progress
    const cleanup = window.electronAPI.onUpdateProgress?.((pct: number) => setProgress(pct))

    try {
      const result = await window.electronAPI.downloadUpdate(info.downloadUrl)
      cleanup?.()
      if (result.success) {
        setStatus('ready')
      } else {
        setError(result.error || '下载失败')
        setStatus('error')
      }
    } catch (err: any) {
      cleanup?.()
      setError(err.message || '下载失败')
      setStatus('error')
    }
  }, [info])

  const handleApply = useCallback(async () => {
    if (!window.electronAPI?.applyUpdate) return
    await window.electronAPI.applyUpdate()
  }, [])

  return (
    <div style={{
      padding: '12px 14px', marginBottom: 8, borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--bg-warm)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>软件更新</div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          当前版本 {info?.currentVersion || '...'}
        </span>
      </div>

      {status === 'idle' && !info?.hasUpdate && (
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
    <div style={{
      padding: '12px 14px', marginBottom: 8, borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--bg-warm)',
    }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={handleToggle}
      >
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>诊断信息</div>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
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
  )
}

interface ProviderInfo {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
  hasKey: boolean
}

export default function TopBar() {
  const { showSettings, setShowSettings, glmApiKeyStatus, activeReadingLogDate, setActiveReadingLogDate, setSidebarTab, rightPanel, setRightPanel, annotationPanelCollapsed, toggleAnnotationPanel, hermesHasInsight, darkMode, toggleDarkMode } = useUiStore()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)

  // Load providers when settings opens
  useEffect(() => {
    if (showSettings && window.electronAPI?.aiGetProviders) {
      window.electronAPI.aiGetProviders().then(setProviders).catch(() => {})
    }
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
  }

  const configuredCount = providers.filter(p => p.hasKey).length

  return (
    <>
      <div className="top-bar">
        <span className="logo">拾卷</span>
        <div style={{ flex: 1 }} />
        {/* Dark mode toggle */}
        <button
          className="btn btn-sm btn-icon"
          onClick={toggleDarkMode}
          title={darkMode ? '切换到亮色模式' : '切换到暗色模式'}
          style={{ padding: '5px 7px', marginRight: 4, color: darkMode ? '#ffc107' : 'var(--text-muted)' }}
        >
          {darkMode ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
              <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          )}
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
          title="Hermes 研究助手"
          style={{
            padding: '5px 7px', marginRight: 4, position: 'relative',
            color: rightPanel === 'agent' && !annotationPanelCollapsed ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        {/* Lecture mode button (hidden for now, feature in development) */}
        {false && <button
          className="btn btn-sm btn-icon"
          onClick={() => {
            const { activeLectureId, setActiveLecture } = useUiStore.getState()
            if (activeLectureId) {
              setActiveLecture(null)
            } else {
              setActiveLecture('__list__')  // show list
            }
          }}
          title="听课模式"
          style={{
            padding: '5px 7px', marginRight: 4,
            color: useUiStore.getState().activeLectureId ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </button>}
        {/* Reading log button */}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => {
            if (activeReadingLogDate) {
              setActiveReadingLogDate(null)
            } else {
              setSidebarTab('reading-log')
              // Open today's log or just switch to log tab
              setActiveReadingLogDate(new Date().toISOString().slice(0, 10))
            }
          }}
          title="阅读日志"
          style={{
            padding: '5px 7px', marginRight: 4,
            color: activeReadingLogDate ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>
        {/* Settings button */}
        <button
          className="btn btn-sm btn-icon"
          onClick={() => setShowSettings(true)}
          title="设置"
          style={{
            padding: '5px 7px',
            ...(glmApiKeyStatus !== 'set' && configuredCount === 0 ? { color: 'var(--warning)' } : { color: 'var(--text-muted)' }),
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, maxHeight: '80vh', overflow: 'auto' }}>
            <h3>设置</h3>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
              配置各 AI 供应商的 API Key。OCR 功能需要智谱 GLM，问答对话支持所有已配置的模型。
            </div>

            {providers.map(provider => (
              <div
                key={provider.id}
                style={{
                  padding: '12px 14px', marginBottom: 8, borderRadius: 8,
                  border: `1px solid ${provider.hasKey ? 'var(--success)' : 'var(--border)'}`,
                  background: provider.hasKey ? 'rgba(76,175,80,0.04)' : 'var(--bg-warm)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                    {provider.name}
                    {provider.id === 'glm' && <span style={{ fontSize: 10, color: 'var(--accent)', marginLeft: 6 }}>OCR 必需</span>}
                  </div>
                  {provider.hasKey ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ 已配置</span>
                      <button
                        className="btn btn-sm"
                        style={{ fontSize: 10, padding: '2px 8px', color: 'var(--text-muted)' }}
                        onClick={() => handleRemoveKey(provider.id)}
                      >
                        移除
                      </button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>未配置</span>
                  )}
                </div>

                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
                  模型：{provider.models.map(m => m.name).join('、')}
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="password"
                    placeholder={provider.hasKey ? '输入新 Key 可更新' : '输入 API Key'}
                    value={keyInputs[provider.id] || ''}
                    onChange={e => setKeyInputs(prev => ({ ...prev, [provider.id]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveKey(provider.id) }}
                    style={{
                      flex: 1, padding: '5px 10px', border: '1px solid var(--border)',
                      borderRadius: 4, fontSize: 12, outline: 'none', background: 'var(--bg)',
                    }}
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
              </div>
            ))}

            {/* Speech-to-Text API Keys — hidden, feature in development */}

            {/* Dual-page mode setting — hidden for now, feature in development */}

            {/* AI Context Window Setting */}
            <div style={{
              padding: '12px 14px', marginBottom: 8, borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--bg-warm)',
            }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 8 }}>
                AI 上下文范围
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                AI 回答时参考选中文字前后多少字的文献内容。范围越大理解越完整，但消耗更多 token。
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { label: '1000字', value: 1000 },
                  { label: '2000字', value: 2000 },
                  { label: '5000字', value: 5000 },
                  { label: '10000字', value: 10000 },
                  { label: '全文', value: -1 },
                ].map(opt => {
                  const active = useUiStore.getState().aiContextWindow === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => useUiStore.getState().setAiContextWindow(opt.value)}
                      style={{
                        padding: '5px 12px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                        border: active ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                        background: active ? 'var(--accent-soft)' : 'var(--bg)',
                        color: active ? 'var(--accent-hover)' : 'var(--text-secondary)',
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Auto Update */}
            <UpdatePanel />

            {/* Diagnostics (collapsible) */}
            <DiagnosticPanel />

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn" onClick={() => setShowSettings(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
