// Phase-C · persona RAG status helpers
// =====================================
// UI bits for the "索引状态" pill that sits on each persona card + the toast
// that fires when an auto-build finishes. Kept in this file so PersonasTab.tsx
// doesn't need further edits — the user integrates these manually.
//
// Exposed pieces:
//   - usePersonaRagStatusList()     — hook that tracks status for many personas
//                                     at once (for PersonasTab list view). Live
//                                     updates via onPersonaRagBuildProgress so
//                                     the card pill transitions while a build
//                                     runs in the background.
//   - usePersonaRagAutoBuildToasts() — hook that surfaces a toast whenever an
//                                     auto-build completes (done or error).
//                                     Parent renders the returned toast[].
//   - <PersonaRagPill>              — the small colored chip. Green/yellow/red/
//                                     gray per state. Click → trigger build.
//   - <PersonaRagCoverageTooltip>   — the hover expansion of the pill (per-
//                                     source indexed/skipped breakdown).
//
// Design notes:
//   * No dependency on heavy UI libs — plain JSX + inline style. Matches the
//     PersonasTab visual idiom (minimal style objects, no Tailwind).
//   * Pill click fires personaRagBuild directly; the hook observes the same
//     progress channel so the UI updates without a second fetch.
//   * Color choices match the spec: green=已索引, gray=未索引, yellow=构建中,
//     red=失败.

import React, { useCallback, useEffect, useRef, useState } from 'react'

// Shape copied from preload's personaRagStatus / personaRagBuild responses.
// Duplicated here so this file doesn't depend on electron/preload types at
// build time (renderer typechecks stay isolated).
export interface PersonaRagCoverage {
  totalSources: number
  indexedSources: number
  skippedSources: number
  erroredSources: number
  perSource: Array<{
    sourceId: string
    sourceTitle: string
    sourceType: string
    status: 'indexed' | 'skipped-empty' | 'skipped-short' | 'error'
    chunkCount: number
    reason?: string
  }>
}

export type PersonaRagUiState =
  | { kind: 'unknown' }                                              // not fetched yet
  | { kind: 'no-sources' }                                           // persona has no hydrated sources
  | { kind: 'not-built'; canBuild: boolean; reason?: string }        // no index file yet
  | { kind: 'building'; phase: string; done: number; total: number } // build running
  | { kind: 'built'; chunks: number; builtAt?: string; stale: boolean; provider?: string; coverage?: PersonaRagCoverage }
  | { kind: 'error'; message: string; coverage?: PersonaRagCoverage } // last build failed

// ===== Shared status fetch =====

/** Single-persona status refresh. Exported for callers that want to force a
 *  refetch (e.g., after ingesting a new source). */
export async function fetchPersonaRagUiState(personaId: string): Promise<PersonaRagUiState> {
  const api = window.electronAPI
  if (!api?.personaRagStatus) return { kind: 'unknown' }
  try {
    const r = await api.personaRagStatus(personaId)
    if (!r?.success) return { kind: 'error', message: r?.error || '状态查询失败' }
    const hasKey = !!(r.availableProviders || []).some(p => p.hasKey)
    if (r.buildInProgress) {
      // Server says a build is live; we don't know the phase, so show a
      // neutral "building" state until the first progress frame arrives.
      return { kind: 'building', phase: 'running', done: 0, total: 0 }
    }
    if (!r.built) {
      if ((r.currentHydratedSources || 0) === 0) return { kind: 'no-sources' }
      if (!hasKey) {
        return {
          kind: 'not-built', canBuild: false,
          reason: '未配置 OpenAI / GLM Key——召唤会退回 BM25 检索（仍然能用，但语义覆盖差）',
        }
      }
      return { kind: 'not-built', canBuild: true }
    }
    return {
      kind: 'built',
      chunks: r.chunkCount || 0,
      builtAt: r.builtAt,
      stale: !!r.needsRebuild,
      provider: r.provider,
      coverage: r.coverage,
    }
  } catch (err: any) {
    return { kind: 'error', message: err?.message || String(err) }
  }
}

