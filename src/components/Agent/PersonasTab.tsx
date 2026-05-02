// 召唤 · 思想家库 (slim rewrite)
// -----------------------------------------------------------------------------
// 从 ~3000 行的多步创建巨石裁到只做三件事：skill 库管理 + 导入 + 召唤对话。
// 原蒸馏/多步搜索流程全部移除（personaPrompts/personaDistillPrompts/
// personaResearchPrompt 仍在 repo 里以备未来重启）。
//
// State machine:
//   'gallery' → 卡片网格 (默认)
//   'detail'  → 卡片详情
//   'summon'  → 召唤对话
//   'import'  → 导入确认弹窗
//
// 视觉：暖金衬线美学，参照拾卷社区页。样式内联（项目无 CSS 框架）。

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import { KATEX_FORGIVING as rehypeKatex, sanitizeMath } from '../../utils/markdownConfig'
import { useUiStore } from '../../store/uiStore'
import type { Persona } from '../../types/library'
import {
  parseCitations, normalizeCitations,
  type InjectedChunk, type ParsedCitation,
} from './personaCitationParse'
import {
  usePersonaRagStatusList, usePersonaRagAutoBuildToasts,
  PersonaRagPill, PersonaRagToastStack,
} from './personaRagStatus'
import { CitationBadge } from './CitationBadge'
import { humanizeAiError } from '../../utils/humanizeAiError'
import { useConfirmDialog } from '../common/ConfirmDialog'
// PERF-R8#11 · 共享 persona list cache,改/删 persona 后 invalidate 让 AnnotationPanel 等订阅者刷新
import { invalidatePersonaListCache } from '../../utils/personaListCache'

// ============================================================================
// Palette · 暖金衬线
// ============================================================================
// 2026-04-24 改造为 CSS 变量引用 —— 原来全部硬编码 hex，暗色模式下 PersonasTab
// 依然显示浅米底 / 白卡片 / 黑字，跟暗色 app 框格格不入。现在全走 global 主题变量。
const C = {
  bg: 'var(--bg)',
  bgWarm: 'var(--bg-warm)',
  bgCard: 'var(--bg-warm)',           // 卡片略比 bg 亮一档（亮色 cream，暗色浅深灰）
  border: 'var(--border)',
  borderHover: 'var(--text-muted)',
  borderLight: 'var(--border-light)',
  text: 'var(--text)',
  textMuted: 'var(--text-secondary)', // 中深 —— 次标题 / 副信息
  textFaint: 'var(--text-muted)',     // 最淡 —— 标签 / kicker
  accent: 'var(--accent)',
  accentDark: 'var(--accent-hover)',
  accentLight: 'var(--accent-soft)',
  accentSoft: 'var(--accent-soft)',
  badgeOfficial: 'var(--accent-hover)',
  danger: 'var(--danger)',
} as const
const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, "Times New Roman", serif'
const MONO = '"JetBrains Mono", "SF Mono", Consolas, monospace'

// Bundled skills we ship — used for OFFICIAL badge + localhost portrait fallback.
const CANONICAL_SLUGS = new Set([
  'kant', 'plato', 'aristotle', 'confucius', 'laozi', 'mozi', 'socrates',
  'wangyangming', 'hegel', 'weber', 'durkheim',
])
const COMMUNITY_PNG_PORTRAITS = new Set(['confucius', 'laozi', 'mozi', 'socrates', 'plato', 'aristotle'])
const CJK_SLUG_MAP: Record<string, string> = {
  '黑格尔': 'hegel', '康德': 'kant', '柏拉图': 'plato',
  '亚里士多德': 'aristotle', '孔子': 'confucius', '老子': 'laozi',
  '墨子': 'mozi', '苏格拉底': 'socrates',
  '王阳明': 'wangyangming', '韦伯': 'weber', '马克斯·韦伯': 'weber',
  '涂尔干': 'durkheim', '埃米尔·涂尔干': 'durkheim',
}

type Stage = 'gallery' | 'detail' | 'summon' | 'import'
type PanelError = { message: string; ctaSettings?: boolean }
type PersonaListEntry = {
  id: string; name: string; canonicalName?: string
  identity?: string; updatedAt: string; currentFitnessTotal?: number
}
type SummonMsg = {
  role: 'user' | 'assistant'
  content: string
  injectedChunks?: InjectedChunk[]
  citations?: ParsedCitation[]
  retrievalMode?: 'embedding' | 'bm25' | 'empty'
  totalChunks?: number
  injectedCitationIds?: number[]
}
type SummonSessionSummary = {
  sessionId: string
  startedAt: string
  messageCount: number
  firstPreview: string
}
// When the user re-enters a past session, the parent passes both the
// sessionId AND the pre-loaded messages so SummonView skips the empty
// init state. undefined startedAt / messages means "new session".
type SummonInit = {
  sessionId: string
  startedAt?: string
  messages?: SummonMsg[]
}

function toAiPanelError(h: ReturnType<typeof humanizeAiError>): PanelError {
  return {
    message: h.hint ? `${h.message}（${h.hint}）` : h.message,
    ctaSettings: h.ctaSettings,
  }
}

// ============================================================================
// Portrait resolver
// ============================================================================
function inferSlugs(p: { canonicalName?: string; name: string }): string[] {
  const out = new Set<string>()
  for (const raw of [p.canonicalName, p.name]) {
    if (!raw) continue
    const latin = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (latin) out.add(latin)
    const mapped = CJK_SLUG_MAP[raw.trim()]
    if (mapped) out.add(mapped)
  }
  return Array.from(out)
}

function Placeholder({ name }: { name: string }) {
  return (
    <div style={{
      width: '100%', aspectRatio: '1 / 1',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: `linear-gradient(135deg, ${C.accentLight} 0%, ${C.bgWarm} 100%)`,
      color: C.accentDark, fontFamily: SERIF,
      fontSize: 52, fontWeight: 500, letterSpacing: '2px', userSelect: 'none',
    }}>{(name || '?').trim().charAt(0) || '?'}</div>
  )
}

// 2026-04-25 PERF · 模块级 portrait cache —— 之前每个组件实例都独立 IPC 加载
// 同一 persona 的肖像，10 个 persona × 多处显示 = 几十次 IPC + 文件读。
// 用 Map 缓存跨组件共享，每个 personaId 全局只加载一次。
// 失效策略：cache 在 page reload 才清；用户重新生成肖像后需要刷新页面看（罕见操作）。
const portraitMemoryCache = new Map<string, string>()
const portraitInflightLoaders = new Map<string, Promise<string | null>>()

async function loadPortraitOnce(p: { id: string; name: string; canonicalName?: string }): Promise<string | null> {
  // hit cache
  if (portraitMemoryCache.has(p.id)) return portraitMemoryCache.get(p.id) || null
  // dedup in-flight：多组件同时请求同一 persona 时，共享同一个 Promise
  const inflight = portraitInflightLoaders.get(p.id)
  if (inflight) return inflight
  const promise = (async (): Promise<string | null> => {
    try {
      const r = await window.electronAPI?.personaGetPortrait?.(p.id)
      if (r?.success && r.dataUrl) {
        portraitMemoryCache.set(p.id, r.dataUrl)
        return r.dataUrl
      }
    } catch { /* fall through */ }
    // Localhost dev server fallback for canonical slugs
    for (const slug of inferSlugs(p)) {
      if (CANONICAL_SLUGS.has(slug)) {
        const ext = COMMUNITY_PNG_PORTRAITS.has(slug) ? 'png' : 'jpeg'
        const url = `http://localhost:8765/assets/portraits/${slug}.${ext}`
        portraitMemoryCache.set(p.id, url)
        return url
      }
    }
    return null
  })()
  portraitInflightLoaders.set(p.id, promise)
  try {
    return await promise
  } finally {
    portraitInflightLoaders.delete(p.id)
  }
}

/** Returns a portrait src (data URL or http fallback) or null while loading. */
function usePortrait(p: { id: string; name: string; canonicalName?: string } | null): string | null {
  // 同步读 cache 作为初始值，避免短暂闪空
  const [src, setSrc] = useState<string | null>(() => p?.id ? portraitMemoryCache.get(p.id) || null : null)
  useEffect(() => {
    if (!p) { setSrc(null); return }
    // 命中 cache 直接同步设置（init 已设过，但 deps 变化时也走这里）
    const cached = portraitMemoryCache.get(p.id)
    if (cached) { setSrc(cached); return }
    setSrc(null)
    let cancelled = false
    loadPortraitOnce(p).then(url => { if (!cancelled) setSrc(url) })
    return () => { cancelled = true }
  }, [p?.id, p?.name, p?.canonicalName])
  return src
}

function PortraitImg({
  src, name, sepia = true, style,
}: { src: string | null; name: string; sepia?: boolean; style?: React.CSSProperties }) {
  if (!src) return <Placeholder name={name} />
  return (
    <img
      src={src} alt={name}
      // 2026-04-25 PERF · lazy + async decode；persona 列表里几十个肖像只有视口内才解码
      loading="lazy"
      decoding="async"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      style={{
        width: '100%', height: '100%', objectFit: 'cover', display: 'block',
        filter: sepia ? 'sepia(0.08) saturate(0.9) contrast(0.98)' : undefined,
        ...style,
      }}
    />
  )
}

