// Citation reverse-parse — find [资料 N] markers in AI output and map back
// to the chunks that were actually injected.
//
// Why a separate module:
//   - LLM is sloppy: emits [资料1], [资料 1], [资料 1, 2], 【资料 1】, 资料1
//     all interchangeably. Need one normalize regex everyone uses.
//   - Hallucination check: if AI cites [资料 99] but only 5 were injected,
//     flag it as a fake citation rather than silently rendering an empty card.
//   - Reusable: distillation flow could later use the same parsing if we ever
//     ask AI to cite during dimension synthesis.

export interface InjectedChunk {
  n: number
  sourceId: string
  sourceTitle: string
  sourceType: string
  trust: string
  chunkIdx: number
  text: string
  url?: string
}

export interface ParsedCitation {
  n: number
  chunk: InjectedChunk | null  // null = AI cited a number that wasn't injected (hallucinated)
  occurrences: number          // how many times this N appeared in the text
}

// Match all the dirty variants AI emits in the wild.
// Examples that match:
//   [资料 1] [资料1] 【资料 1】 【资料1】 [资料 1, 2] [资料 1、2、3] [资料1-3]
// Doesn't match (intentional):
//   bare "资料 1" without brackets — too noisy, would match prose like "这份资料 1 个月后…"
const CITATION_REGEX = /[\[【]\s*资料\s*([\d,，、\s\-–~~]+)\s*[\]】]/g

// Expand "1, 2, 3-5" → [1, 2, 3, 4, 5]. Returns deduped sorted ints.
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
        // Cap at 50 to avoid pathological "[资料 1-9999]" inflation
        for (let i = lo; i <= Math.min(hi, lo + 50); i++) out.add(i)
      }
    } else {
      const n = parseInt(p, 10)
      if (Number.isFinite(n)) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}

// Parse AI output → list of cited Ns + occurrence counts.
// `injected` is the chunk array passed to the AI (so we can map N → chunk
// and detect hallucinated numbers).
export function parseCitations(text: string, injected: InjectedChunk[]): ParsedCitation[] {
  if (!text) return []
  const counts = new Map<number, number>()
  CITATION_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CITATION_REGEX.exec(text)) !== null) {
    const ns = expandNumberList(m[1])
    for (const n of ns) counts.set(n, (counts.get(n) || 0) + 1)
  }
  const byN = new Map(injected.map(c => [c.n, c]))
  const result: ParsedCitation[] = []
  for (const [n, occ] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    result.push({ n, chunk: byN.get(n) || null, occurrences: occ })
  }
  return result
}

// Normalize sloppy citation forms in the text itself so the rendered markdown
// looks consistent. Run before passing to ReactMarkdown. Idempotent.
//   "[资料1]"  → "[资料 1]"
//   "【资料 2】" → "[资料 2]"
//   "[资料 1, 2]" → "[资料 1] [资料 2]"  (split into individual marks for cleaner rendering)
export function normalizeCitations(text: string): string {
  if (!text) return text
  return text.replace(CITATION_REGEX, (_match, raw) => {
    const ns = expandNumberList(raw)
    if (ns.length === 0) return _match
    return ns.map(n => `[资料 ${n}]`).join(' ')
  })
}