// ===== Hook: track many personas at once (for list view) =====

/** Live-updating status map keyed by personaId. Subscribes to the build
 *  progress channel so when an auto-build runs (triggered by persona-save),
 *  the pill transitions automatically. Call `refreshOne(id)` to force a
 *  refetch after e.g. ingest; `refreshAll()` for list-level refresh.
 */
export function usePersonaRagStatusList(personaIds: string[]): {
  statuses: Record<string, PersonaRagUiState>
  refreshOne: (id: string) => Promise<void>
  refreshAll: () => Promise<void>
  buildIndex: (id: string) => Promise<void>
} {
  const [statuses, setStatuses] = useState<Record<string, PersonaRagUiState>>({})
  const idSetRef = useRef<Set<string>>(new Set())
  // Keep the latest id set in a ref so the progress listener (which closes
  // over the initial value) can read it without restarting on every rerender.
  idSetRef.current = new Set(personaIds)
  // BUG-FIX #A · mountedRef so manual buildIndex / refreshOne / refreshAll
  // don't setState after unmount. personaRagBuild can take 30–60s; if the
  // user switches tabs mid-build the awaited resolution otherwise fires
  // setStatuses on a zombie hook instance (React warning + wasted state).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refreshOne = useCallback(async (id: string) => {
    const state = await fetchPersonaRagUiState(id)
    if (!mountedRef.current) return  // BUG-FIX #A · drop result after unmount
    setStatuses(prev => ({ ...prev, [id]: state }))
  }, [])

  const refreshAll = useCallback(async () => {
    const entries = await Promise.all(
      personaIds.map(async id => [id, await fetchPersonaRagUiState(id)] as const),
    )
    if (!mountedRef.current) return  // BUG-FIX #A · drop result after unmount
    setStatuses(Object.fromEntries(entries))
  }, [personaIds])

  const buildIndex = useCallback(async (id: string) => {
    const api = window.electronAPI
    if (!api?.personaRagBuild) return
    if (!mountedRef.current) return
    setStatuses(prev => ({ ...prev, [id]: { kind: 'building', phase: 'chunk', done: 0, total: 0 } }))
    try {
      const r = await api.personaRagBuild(id)
      // BUG-FIX #A · personaRagBuild may take 30-60s; user can navigate away.
      // Guard all post-await setStatuses calls so we don't warn-log zombies.
      if (!mountedRef.current) return
      if (!r?.success) {
        setStatuses(prev => ({
          ...prev, [id]: { kind: 'error', message: r?.error || '构建失败', coverage: r?.coverage },
        }))
        return
      }
    } catch (err: any) {
      if (!mountedRef.current) return  // BUG-FIX #A
      setStatuses(prev => ({ ...prev, [id]: { kind: 'error', message: err?.message || String(err) } }))
      return
    }
    if (!mountedRef.current) return  // BUG-FIX #A
    await refreshOne(id)
  }, [refreshOne])

  // Initial load + whenever the id list changes (persona added/deleted)
  useEffect(() => { void refreshAll() }, [refreshAll])

  // Subscribe once to the build progress channel; filter by id set.
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onPersonaRagBuildProgress) return
    const cleanup = api.onPersonaRagBuildProgress((payload) => {
      if (!payload?.personaId) return
      if (!idSetRef.current.has(payload.personaId)) return
      if (payload.phase === 'done') {
        // Index file just written — refetch to pull authoritative numbers.
        void fetchPersonaRagUiState(payload.personaId).then(s => {
          if (!mountedRef.current) return  // BUG-FIX #A
          setStatuses(prev => ({ ...prev, [payload.personaId]: s }))
        })
      } else if (payload.phase === 'error') {
        if (!mountedRef.current) return  // BUG-FIX #A
        setStatuses(prev => ({
          ...prev,
          [payload.personaId]: {
            kind: 'error',
            message: payload.error || '构建失败',
            coverage: payload.coverage,
          },
        }))
      } else {
        // 'chunk' / 'embed' / 'save' — intermediate progress
        if (!mountedRef.current) return  // BUG-FIX #A
        setStatuses(prev => ({
          ...prev,
          [payload.personaId]: {
            kind: 'building',
            phase: payload.phase,
            done: payload.done,
            total: payload.total,
          },
        }))
      }
    })
    return cleanup
  }, [])

  return { statuses, refreshOne, refreshAll, buildIndex }
}