// ============================================================================
// Card
// ============================================================================
function Card({
  entry, ragPill, onOpen, onDelete,
}: {
  entry: PersonaListEntry
  ragPill?: React.ReactNode
  onOpen: () => void
  onDelete: () => void
}) {
  const src = usePortrait(entry)
  const [hover, setHover] = useState(false)
  const subtitle = entry.identity
    || (entry.canonicalName && entry.canonicalName !== entry.name ? entry.canonicalName : '')
  const isOfficial = inferSlugs(entry).some(s => CANONICAL_SLUGS.has(s))
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: 'pointer',
        background: hover ? C.bgWarm : C.bgCard,
        border: `1px solid ${hover ? C.borderHover : C.border}`,
        borderRadius: 10, overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        transform: hover ? 'translateY(-3px)' : 'translateY(0)',
        transition: 'transform 260ms cubic-bezier(0.4, 0, 0.2, 1), border-color 260ms cubic-bezier(0.4, 0, 0.2, 1), background 260ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 260ms cubic-bezier(0.4, 0, 0.2, 1)',
        boxShadow: hover ? '0 10px 28px rgba(90, 68, 40, 0.08)' : '0 1px 2px rgba(90, 68, 40, 0.03)',
      }}
    >
      <div style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1', background: 'var(--bg-warm)', overflow: 'hidden' }}>
        <PortraitImg src={src} name={entry.canonicalName || entry.name} />
        {isOfficial && (
          <span style={{
            position: 'absolute', top: 10, left: 10,
            padding: '4px 10px', borderRadius: 2,
            background: C.badgeOfficial, color: C.bg,
            fontSize: 9.5, fontWeight: 600, letterSpacing: '2.4px', textTransform: 'uppercase',
          }}>OFFICIAL</span>
        )}
        {ragPill && (
          <span style={{ position: 'absolute', top: 10, right: 10, display: 'inline-flex' }}>
            {ragPill}
          </span>
        )}
      </div>
      <div style={{ padding: '18px 20px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          fontFamily: SERIF, fontSize: 22, fontWeight: 500,
          color: C.text, letterSpacing: '0.8px', lineHeight: 1.3,
        }}>{entry.canonicalName || entry.name}</div>
        {subtitle && (
          <div style={{
            fontSize: 12.5, color: C.textFaint,
            fontFamily: SERIF, fontStyle: 'italic', lineHeight: 1.55,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{subtitle}</div>
        )}
        <div style={{
          marginTop: 14, paddingTop: 12,
          borderTop: `1px solid ${C.borderLight}`,
          display: 'flex', gap: 8, alignItems: 'center',
          fontSize: 11, color: C.textFaint, letterSpacing: '0.6px',
        }}>
          <span style={{ color: C.accent, fontWeight: 500, letterSpacing: '1px' }}>召唤 →</span>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            title="移除此档案"
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', padding: 0,
              cursor: 'pointer', color: C.textFaint, fontSize: 11,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = C.danger }}
            onMouseLeave={(e) => { e.currentTarget.style.color = C.textFaint }}
          >移除</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Detail view
// ============================================================================
const infoRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between',
  padding: '10px 0', borderBottom: `1px solid ${C.border}`,
}
const infoKey: React.CSSProperties = {
  fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '1px', color: C.textFaint,
}
const infoVal: React.CSSProperties = { color: C.text, fontWeight: 500, fontSize: 12 }

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 11, fontWeight: 500, letterSpacing: '2.5px',
      textTransform: 'uppercase', color: C.textFaint,
      display: 'flex', alignItems: 'center', gap: 12, margin: '0 0 20px',
    }}>
      <span style={{ width: 28, height: 1, background: C.textFaint }} />
      {children}
    </h3>
  )
}

function ActionBtn({ children, onClick, variant = 'secondary', title }: {
  children: React.ReactNode
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'muted'
  title?: string
}) {
  const [hover, setHover] = useState(false)
  const base = {
    primary: { bg: hover ? C.accentDark : C.text, fg: C.bg, bd: 'transparent', padding: '12px 18px', fs: 13 },
    secondary: { bg: 'transparent', fg: hover ? C.text : C.textMuted, bd: hover ? C.text : C.border, padding: '9px 10px', fs: 11 },
    muted: { bg: 'transparent', fg: hover ? C.text : C.textFaint, bd: hover ? C.text : C.border, padding: '9px 10px', fs: 11 },
  }[variant]
  return (
    <button
      onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: base.padding, fontSize: base.fs,
        fontWeight: variant === 'primary' ? 500 : undefined,
        letterSpacing: variant === 'primary' ? '1px' : '0.5px',
        background: base.bg, color: base.fg,
        border: `1px solid ${base.bd}`, borderRadius: 5,
        cursor: 'pointer', transition: 'background 220ms cubic-bezier(0.4, 0, 0.2, 1), color 220ms cubic-bezier(0.4, 0, 0.2, 1), border-color 220ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >{children}</button>
  )
}

