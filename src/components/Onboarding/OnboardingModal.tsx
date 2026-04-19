// OnboardingModal — first-launch friendly nudge for users with no AI provider
// configured. Pops up exactly once (gated by localStorage flag) and lets the
// user either jump straight to Settings or dismiss.
//
// Why this exists: humanities-track users hit the app fresh and see a quiet
// reading interface but no obvious "how do I make AI work" path. The Settings
// modal is buried behind a gear icon they may not notice. This modal:
//   1. Greets them by name (well, by app)
//   2. Explains in plain language that AI is optional but recommended
//   3. Says "GLM is the easiest start" — Chinese, free tier, no VPN needed
//   4. Has one prominent CTA: "去配置 GLM" → opens settings
//   5. Has a quiet "稍后再说" → dismisses without pressure
//
// Flag key `sj-onboarding-shown` is checked once on mount; if present we don't
// render at all. Setting it on either button click means the user won't be
// re-pestered on subsequent boots even if they never end up configuring a key.

import { useEffect, useState } from 'react'
import { useUiStore } from '../../store/uiStore'

const FLAG_KEY = 'sj-onboarding-shown'

interface ProviderInfo {
  id: string
  name: string
  hasKey: boolean
  noKey?: boolean
}

export default function OnboardingModal(): JSX.Element | null {
  const [shouldShow, setShouldShow] = useState(false)
  const setShowSettings = useUiStore(s => s.setShowSettings)
  const forceOnboarding = useUiStore(s => s.forceOnboarding)
  const setForceOnboarding = useUiStore(s => s.setForceOnboarding)

  useEffect(() => {
    // Check if we've already shown this once.
    let alreadyShown = false
    try { alreadyShown = !!localStorage.getItem(FLAG_KEY) } catch { /* private mode etc. */ }
    if (alreadyShown) return

    // Check if any provider has a key configured. If so, user is already
    // set up — no point showing the wizard.
    if (!window.electronAPI?.aiGetProviders) return
    let cancelled = false
    // Slight delay so the wizard doesn't fight the app's first paint.
    const t = setTimeout(() => {
      if (cancelled) return
      window.electronAPI.aiGetProviders().then((providers: ProviderInfo[]) => {
        if (cancelled) return
        const anyConfigured = providers.some(p => p.hasKey)
        if (!anyConfigured) setShouldShow(true)
      }).catch(() => { /* swallow — don't block startup on this */ })
    }, 1200)

    return () => { cancelled = true; clearTimeout(t) }
  }, [])

  const dismiss = () => {
    try { localStorage.setItem(FLAG_KEY, '1') } catch { /* fine */ }
    setShouldShow(false)
    // Force-show is a one-shot bypass — clear it on close so the next boot
    // returns to normal flag-gated behavior.
    if (forceOnboarding) setForceOnboarding(false)
  }

  const goToSettings = () => {
    dismiss()
    setShowSettings(true)
  }

  // Open 智谱AI开放平台 in the system browser. main.ts setWindowOpenHandler
  // intercepts window.open and routes to shell.openExternal.
  const openGlmPlatform = () => {
    try { window.open('https://open.bigmodel.cn/', '_blank') } catch { /* fine */ }
  }

  // Skip API config and jump straight to the feature tour. For users who
  // already know they don't want AI right now but still want the lay of the
  // land. Same dismiss flag — onboarding is "done" either way.
  const setForceFeatureTour = useUiStore(s => s.setForceFeatureTour)
  const goToFeatureTour = () => {
    dismiss()
    setTimeout(() => setForceFeatureTour(true), 60)
  }

  // forceOnboarding bypasses both the localStorage flag and the provider check,
  // so users can re-trigger the welcome screen from Settings any time.
  if (!shouldShow && !forceOnboarding) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}
      onClick={dismiss}
    >
      <div
        style={{
          maxWidth: 480, width: '100%',
          background: 'var(--bg)', borderRadius: 12,
          padding: '28px 32px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.18)',
          border: '1px solid var(--border)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>
          欢迎使用拾卷
        </div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.85, marginBottom: 18 }}>
          拾卷是一个安静的本地读书工具——你可以直接导入书、选中文字写注释，<strong>不接 AI 也能用</strong>。
          <br /><br />
          如果想让它帮你<strong>梳理脉络、让学徒写周报</strong>，需要接入一个 AI 服务。
          <br /><br />
          最简单的开始方式是
          <a
            href="https://open.bigmodel.cn/"
            onClick={(e) => { e.preventDefault(); openGlmPlatform() }}
            style={{
              color: 'var(--accent)', fontWeight: 600,
              textDecoration: 'underline', textDecorationStyle: 'dotted',
              textUnderlineOffset: 3, cursor: 'pointer',
            }}
            title="点击打开智谱AI开放平台（系统浏览器）"
          >
            智谱 GLM
          </a>
          ：
          <ul style={{ margin: '8px 0 8px 22px', paddingLeft: 0, lineHeight: 1.85 }}>
            <li>国内可直接访问，不需要梯子</li>
            <li>GLM-4-Flash 模型完全免费</li>
            <li>注册送新用户额度</li>
          </ul>
          注册一个账号、复制 API Key 到拾卷设置里，5 分钟搞定。
        </div>

        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: 'var(--bg-warm)', borderRadius: 6,
          border: '1px solid var(--border-light)',
          fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7,
        }}>
          也支持 OpenAI / Claude / Gemini / Kimi / DeepSeek / 豆包等。
          已经有 Claude Code 在本机？可以零配置直接复用。
        </div>

        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          marginBottom: 18, lineHeight: 1.7,
        }}>
          <span style={{ opacity: 0.85 }}>配好 Key 后，下次启动会自动弹出</span>
          <button
            onClick={goToFeatureTour}
            style={{
              padding: '0 4px', margin: '0 1px', fontSize: 11,
              background: 'transparent', border: 'none',
              color: 'var(--accent)', fontWeight: 500,
              cursor: 'pointer', textDecoration: 'underline',
              textDecorationStyle: 'dotted', textUnderlineOffset: 3,
            }}
            title="跳过 API 配置，直接看 5 步功能教程"
          >
            5 步功能教程
          </button>
          <span style={{ opacity: 0.85 }}>（导入 / OCR / 划线 / 注释 / 学徒周报）；也可以现在就先看看。</span>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={dismiss}
            style={{
              padding: '8px 18px', fontSize: 12.5,
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            稍后再说
          </button>
          <button
            onClick={openGlmPlatform}
            title="打开智谱AI开放平台（注册账号、复制 API Key）"
            style={{
              padding: '8px 14px', fontSize: 12.5,
              background: 'transparent',
              border: '1px solid var(--accent)',
              borderRadius: 6, color: 'var(--accent)',
              cursor: 'pointer', fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            去注册 GLM 账号
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3h7v7" />
              <path d="M10 14L21 3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
          </button>
          <button
            onClick={goToSettings}
            style={{
              padding: '8px 18px', fontSize: 12.5, fontWeight: 600,
              background: 'var(--accent)', border: 'none',
              borderRadius: 6, color: '#fff', cursor: 'pointer',
            }}
          >
            去配置 GLM →
          </button>
        </div>
      </div>
    </div>
  )
}