// ===== Hook: toast notifications for completed auto-builds =====

export interface PersonaRagToast {
  id: string                                        // uuid-ish, monotonic counter works too
  personaId: string
  kind: 'success' | 'error' | 'partial'
  title: string                                     // "已为 张三 建好索引"
  body: string                                      // coverage summary / error reason
  createdAt: number                                 // Date.now()
}

/** Collects a short-lived toast each time an **auto** build completes (manual
 *  builds already show their result inline in the progress UI). Partial
 *  success (some sources skipped) becomes a 'partial' toast so users notice
 *  the coverage gap without being pestered every time.
 *
 *  Caller renders the returned toast list however they like (top-right stack,
 *  toast bar, etc.) and calls dismiss(id) when the user closes one. Toasts
 *  auto-expire after `autoDismissMs` (default 6s) via the returned timer.
 */
export function usePersonaRagAutoBuildToasts(opts?: {
  personaNameLookup?: (personaId: string) => string | undefined
  autoDismissMs?: number
}): {
  toasts: PersonaRagToast[]
  dismiss: (id: string) => void
} {
  const [toasts, setToasts] = useState<PersonaRagToast[]>([])
  const autoDismissMs = opts?.autoDismissMs ?? 6000
  const counterRef = useRef(0)
  const lookupRef = useRef(opts?.personaNameLookup)
  lookupRef.current = opts?.personaNameLookup
  // BUG-FIX #2 · track auto-dismiss timers so unmount can clear them
  // Previously each toast scheduled a bare `setTimeout(dismiss, 6s)` that
  // was NEVER tracked. If the user navigated away from PersonasTab (which
  // unmounts the parent) within 6s of the last auto-build finishing, React
  // fired "setState on unmounted component" warnings and kept a dangling
  // timer alive that would still call dismiss→setToasts on a zombie state.
  // Collect them in a ref so the effect cleanup can wipe them all.
  const dismissTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onPersonaRagBuildProgress) return
    const cleanup = api.onPersonaRagBuildProgress((payload) => {
      // Only toast auto-builds — manual builds are driven from visible UI.
      if (payload?.trigger !== 'auto') return
      if (payload.phase !== 'done' && payload.phase !== 'error') return
      const personaName = lookupRef.current?.(payload.personaId) || '人物'
      const id = `rag-toast-${++counterRef.current}`
      let toast: PersonaRagToast
      if (payload.phase === 'error') {
        toast = {
          id, personaId: payload.personaId, kind: 'error',
          title: `「${personaName}」索引构建失败`,
          body: payload.error || '未知原因（可能是 API 限流 / 网络问题）',
          createdAt: Date.now(),
        }
      } else {
        const cov = payload.coverage
        const indexed = cov?.indexedSources ?? 0
        const total = cov?.totalSources ?? 0
        const skipped = (cov?.skippedSources ?? 0) + (cov?.erroredSources ?? 0)
        const kind = skipped > 0 ? 'partial' : 'success'
        toast = {
          id, personaId: payload.personaId, kind,
          title: kind === 'success'
            ? `「${personaName}」索引已自动建好`
            : `「${personaName}」索引建好（部分跳过）`,
          body: cov
            ? `${indexed}/${total} 源入库${skipped > 0 ? `，${skipped} 源跳过（详见档案页）` : ''}`
            : '',
          createdAt: Date.now(),
        }
      }
      setToasts(prev => [...prev, toast])
      // BUG-FIX #2 · track the timer in a ref + clear on cleanup
      const timer = setTimeout(() => {
        dismissTimersRef.current.delete(timer)
        dismiss(toast.id)
      }, autoDismissMs)
      dismissTimersRef.current.add(timer)
    })
    return () => {
      cleanup()
      // BUG-FIX #2 · on unmount, cancel any pending auto-dismiss timers so
      // they don't call setState after we're gone.
      for (const t of dismissTimersRef.current) clearTimeout(t)
      dismissTimersRef.current.clear()
    }
  }, [autoDismissMs, dismiss])

  return { toasts, dismiss }
}

