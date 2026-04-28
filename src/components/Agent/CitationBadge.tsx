// Wave-4 · Citation verdict badge
// ------------------------------------------------------------
// Renders a compact colored chip at the bottom of an AI message that tells
// the reader whether the model's [资料 N] citations were actually injected
// this turn, or whether the model hallucinated numbers.
//
// Three visual states:
//   1. "✓ 引用 N 条全部可验证"    — green   (all cites ∈ injectedIds)
//   2. "⚠️ N 条引用中 K 条为模型幻觉" — orange (some invalid)
//   3. (nothing)                        — when total = 0
//
// Design notes
// - No modal / popover library — hover is via native `title` + inline tooltip
//   div. Keeps the component tree-shakeable and free of external deps.
// - Uses the app's CSS variables (--success, --warning, --danger, etc.) so
//   light/dark themes flip automatically.
// - Callers pass either:
//     (a) an already-computed result from window.electronAPI.aiVerifyCitations()
//         or the local parseCitations() shim; or
//     (b) raw `responseText` + `injectedIds` and let the badge verify
//         synchronously via the same regex set.
//   We expose both because integration points differ — the streaming UI
//   wants option (a) (verify once after stream ends), but a retroactive
//   "view past message" flow can use (b) with no IPC round-trip.

import React from 'react'

// ---- Shared regex + expander (mirrors electron/ipc/citationVerifier.ts) ----
// Kept in sync so (a) client-side preview and (b) backend IPC agree on which
// forms count as citations. If you edit one, edit the other. The two files
// deliberately duplicate a few dozen lines rather than share a module —
// the renderer can't easily import from `electron/` in this project.
const CITATION_REGEX_CN = /[\[【]\s*资料\s*([\d,，、\s\-–~~]+)\s*[\]】]/g
const CITATION_REGEX_EN = /\[\s*(?:Source|source|SOURCE|Ref|ref|REF)\s*([\d,\s\-–~~]+)\s*\]/g

function expandNumberList(raw: string): number[] {
  const out = new Set<number>()
  const parts = raw.split(/[,，、\s]+/).filter(Boolean)
  for (const p of parts) {
    const range = p.match(/^(\d+)\s*[\-–~~]\s*(\d+)$/)
    if (range) {
      const a = parseInt(range[1], 10)
      const b = parseInt(range[2], 10)
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        for (let i = lo; i <= Math.min(hi, lo + 50); i++) out.add(i)
      }
    } else {
      const n = parseInt(p, 10)
      if (Number.isFinite(n)) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}

export interface CitationVerifyResult {
  valid: number[]
  invalid: number[]
  duplicates: number[]
  total: number
  allCited: number[]
}

/** Client-side mirror of electron/ipc/citationVerifier.ts#verifyCitations.
 *  Use this when you don't want an IPC round-trip (e.g. syncing badge state
 *  on already-rendered history messages). The IPC version should be used
 *  for authoritative checks that also emit the append-warning payload.
 */
export function verifyCitationsLocal(
  aiResponse: string,
  injectedIds: number[],
): CitationVerifyResult {
  const empty: CitationVerifyResult = { valid: [], invalid: [], duplicates: [], total: 0, allCited: [] }
  if (!aiResponse || typeof aiResponse !== 'string') return empty

  const injected = new Set(injectedIds || [])
  const occurrences = new Map<number, number>()

  for (const re of [CITATION_REGEX_CN, CITATION_REGEX_EN]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(aiResponse)) !== null) {
      const ns = expandNumberList(m[1])
      for (const n of ns) occurrences.set(n, (occurrences.get(n) || 0) + 1)
    }
  }

  if (occurrences.size === 0) return empty

  const valid: number[] = []
  const invalid: number[] = []
  const duplicates: number[] = []
  let total = 0
  for (const [n, occ] of [...occurrences.entries()].sort((a, b) => a[0] - b[0])) {
    total += occ
    if (occ > 1) duplicates.push(n)
    if (injected.has(n)) valid.push(n)
    else invalid.push(n)
  }
  return {
    valid,
    invalid,
    duplicates,
    total,
    allCited: [...occurrences.keys()].sort((a, b) => a - b),
  }
}

