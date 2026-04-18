// Minimal BibTeX parser. Zotero / JabRef / EndNote / Mendeley all export in
// a fairly regular subset of BibTeX — no @string abbreviations, no @comment
// macros, no LaTeX math in fields. We target that subset.
//
// Not targeted: @string macro expansion, #-concatenation, complex LaTeX
// escaping in values (we do basic {...} unwrapping and whitespace normalization).
//
// Input: full text of a .bib file
// Output: { entries: ParsedBibEntry[], errors: ParseError[] }

export interface ParsedBibEntry {
  type: string               // 'article', 'book', 'misc', ...
  citeKey: string            // the ID inside the braces
  fields: Record<string, string>  // normalized field values (lowercased keys)
}

export interface ParseError {
  message: string
  position: number          // character offset into input
  snippet: string           // 40 char window around the error for diagnostics
}

export interface BibParseResult {
  entries: ParsedBibEntry[]
  errors: ParseError[]
}

// Strip enclosing {braces} or "quotes", collapse whitespace, unescape common LaTeX.
// We don't do full LaTeX decoding — that's a rabbit hole. We just make values readable.
function cleanValue(raw: string): string {
  let s = raw.trim()
  // Strip one layer of outer braces or quotes
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1)
  }
  // Flatten inner braces used for capitalization protection: {Foo} → Foo
  s = s.replace(/\{([^{}]*)\}/g, '$1')
  // Common LaTeX escapes we can undo safely
  s = s
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    .replace(/\\_/g, '_')
    .replace(/\\\\/g, '\\')
    .replace(/~/g, ' ')            // BibTeX non-breaking space
    .replace(/--/g, '–')           // en dash
    .replace(/---/g, '—')          // em dash
  // Collapse runs of whitespace (incl. newlines) to single space
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// Split a BibTeX `author` field ("Foo Bar and Baz Qux and ..." → ["Foo Bar", "Baz Qux"]).
// Skip empty and placeholder entries.
export function splitAuthors(authorField: string): string[] {
  if (!authorField) return []
  return authorField
    .split(/\s+and\s+/i)
    .map(a => a.trim())
    .filter(a => a && a.toLowerCase() !== 'others')
}

// Parse keywords field: comma- or semicolon-separated.
export function splitKeywords(kwField: string): string[] {
  if (!kwField) return []
  return kwField.split(/[,;]/).map(k => k.trim()).filter(Boolean)
}

// Parse year: most fields are "2021" but some are "2021-03" or "{2021}".
export function parseYear(yearField: string): number | undefined {
  if (!yearField) return undefined
  const m = yearField.match(/\b(1[5-9]\d{2}|2[0-1]\d{2})\b/)   // 1500–2199
  return m ? parseInt(m[1], 10) : undefined
}

// Extract local file path from BibTeX `file` field. Zotero format:
//   file = {Full Paper:C\:/Users/.../file.pdf:application/pdf}
// JabRef format:
//   file = {:C\:/Users/.../file.pdf:PDF}
// Simple format:
//   file = {/path/to/file.pdf}
// We split by ':' and pick the longest segment that looks like a path.
export function extractFilePath(fileField: string): string | null {
  if (!fileField) return null
  // Handle escaped colons on Windows: \:
  const normalized = fileField.replace(/\\:/g, '§COLON§')
  const segments = normalized.split(':').map(s => s.replace(/§COLON§/g, ':'))
  // Find segment that contains a path separator or drive letter
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed) continue
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed.replace(/\\/g, '/')   // Windows abs
    if (trimmed.startsWith('/')) return trimmed                                 // Unix abs
    if (trimmed.includes('/') && /\.(pdf|epub|djvu|docx?|html?|txt|md)$/i.test(trimmed)) {
      return trimmed
    }
  }
  return null
}

