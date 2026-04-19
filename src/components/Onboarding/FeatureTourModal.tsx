// FeatureTourModal — multi-step feature walkthrough.
// Triggered automatically the first time the user has any AI provider
// configured AND has not yet seen the tour. Can also be re-triggered from
// Settings via `setForceFeatureTour(true)` (the "查看功能教程" button).
//
// Why this exists: OnboardingModal only nudges the user to set up an AI key.
// Even after they're set up, humanities-track users tend to miss key
// affordances — the 导入文件 button is in a sidebar they may have collapsed,
// OCR is hidden behind a viewer toolbar, the selection-driven highlight
// toolbar isn't discoverable until you actually select text. This tour
// surfaces the five flows that almost every user needs:
//   1. 导入文献 (file / folder import)
//   2. OCR 识别 (image-PDF → searchable text)
//   3. 划线 / 高光 / 注释 (selection-toolbar features)
//   4. 删除划线 / 高光 (the inverse — click an existing mark)
//   5. 学徒周报 (Hermes 学徒 tab)
//
// Each step is centered narration + a small SVG icon. We deliberately don't
// try to "spotlight" real DOM elements — those move around with sidebar
// collapse / panel resize and the spotlight breaks. Static narration is
// more robust and works the same on first launch as on a re-trigger.

import { useEffect, useState, useCallback } from 'react'
import { useUiStore } from '../../store/uiStore'

const FLAG_KEY = 'sj-feature-tour-shown'

interface Step {
  title: string
  body: JSX.Element
  icon: JSX.Element
}

// ===== Icons =====
// Inline SVGs so the tour stays in one file. Stroke-based, --accent color,
// matches the rest of 拾卷's iconography.
const iconStyle = { stroke: 'currentColor', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const ImportIcon = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const OcrIcon = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" {...iconStyle}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <path d="M14 14h7M14 17h5M14 20h7" />
  </svg>
)

const HighlightIcon = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M9 11l-6 6v3h3l6-6" />
    <path d="M14 5l5 5" />
    <path d="M16 3l5 5-9 9-5-5z" />
  </svg>
)

const EraseIcon = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M20 20H7L3 16a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L13 19" />
    <path d="M9 11l5 5" />
  </svg>
)

const ApprenticeIcon = () => (
  <svg width="44" height="44" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M9 7h7M9 11h7M9 15h4" />
  </svg>
)

// ===== Steps =====
// Body uses small layout primitives (kbd, pill) defined inline below.
const KBD: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{
    display: 'inline-block', padding: '1px 7px', fontSize: 11,
    fontFamily: 'ui-monospace, "Consolas", monospace',
    border: '1px solid var(--border)', borderBottomWidth: 2,
    borderRadius: 4, background: 'var(--bg-warm)',
    color: 'var(--text-secondary)', lineHeight: 1.4,
    margin: '0 1px',
  }}>{children}</span>
)

const Pill: React.FC<{ children: React.ReactNode; tone?: 'accent' | 'warm' }> = ({ children, tone = 'warm' }) => (
  <span style={{
    display: 'inline-block', padding: '1px 8px', fontSize: 11.5,
    border: tone === 'accent' ? '1px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 10, background: tone === 'accent' ? 'transparent' : 'var(--bg-warm)',
    color: tone === 'accent' ? 'var(--accent)' : 'var(--text-secondary)',
    margin: '0 2px',
  }}>{children}</span>
)

