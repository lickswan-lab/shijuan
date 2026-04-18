// Normalize Markdown text so KaTeX can render LaTeX that came from noisy
// sources — in particular the common failure mode where a math expression has
// internal `$` delimiters nesting inside outer ones, e.g.
//
//   $\frac { $\partial$ ^ {k_{1}$ + k_{2}} f} { $\partial$ x^{k_{1}} }$
//
// This happens when upstream producers (GLM OCR output, copied Obsidian notes,
// pasted PDF text) wrap every LaTeX token individually in `$…$` instead of
// wrapping the whole expression once. Remark-math splits on the innermost `$`
// and KaTeX then sees broken fragments and renders them red.
//
// Strategy: conservative whitespace-based heuristic.
//   - Scan line by line (or paragraph by paragraph).
//   - Find runs of tokens containing `$` where the overall `$` count is >= 3
//     AND the content between them contains LaTeX commands (`\something`).
//   - Collapse: keep the outermost pair, remove all inner `$` within that run.
//
// We deliberately do NOT touch:
//   - Balanced `$a$ and $b$` (simple two expressions on one line, even count = 2).
//   - Display math `$$…$$` (separate logic path; rarely suffers nesting).
//   - Code blocks (Markdown fences) — we skip content between ``` fences.

const LATEX_TOKEN = /\\[a-zA-Z]+|[_^]\{|\\[({[]/   // cheap "looks like LaTeX" probe

// Remove all inner `$` in a span that has ≥3 `$`s AND contains LaTeX tokens.
// Example: `$\frac{$\partial$ ^ k}$` → `$\frac{\partial ^ k}$`
function collapseInnerDollars(segment: string): string {
  const dollarCount = (segment.match(/\$/g) || []).length
  if (dollarCount < 3) return segment
  if (!LATEX_TOKEN.test(segment)) return segment
  // Find first and last `$` positions; keep only those, strip the rest.
  const firstIdx = segment.indexOf('$')
  const lastIdx = segment.lastIndexOf('$')
  if (firstIdx === lastIdx) return segment
  const before = segment.slice(0, firstIdx)
  const inside = segment.slice(firstIdx + 1, lastIdx).replace(/\$/g, '')
  const after = segment.slice(lastIdx + 1)
  return `${before}$${inside}$${after}`
}

// Sanitize a single non-code line. Also handles the case where the line is
// almost-but-not-quite a display-math block (all LaTeX, surrounded by unnecessary
// inline `$`s) by converting to `$$…$$` if it's long enough.
function sanitizeLine(line: string): string {
  // Quick skip if no `$`
  if (!line.includes('$')) return line
  return collapseInnerDollars(line)
}

export function sanitizeMath(input: string): string {
  if (!input || !input.includes('$')) return input
  const lines = input.split('\n')
  let inCode = false
  const out: string[] = []
  for (const line of lines) {
    // Preserve ``` code fences untouched — those are code, not math
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      out.push(line)
      continue
    }
    if (inCode) { out.push(line); continue }
    out.push(sanitizeLine(line))
  }
  return out.join('\n')
}
