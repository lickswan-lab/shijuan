import { useState, useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'

interface ProviderInfo {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
  hasKey: boolean
}

export default function TopBar() {
  const { showSettings, setShowSettings, glmApiKeyStatus, activeReadingLogDate, setActiveReadingLogDate, setSidebarTab } = useUiStore()
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
            <h3>AI 模型设置</h3>
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

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn" onClick={() => setShowSettings(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