// ===== Presentational components =====

const PILL_STYLE_BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 8px',
  borderRadius: 11,
  fontSize: 11,
  lineHeight: '14px',
  userSelect: 'none',
  cursor: 'default',
  border: '1px solid transparent',
  whiteSpace: 'nowrap',
  transition: 'background 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1)',
}

const SPINNER_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: 8, height: 8,
  borderRadius: '50%',
  border: '1.5px solid currentColor',
  borderTopColor: 'transparent',
  animation: 'persona-rag-spin 0.8s linear infinite',
}

// Inline keyframes so the component works without touching global CSS. Next
// time the file mounts we overwrite the same <style>, that's fine.
function injectKeyframesOnce() {
  if (typeof document === 'undefined') return
  if (document.getElementById('persona-rag-keyframes')) return
  const s = document.createElement('style')
  s.id = 'persona-rag-keyframes'
  s.textContent = '@keyframes persona-rag-spin { to { transform: rotate(360deg); } }'
  document.head.appendChild(s)
}

/** The small clickable chip. In list view, clicking fires buildIndex(); in
 *  detail view, parent can override via onClick.
 *
 *  UX-R8#6 · P2-5 落地:state.kind === 'error' 时点击 pill 不再直接 onBuild,
 *  而是展开一个小详情面板,显示 state.message + 一个明确的"重试构建"按钮。
 *  失败原因常常是 API key 失效 / 限流 / 余额不足等用户必须立即知道的信息,
 *  原版只能 hover 看 title 太隐蔽。 */
