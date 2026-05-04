// FeatureTourModal — visual first-run walkthrough.
// Triggered automatically the first time the user has any AI provider
// configured AND has not yet seen the current tour. Can also be re-triggered
// from Settings via `setForceFeatureTour(true)`.
//
// The tour now mirrors the 1.3.3 interface:
//   1. 导入文献
//   2. 阅读 / OCR
//   3. 划线 / 高光 / 注释
//   4. 管理注释与标记
//   5. 学徒对话
//   6. 召唤人物
//
// Each step pairs short copy with a miniature UI preview. That is more concrete
// than asking new users to infer behavior from abstract icons.

import { useEffect, useState, useCallback } from 'react'
import { useUiStore } from '../../store/uiStore'

const FLAG_KEY = 'sj-feature-tour-shown-v133'

interface Step {
  title: string
  body: JSX.Element
  icon: JSX.Element
  visual: JSX.Element
}

// ===== Icons =====
const iconStyle = { stroke: 'currentColor', strokeWidth: 1.7, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const ImportIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

const ReaderIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M9 7h7M9 11h7M9 15h4" />
  </svg>
)

const MarkIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M9 11l-6 6v3h3l6-6" />
    <path d="M14 5l5 5" />
    <path d="M16 3l5 5-9 9-5-5z" />
  </svg>
)

const NotesIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M4 4h16v16H4z" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
)

const DialogueIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
    <path d="M8 8h8M8 12h5" />
  </svg>
)

const SummonIcon = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" {...iconStyle}>
    <path d="M12 2l2.4 4.9L20 8l-4 3.9.9 5.6L12 14.8 7.1 17.5 8 11.9 4 8l5.6-1.1L12 2z" />
    <path d="M5 21h14" />
  </svg>
)

// ===== Small UI primitives =====
const KBD: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{
    display: 'inline-block', padding: '1px 7px', fontSize: 11,
    fontFamily: 'ui-monospace, "Consolas", monospace',
    border: '1px solid var(--border)', borderBottomWidth: 2,
    borderRadius: 4, background: 'var(--bg-warm)',
    color: 'var(--text-secondary)', lineHeight: 1.4,
    margin: '0 1px', whiteSpace: 'nowrap',
  }}>{children}</span>
)

const Pill: React.FC<{ children: React.ReactNode; tone?: 'accent' | 'warm' }> = ({ children, tone = 'warm' }) => (
  <span style={{
    display: 'inline-block', padding: '1px 8px', fontSize: 11.5,
    border: tone === 'accent' ? '1px solid var(--accent)' : '1px solid var(--border)',
    borderRadius: 10, background: tone === 'accent' ? 'transparent' : 'var(--bg-warm)',
    color: tone === 'accent' ? 'var(--accent)' : 'var(--text-secondary)',
    margin: '0 2px', whiteSpace: 'nowrap',
  }}>{children}</span>
)

const MiniButton: React.FC<{ children: React.ReactNode; active?: boolean; accent?: boolean }> = ({ children, active = false, accent = false }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minHeight: 20, padding: '2px 8px', borderRadius: 5,
    border: active || accent ? '1px solid var(--accent)' : '1px solid var(--border)',
    background: active ? 'var(--accent)' : 'var(--bg)',
    color: active ? '#fff' : accent ? 'var(--accent)' : 'var(--text-secondary)',
    fontSize: 10.5, fontWeight: active || accent ? 600 : 400,
    whiteSpace: 'nowrap',
  }}>{children}</span>
)

const MiniTab: React.FC<{ children: React.ReactNode; active?: boolean }> = ({ children, active = false }) => (
  <span style={{
    display: 'inline-flex', flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: '5px 0', fontSize: 10.5, fontWeight: active ? 600 : 400,
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    color: active ? 'var(--accent)' : 'var(--text-muted)',
  }}>{children}</span>
)

const MockLine: React.FC<{ w?: string; strong?: boolean; accent?: boolean }> = ({ w = '100%', strong = false, accent = false }) => (
  <div style={{
    width: w, height: strong ? 7 : 5, borderRadius: 5,
    background: accent ? 'rgba(195, 141, 92, 0.35)' : strong ? 'var(--text-muted)' : 'var(--border-light)',
    opacity: accent ? 1 : strong ? 0.42 : 0.95,
  }} />
)

const PreviewFrame: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{
    border: '1px solid var(--border-light)',
    borderRadius: 8,
    background: 'linear-gradient(180deg, var(--bg) 0%, var(--bg-warm) 100%)',
    padding: 10,
    marginBottom: 14,
  }}>
    <div style={{
      fontSize: 10.5, color: 'var(--text-muted)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      marginBottom: 8,
    }}>
      <span>界面指引</span>
      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{label}</span>
    </div>
    {children}
  </div>
)