const STEPS: Step[] = [
  {
    title: '导入文献',
    icon: <ImportIcon />,
    body: (
      <>
        左侧文献栏底部有两个按钮：
        <Pill>导入文件</Pill>
        和
        <Pill>导入文件夹</Pill>
        。
        <br /><br />
        支持 <strong>PDF / EPUB / Word / TXT / Markdown</strong> 等常见格式。
        文件夹会按目录结构自动建立分组。
        <br /><br />
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          也可以直接把文件拖进窗口；或者从 Zotero / EndNote 导出 .bib 批量带过来（顶栏 → 导入 .bib）。
        </span>
      </>
    ),
  },
  {
    title: 'OCR 识别',
    icon: <OcrIcon />,
    body: (
      <>
        <strong>扫描版 PDF</strong>（图片，没有文字层）需要先 OCR 才能选中、注释、被 AI 检索到。
        <br /><br />
        打开一份 PDF 后，顶部工具栏有
        <Pill tone="accent">OCR</Pill>
        按钮——一键把整本书发给智谱 GLM 识别。多本书可在<strong>批量 OCR</strong>队列里依次跑。
        <br /><br />
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          已经有文字层的 PDF 不用 OCR，直接选中文字即可。OCR 完成后阅读器右上角能切换 <KBD>原版</KBD> / <KBD>OCR 文本</KBD> 两种视图。
        </span>
      </>
    ),
  },
  {
    title: '划线 · 高光 · 注释',
    icon: <HighlightIcon />,
    body: (
      <>
        在阅读器里<strong>选中任意文字</strong>，浮动工具栏会出现：
        <ul style={{ margin: '8px 0 8px 22px', paddingLeft: 0, lineHeight: 1.8, fontSize: 12.5 }}>
          <li><Pill>划线</Pill> — 给选区加一条彩色下划线（黄/绿/蓝可选）</li>
          <li><Pill>高亮</Pill> — 把文字加粗 + 改色，用来标记关键句</li>
          <li><Pill>注释</Pill> — 在右侧面板写一段想法，绑定到这段原文</li>
        </ul>
        快捷键 <KBD>Ctrl</KBD> + <KBD>↵</KBD> 在注释面板里直接保存。
      </>
    ),
  },
  {
    title: '删除划线 · 高光',
    icon: <EraseIcon />,
    body: (
      <>
        想去掉一条已有的划线或高光，在它上面<strong>右键</strong>——会弹出小菜单，里面有
        <Pill>取消划线</Pill>
        /
        <Pill>取消高亮</Pill>
        。
        <br /><br />
        <strong>注释</strong>的删除在右侧 <Pill tone="accent">注释面板</Pill> 里：点击对应注释卡片右上角的 <KBD>×</KBD>。
        <br /><br />
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          所有标记和注释都<strong>本地保存</strong>，跟着这本书走，不依赖网络。
        </span>
      </>
    ),
  },
  {
    title: '学徒周报',
    icon: <ApprenticeIcon />,
    body: (
      <>
        右侧 <Pill tone="accent">Hermes</Pill> 面板顶部切到 <Pill>学徒</Pill> 标签。
        <br /><br />
        点
        <Pill tone="accent">让学徒写最近 7 天观察</Pill>
        ——它会读你这一周划线、注释、笔记的痕迹，写成一份<strong>观察周报</strong>：你最近在想什么、哪几本书在串、哪些念头反复出现。
        <br /><br />
        生成后还能在底部对话框 <strong>追问学徒</strong>，让它顺着某条线索往下挖。
        <br /><br />
        <span style={{ fontSize: 11, opacity: 0.75 }}>
          学徒不是助手，是跟你并肩读书的同伴——它只观察，不评价、不建议。
        </span>
      </>
    ),
  },
]