// The tokenizer walks the file left-to-right. Each entry starts with '@type{'
// followed by `key,` then a sequence of `field = value,` pairs, then `}`.
// Comments (%), whitespace, and blank lines outside entries are skipped.
export function parseBibTeX(input: string): BibParseResult {
  const entries: ParsedBibEntry[] = []
  const errors: ParseError[] = []
  let i = 0
  const n = input.length

  const snippetAt = (pos: number) => {
    const start = Math.max(0, pos - 20)
    const end = Math.min(n, pos + 20)
    return input.slice(start, end).replace(/\s+/g, ' ')
  }

  // Skip whitespace and %-line-comments
  const skipWs = () => {
    while (i < n) {
      const c = input[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
      if (c === '%') {
        while (i < n && input[i] !== '\n') i++
        continue
      }
      break
    }
  }

  // Read a {...} or "..." balanced value starting at the current char.
  // Returns the raw value string including the opening/closing delimiter so
  // cleanValue can strip it. Throws on unbalanced braces (caller catches).
  const readValue = (): string => {
    const start = i
    const c = input[i]
    if (c === '{') {
      let depth = 0
      while (i < n) {
        if (input[i] === '{') depth++
        else if (input[i] === '}') {
          depth--
          if (depth === 0) { i++; return input.slice(start, i) }
        }
        i++
      }
      throw new Error('未闭合的 {')
    }
    if (c === '"') {
      i++  // skip opening "
      while (i < n) {
        if (input[i] === '\\') { i += 2; continue }
        if (input[i] === '"') { i++; return input.slice(start, i) }
        i++
      }
      throw new Error('未闭合的 "')
    }
    // Bare value (number or reference): read until , } \n
    while (i < n && !',}\n'.includes(input[i])) i++
    return input.slice(start, i)
  }

  while (i < n) {
    skipWs()
    if (i >= n) break
    if (input[i] !== '@') {
      // Unknown top-level char — skip to next @ or end
      i++
      continue
    }
    const entryStart = i
    i++  // skip @

    // Read type: letters only
    const typeStart = i
    while (i < n && /[a-zA-Z]/.test(input[i])) i++
    const type = input.slice(typeStart, i).toLowerCase()
    if (!type) {
      errors.push({ message: '期望 @ 后跟类型', position: entryStart, snippet: snippetAt(entryStart) })
      continue
    }
    // Skip @string/@preamble/@comment — we don't support string macros or
    // preamble LaTeX, but silently skipping keeps the rest parseable
    if (type === 'string' || type === 'preamble' || type === 'comment') {
      // Skip to matching closing }
      skipWs()
      if (input[i] === '{') {
        let depth = 0
        while (i < n) {
          if (input[i] === '{') depth++
          else if (input[i] === '}') { depth--; if (depth === 0) { i++; break } }
          i++
        }
      }
      continue
    }

    skipWs()
    if (input[i] !== '{') {
      errors.push({ message: `@${type} 后缺少 {`, position: i, snippet: snippetAt(i) })
      continue
    }
    i++  // skip {

    // Read citeKey until ,
    skipWs()
    const keyStart = i
    while (i < n && input[i] !== ',' && input[i] !== '}' && input[i] !== '\n') i++
    const citeKey = input.slice(keyStart, i).trim()
    if (!citeKey) {
      errors.push({ message: `@${type} 缺少 cite key`, position: keyStart, snippet: snippetAt(keyStart) })
      // Try to recover: skip to matching }
      let depth = 1
      while (i < n && depth > 0) {
        if (input[i] === '{') depth++
        else if (input[i] === '}') depth--
        i++
      }
      continue
    }
    if (input[i] === ',') i++

    // Read fields until closing }
    const fields: Record<string, string> = {}
    let entryClosed = false
    while (i < n) {
      skipWs()
      if (input[i] === '}') { i++; entryClosed = true; break }
      if (input[i] === ',') { i++; continue }   // trailing comma between fields

      // Read field name
      const nameStart = i
      while (i < n && /[a-zA-Z0-9_-]/.test(input[i])) i++
      const name = input.slice(nameStart, i).toLowerCase()
      if (!name) {
        errors.push({ message: '期望字段名', position: nameStart, snippet: snippetAt(nameStart) })
        // Skip to next , or }
        while (i < n && input[i] !== ',' && input[i] !== '}') i++
        continue
      }

      skipWs()
      if (input[i] !== '=') {
        errors.push({ message: `字段 ${name} 后缺少 =`, position: i, snippet: snippetAt(i) })
        while (i < n && input[i] !== ',' && input[i] !== '}') i++
        continue
      }
      i++  // skip =

      skipWs()
      try {
        const rawValue = readValue()
        fields[name] = cleanValue(rawValue)
      } catch (e: any) {
        errors.push({ message: `字段 ${name} 值解析失败: ${e.message}`, position: i, snippet: snippetAt(i) })
        // Try to skip to next , or }
        while (i < n && input[i] !== ',' && input[i] !== '}') i++
      }

      skipWs()
      if (input[i] === ',') { i++; continue }
      if (input[i] === '}') { i++; entryClosed = true; break }
    }

    if (!entryClosed) {
      errors.push({ message: `@${type}{${citeKey}} 未正常闭合`, position: i, snippet: snippetAt(i) })
    }

    entries.push({ type, citeKey, fields })
  }

  return { entries, errors }
}