const ImportPreview = () => (
  <PreviewFrame label="左侧文献栏底部">
    <div style={{ display: 'grid', gridTemplateColumns: '112px 1fr', gap: 10, minHeight: 126 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', padding: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>文献</div>
        <MockLine w="84%" strong />
        <MockLine w="72%" />
        <MockLine w="90%" />
        <div style={{ flex: 1 }} />
        <MiniButton accent>导入文件</MiniButton>
        <MiniButton>导入文件夹</MiniButton>
      </div>
      <div style={{ border: '1px dashed var(--border)', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 9, justifyContent: 'center' }}>
        <MockLine w="52%" strong />
        <MockLine w="90%" />
        <MockLine w="78%" />
        <MockLine w="84%" />
      </div>
    </div>
  </PreviewFrame>
)

const ReaderPreview = () => (
  <PreviewFrame label="阅读器顶部工具栏">
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 8, borderBottom: '1px solid var(--border-light)', overflow: 'hidden' }}>
        <MiniButton>PDF</MiniButton>
        <MiniButton active>OCR 文本</MiniButton>
        <MiniButton accent>重新<br />OCR</MiniButton>
        <MiniButton>翻译</MiniButton>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <MockLine w="88%" strong />
        <MockLine w="96%" />
        <MockLine w="72%" />
        <MockLine w="91%" />
      </div>
    </div>
  </PreviewFrame>
)

