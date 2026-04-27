// Citation reverse-parse verifier (Wave-4) — backend companion to
// src/components/Agent/personaCitationParse.ts.
//
// Why a backend verifier when the frontend already has parseCitations?
//   1) Prompt-hardening guard: after the AI response arrives, we may want to
//      auto-append a warning like "模型引用了不存在的资料编号 {list}" to the
//      saved message. That post-processing belongs on the backend so both the
//      UI summary *and* any server-side persistence stay consistent.
//   2) IPC boundary: exposing ai-verify-citations lets non-persona flows (e.g.
//      agent tools, apprentice reflections) reuse the same verdict logic
//      without importing renderer-side React modules.
//   3) Single source of truth for the citation regex — if we ever add new
//      citation styles ([Source N], [Ref N], etc.), we update once here.
//
// The regex must match the same sloppy variants the frontend's
// personaCitationParse.ts handles:
//   [资料 1] [资料1] 【资料 1】 【资料1】 [资料 1, 2] [资料 1、2、3] [资料1-3]
// and English-style:
//   [Source 1] [source 2] [Ref 3]

import { ipcMain } from 'electron'

// Combined regex covering Chinese 资料 + English Source/source/Ref variants.
// Each match captures the raw number list in group 1.
// Kept as two alternatives joined by | so the character classes stay simple.
// BUG-FIX R8#1 · char class 里 ~~ 是重复(R1 观察项),清成 ~
const CITATION_REGEX_CN = /[\[【]\s*资料\s*([\d,，、\s\-–~]+)\s*[\]】]/g
const CITATION_REGEX_EN = /\[\s*(?:Source|source|SOURCE|Ref|ref|REF)\s*([\d,\s\-–~]+)\s*\]/g

// Expand "1, 2, 3-5" → [1, 2, 3, 4, 5]. Deduped + sorted.
// Caps ranges at +50 from the low end to avoid pathological inflation.
function expandNumberList(raw: string): number[] {
  const out = new Set<number>()
  const parts = raw.split(/[,，、\s]+/).filter(Boolean)
  for (const p of parts) {
    const range = p.match(/^(\d+)\s*[\-–~]\s*(\d+)$/)
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
  /** Citation numbers that match injectedIds. Each N listed once, in ascending order. */
  valid: number[]
  /** Citation numbers NOT in injectedIds (AI hallucinated or miscounted). */
  invalid: number[]
  /** Subset of all cited Ns that appeared more than once (generally ignorable). */
  duplicates: number[]
  /** Total citation token occurrences (counts every bracket, not distinct Ns).
   *  Matches what a reader would see: if [资料 1] appears 3 times and [资料 2]
   *  appears 1 time, total = 4. */
  total: number
  /** Distinct citation numbers the AI emitted (both valid + invalid). */
  allCited: number[]
}

/** Verify citations in an AI response against the chunk IDs actually injected
 *  this turn.
 *
 *  @param aiResponse - raw text from the LLM (streamed or full)
 *  @param injectedIds - array of 1-based N's that were in the system prompt
 *                       (e.g. [1,2,3,4,5] when 5 chunks were injected)
 *
 *  @returns CitationVerifyResult — valid/invalid/duplicates/total/allCited.
 *           Returns all-zeros if no citations found.
 */
export function verifyCitations(
  aiResponse: string,
  injectedIds: number[],
): CitationVerifyResult {
  const empty: CitationVerifyResult = { valid: [], invalid: [], duplicates: [], total: 0, allCited: [] }
  if (!aiResponse || typeof aiResponse !== 'string') return empty

  const injected = new Set(injectedIds || [])
  const occurrences = new Map<number, number>()

  // Run both regexes independently. Group-1 semantics are the same: raw number list.
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

/** Given a verify result, produce an optional trailing warning string to
 *  append to the AI response. Returns empty string when there's nothing to
 *  warn about. Used by Wave-4 bonus #6 to auto-annotate hallucinated cites.
 */
export function buildCitationWarning(result: CitationVerifyResult): string {
  if (!result.invalid.length) return ''
  const list = result.invalid.map(n => `[资料 ${n}]`).join(' ')
  return `\n\n> ⚠️ 模型引用了不存在的资料编号 ${list}；相关内容可能是编造，请核对。`
}

// ===== IPC =====

export function registerCitationVerifierIpc(): void {
  ipcMain.handle(
    'ai-verify-citations',
    async (
      _event,
      responseText: string,
      injectedIds: number[],
    ): Promise<{ success: boolean; result?: CitationVerifyResult; warning?: string; error?: string }> => {
      try {
        const result = verifyCitations(responseText || '', Array.isArray(injectedIds) ? injectedIds : [])
        return { success: true, result, warning: buildCitationWarning(result) }
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) }
      }
    },
  )
}
