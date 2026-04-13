import { useState, useEffect } from 'react'
import { useUiStore } from '../../store/uiStore'

interface ProviderInfo {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
  hasKey: boolean
}

export default function TopBar() {
  const { showSettings, setShowSettings, glmApiKeyStatus } = useUiStore()
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
        <button
          className="btn btn-sm"
          onClick={() => setShowSettings(true)}
          style={glmApiKeyStatus !== 'set' && configuredCount === 0 ? { borderColor: 'var(--warning)', color: 'var(--warning)' } : {}}
        >
          设置
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

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn" onClick={() => setShowSettings(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
