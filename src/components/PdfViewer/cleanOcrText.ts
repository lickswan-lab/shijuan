// Clean OCR text for display: handle LaTeX, superscripts, circled numbers
export function cleanOcrText(raw: string): string {
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
  const superDigits: Record<string, string> = {
    '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'
  }
  const toSuper = (s: string) => s.split('').map(c => superDigits[c] || c).join('')

  return raw
    .replace(/\$\s*\\\\?textcircled\{(\d+)\}\s*\$/g, (_m, n) => circled[parseInt(n)-1] || `(${n})`)
    .replace(/\$\s*\^?\s*\{?\s*\((\d+)\)\s*\}?\s*\$/g, (_m, n) => `⁽${toSuper(n)}⁾`)
    .replace(/\$\s*\^\s*\{(\d+)\}\s*\$/g, (_m, n) => toSuper(n))
    .replace(/\$\s*\^\s*\{?\s*\\circ\s*\}?\s*\$/g, '°')
    .replace(/\$\s*_\s*\{([^}]+)\}\s*\$/g, (_m, t) => t)
    .replace(/!\[[^\]]*\]\(page=\d+,\s*bbox=\[[^\]]*\]\)/g, '')
    .replace(/!\[\]\([^)]*\)/g, '')
    .replace(/\^{?\{(\d+)\}?}/g, (_m, n) => toSuper(n))
    .replace(/\^(\d{1,3})(?=\D|$)/g, (_m, n) => toSuper(n))
    .replace(/^(.*?)(\\(?:frac|partial|sqrt|sum|int|prod|lim|nabla|vec|hat|bar|overline|underline)\s*\{[^}]{0,200}\}(?:\s*\{[^}]{0,200}\})*(?:\s*[,，.。])?)/gm, (full, before, latex) => {
      const dollarsBefore = (before.match(/\$/g) || []).length
      if (dollarsBefore % 2 === 1) return full
      return `${before} $${latex.trim()}$ `
    })
    .replace(/(?<!\$)\\(partial|alpha|beta|gamma|delta|epsilon|theta|lambda|mu|sigma|omega|pi|phi|psi|infty|cdot|times|div|pm|mp|leq|geq|neq|approx|equiv|forall|exists)(?=[^a-zA-Z])/g, (match) => {
      return ` $${match}$ `
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