export function PersonaRagPill({
  state, onBuild, compact = false,
}: {
  state: PersonaRagUiState
  onBuild?: () => void
  /** If true, drop the secondary text and keep only the dot + one word. */
  compact?: boolean
}): React.ReactElement | null {
  useEffect(() => { injectKeyframesOnce() }, [])

  // UX-R8#6 · P2-5 · 错误详情面板的展开状态
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false)
  // state 切回非 error 时自动收起,避免遗留的 expanded UI 卡在新状态上
  useEffect(() => { if (state.kind !== 'error') setErrorDetailsOpen(false) }, [state.kind])

  let bg = '#eee', fg = '#555', border = '#ddd'
  let dot: React.ReactNode = null
  let label = ''
  let tooltip = ''
  let clickable = false

  switch (state.kind) {
    case 'unknown':
      return null   // don't flash anything before first fetch
    case 'no-sources':
      bg = '#f4f4f5'; fg = '#71717a'; border = '#e4e4e7'
      dot = <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#a1a1aa' }} />
      label = '无资料'
      tooltip = '该档案 sourcesUsed 为空，先添加资料再建索引'
      break
    case 'not-built':
      bg = '#f4f4f5'; fg = '#71717a'; border = '#d4d4d8'
      dot = <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#9ca3af' }} />
      label = state.canBuild ? '未索引 · 点击构建' : '未索引 (需 Key)'
      tooltip = state.canBuild
        ? '点击构建语义索引。召唤时会用 embedding 检索资料片段，覆盖率更好。'
        : (state.reason || '未配置 embedding provider')
      clickable = state.canBuild && !!onBuild
      break
    case 'building': {
      bg = '#faf0ce'; fg = '#8a5a1a'; border = '#ead9a8'
      dot = <span style={SPINNER_STYLE} />
      const pct = state.total > 0 ? `${state.done}/${state.total}` : ''
      label = compact ? '构建中' : `构建中${pct ? ' · ' + pct : ''}`
      tooltip = `后台构建中（phase: ${state.phase}）——可正常使用召唤，索引完成后自动切换到语义检索`
      break
    }
    case 'built': {
      if (state.stale) {
        bg = '#fbeedb'; fg = '#a85520'; border = '#edd3b0'
        dot = <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#d88638' }} />
        label = compact ? '索引过期' : `索引过期 · ${state.chunks} 段`
        tooltip = `上次构建后资料有变化，建议重建以获得最佳检索质量`
        clickable = !!onBuild
      } else {
        bg = '#e8f3e4'; fg = '#2f6a3a'; border = '#cde4c2'
        dot = <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#4a9653' }} />
        label = compact ? '已索引' : `已索引 · ${state.chunks} 段`
        const cov = state.coverage
        const covLine = cov
          ? `\n${cov.indexedSources}/${cov.totalSources} 源入库${cov.skippedSources > 0 ? ` · ${cov.skippedSources} 跳过` : ''}${cov.erroredSources > 0 ? ` · ${cov.erroredSources} 出错` : ''}`
          : ''
        tooltip = `语义索引已就绪${state.provider ? ` (${state.provider})` : ''}${covLine}${state.builtAt ? `\n构建于 ${new Date(state.builtAt).toLocaleString('zh-CN')}` : ''}`
      }
      break
    }
    case 'error':
      bg = '#f7dedc'; fg = '#9b3d3a'; border = '#ebc3c0'
      dot = <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: '#c05854' }} />
      // UX-R8#6 · P2-5 · 错误状态加 ▾/▴ 提示用户可展开
      label = compact
        ? (errorDetailsOpen ? '失败 ▴' : '失败 ▾')
        : (errorDetailsOpen ? '索引失败 ▴' : '索引失败 ▾')
      tooltip = state.message
      clickable = true   // error pill 永远可点(展开/收起)
      break
  }

  // UX-R8#6 · P2-5 · error 时点 pill 切换详情面板,其他状态保持原 onBuild 行为
  const isError = state.kind === 'error'
  const handlePillClick = (e: React.MouseEvent) => {
    if (isError) {
      e.stopPropagation()
      setErrorDetailsOpen(o => !o)
      return
    }
    if (!clickable) return
    e.stopPropagation()
    onBuild?.()
  }

  const pill = (
    <span
      title={tooltip}
      onClick={handlePillClick}
      style={{
        ...PILL_STYLE_BASE,
        background: bg, color: fg, borderColor: border,
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      {dot}
      <span>{label}</span>
    </span>
  )

  if (!isError) return pill

  // error · 展开式详情面板(显示 message + 重试按钮)
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      {pill}
      {errorDetailsOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%', marginTop: 4, left: 0,
            zIndex: 100,
            minWidth: 220, maxWidth: 320,
            background: 'var(--bg, #fff)',
            border: '1px solid var(--border, #ebc3c0)',
            borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
            padding: '10px 12px',
            fontSize: 11.5,
            lineHeight: 1.55,
            color: 'var(--text, #3D3529)',
            cursor: 'default',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: '#9b3d3a' }}>RAG 索引构建失败</div>
          <div style={{ marginBottom: 10, wordBreak: 'break-word' }}>
            {state.kind === 'error' ? state.message : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setErrorDetailsOpen(false)}
              style={{
                padding: '4px 10px', fontSize: 11, borderRadius: 4,
                border: '1px solid var(--border-light, #e3d8be)',
                background: 'transparent', color: 'var(--text-secondary, #7a6f5f)',
                cursor: 'pointer',
              }}
            >收起</button>
            {onBuild && (
              <button
                onClick={() => { setErrorDetailsOpen(false); onBuild() }}
                style={{
                  padding: '4px 10px', fontSize: 11, borderRadius: 4,
                  border: '1px solid #c05854',
                  background: '#c05854', color: '#fff',
                  cursor: 'pointer',
                }}
              >重试构建</button>
            )}
          </div>
        </div>
      )}
    </span>
  )
}