// ===== Component =====
export default function FeatureTourModal(): JSX.Element | null {
  const [shouldShow, setShouldShow] = useState(false)
  const [stepIdx, setStepIdx] = useState(0)
  const forceFeatureTour = useUiStore(s => s.forceFeatureTour)
  const setForceFeatureTour = useUiStore(s => s.setForceFeatureTour)

  // Trigger on mount: if flag not set AND any AI provider has a key configured.
  // We deliberately wait for an API key so the tour pairs naturally with the
  // OnboardingModal's "去配置 GLM" CTA — once the user finishes API setup
  // (returns from Settings, opens app next time), this fires.
  //
  // Edge: users who skip onboarding entirely will see this tour on a later boot
  // once they've configured a key through Settings. That's intended — the tour
  // is most useful when they've actually committed to using AI features.
  useEffect(() => {
    let alreadyShown = false
    try { alreadyShown = !!localStorage.getItem(FLAG_KEY) } catch {}
    if (alreadyShown) return
    if (!window.electronAPI?.aiGetProviders) return

    let cancelled = false
    // Slight delay so we don't fight the OnboardingModal's mount.
    const t = setTimeout(() => {
      if (cancelled) return
      window.electronAPI.aiGetProviders().then((providers: any[]) => {
        if (cancelled) return
        const hasAnyKey = providers.some(p => p.hasKey)
        if (hasAnyKey) setShouldShow(true)
      }).catch(() => { /* don't block boot */ })
    }, 1800)

    return () => { cancelled = true; clearTimeout(t) }
  }, [])

  const close = useCallback((markAsSeen: boolean) => {
    if (markAsSeen) {
      try { localStorage.setItem(FLAG_KEY, '1') } catch {}
    }
    setShouldShow(false)
    setStepIdx(0)
    if (forceFeatureTour) setForceFeatureTour(false)
  }, [forceFeatureTour, setForceFeatureTour])

  const next = useCallback(() => {
    if (stepIdx >= STEPS.length - 1) {
      close(true)
    } else {
      setStepIdx(i => i + 1)
    }
  }, [stepIdx, close])

  const prev = useCallback(() => {
    setStepIdx(i => Math.max(0, i - 1))
  }, [])

  // Keyboard nav: ← → for prev/next, ESC for skip
  useEffect(() => {
    if (!shouldShow && !forceFeatureTour) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
      else if (e.key === 'Escape') { e.preventDefault(); close(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shouldShow, forceFeatureTour, next, prev, close])

  if (!shouldShow && !forceFeatureTour) return null

  const step = STEPS[stepIdx]
  const isLast = stepIdx === STEPS.length - 1
  const isFirst = stepIdx === 0

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1001,
        background: 'rgba(40, 30, 20, 0.42)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        animation: 'sj-tour-fade 0.18s ease-out',
      }}
      onClick={() => close(true)}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: 480, width: '100%',
          background: 'var(--bg, #faf6ef)',
          borderRadius: 12,
          padding: '26px 32px 22px',
          boxShadow: '0 12px 36px rgba(60, 40, 20, 0.22)',
          border: '1px solid var(--border)',
          fontFamily: 'inherit',
          animation: 'sj-tour-pop 0.22s cubic-bezier(.2,.9,.3,1.15)',
        }}
      >
        {/* Step counter + skip */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {STEPS.map((_, i) => (
              <div
                key={i}
                onClick={() => setStepIdx(i)}
                title={`第 ${i + 1} 步`}
                style={{
                  width: i === stepIdx ? 18 : 6, height: 6, borderRadius: 3,
                  background: i === stepIdx
                    ? 'var(--accent)'
                    : i < stepIdx ? 'var(--text-muted)' : 'var(--border)',
                  cursor: 'pointer',
                  transition: 'width 0.2s, background 0.2s',
                }}
              />
            ))}
            <span style={{
              marginLeft: 10, fontSize: 11, color: 'var(--text-muted)',
              letterSpacing: 0.4,
            }}>
              {stepIdx + 1} / {STEPS.length}
            </span>
          </div>
          <button
            onClick={() => close(true)}
            title="跳过教程（不再提示）"
            style={{
              padding: '3px 10px', fontSize: 11,
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', cursor: 'pointer',
              borderRadius: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-warm)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            跳过
          </button>
        </div>

        {/* Icon + title row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          marginBottom: 14, color: 'var(--accent)',
        }}>
          <div style={{
            width: 56, height: 56,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--bg-warm)',
            borderRadius: 12,
            border: '1px solid var(--border-light)',
            flexShrink: 0,
          }}>
            {step.icon}
          </div>
          <div>
            <div style={{
              fontSize: 11, color: 'var(--text-muted)', letterSpacing: 1,
              marginBottom: 3, textTransform: 'uppercase',
            }}>
              功能教程 · STEP {stepIdx + 1}
            </div>
            <div style={{
              fontSize: 18, fontWeight: 600, color: 'var(--text)',
              letterSpacing: 0.5,
            }}>
              {step.title}
            </div>
          </div>
        </div>

        {/* Body */}
        <div style={{
          fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.85,
          padding: '14px 16px',
          background: 'var(--bg-warm)',
          borderRadius: 8,
          border: '1px solid var(--border-light)',
          marginBottom: 18,
          minHeight: 130,
        }}>
          {step.body}
        </div>

        {/* Nav buttons */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10,
        }}>
          <button
            onClick={prev}
            disabled={isFirst}
            style={{
              padding: '7px 14px', fontSize: 12.5,
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: isFirst ? 'var(--text-muted)' : 'var(--text-secondary)',
              cursor: isFirst ? 'not-allowed' : 'pointer',
              opacity: isFirst ? 0.4 : 1,
              transition: 'background 0.12s',
            }}
            onMouseEnter={e => { if (!isFirst) e.currentTarget.style.background = 'var(--bg-warm)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            ← 上一步
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75 }}>
            <KBD>←</KBD> <KBD>→</KBD> 切换 · <KBD>Esc</KBD> 跳过
          </span>
          <button
            onClick={next}
            autoFocus
            style={{
              padding: '7px 18px', fontSize: 12.5, fontWeight: 600,
              background: 'var(--accent)', border: 'none',
              borderRadius: 6, color: '#fff', cursor: 'pointer',
              transition: 'opacity 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '0.88' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >
            {isLast ? '完成 ✓' : '下一步 →'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes sj-tour-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes sj-tour-pop {
          from { opacity: 0; transform: translateY(-8px) scale(0.96) }
          to { opacity: 1; transform: translateY(0) scale(1) }
        }
      `}</style>
    </div>
  )
}