// ---- Component ----

export interface CitationBadgeProps {
  /** Verified result. Preferred over responseText+injectedIds if you have it. */
  result?: CitationVerifyResult
  /** AI response text — used when `result` is not provided. */
  responseText?: string
  /** The 1-based N's actually injected this turn. */
  injectedIds?: number[]
  /** Override element class for host-side layout tweaks. */
  className?: string
  /** Optional extra style, merged after the built-in colors. */
  style?: React.CSSProperties
  /** If true, render a noop <span /> when nothing's been cited (vs null).
   *  Handy if the caller lays out a fixed row. Default: false (returns null). */
  reserveSpace?: boolean
}

/** Small pill at the bottom of an AI message summarizing whether
 *  [资料 N] citations were real (injected) or hallucinated.
 *
 *  Usage — inside PersonasTab.tsx's assistant-message render:
 *    <CitationBadge
 *      result={m.citationVerify}
 *      responseText={m.content}
 *      injectedIds={m.injectedCitationIds}
 *    />
 *
 *  Usage — inside AnnotationPanel.tsx after a persona invocation:
 *    <CitationBadge responseText={aiAnswer} injectedIds={ragCites} />
 */
export function CitationBadge(props: CitationBadgeProps): JSX.Element | null {
  const { result, responseText, injectedIds, className, style, reserveSpace } = props

  // Resolve verdict: explicit result beats re-computing from raw text.
  const verdict: CitationVerifyResult = React.useMemo(() => {
    if (result) return result
    if (responseText && injectedIds) return verifyCitationsLocal(responseText, injectedIds)
    return { valid: [], invalid: [], duplicates: [], total: 0, allCited: [] }
  }, [result, responseText, injectedIds])

  const validCount = verdict.valid.length
  const invalidCount = verdict.invalid.length
  const total = verdict.total
  const hasAny = validCount > 0 || invalidCount > 0

  if (!hasAny) {
    return reserveSpace ? <span className={className} style={style} /> : null
  }

  const allValid = invalidCount === 0
  // Color/theme by verdict class. We inline the colors rather than using
  // CSS vars for the **badge background** because these are
  // translucent overlays that must stay consistent regardless of which
  // theme CSS var is active — a soft green / soft orange pill that reads
  // the same on light and dark.
  const bg = allValid ? 'rgba(46, 139, 87, 0.10)'  : 'rgba(230, 126, 34, 0.12)'
  const border = allValid ? 'rgba(46, 139, 87, 0.45)' : 'rgba(230, 126, 34, 0.55)'
  const textColor = allValid ? 'var(--success, #2e8b57)' : 'var(--warning, #e67e22)'
  const icon = allValid ? '✓' : '⚠️'

  const distinctCount = verdict.allCited.length  // valid ∪ invalid
  const label = allValid
    ? `引用 ${distinctCount} 条全部可验证`
    : `${distinctCount} 条引用中 ${invalidCount} 条为模型幻觉`

  // Tooltip lists the actual numbers so a reader can jump-verify
  const invalidList = verdict.invalid.map(n => `[资料 ${n}]`).join(' ')
  const validList = verdict.valid.map(n => `[资料 ${n}]`).join(' ')
  const tooltip = allValid
    ? `本轮 AI 引用的资料编号：${validList}\n总计出现 ${total} 次（去重后 ${distinctCount} 个编号）。\n全部落在本轮实际注入的范围内。`
    : `本轮 AI 引用的编号中：\n✓ 有效 (${validCount})：${validList || '(无)'}\n✗ 幻觉 (${invalidCount})：${invalidList}\n总出现 ${total} 次。\n标红编号不在本轮实际注入的资料范围内，相关内容可能是模型编造。`

  return (
    <span
      className={className}
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 11,
        background: bg,
        border: `1px solid ${border}`,
        color: textColor,
        fontSize: 10.5,
        fontWeight: 500,
        lineHeight: 1.2,
        cursor: 'help',
        userSelect: 'none',
        letterSpacing: '0.2px',
        ...style,
      }}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </span>
  )
}

export default CitationBadge