const MarkPreview = () => (
  <PreviewFrame label="选中文字后出现">
    <div style={{ position: 'relative', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', padding: '34px 14px 16px' }}>
      <div style={{ position: 'absolute', top: 8, left: 36, display: 'flex', gap: 5, padding: 4, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', boxShadow: '0 4px 14px rgba(60,40,20,0.12)' }}>
        <MiniButton accent>划线</MiniButton>
        <MiniButton>高光</MiniButton>
        <MiniButton>注释</MiniButton>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <MockLine w="92%" />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <MockLine w="26%" />
          <span style={{ width: '42%', height: 12, borderRadius: 3, background: 'rgba(245, 207, 95, 0.45)', borderBottom: '2px solid var(--accent)' }} />
          <MockLine w="19%" />
        </div>
        <MockLine w="83%" />
      </div>
    </div>
  </PreviewFrame>
)

const NotesPreview = () => (
  <PreviewFrame label="右侧注释面板">
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 126px', gap: 10 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <MockLine w="82%" />
        <MockLine w="94%" accent />
        <MockLine w="70%" />
        <div style={{ alignSelf: 'flex-start', marginTop: 4 }}>
          <MiniButton>右键取消标记</MiniButton>
        </div>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', padding: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text)' }}>注释</div>
        <div style={{ border: '1px solid var(--border-light)', borderRadius: 5, padding: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>
            <span>想法</span><span>×</span>
          </div>
          <MockLine w="92%" />
        </div>
        <div style={{ border: '1px solid var(--border-light)', borderRadius: 5, padding: 6 }}>
          <MockLine w="74%" />
        </div>
      </div>
    </div>
  </PreviewFrame>
)

const DialoguePreview = () => (
  <PreviewFrame label="右侧学徒 · 对话">
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ padding: '7px 10px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>学徒</span>
        <MiniButton>模型</MiniButton>
      </div>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
        <MiniTab active>对话</MiniTab>
        <MiniTab>召唤</MiniTab>
      </div>
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ alignSelf: 'flex-end', maxWidth: '72%', padding: 7, borderRadius: 8, background: 'var(--accent-soft)', fontSize: 10.5, color: 'var(--text)' }}>这段论证在说什么？</div>
        <div style={{ alignSelf: 'flex-start', maxWidth: '78%', padding: 7, borderRadius: 8, border: '1px solid var(--border-light)', fontSize: 10.5, color: 'var(--text-secondary)' }}>我会结合当前书页、划线和注释来回答。</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <MiniButton accent>☆ 召唤</MiniButton>
          <MiniButton>输入问题...</MiniButton>
        </div>
      </div>
    </div>
  </PreviewFrame>
)

const SummonPreview = () => (
  <PreviewFrame label="右侧学徒 · 召唤">
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)' }}>
        <MiniTab>对话</MiniTab>
        <MiniTab active>召唤</MiniTab>
      </div>
      <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7 }}>
        {['孔子', '老子', '墨子'].map(name => (
          <div key={name} style={{ border: '1px solid var(--border-light)', borderRadius: 6, padding: 7, textAlign: 'center', background: 'var(--bg-warm)' }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(195,141,92,0.24)', margin: '0 auto 5px', border: '1px solid var(--accent-soft)' }} />
            <div style={{ fontSize: 10.5, color: 'var(--text)', fontWeight: 600 }}>{name}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: '0 10px 10px', display: 'flex', gap: 6 }}>
        <MiniButton active>召唤孔子</MiniButton>
        <MiniButton>多人辩论</MiniButton>
      </div>
    </div>
  </PreviewFrame>
)

// ===== Steps =====
const STEPS: Step[] = [
  {
    title: '导入文献',
    icon: <ImportIcon />,
    visual: <ImportPreview />,
    body: (
      <>
        从左侧文献栏底部开始：点 <Pill tone="accent">导入文件</Pill> 或 <Pill>导入文件夹</Pill>。
        支持 <strong>PDF / EPUB / DOCX / TXT / Markdown</strong> 等常见格式，文件夹会按目录自动建立分组。
        <br /><br />
        也可以直接把文件拖进窗口；Zotero / EndNote 导出的 <KBD>.bib</KBD> 可从顶栏批量导入。
      </>
    ),
  },
  {
    title: '阅读与 OCR',
    icon: <ReaderIcon />,
    visual: <ReaderPreview />,
    body: (
      <>
        普通电子书导入后可以直接读；扫描版 PDF 先点顶部工具栏里的 <Pill tone="accent">OCR</Pill>。
        OCR 完成后可在 <Pill>PDF</Pill> 和 <Pill>OCR 文本</Pill> 之间切换。
        <br /><br />
        OCR 文本、HTML、EPUB、DOCX、TXT 都会使用轻降眩光阅读层，阅读亮度更稳。
      </>
    ),
  },
  {
    title: '划线 · 高光 · 注释',
    icon: <MarkIcon />,
    visual: <MarkPreview />,
    body: (
      <>
        在阅读器里选中任意文字，浮动工具栏会直接贴着选区出现。
        <Pill>划线</Pill> 用来留痕，<Pill>高光</Pill> 用来强调，<Pill tone="accent">注释</Pill> 会把你的想法绑定到这段原文。
        <br /><br />
        写注释时可用 <KBD>Ctrl</KBD> + <KBD>Enter</KBD> 快速保存。
      </>
    ),
  },
  {
    title: '管理注释与标记',
    icon: <NotesIcon />,
    visual: <NotesPreview />,
    body: (
      <>
        右侧注释面板会集中显示当前书的注释卡片，点卡片可回到对应原文。
        已有划线或高光可以在原文上<strong>右键</strong>取消；注释卡片右上角的 <KBD>×</KBD> 用来删除注释。
        <br /><br />
        这些标记都保存在本地，跟着这本书走，不依赖网络。
      </>
    ),
  },
  {
    title: '学徒对话',
    icon: <DialogueIcon />,
    visual: <DialoguePreview />,
    body: (
      <>
        右侧 <Pill tone="accent">学徒</Pill> 面板现在以 <Pill>对话</Pill> 为主：你可以围绕当前页、选中文本、划线和注释继续追问。
        <br /><br />
        原来的定期观察独立入口已经下线，观察能力转入对话和召唤流程里：直接问学徒“帮我梳理最近读到的线索”即可。
      </>
    ),
  },
  {
    title: '召唤人物',
    icon: <SummonIcon />,
    visual: <SummonPreview />,
    body: (
      <>
        在学徒面板切到 <Pill tone="accent">召唤</Pill>，选择已经发布的 skill 人物，或从本地资料蒸馏新人物。
        回到 <Pill>对话</Pill> 后，底部的召唤按钮可切换当前对话中的人物。
        <br /><br />
        1.3.3 公开社区先放出孔子、老子、墨子、苏格拉底、柏拉图、亚里士多德六位，可一对一追问，也可多重召唤讨论。
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
  useEffect(() => {
    let alreadyShown = false
    try { alreadyShown = !!localStorage.getItem(FLAG_KEY) } catch {}
    if (alreadyShown) return
    if (!window.electronAPI?.aiGetProviders) return

    let cancelled = false
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
          maxWidth: 640, width: '100%',
          maxHeight: 'calc(100vh - 40px)',
          overflowY: 'auto',
          background: 'var(--bg, #faf6ef)',
          borderRadius: 12,
          padding: '24px 30px 22px',
          boxShadow: '0 12px 36px rgba(60, 40, 20, 0.22)',
          border: '1px solid var(--border)',
          fontFamily: 'inherit',
          animation: 'sj-tour-pop 0.22s cubic-bezier(.2,.9,.3,1.15)',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStepIdx(i)}
                title={`第 ${i + 1} 步`}
                style={{
                  width: i === stepIdx ? 18 : 6, height: 6, borderRadius: 3,
                  padding: 0, border: 'none',
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

        <div style={{
          display: 'flex', alignItems: 'center', gap: 13,
          marginBottom: 14, color: 'var(--accent)',
        }}>
          <div style={{
            width: 48, height: 48,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--bg-warm)',
            borderRadius: 8,
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
              功能指引 · STEP {stepIdx + 1}
            </div>
            <div style={{
              fontSize: 19, fontWeight: 600, color: 'var(--text)',
              letterSpacing: 0.4,
            }}>
              {step.title}
            </div>
          </div>
        </div>

        {step.visual}

        <div style={{
          fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.85,
          padding: '13px 15px',
          background: 'var(--bg-warm)',
          borderRadius: 8,
          border: '1px solid var(--border-light)',
          marginBottom: 18,
        }}>
          {step.body}
        </div>

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
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', opacity: 0.75, textAlign: 'center' }}>
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
