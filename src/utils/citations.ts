// Citation format exporters. The library already has { title, authors[], year,
// tags[], notes } per entry — enough for minimal BibTeX/RIS records that any
// reference manager (Zotero / EndNote / Mendeley / Paperpile / JabRef) will
// accept and round-trip. Journal / volume / publisher aren't in the data model
// yet; an entry without them falls back to @misc, which is the correct BibTeX
// convention for "item of unclear type."
//
// We deliberately generate BibTeX/RIS in the renderer (not main): it's pure
// string work, zero new IPC, and keeps the main process lean.

import type { LibraryEntry } from '../types/library'

// Turn "Michel Foucault" → "foucault"; keep only ASCII [a-z0-9].
// Citation keys must be ASCII-safe for BibTeX to round-trip cleanly through
// LaTeX / Zotero / JabRef. Chinese names collapse to '' here, in which case
// the caller falls back to 'anon' + year + title word. Full pinyin conversion
// is out of scope — users with lots of Chinese authors can edit keys in
// Zotero after import.
function normalizeForCiteKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '')
}

// Generate a citation key: `lastnameYYYYfirsttitleword`. If no author, use
// first title word. Collisions resolved by suffix a/b/c...
function baseCiteKey(entry: LibraryEntry): string {
  const firstAuthor = entry.authors[0] || ''
  // Chinese-style "张三" vs Western "John Smith" — naive split: last whitespace token
  const tokens = firstAuthor.split(/\s+/).filter(Boolean)
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : firstAuthor
  const lastKey = normalizeForCiteKey(last) || 'anon'
  const year = entry.year ? String(entry.year) : 'nd'
  const titleFirst = (entry.title || '').trim().split(/\s+/)[0] || ''
  const titleKey = normalizeForCiteKey(titleFirst).slice(0, 10)
  return `${lastKey}${year}${titleKey}`
}

// Assign unique keys across the whole export batch.
function assignUniqueKeys(entries: LibraryEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const e of entries) {
    const base = baseCiteKey(e) || 'entry'
    const used = seen.get(base) || 0
    if (used === 0) {
      map.set(e.id, base)
      seen.set(base, 1)
    } else {
      // foo, foo1, foo2 — BibTeX keys must be ASCII-simple
      map.set(e.id, `${base}${String.fromCharCode(96 + used)}`) // a/b/c...
      seen.set(base, used + 1)
    }
  }
  return map
}

// Escape BibTeX value: wrap in {...} (preserves casing + accents) and escape %.
// We skip the more paranoid LaTeX escaping because the common path today is
// "paste into Zotero which will clean it up." Users who need pristine LaTeX
// can post-process in JabRef.
function escapeBibValue(v: string): string {
  return v.replace(/[\\%&$#_]/g, m => `\\${m}`)
}

function bibTypeForEntry(entry: LibraryEntry): string {
  // Heuristic: year + exactly one author → @article-ish; otherwise @misc.
  // We don't have reliable journal info so @misc is the honest default —
  // it's what Zotero falls back to for "unknown type" and won't break import.
  if (entry.year && entry.authors.length > 0) return 'misc'
  return 'misc'
}

export function generateBibTeX(entries: LibraryEntry[]): string {
  if (entries.length === 0) return '% 没有可导出的文献\n'
  const keys = assignUniqueKeys(entries)
  const lines: string[] = []
  lines.push(`% 拾卷导出 ${new Date().toISOString().slice(0, 10)} · ${entries.length} 条文献`)
  lines.push('')
  for (const e of entries) {
    const key = keys.get(e.id) || e.id
    const type = bibTypeForEntry(e)
    const fields: string[] = []
    if (e.title) fields.push(`  title = {${escapeBibValue(e.title)}}`)
    if (e.authors.length > 0) {
      // BibTeX author separator is " and "
      fields.push(`  author = {${e.authors.map(escapeBibValue).join(' and ')}}`)
    }
    if (e.year) fields.push(`  year = {${e.year}}`)
    if (e.tags.length > 0) fields.push(`  keywords = {${e.tags.map(escapeBibValue).join(', ')}}`)
    if (e.notes?.trim()) fields.push(`  note = {${escapeBibValue(e.notes.trim())}}`)
    // Local path as file field — Zotero + JabRef both respect this. Use forward
    // slashes even on Windows since BibTeX prefers them.
    if (e.absPath) fields.push(`  file = {${e.absPath.replace(/\\/g, '/')}}`)
    lines.push(`@${type}{${key},`)
    lines.push(fields.join(',\n'))
    lines.push('}')
    lines.push('')
  }
  return lines.join('\n')
}

export function generateRIS(entries: LibraryEntry[]): string {
  if (entries.length === 0) return ''
  const lines: string[] = []
  for (const e of entries) {
    // TY - type. GEN (generic) is the RIS equivalent of BibTeX's @misc.
    lines.push('TY  - GEN')
    if (e.title) lines.push(`TI  - ${e.title}`)
    for (const a of e.authors) lines.push(`AU  - ${a}`)
    if (e.year) lines.push(`PY  - ${e.year}`)
    for (const t of e.tags) lines.push(`KW  - ${t}`)
    if (e.notes?.trim()) {
      // Multiline notes: RIS allows N1 to repeat
      for (const line of e.notes.trim().split(/\r?\n/)) {
        lines.push(`N1  - ${line}`)
      }
    }
    if (e.absPath) lines.push(`L1  - ${e.absPath}`)
    lines.push('ER  - ')
    lines.push('')
  }
  return lines.join('\n')
}