/** Expanded coverage breakdown — for the persona detail panel.
 *  Lists every source with its indexed/skipped/error status + reason.
 *  Renders nothing if coverage is null (pre-Phase-C index). */
export function PersonaRagCoverageTable({
  coverage,
}: {
  coverage?: PersonaRagCoverage
}): React.ReactElement | null {
  if (!coverage || !coverage.perSource?.length) return null

  const statusLabel: Record<string, { label: string; color: string }> = {
    'indexed':        { label: '已索引', color: '#16a34a' },
    'skipped-empty':  { label: '跳过(空)', color: '#a1a1aa' },
    'skipped-short':  { label: '跳过(过短)', color: '#a1a1aa' },
    'error':          { label: '出错', color: '#dc2626' },
  }

  return (
    <div style={{ fontSize: 12, marginTop: 8 }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: '#52525b' }}>
        索引覆盖率：{coverage.indexedSources}/{coverage.totalSources} 源入库
        {coverage.skippedSources > 0 && <span style={{ color: '#a16207' }}> · {coverage.skippedSources} 跳过</span>}
        {coverage.erroredSources > 0 && <span style={{ color: '#b91c1c' }}> · {coverage.erroredSources} 出错</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {coverage.perSource.map(s => {
          const meta = statusLabel[s.status] || { label: s.status, color: '#555' }
          return (
            <div key={s.sourceId} style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '2px 6px', background: '#fafafa', borderRadius: 4,
              borderLeft: `3px solid ${meta.color}`,
            }}>
              <span style={{ color: meta.color, fontWeight: 500, minWidth: 70 }}>{meta.label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#27272a' }}>
                  {s.sourceTitle}
                </div>
                {s.status === 'indexed' && (
                  <div style={{ color: '#71717a', fontSize: 11 }}>{s.chunkCount} 个片段</div>
                )}
                {s.reason && (
                  <div style={{ color: '#a16207', fontSize: 11 }}>{s.reason}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A compact toast stack (fixed top-right) for auto-build notifications.
 *  Caller supplies toasts (from usePersonaRagAutoBuildToasts) + dismiss fn. */
export function PersonaRagToastStack({
  toasts, onDismiss,
}: {
  toasts: PersonaRagToast[]
  onDismiss: (id: string) => void
}): React.ReactElement | null {
  if (toasts.length === 0) return null
  return (
    <div style={{
      position: 'fixed', top: 16, right: 16, zIndex: 9999,
      display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none',
    }}>
      {toasts.map(t => {
        const bg = t.kind === 'error' ? '#fee2e2' : t.kind === 'partial' ? '#fef3c7' : '#dcfce7'
        const fg = t.kind === 'error' ? '#991b1b' : t.kind === 'partial' ? '#854d0e' : '#166534'
        return (
          <div
            key={t.id}
            onClick={() => onDismiss(t.id)}
            style={{
              background: bg, color: fg,
              padding: '10px 14px', borderRadius: 8,
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              maxWidth: 320, fontSize: 13, lineHeight: '18px',
              pointerEvents: 'auto', cursor: 'pointer',
            }}
            title='点击关闭'
          >
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            {t.body && <div style={{ marginTop: 2, opacity: 0.85 }}>{t.body}</div>}
          </div>
        )
      })}
    </div>
  )
}