function DetailView({
  persona, onBack, onSummon, onOpenSession, onReveal, onDelete,
  onPersonaUpdated,
}: {
  persona: Persona
  onBack: () => void
  onSummon: () => void
  onOpenSession: (sessionId: string) => void
  onReveal: () => void
  onDelete: () => void
  onPersonaUpdated: (persona: Persona) => void
}) {
  const src = usePortrait(persona)
  const skill = persona.skill
  const lifespanMatch = skill?.frontmatter?.description?.match(/\d{3,4}\s*[-–—]\s*\d{3,4}/)?.[0]
  const mentalModels = skill?.mentalModels || []
  const sourceRefs = skill?.sourceReferences || []
  const files: string[] = [
    skill?.fullMarkdown ? 'SKILL.md' : null,
    mentalModels.length ? 'MENTAL_MODELS.md' : null,
    skill?.expressionDna ? 'EXPRESSION.md' : null,
    skill?.timeline ? 'TIMELINE.md' : null,
    skill?.tensions?.length ? 'TENSIONS.md' : null,
  ].filter((x): x is string => !!x)

  return (
    <div style={{ padding: '32px 36px', maxWidth: 1100, margin: '0 auto' }}>
      <button
        onClick={onBack}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 8,
          fontSize: 11, color: C.textMuted, letterSpacing: '1px',
          textTransform: 'uppercase', marginBottom: 28,
        }}
      >← 返回召唤人物</button>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 56, alignItems: 'start' }}>
        <div style={{ position: 'sticky', top: 16 }}>
          <div style={{
            width: '100%', aspectRatio: '1 / 1', background: 'var(--bg-warm)',
            border: `1px solid ${C.border}`, overflow: 'hidden', marginBottom: 22,
          }}>
            <PortraitImg src={src} name={persona.canonicalName || persona.name} />
          </div>
          <div style={{
            borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
            padding: '20px 0', marginBottom: 22,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <ActionBtn onClick={onSummon} variant="primary">召唤对话 →</ActionBtn>
            <ActionBtn onClick={onReveal} variant="secondary" title="在文件管理器中打开此 skill 的文件夹">查看 skill 位置</ActionBtn>
            <ActionBtn onClick={onDelete} variant="muted">删除档案</ActionBtn>
          </div>
          <div style={{ fontSize: 12 }}>
            {lifespanMatch && (
              <div style={infoRow}><span style={infoKey}>年代</span><strong style={infoVal}>{lifespanMatch}</strong></div>
            )}
            <div style={infoRow}>
              <span style={infoKey}>模式</span>
              <strong style={infoVal}>{persona.skillMode === 'distilled' ? '蒸馏' : persona.skillMode === 'imported' ? '导入' : '传统'}</strong>
            </div>
            <div style={infoRow}>
              <span style={infoKey}>版本</span>
              <strong style={infoVal}>{persona.versions.length}</strong>
            </div>
            <div style={infoRow}>
              <span style={infoKey}>更新</span>
              <strong style={infoVal}>{new Date(persona.updatedAt).toLocaleDateString('zh-CN')}</strong>
            </div>
          </div>
        </div>

        <div>
          <h1 style={{
            fontFamily: SERIF, fontSize: 40, fontWeight: 500,
            letterSpacing: '3px', lineHeight: 1.25,
            margin: '0 0 12px', color: C.text,
          }}>{persona.canonicalName || persona.name}</h1>
          {persona.identity && (
            <div style={{
              fontSize: 12, color: C.textFaint, letterSpacing: '0.5px',
              paddingBottom: 20, borderBottom: `1px solid ${C.border}`, marginBottom: 32,
            }}>{persona.identity}</div>
          )}
          {skill?.frontmatter?.description && (
            <div style={{
              borderLeft: `2px solid ${C.accent}`,
              padding: '4px 0 4px 22px', marginBottom: 28,
              fontSize: 15, color: C.textMuted, lineHeight: 1.85,
              fontFamily: SERIF, fontStyle: 'italic', letterSpacing: '0.3px',
            }}>{skill.frontmatter.description}</div>
          )}

          {/* 2026-04-28 · 作者声明 — 期望管理,frame "AI 模拟"非真人。 */}
          <div style={{
            background: C.bgWarm,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            padding: '14px 18px',
            marginBottom: 44,
            fontSize: 12, color: C.textMuted, lineHeight: 1.75,
          }}>
            <div style={{
              fontSize: 10, letterSpacing: '1.6px', color: C.textFaint,
              textTransform: 'uppercase', marginBottom: 6, fontWeight: 500,
            }}>关于本召唤</div>
            <div>
              我们尽力还原 <strong style={{ color: C.text }}>{persona.canonicalName || persona.name}</strong> 的思考方式 ——
              基于其著作 / 心智模型 / 时代背景蒸馏。
              但任何 AI 模拟都有局限。建议把它当
              <strong style={{ color: C.accent }}>思考伙伴</strong>
              而不是<strong style={{ color: C.accent }}>权威发言人</strong>。
              重要论点请回到原文核对。
            </div>
          </div>

          {mentalModels.length > 0 && (
            <section style={{ marginBottom: 44 }}>
              <SectionLabel>核心心智模型</SectionLabel>
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 1,
                background: C.border, border: `1px solid ${C.border}`,
              }}>
                {mentalModels.map((m, i) => (
                  <div key={i} style={{ padding: '18px 22px', background: C.bgCard }}>
                    <div style={{
                      fontFamily: SERIF, fontSize: 16, fontWeight: 500,
                      color: C.text, marginBottom: 6, letterSpacing: '0.5px',
                    }}>{m.name}</div>
                    <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.75 }}>{m.description}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <HistorySessionsSection personaId={persona.id} onOpenSession={onOpenSession} />
          <UserMaterialsSection persona={persona} onPersonaUpdated={onPersonaUpdated} />

          {files.length > 0 && <FilesSection files={files} />}
          {sourceRefs.length > 0 && <SourcesSection refs={sourceRefs} />}
          {!skill?.fullMarkdown && persona.content && (
            <section style={{ marginBottom: 32 }}>
              <SectionLabel>档案</SectionLabel>
              <div className="annotation-markdown" style={{ fontSize: 13.5, lineHeight: 1.9, color: C.text }}>
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {sanitizeMath(persona.content)}
                </ReactMarkdown>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function FilesSection({ files }: { files: string[] }) {
  return (
    <section style={{ marginBottom: 44 }}>
      <SectionLabel>文件结构</SectionLabel>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 1, background: C.border, border: `1px solid ${C.border}`,
      }}>
        {files.map((name, i) => (
          <div key={i} style={{
            padding: '12px 16px', background: C.bgCard,
            display: 'flex', alignItems: 'center', gap: 12,
            fontSize: 12.5, color: C.textMuted,
          }}>
            <span style={{
              width: 28, height: 36, border: `1px solid ${C.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 600, letterSpacing: '1px', color: C.textFaint,
            }}>MD</span>
            <span style={{ fontFamily: MONO, fontSize: 12 }}>{name}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SourcesSection({ refs }: { refs: string[] }) {
  return (
    <section style={{ marginBottom: 44 }}>
      <SectionLabel>资料来源</SectionLabel>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {refs.slice(0, 12).map((s, i) => (
          <li key={i} style={{
            fontSize: 12.5, color: C.textMuted, lineHeight: 1.7,
            paddingLeft: 14, borderLeft: `1px solid ${C.border}`,
          }}>{s}</li>
        ))}
      </ul>
    </section>
  )
}

// ============================================================================
// History sessions (Pain point #1) — list past summon conversations for this
// persona. Clicking one resumes that conversation.
// ============================================================================
// UX-R8#9 · P2-10 · 模块级乐观 cache,免每次重进 detail 看到 "加载中…" 闪烁。
// SWR 风格:有 cache → 立刻渲染 + 后台 revalidate;无 cache → 显示 loading。
// 删除 / 用户后续 invalidate 时清掉这个 personaId 的 entry。
const historySessionsCache = new Map<string, SummonSessionSummary[]>()

function HistorySessionsSection({
  personaId, onOpenSession,
}: {
  personaId: string
  onOpenSession: (sessionId: string) => void
}) {
  // Batch 43: 替换 window.confirm
  const { ask: askConfirm, dialog: confirmDialog } = useConfirmDialog()
  // UX-R8#9 · 初始 state 直接读 cache(同步),没 cache 才走 loading
  const cachedInitial = historySessionsCache.get(personaId)
  const [sessions, setSessions] = useState<SummonSessionSummary[]>(cachedInitial || [])
  const [loading, setLoading] = useState(!cachedInitial)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // 没 cache 时显示 loading;有 cache 静默后台刷新,UI 不闪
        if (!historySessionsCache.has(personaId)) setLoading(true)
        const r = await window.electronAPI.summonSessionList?.(personaId)
        if (cancelled) return
        const list = r?.success ? (r.sessions || []) : []
        setSessions(list)
        historySessionsCache.set(personaId, list)
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [personaId, refreshTick])

  const handleDelete = useCallback((sessionId: string) => {
    // Batch 43: window.confirm() → 暖金 ConfirmDialog
    askConfirm({
      title: '删除对话记录',
      message: '删除这段对话记录？此操作不可撤销。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: async () => {
        await window.electronAPI.summonSessionDelete?.(personaId, sessionId)
        // UX-R8#9 · 删完清 cache,下次 effect 重 fetch 拿到最新
        historySessionsCache.delete(personaId)
        setRefreshTick(t => t + 1)
      },
    })
  }, [personaId, askConfirm])

  if (loading) {
    return (
      <section style={{ marginBottom: 44 }}>
        <SectionLabel>历史对话</SectionLabel>
        <div style={{ fontSize: 12, color: C.textFaint, padding: '8px 0' }}>加载中…</div>
      </section>
    )
  }
  if (sessions.length === 0) {
    return (
      <section style={{ marginBottom: 44 }}>
        <SectionLabel>历史对话</SectionLabel>
        <div style={{
          fontSize: 12, color: C.textFaint, padding: '10px 14px',
          background: C.bgWarm, border: `1px dashed ${C.border}`, borderRadius: 4,
        }}>还没有召唤过——点上面的「召唤对话」开始第一段。</div>
      </section>
    )
  }

  return (
    <section style={{ marginBottom: 44 }}>
      <SectionLabel>历史对话（{sessions.length}）</SectionLabel>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 1,
        background: C.border, border: `1px solid ${C.border}`,
      }}>
        {sessions.map(s => (
          <div
            key={s.sessionId}
            onClick={() => onOpenSession(s.sessionId)}
            style={{
              padding: '12px 16px', background: C.bgCard, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 12,
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.bgWarm }}
            onMouseLeave={(e) => { e.currentTarget.style.background = C.bgCard }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, color: C.text, lineHeight: 1.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{s.firstPreview || '(空白会话)'}</div>
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 3, letterSpacing: '0.3px' }}>
                {new Date(s.startedAt).toLocaleString('zh-CN')} · {s.messageCount} 轮对话
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(s.sessionId) }}
              title="删除此对话"
              style={{
                background: 'none', border: 'none', padding: '4px 6px',
                fontSize: 11, color: C.textFaint, cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = C.danger }}
              onMouseLeave={(e) => { e.currentTarget.style.color = C.textFaint }}
            >删除</button>
          </div>
        ))}
      </div>
      {/* Batch 43: ConfirmDialog 替代 window.confirm */}
      {confirmDialog}
    </section>
  )
}

// ============================================================================
// User materials (Pain point #2) — upload file / paste text / add URL to a
// persona's sourcesUsed. After upload, triggers RAG rebuild so subsequent
// summons can cite the new material.
// ============================================================================
function UserMaterialsSection({
  persona, onPersonaUpdated,
}: {
  persona: Persona
  onPersonaUpdated: (persona: Persona) => void
}) {
  const [pasteText, setPasteText] = useState('')
  const [pasteTitle, setPasteTitle] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [busy, setBusy] = useState<null | 'file' | 'text' | 'url'>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  // P1-5: ok 成功消息自动 5s 消失，避免一直占着垂直空间
  useEffect(() => {
    if (!ok) return
    const t = setTimeout(() => setOk(null), 5000)
    return () => clearTimeout(t)
  }, [ok])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const sourceCount = (persona.sourcesUsed || []).length
  const hydratedCount = (persona.sourcesUsed || []).filter(s => s.fullContent).length
  const userSourceCount = (persona.sourcesUsed || []).filter(s =>
    s.source === 'user-file' || s.source === 'user-url' || s.source === 'user-prompt'
  ).length

  const clearMsgs = () => { setErr(null); setOk(null) }

  // 2026-04-24 扩展文件格式支持：TXT/MD/HTML + PDF（pdfjs-dist）+ DOCX/DOC（mammoth）。
  // EPUB/ZIP 暂未实现解析 —— 给明确提示。
  const readFileAsText = async (file: File): Promise<string> => {
    const ext = file.name.toLowerCase().split('.').pop() || ''

    // 文本类：FileReader 直接读
    if (['txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm'].includes(ext)) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.readAsText(file, 'utf-8')
      })
    }

    // PDF：pdfjs-dist 抽文本
    if (ext === 'pdf') {
      const pdfjsLib = await import('pdfjs-dist')
      // @ts-ignore — pdfjs worker src
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
      const buf = await file.arrayBuffer()
      const doc = await pdfjsLib.getDocument({ data: buf }).promise
      const chunks: string[] = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const tc = await page.getTextContent()
        const txt = tc.items.map((it: any) => ('str' in it ? it.str : '')).join(' ')
        chunks.push(`=== 第 ${i} 页 ===\n${txt}`)
      }
      return chunks.join('\n\n')
    }

    // DOCX/DOC：mammoth extractRawText（convertToMarkdown 版本 API 差异，保险走 raw）
    if (ext === 'docx' || ext === 'doc') {
      const mammoth = await import('mammoth')
      const buf = await file.arrayBuffer()
      const r = await mammoth.extractRawText({ arrayBuffer: buf })
      return r.value || ''
    }

    // EPUB / ZIP：未实现
    if (ext === 'epub' || ext === 'zip') {
      throw new Error(`${ext.toUpperCase()} 格式暂未支持解析 —— 请先解压或转成 TXT/MD 再上传。`)
    }

    throw new Error(`不支持的文件类型 .${ext}`)
  }

  // BUG-FIX #E · Append via backend persona-append-source so concurrent
  // uploads can't race. Previously this read the `persona` prop, spread
  // `sourcesUsed`, and called personaSave — two concurrent calls would
  // both see the same baseline and the second save would silently drop the
  // first's new source. The backend handler now loads the latest persona
  // under a per-persona mutex, appends, and saves, returning the updated
  // persona so we can refresh UI state.
  const appendSource = useCallback(async (newSource: {
    title: string
    fullContent: string
    url?: string
    source: 'user-file' | 'user-url' | 'user-prompt'
    snippet?: string
  }) => {
    const src = {
      id: uuid(),
      title: newSource.title,
      snippet: newSource.snippet || newSource.fullContent.slice(0, 200),
      url: newSource.url || '',
      source: newSource.source,
      fullContent: newSource.fullContent,
      fetchedAt: new Date().toISOString(),
      trust: 'primary' as const,
    }
    const r = await window.electronAPI.personaAppendSource?.(persona.id, src)
    if (!r?.success || !r.persona) throw new Error(r?.error || '保存失败')
    onPersonaUpdated(r.persona)
  }, [persona.id, onPersonaUpdated])

  const handleFilePick = () => { clearMsgs(); fileInputRef.current?.click() }
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    clearMsgs(); setBusy('file')
    try {
      const text = await readFileAsText(file)
      if (!text.trim()) throw new Error('文件内容为空')
      await appendSource({
        title: file.name,
        fullContent: text,
        source: 'user-file',
        snippet: text.slice(0, 200),
      })
      setOk(`已添加：${file.name}（${text.length} 字符）——RAG 索引正在后台重建`)
    } catch (err: any) { setErr(err?.message || String(err)) }
    finally { setBusy(null) }
  }

  const handlePaste = async () => {
    if (!pasteText.trim()) return
    clearMsgs(); setBusy('text')
    try {
      const title = pasteTitle.trim() || `用户粘贴（${new Date().toLocaleString('zh-CN')}）`
      await appendSource({
        title,
        fullContent: pasteText.trim(),
        source: 'user-prompt',
        snippet: pasteText.trim().slice(0, 200),
      })
      setPasteText(''); setPasteTitle('')
      setOk(`已添加粘贴文本（${pasteText.trim().length} 字符）——RAG 索引正在后台重建`)
    } catch (err: any) { setErr(err?.message || String(err)) }
    finally { setBusy(null) }
  }

  const handleUrl = async () => {
    const url = urlInput.trim()
    if (!url) return
    if (!/^https?:\/\//.test(url)) { setErr('请提供完整的 http(s):// URL'); return }
    clearMsgs(); setBusy('url')
    try {
      // Piggy-back on nuwa-fetch-page with a fake PersonaSource marked
      // 'duckduckgo' — the fetcher treats it as a generic HTML page and
      // returns extracted body text.
      const fake = {
        id: uuid(), title: url, snippet: '',
        url, source: 'duckduckgo' as const, trust: 'medium' as const,
      }
      const r = await window.electronAPI.nuwaFetchPage?.(fake)
      if (!r?.success || !r.fullContent) throw new Error(r?.error || '抓取失败——网站可能拒绝访问或不是 HTML')
      await appendSource({
        title: url, fullContent: r.fullContent, url, source: 'user-url',
        snippet: r.fullContent.slice(0, 200),
      })
      setUrlInput('')
      setOk(`已从 ${url} 抓取（${r.fullContent.length} 字符）——RAG 索引正在后台重建`)
    } catch (err: any) { setErr(err?.message || String(err)) }
    finally { setBusy(null) }
  }

  const inputBase: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 12.5,
    border: `1px solid ${C.border}`, borderRadius: 4,
    background: C.bgCard, color: C.text, outline: 'none',
    fontFamily: 'inherit', boxSizing: 'border-box',
  }
  const btn = (disabled: boolean): React.CSSProperties => ({
    padding: '8px 14px', fontSize: 12, fontWeight: 500, letterSpacing: '0.5px',
    border: 'none', borderRadius: 4,
    background: disabled ? C.border : C.text,
    color: disabled ? C.textFaint : C.bg,
    cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0,
  })

  return (
    <section style={{ marginBottom: 44 }}>
      <SectionLabel>补充资料</SectionLabel>
      <div style={{
        fontSize: 11.5, color: C.textMuted, marginBottom: 14, lineHeight: 1.7,
      }}>
        已有 {sourceCount} 条资料（{userSourceCount} 条用户投喂 · {hydratedCount} 条已 hydrated），
        添加后自动重建 RAG 索引。召唤对话可以直接引用。
      </div>

      {err && (
        <div style={{
          padding: '8px 12px', marginBottom: 12,
          background: 'rgba(181,90,79,0.08)', border: `1px solid ${C.danger}`,
          borderRadius: 4, fontSize: 11.5, color: C.danger,
        }}>{err}</div>
      )}
      {ok && (
        <div style={{
          padding: '8px 12px', marginBottom: 12,
          background: 'rgba(44,138,111,0.08)', border: `1px solid #2c8a6f`,
          borderRadius: 4, fontSize: 11.5, color: '#2c8a6f',
        }}>{ok}</div>
      )}

      {/* File upload */}
      <div style={{
        padding: 14, border: `1px solid ${C.border}`, borderRadius: 4,
        marginBottom: 10, background: C.bgCard,
      }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: C.text, marginBottom: 8, letterSpacing: '0.5px' }}>
          上传文件
        </div>
        <input
          ref={fileInputRef} type="file" onChange={handleFileChange}
          accept=".txt,.md,.markdown,.html,.htm,.csv,.json,.pdf,.epub,.doc,.docx,.zip"
          style={{ display: 'none' }}
        />
        <button
          onClick={handleFilePick} disabled={busy !== null}
          style={btn(busy !== null)}
        >{busy === 'file' ? '读取中…' : '选择文件'}</button>
        <div style={{ fontSize: 10, color: C.textFaint, marginTop: 6, lineHeight: 1.5 }}>
          支持 TXT / MD / HTML / PDF / EPUB / DOC / DOCX / ZIP
        </div>
      </div>

      {/* Paste text */}
      <div style={{
        padding: 14, border: `1px solid ${C.border}`, borderRadius: 4,
        marginBottom: 10, background: C.bgCard,
      }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: C.text, marginBottom: 8, letterSpacing: '0.5px' }}>
          粘贴文本
        </div>
        <input
          type="text" value={pasteTitle}
          onChange={(e) => setPasteTitle(e.target.value)}
          placeholder="标题（可选，比如「我的读书笔记」）"
          style={{ ...inputBase, marginBottom: 8 }}
        />
        <textarea
          value={pasteText} onChange={(e) => setPasteText(e.target.value)}
          placeholder="粘贴一段你希望 persona 知晓的内容（论文摘要、读书笔记、个人背景等）"
          rows={4}
          style={{ ...inputBase, resize: 'vertical', marginBottom: 8 }}
        />
        <button
          onClick={handlePaste}
          disabled={busy !== null || !pasteText.trim()}
          style={btn(busy !== null || !pasteText.trim())}
        >{busy === 'text' ? '保存中…' : '添加为一条资料'}</button>
      </div>

      {/* URL */}
      <div style={{
        padding: 14, border: `1px solid ${C.border}`, borderRadius: 4, background: C.bgCard,
      }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: C.text, marginBottom: 8, letterSpacing: '0.5px' }}>
          抓取 URL 正文
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="url" value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/article"
            style={inputBase}
            onKeyDown={(e) => { if (e.key === 'Enter' && urlInput.trim() && busy === null) handleUrl() }}
          />
          <button
            onClick={handleUrl}
            disabled={busy !== null || !urlInput.trim()}
            style={btn(busy !== null || !urlInput.trim())}
          >{busy === 'url' ? '抓取中…' : '抓取'}</button>
        </div>
        <div style={{ fontSize: 10.5, color: C.textFaint, marginTop: 6, lineHeight: 1.5 }}>
          会抽取 HTML 正文（去掉 nav/script/style），存为一条 user-url 资料。
        </div>
      </div>
    </section>
  )
}

// ============================================================================
// Summon chat
// ============================================================================
const pillStyle = (bg: string): React.CSSProperties => ({
  padding: '1px 6px', borderRadius: 3, background: bg,
  color: '#fff', fontSize: 9, fontWeight: 500,
})

function RetrievalPill({ m }: { m: SummonMsg }) {
  if (m.role !== 'user') return null
  const chunks = m.injectedChunks || []
  if (chunks.length > 0) {
    return (
      <span
        style={pillStyle(m.retrievalMode === 'embedding' ? '#2c8a6f' : C.accent)}
        title={`从 ${m.totalChunks} 段候选里 ${m.retrievalMode === 'embedding' ? '语义' : 'BM25'} 检索 top-${chunks.length}`}
      >🔎 {m.retrievalMode === 'embedding' ? '语义' : 'BM25'} top-{chunks.length}</span>
    )
  }
  if (m.totalChunks !== undefined) {
    return <span style={pillStyle(m.totalChunks === 0 ? C.danger : '#c2410c')}>⛔ {m.totalChunks === 0 ? '无资料' : '0 匹配'}</span>
  }
  return null
}

function CitationCard({ c }: { c: ParsedCitation }) {
  const chunk = c.chunk!
  return (
    <div style={{
      padding: '6px 10px', borderRadius: 4,
      background: C.bg, border: `1px solid ${C.borderLight}`, fontSize: 10.5,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ padding: '1px 5px', borderRadius: 3, background: C.accent, color: '#fff', fontSize: 9, fontWeight: 600 }}>资料 {c.n}</span>
        <span style={{ fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{chunk.sourceTitle}</span>
        <span style={{ fontSize: 9, color: C.textMuted }}>· 片段 {chunk.chunkIdx + 1}</span>
        {chunk.url && !chunk.url.startsWith('data:') && (
          <button
            onClick={(e) => { e.stopPropagation(); window.electronAPI.nuwaOpenUrl?.(chunk.url!) }}
            style={{
              marginLeft: 'auto', padding: 0, fontSize: 9,
              background: 'none', border: 'none', color: C.accent,
              cursor: 'pointer', textDecoration: 'underline',
            }}
          >原文</button>
        )}
      </div>
      <div style={{ color: C.textMuted, marginTop: 3, fontSize: 10, lineHeight: 1.5, fontStyle: 'italic' }}>
        {chunk.text.slice(0, 140)}{chunk.text.length > 140 ? '…' : ''}
      </div>
    </div>
  )
}

function SummonMessage({ m, persona }: { m: SummonMsg; persona: Persona }) {
  const real = (m.citations || []).filter(c => c.chunk)
  const fake = (m.citations || []).filter(c => !c.chunk)
  return (
    <div style={{
      marginBottom: 14, padding: '14px 18px', borderRadius: 10,
      background: m.role === 'user' ? C.bgWarm : C.accentSoft,
      border: `1px solid ${C.borderLight}`,
    }}>
      <div style={{
        fontSize: 10.5, color: C.textMuted, marginBottom: 7,
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', letterSpacing: '0.5px',
      }}>
        <span>{m.role === 'user' ? '你' : (persona.canonicalName || persona.name)}</span>
        <RetrievalPill m={m} />
      </div>
      <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.8, color: C.text }}>
        <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
          {sanitizeMath(m.role === 'assistant' ? normalizeCitations(m.content) : m.content)}
        </ReactMarkdown>
      </div>
      {m.role === 'assistant' && (real.length > 0 || fake.length > 0) && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${C.borderLight}` }}>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 6, fontWeight: 500 }}>
            📚 引用核验（{real.length} 条真实{fake.length > 0 ? ` · ${fake.length} 条伪造` : ''}）
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {real.map(c => <CitationCard key={c.n} c={c} />)}
            {fake.map(c => (
              <div key={`fake-${c.n}`} style={{
                padding: '6px 10px', borderRadius: 4,
                background: 'rgba(181, 90, 79, 0.06)', border: `1px solid ${C.danger}`,
                fontSize: 10.5, color: C.danger,
              }}>⚠️ [资料 {c.n}] · AI 编号超出注入范围</div>
            ))}
          </div>
        </div>
      )}
      {m.role === 'assistant' && m.injectedCitationIds !== undefined && (
        <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
          <CitationBadge responseText={m.content} injectedIds={m.injectedCitationIds} />
        </div>
      )}
    </div>
  )
}

function SummonView({
  persona, init, onClose, onError, onNewSession,
}: {
  persona: Persona
  init: SummonInit
  onClose: () => void
  onError: (error: PanelError) => void
  onNewSession: () => void
}) {
  const selectedAiModel = useUiStore(s => s.selectedAiModel)
  const src = usePortrait(persona)
  const [sysPrompt, setSysPrompt] = useState('')
  const [messages, setMessages] = useState<SummonMsg[]>(init.messages || [])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [ragInfo, setRagInfo] = useState<{ totalChunks: number; hydratedSources: number } | null>(null)
  // P0-1: 消息列表底部锚点 — 流式生成时用 scrollIntoView 自动滚到底，避免用户手动拖
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  // P1-2: 初始加载指示 — 进入 summon 时 sysPrompt / ragInfo 都是异步，避免空白 UI 让用户以为卡死
  const [initLoading, setInitLoading] = useState(true)

  // Session metadata — stays stable for the lifetime of this view. "新对话"
  // unmounts + remounts with a fresh init, so we can rely on init.* being
  // immutable here. startedAt defaults to now when init didn't carry one (new session).
  const sessionIdRef = useRef(init.sessionId)
  const startedAtRef = useRef(init.startedAt || new Date().toISOString())

  useEffect(() => {
    let cancelled = false
    setInitLoading(true)  // P1-2: 开始载入前置
    ;(async () => {
      try {
        const r = await window.electronAPI.personaGetSystemPrompt?.(persona.id)
        if (cancelled) return
        if (!r?.success || !r.systemPrompt) {
          // Batch 43: humanize raw API errors (401/429/网络/etc.)
          const h = humanizeAiError(r?.error || '无法构建召唤 system prompt')
          if (!h.silent) onError(toAiPanelError(h))
          return
        }
        setSysPrompt(r.systemPrompt)
        const hydrated = (persona.sourcesUsed || []).filter(s => s.fullContent).length
        try {
          const probe = await window.electronAPI.personaRagRetrieve?.(persona.id, '', 1)
          if (!cancelled) setRagInfo({ totalChunks: probe?.totalChunks ?? 0, hydratedSources: hydrated })
        } catch {
          if (!cancelled) setRagInfo({ totalChunks: 0, hydratedSources: hydrated })
        }
      } catch (err: any) {
        if (!cancelled) {
          // Batch 43: humanize
          const h = humanizeAiError(err)
          if (!h.silent) onError(toAiPanelError(h))
        }
      }
      finally { if (!cancelled) setInitLoading(false) }  // P1-2: 结束载入
    })()
    return () => { cancelled = true }
  }, [persona.id])

  // P0-1: 有新消息 / 流式 token 到达时自动滚到底部；smooth 避免硬跳
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, streaming])

  // P2-3 · Esc 返回对话列表。两段式：第一下 Esc 若焦点在 textarea / input 上
  // 先 blur（让用户有"收手"的中间态，避免误触丢一条正在输入的长消息）；
  // 第二下 Esc 真关闭。流式响应进行中不退出——避免用户误按 Esc 丢掉正在生成的回复。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (busy || streaming) return  // 别在生成中中断
      const ae = document.activeElement as HTMLElement | null
      const tag = ae?.tagName.toLowerCase()
      if (tag === 'textarea' || tag === 'input') {
        // 先 blur，第二下 Esc 才关闭
        ae?.blur()
        e.preventDefault()
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy, streaming])

  // === Debounced session save (Pain point #1) ===
  // Whenever messages change, schedule a save 2s later. Cancels any previous
  // pending save so rapid updates (streaming-triggered setMessages) collapse
  // into one write. A messagesRef keeps the latest snapshot so the
  // flush-on-unmount effect can write the final state without re-subscribing.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const messagesRef = useRef<SummonMsg[]>(messages)
  useEffect(() => { messagesRef.current = messages }, [messages])

  // BUG-FIX #B · persist compact chunks + citations so restored sessions still
  // render the 📚 引用核验 cards. Previously toPersistable dropped injectedChunks
  // and citations entirely, leaving old assistant messages with empty cite
  // regions. Text is truncated to 240 chars (card only shows first 140 anyway).
  const compactChunk = (c: InjectedChunk): InjectedChunk => ({
    n: c.n, sourceId: c.sourceId, sourceTitle: c.sourceTitle,
    sourceType: c.sourceType, trust: c.trust, chunkIdx: c.chunkIdx,
    text: c.text.length > 240 ? c.text.slice(0, 240) : c.text,
    url: c.url,
  })
  const toPersistable = (msgs: SummonMsg[]) => msgs.map(m => ({
    role: m.role, content: m.content,
    retrievalMode: m.retrievalMode,
    totalChunks: m.totalChunks,
    injectedCitationIds: m.injectedCitationIds,
    injectedChunks: m.injectedChunks?.map(compactChunk),
    citations: m.citations?.map(c => ({
      n: c.n,
      chunk: c.chunk ? compactChunk(c.chunk) : null,
      occurrences: c.occurrences,
    })),
  }))

  useEffect(() => {
    if (messages.length === 0) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void window.electronAPI.summonSessionSave?.({
        sessionId: sessionIdRef.current,
        personaId: persona.id,
        startedAt: startedAtRef.current,
        messages: toPersistable(messages),
      })
    }, 2000)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [messages, persona.id])

  // BUG-FIX #3 · mountedRef so async stream callbacks don't setState after unmount
  // handleSend may still be awaiting `aiChatStream` when the user navigates
  // away (close, "新对话" remount via key swap, switch app tab, etc.). Without
  // this guard, the subsequent setMessages / setStreaming / setBusy each fire
  // React's "can't perform a React state update on an unmounted component"
  // warning. Also guarantees the onAiStreamChunk listener that's still
  // receiving chunks doesn't keep pushing updates into a ghost state.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Flush-on-unmount: if a save is queued when the component unmounts (user
  // switches views / closes / starts new session), write immediately so
  // nothing is lost. Reads messagesRef.current so we always see the latest.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const snapshot = messagesRef.current
      if (snapshot.length > 0) {
        void window.electronAPI.summonSessionSave?.({
          sessionId: sessionIdRef.current,
          personaId: persona.id,
          startedAt: startedAtRef.current,
          messages: toPersistable(snapshot),
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSend = useCallback(async () => {
    if (!input.trim() || busy) return
    const userQuery = input.trim()
    setInput(''); setBusy(true); setStreaming('')
    try {
      // Fresh RAG per turn: re-fetch system prompt with this exact query.
      const sr = await window.electronAPI.personaGetSystemPrompt?.(persona.id, userQuery)
      if (!mountedRef.current) return  // BUG-FIX #3 · bail if unmounted mid-await
      const sys = (sr?.success && sr.systemPrompt) ? sr.systemPrompt : sysPrompt
      const chunks: InjectedChunk[] = (sr?.success && sr.chunks) ? sr.chunks : []
      const ids = (sr?.success && sr.injectedCitationIds) ? sr.injectedCitationIds : chunks.map(c => c.n)

      const userMsg: SummonMsg = {
        role: 'user', content: userQuery,
        injectedChunks: chunks,
        retrievalMode: sr?.retrievalMode,
        totalChunks: sr?.totalChunks,
        injectedCitationIds: ids,
      }
      const next = [...messages, userMsg]
      setMessages(next)

      const forAi = [
        { role: 'system', content: sys },
        ...next.map(m => ({ role: m.role, content: m.content })),
      ]
      const streamId = uuid()
      let full = ''
      const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
        if (sid !== streamId) return
        // BUG-FIX #3 · only push updates if we're still mounted
        if (!mountedRef.current) return
        full += chunk; setStreaming(full)
      })
      try {
        const res = await window.electronAPI.aiChatStream(streamId, selectedAiModel, forAi)
        if (!mountedRef.current) return  // BUG-FIX #3 · swallow late response
        if (!res.success) throw new Error(res.error || '召唤对话失败')
        if (res.text) full = res.text
      } finally { cleanup() }

      if (!mountedRef.current) return
      setMessages([...next, {
        role: 'assistant', content: full,
        citations: parseCitations(full, chunks),
        injectedCitationIds: ids,
      }])
      setStreaming('')
    } catch (err: any) {
      if (!mountedRef.current) return
      // Batch 43: humanize raw API errors
      const h = humanizeAiError(err)
      if (!h.silent) onError(toAiPanelError(h))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [input, busy, messages, sysPrompt, selectedAiModel, persona.id, onError])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: 'calc(100vh - 80px)', padding: '20px 28px',
      maxWidth: 920, margin: '0 auto', width: '100%',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14,
        paddingBottom: 14, marginBottom: 14,
        borderBottom: `1px solid ${C.border}`,
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 22, overflow: 'hidden',
          background: C.bgWarm, border: `1px solid ${C.border}`, flexShrink: 0,
        }}>
          <PortraitImg src={src} name={persona.canonicalName || persona.name} sepia={false} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: SERIF, fontSize: 20, fontWeight: 500,
            color: C.text, letterSpacing: '1.2px', lineHeight: 1.2,
          }}>{persona.canonicalName || persona.name}</div>
          {persona.identity && (
            <div style={{
              fontSize: 11.5, color: C.textMuted, marginTop: 3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{persona.identity}</div>
          )}
        </div>
        <ActionBtn onClick={onNewSession} variant="secondary" title="保存当前对话并开启新一段">新对话</ActionBtn>
        <ActionBtn onClick={onClose} variant="secondary">返回</ActionBtn>
      </div>

      <div style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
        {/* P1-2: 初始化加载态 — 给 sysPrompt + RAG probe 一个明确的进度指示，免得用户面对空白区发呆 */}
        {initLoading && messages.length === 0 && !streaming && (
          <div style={{
            padding: '14px 16px', fontSize: 12,
            color: C.textFaint, background: C.bgWarm,
            border: `1px dashed ${C.border}`, borderRadius: 6,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span className="loading-spinner" style={{ width: 10, height: 10 }} />
            正在召唤 {persona.canonicalName || persona.name}（加载 skill 和 RAG 索引）…
          </div>
        )}
        {!initLoading && messages.length === 0 && !streaming && (
          <div style={{
            padding: '14px 16px', fontSize: 12, lineHeight: 1.8,
            color: C.textMuted, background: C.bgWarm,
            border: `1px dashed ${C.border}`, borderRadius: 6,
          }}>
            {ragInfo && ragInfo.totalChunks > 0 ? (
              <div style={{ marginBottom: 6, color: C.accent }}>
                🔎 <b>RAG 已启用</b>：{ragInfo.hydratedSources} 份原文共 {ragInfo.totalChunks} 段可检索——每次提问会按 BM25 / 语义选 top-5 段注入对话。
              </div>
            ) : ragInfo ? (
              <div style={{ marginBottom: 6, color: C.danger }}>
                ⚠️ 没有 hydrated 的原文可检索——对话只基于 skill 心智模型。
              </div>
            ) : null}
            以 {persona.canonicalName || persona.name} 的思维方式回应。对话自动保存到历史。<br />
            提问示例："你怎么看 X？""这段文字你会怎么批注？"
          </div>
        )}
        {messages.map((m, i) => <SummonMessage key={i} m={m} persona={persona} />)}
        {streaming && (
          <div style={{
            marginBottom: 14, padding: '14px 18px', borderRadius: 10,
            background: C.accentSoft, border: `1px solid ${C.borderLight}`,
          }}>
            <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 7, letterSpacing: '0.5px' }}>
              {persona.canonicalName || persona.name}
              <span className="loading-spinner" style={{ marginLeft: 6, width: 8, height: 8 }} />
            </div>
            <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.8, color: C.text }}>
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {sanitizeMath(streaming)}
              </ReactMarkdown>
            </div>
          </div>
        )}
        {/* P0-1: 锚点 div — useEffect 追踪 messages.length + streaming 时 scrollIntoView 这里 */}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleSend() }
          }}
          placeholder={busy ? '等待对方回应…' : '输入你想问他的问题（Ctrl/Cmd + Enter 发送）'}
          rows={3}
          disabled={busy}
          onFocus={(e) => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.boxShadow = `0 0 0 3px ${C.accentSoft}` }}
          onBlur={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none' }}
          style={{
            flex: 1, padding: '11px 14px', fontSize: 13,
            border: `1px solid ${C.border}`, borderRadius: 6,
            transition: 'border-color 200ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1)',
            // P1-4: busy 时明显变灰 + not-allowed cursor，让用户知道发送中不能继续输入
            background: busy ? C.bgWarm : C.bgCard,
            color: busy ? C.textFaint : C.text,
            cursor: busy ? 'not-allowed' : 'text',
            outline: 'none', resize: 'vertical', fontFamily: 'inherit',
          }}
        />
        <button
          onClick={handleSend}
          disabled={busy || !input.trim()}
          style={{
            // UX-R8#15 · P1-6 · padding 对齐 ActionBtn primary(12px 18px)消除 1-2px 行高差
            padding: '12px 18px', fontSize: 13, fontWeight: 500, letterSpacing: '0.8px',
            border: 'none', borderRadius: 6,
            background: (busy || !input.trim()) ? C.border : C.text,
            color: (busy || !input.trim()) ? C.textFaint : C.bg,
            cursor: (busy || !input.trim()) ? 'not-allowed' : 'pointer',
            alignSelf: 'stretch',
            transition: 'background 220ms cubic-bezier(0.4, 0, 0.2, 1), color 220ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >{busy ? '...' : '发送'}</button>
      </div>
    </div>
  )
}

// ============================================================================
// Import preview modal
// ============================================================================
function ImportModal({
  preview, onCancel, onConfirm,
}: {
  preview: { path: string; persona: Persona }
  onCancel: () => void
  onConfirm: () => void
}) {
  const src = usePortrait(preview.persona)
  const { persona } = preview
  // P1-3: 监听 Esc 取消导入 / Enter 确认导入 — 跟 AgentPanel 的 confirmingDelete 模态行为一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter' && !e.shiftKey) onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onConfirm])
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(61, 53, 41, 0.52)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.bgCard, borderRadius: 14,
          border: `1px solid ${C.border}`,
          boxShadow: '0 20px 48px rgba(60, 45, 25, 0.18)',
          maxWidth: 520, width: '100%', padding: 30,
          display: 'flex', flexDirection: 'column', gap: 20,
        }}
      >
        <div style={{
          fontFamily: SERIF, fontSize: 20, fontWeight: 500,
          color: C.text, letterSpacing: '0.5px',
        }}>导入 skill 预览</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{
            width: 88, height: 88, borderRadius: 6, overflow: 'hidden',
            background: C.bgWarm, border: `1px solid ${C.border}`, flexShrink: 0,
          }}>
            <PortraitImg src={src} name={persona.canonicalName || persona.name} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontFamily: SERIF, fontSize: 22, fontWeight: 500,
              color: C.text, letterSpacing: '0.5px',
            }}>{persona.canonicalName || persona.name}</div>
            {persona.identity && (
              <div style={{ fontSize: 12.5, color: C.textMuted, marginTop: 4, lineHeight: 1.6 }}>
                {persona.identity}
              </div>
            )}
          </div>
        </div>
        <div style={{
          padding: 12, background: C.bgWarm, borderRadius: 6,
          fontSize: 11, color: C.textMuted, lineHeight: 1.6,
          fontFamily: MONO, wordBreak: 'break-all',
        }}>{preview.path}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <ActionBtn onClick={onCancel} variant="secondary">取消</ActionBtn>
          <ActionBtn onClick={onConfirm} variant="primary">确认导入</ActionBtn>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Main
// ============================================================================
export default function PersonasTab() {
  const [list, setList] = useState<PersonaListEntry[]>([])
  const [current, setCurrent] = useState<Persona | null>(null)
  const [stage, setStage] = useState<Stage>('gallery')
  // UX-R8#19 · 召唤页的 AI/key/quota/model 类错误也接入 "去设置" CTA.
  const [errorMsg, setErrorMsg] = useState<PanelError | null>(null)
  // Batch 43: 替代 window.confirm() 的暖金确认弹窗
  const { ask: askConfirm, dialog: confirmDialog } = useConfirmDialog()
  // P0-4: 取代导出成功的 window.alert(), 改成面板内暖金风格的成功提示（4s 自消失）
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!successMsg) return
    const t = setTimeout(() => setSuccessMsg(null), 4000)
    return () => clearTimeout(t)
  }, [successMsg])
  const [importing, setImporting] = useState(false)
  const [importPreview, setImportPreview] = useState<{ path: string; persona: Persona } | null>(null)
  // Summon session init — set whenever we move into the 'summon' stage.
  // Starting a fresh summon: { sessionId: new uuid() }.
  // Resuming history: { sessionId, startedAt, messages } from session-load.
  const [summonInit, setSummonInit] = useState<SummonInit | null>(null)

  // UX-R8#2 · P2-1 · 跨 Ctrl+Shift+R 恢复 stage / 当前 persona / 当前 session
  //   sessionStorage 在 Electron 渲染器 reload 期间保留(关窗才清),正好适合这个场景。
  //   仅恢复 'detail' / 'summon';'gallery' / 'import' 是过渡态,reload 后回到 gallery 即可。
  //   原问题(_UX_AUDIT_TODO P2-1):summonInit 是 useState 不持久化,刷新后 stage 重置到 gallery,
  //   写到一半的对话 + 召唤会话上下文全丢。
  const PERSONAS_TAB_SS_KEY = 'shijuan.personasTab.state.v1'
  useEffect(() => {
    let cancelled = false
    let raw: string | null = null
    try { raw = sessionStorage.getItem(PERSONAS_TAB_SS_KEY) } catch { return }
    if (!raw) return
    ;(async () => {
      let saved: { stage?: Stage; personaId?: string; sessionId?: string }
      try { saved = JSON.parse(raw!) } catch { return }
      if (!saved?.personaId || (saved.stage !== 'detail' && saved.stage !== 'summon')) return

      const r = await window.electronAPI.personaLoad?.(saved.personaId)
      if (cancelled) return
      if (!r?.success || !r.persona) {
        // persona 已删/损坏,清掉过期 state
        try { sessionStorage.removeItem(PERSONAS_TAB_SS_KEY) } catch {}
        return
      }
      setCurrent(r.persona)

      if (saved.stage === 'summon' && saved.sessionId) {
        try {
          const sessR = await window.electronAPI.summonSessionLoad?.(saved.personaId, saved.sessionId)
          if (cancelled) return
          if (sessR?.success && sessR.session) {
            setSummonInit({
              sessionId: sessR.session.sessionId,
              startedAt: sessR.session.startedAt,
              messages: sessR.session.messages as SummonMsg[],
            })
            setStage('summon')
            return
          }
        } catch { /* fall through to fresh sessionId */ }
        // 会话存档丢了 — 用同一个 sessionId 起一个空会话,后续保存会重建
        setSummonInit({ sessionId: saved.sessionId })
        setStage('summon')
      } else {
        setStage('detail')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // UX-R8#2 · 写入 sessionStorage(stage / current / sessionId 任一变化)
  useEffect(() => {
    try {
      if (stage === 'gallery' || stage === 'import' || !current) {
        sessionStorage.removeItem(PERSONAS_TAB_SS_KEY)
        return
      }
      sessionStorage.setItem(PERSONAS_TAB_SS_KEY, JSON.stringify({
        stage,
        personaId: current.id,
        sessionId: summonInit?.sessionId,
      }))
    } catch { /* quota / disabled — ignore */ }
  }, [stage, current?.id, summonInit?.sessionId])

  const loadListRef = useRef<() => Promise<void>>(async () => {})

  const loadList = useCallback(async () => {
    if (!window.electronAPI?.personaList) return
    const r = await window.electronAPI.personaList()
    if (r?.success) setList(r.entries)
  }, [])
  loadListRef.current = loadList
  useEffect(() => { void loadList() }, [loadList])

  // Memoize ragPersonaIds by content (not array ref) to avoid infinite loops.
  const ragIdsKey = list.map(p => p.id).join('|')
  const ragPersonaIds = useMemo(
    () => list.map(p => p.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ragIdsKey],
  )
  const { statuses: ragStatuses, buildIndex: buildRagIndexFor } = usePersonaRagStatusList(ragPersonaIds)
  const { toasts: ragToasts, dismiss: dismissRagToast } = usePersonaRagAutoBuildToasts({
    personaNameLookup: (pid) => list.find(e => e.id === pid)?.canonicalName || list.find(e => e.id === pid)?.name,
  })

  const openDetail = useCallback(async (id: string) => {
    setErrorMsg(null)
    const r = await window.electronAPI.personaLoad?.(id)
    if (r?.success && r.persona) { setCurrent(r.persona); setStage('detail') }
    else setErrorMsg({ message: r?.error || '档案加载失败' })
  }, [])

  const handleDelete = useCallback((id: string) => {
    // Batch 43: window.confirm() → 暖金 ConfirmDialog
    askConfirm({
      title: '删除思想家档案',
      message: '删除这位思想家的档案？此操作不可撤销。',
      confirmLabel: '删除',
      danger: true,
      onConfirm: async () => {
        await window.electronAPI.personaDelete?.(id)
        if (current?.id === id) { setCurrent(null); setStage('gallery') }
        await loadListRef.current()
        // PERF-R8#11 · 通知共享 cache 失效,AnnotationPanel 召唤 dropdown 自动刷新
        invalidatePersonaListCache()
      },
    })
  }, [current, askConfirm])

  const handleExport = useCallback(async (opts?: { pickDir?: boolean }) => {
    if (!current) return
    setErrorMsg(null)
    try {
      let outDir: string | undefined
      if (opts?.pickDir) {
        const r = await window.electronAPI.personaPickExportDir?.()
        if (!r?.success || !r.dir) return
        outDir = r.dir
      }
      const r = await window.electronAPI.personaExportSkill?.(current.id, { outDir })
      if (!r?.success) { setErrorMsg({ message: r?.error || '导出失败' }); return }
      const reloaded = await window.electronAPI.personaLoad?.(current.id)
      if (reloaded?.success && reloaded.persona) setCurrent(reloaded.persona)
      // P0-4: 从 window.alert 换成 in-app 绿色横幅（4s 自消失），保留暖金美学
      setSuccessMsg(`已导出到 ${r.skillDir}`)
    } catch (err: any) { setErrorMsg({ message: err?.message || String(err) }) }
  }, [current])

  const handleImport = useCallback(async () => {
    setErrorMsg(null); setImporting(true)
    try {
      const pick = await window.electronAPI.personaPickSkillPath?.()
      if (!pick?.success || !pick.path) return
      const r = await window.electronAPI.personaImportSkill?.(pick.path)
      if (!r?.success || !r.persona) { setErrorMsg({ message: r?.error || '导入失败' }); return }
      setImportPreview({ path: pick.path, persona: r.persona })
      setStage('import')
    } catch (err: any) { setErrorMsg({ message: err?.message || String(err) }) }
    finally { setImporting(false) }
  }, [])

  const confirmImport = useCallback(async () => {
    if (!importPreview) return
    // personaImportSkill already wrote the persona; this is just the confirmation gate.
    await loadListRef.current()
    // PERF-R8#11 · 通知共享 cache 失效
    invalidatePersonaListCache()
    setCurrent(importPreview.persona)
    setImportPreview(null)
    setStage('detail')
  }, [importPreview])

  const cancelImport = useCallback(async () => {
    if (importPreview) {
      // Roll back the write that personaImportSkill performed.
      await window.electronAPI.personaDelete?.(importPreview.persona.id).catch(() => {})
      await loadListRef.current()
      // PERF-R8#11 · 回滚后也要 invalidate
      invalidatePersonaListCache()
    }
    setImportPreview(null); setStage('gallery')
  }, [importPreview])

  // === Summon session handlers (Pain point #1) ===
  // Start a brand-new summon session. The SummonView unmounts its previous
  // instance (flushing any pending save), and mounts fresh with a new sessionId.
  const handleStartSummon = useCallback(() => {
    setSummonInit({ sessionId: uuid() })
    setStage('summon')
  }, [])

  // Resume a past session — fetch its stored messages then mount SummonView.
  const handleOpenSession = useCallback(async (sessionId: string) => {
    if (!current) return
    try {
      const r = await window.electronAPI.summonSessionLoad?.(current.id, sessionId)
      if (!r?.success || !r.session) {
        setErrorMsg({ message: r?.error || '该对话已丢失或损坏' })
        return
      }
      setSummonInit({
        sessionId: r.session.sessionId,
        startedAt: r.session.startedAt,
        messages: r.session.messages as SummonMsg[],
      })
      setStage('summon')
    } catch (err: any) { setErrorMsg({ message: err?.message || String(err) }) }
  }, [current])

  // "新对话" button inside SummonView. We force a remount by swapping summonInit
  // — SummonView's useEffect([]) cleanup flushes the current session before
  // the new one mounts.
  const handleNewSession = useCallback(() => {
    setSummonInit({ sessionId: uuid() })
  }, [])

  // After a material-upload writes a new source, reload the persona from disk
  // so the DetailView's sourcesUsed counts refresh, and the list / RAG status
  // pick up the new updatedAt.
  const handlePersonaUpdated = useCallback(async (updated: Persona) => {
    setCurrent(updated)
    await loadListRef.current()
  }, [])

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      minHeight: 0, background: C.bg, color: C.text, overflow: 'auto',
    }}>
      {errorMsg && (
        <div style={{
          margin: '14px 28px 0', padding: '10px 14px',
          background: 'rgba(181, 90, 79, 0.08)', border: `1px solid ${C.danger}`,
          borderRadius: 6, fontSize: 12, color: C.danger,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span style={{ flex: 1, minWidth: 0 }}>{errorMsg.message}</span>
          {errorMsg.ctaSettings && (
            <button
              type="button"
              onClick={() => {
                useUiStore.getState().setShowSettings(true)
                setErrorMsg(null)
              }}
              style={{
                padding: '4px 9px',
                borderRadius: 5,
                border: `1px solid ${C.danger}`,
                background: 'rgba(181, 90, 79, 0.08)',
                color: C.danger,
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
              }}
            >去设置</button>
          )}
          <button
            onClick={() => setErrorMsg(null)}
            style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
          >×</button>
        </div>
      )}
      {/* P0-4: 导出等成功消息的面板内横幅（自动 4s 消失） */}
      {successMsg && (
        <div style={{
          margin: '14px 28px 0', padding: '10px 14px',
          background: 'rgba(44,138,111,0.08)', border: `1px solid #2c8a6f`,
          borderRadius: 6, fontSize: 12, color: '#2c8a6f',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <span>✓ {successMsg}</span>
          <button
            onClick={() => setSuccessMsg(null)}
            style={{ background: 'none', border: 'none', color: '#2c8a6f', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
          >×</button>
        </div>
      )}

      {stage === 'gallery' && (
        <div style={{ padding: '32px 36px', maxWidth: 1280, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            paddingBottom: 24, marginBottom: 32, borderBottom: `1px solid ${C.border}`,
          }}>
            <div>
              <div style={{
                fontSize: 11, color: C.textFaint, letterSpacing: '4.5px',
                textTransform: 'uppercase', marginBottom: 12, fontWeight: 500,
              }}>Summon / 召唤</div>
              <h1 style={{
                fontFamily: SERIF, fontSize: 34, fontWeight: 500,
                color: C.text, letterSpacing: '3px', margin: 0,
              }}>召唤人物</h1>
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10, letterSpacing: '0.3px' }}>
                {list.length === 0
                  ? '还没有人物 — 从右上导入一位。'
                  : `共 ${list.length} 位 · 点卡片进入详情，召唤对话`}
              </div>
            </div>
            <button
              onClick={handleImport}
              disabled={importing}
              style={{
                padding: '11px 22px', fontSize: 13, fontWeight: 500, letterSpacing: '0.8px',
                background: C.text, color: C.bg, border: 'none', borderRadius: 4,
                cursor: importing ? 'wait' : 'pointer', transition: 'background 220ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={(e) => { if (!importing) e.currentTarget.style.background = C.accentDark }}
              onMouseLeave={(e) => { if (!importing) e.currentTarget.style.background = C.text }}
            >{importing ? '导入中…' : '导入 skill'}</button>
          </div>

          {list.length === 0 ? (
            <div style={{ padding: '80px 24px', textAlign: 'center', color: C.textMuted, fontSize: 14, lineHeight: 1.9 }}>
              <div style={{
                fontFamily: SERIF, fontSize: 24, fontWeight: 500,
                letterSpacing: '2px', marginBottom: 14, color: C.text,
              }}>召唤人物库是空的</div>
              <div>点右上「导入 skill」从 Claude Code 目录导入一位（比如 hegel / kant）</div>
            </div>
          ) : (
            <div style={{
              display: 'grid', gap: 24,
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            }}>
              {list.map(entry => (
                <Card
                  key={entry.id}
                  entry={entry}
                  ragPill={ragStatuses[entry.id] && (
                    <PersonaRagPill
                      state={ragStatuses[entry.id]}
                      onBuild={() => buildRagIndexFor(entry.id)}
                      compact
                    />
                  )}
                  onOpen={() => openDetail(entry.id)}
                  onDelete={() => handleDelete(entry.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {stage === 'detail' && current && (
        <DetailView
          persona={current}
          onBack={() => { setCurrent(null); setStage('gallery'); setErrorMsg(null) }}
          onSummon={handleStartSummon}
          onOpenSession={handleOpenSession}
          onReveal={async () => {
            if (!current) return
            const r = await window.electronAPI.personaReveal?.(current.id)
            if (!r?.success) setErrorMsg({ message: r?.error || '定位失败' })
          }}
          onDelete={() => handleDelete(current.id)}
          onPersonaUpdated={handlePersonaUpdated}
        />
      )}

      {stage === 'summon' && current && summonInit && (
        <SummonView
          key={summonInit.sessionId}  // force remount on new session so effects flush/init fresh
          persona={current}
          init={summonInit}
          onClose={() => setStage('detail')}
          onError={setErrorMsg}
          onNewSession={handleNewSession}
        />
      )}

      {stage === 'import' && importPreview && (
        <ImportModal
          preview={importPreview}
          onCancel={cancelImport}
          onConfirm={confirmImport}
        />
      )}

      <PersonaRagToastStack toasts={ragToasts} onDismiss={dismissRagToast} />
      {/* Batch 43: ConfirmDialog 替代 window.confirm */}
      {confirmDialog}
    </div>
  )
}
