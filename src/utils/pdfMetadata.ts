// ===== PDF metadata extraction (renderer-side, uses pdfjs-dist dynamic import) =====
// Called by libraryStore after import to enrich entry title/authors/year from the PDF's
// internal Info dictionary. Failures are silent — we just keep the filename-based title.

export interface ExtractedPdfMetadata {
  title?: string
  author?: string  // may be "Last, First" or "Name1, Name2"
  year?: number
}

// Parse PDF date strings like "D:20231015143000+08'00'" → 2023
function parseYearFromPdfDate(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = s.match(/D?:?(\d{4})/)
  if (!m) return undefined
  const y = parseInt(m[1], 10)
  return y > 1900 && y < 2100 ? y : undefined
}

function cleanStr(s: string | undefined | null): string | undefined {
  if (!s) return undefined
  // PDF Info strings sometimes contain UTF-16 BOM, null bytes, or look like
  // garbage binary. Filter those.
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!cleaned) return undefined
  // Heuristic: if more than half the chars are non-printable / weird, reject
  const printable = cleaned.replace(/[^\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '')
  if (printable.length < cleaned.length * 0.5) return undefined
  return cleaned
}

export async function extractPdfMetadata(absPath: string): Promise<ExtractedPdfMetadata | null> {
  try {
    const buf = await window.electronAPI.readFileBuffer(absPath)
    // Dynamically import pdfjs so metadata extraction doesn't bloat the main chunk.
    const pdfjs = await import('pdfjs-dist')
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
    const meta: any = await pdf.getMetadata()
    const info = meta?.info || {}

    const title = cleanStr(info.Title)
    const author = cleanStr(info.Author)
    const year = parseYearFromPdfDate(info.CreationDate) ?? parseYearFromPdfDate(info.ModDate)

    // Clean up pdf document to release memory
    try { await pdf.destroy() } catch {}

    if (!title && !author && !year) return null
    return { title, author, year }
  } catch {
    return null
  }
}
