import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import Markdown from 'react-markdown'
import 'react-pdf/dist/esm/Page/TextLayer.css'
import 'react-pdf/dist/esm/Page/AnnotationLayer.css'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

// Clean OCR text for display
function cleanOcrText(raw: string): string {
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
  const superDigits: Record<string, string> = {
    '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'
  }
  const toSuper = (s: string) => s.split('').map(c => superDigits[c] || c).join('')

  return raw
    // \textcircled{N} → circled number
    .replace(/\$\s*\\\\?textcircled\{(\d+)\}\s*\$/g, (_m, n) => circled[parseInt(n)-1] || `(${n})`)
    // $^{(15)}$ or $^{15}$ or $ ^{(15)} $ → superscript: ⁽¹⁵⁾
    .replace(/\$\s*\^?\s*\{?\s*\((\d+)\)\s*\}?\s*\$/g, (_m, n) => `⁽${toSuper(n)}⁾`)
    .replace(/\$\s*\^\s*\{(\d+)\}\s*\$/g, (_m, n) => toSuper(n))
    .replace(/\$\s*\^\s*\{?\s*\\circ\s*\}?\s*\$/g, '°')
    // $_{text}$ → subscript (just keep the text)
    .replace(/\$\s*_\s*\{([^}]+)\}\s*\$/g, (_m, t) => t)
    // Remove image bbox references
    .replace(/!\[[^\]]*\]\(page=\d+,\s*bbox=\[[^\]]*\]\)/g, '')
    .replace(/!\[\]\([^)]*\)/g, '')
    // Remaining LaTeX: try to extract readable content, or remove
    .replace(/\$([^$]{1,80})\$/g, (_m, inner) => {
      // If it's mostly normal text with minor LaTeX, extract text
      const cleaned = inner
        .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
        .replace(/\\textit\{([^}]+)\}/g, '*$1*')
        .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
        .replace(/\\\\/g, '')
        .replace(/[\\{}^_]/g, '')
        .trim()
      return cleaned || ''
    })
    // Clean up excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Highlight annotated text in the rendered DOM
function useAnnotationHighlights(
  containerRef: React.RefObject<HTMLDivElement | null>,
  annotations: Array<{ id: string; selectedText: string }>,
  onAnnotationClick: (id: string) => void,
  deps: unknown[]
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function applyHighlights() {
      try {
        // Remove all existing annotation DOM elements
        container!.querySelectorAll('.ocr-ann-marker, .ocr-ann-underline').forEach(el => {
          try {
            if (el.classList.contains('ocr-ann-underline')) {
              const parent = el.parentNode
              if (parent) {
                while (el.firstChild) parent.insertBefore(el.firstChild, el)
                parent.removeChild(el)
              }
            } else {
              el.parentNode?.removeChild(el)
            }
          } catch { /* skip */ }
        })
        try { container!.normalize() } catch {}

        if (annotations.length === 0) return

        const targets = annotations
          .filter(a => a.selectedText && a.selectedText.length >= 4)
          .sort((a, b) => b.selectedText.length - a.selectedText.length)
        if (targets.length === 0) return

        const walker = document.createTreeWalker(container!, NodeFilter.SHOW_TEXT)
        const textNodes: Text[] = []
        while (walker.nextNode()) textNodes.push(walker.currentNode as Text)

        for (const target of targets) {
          const searchText = target.selectedText.replace(/\s+/g, ' ').trim()
          if (searchText.length < 4) continue

          for (let ni = 0; ni < textNodes.length; ni++) {
            const node = textNodes[ni]
            if (!node.parentNode || !node.isConnected) continue
            if ((node.parentNode as HTMLElement).classList?.contains('ocr-ann-underline')) continue

            const nodeText = node.textContent || ''
            const normalizedNodeText = nodeText.replace(/\s+/g, ' ')
            const idx = normalizedNodeText.indexOf(searchText)
            if (idx === -1) continue

            let origIdx = 0, normIdx = 0
            while (normIdx < idx && origIdx < nodeText.length) {
              if (/\s/.test(nodeText[origIdx])) {
                while (origIdx < nodeText.length && /\s/.test(nodeText[origIdx])) origIdx++
                normIdx++
              } else { origIdx++; normIdx++ }
            }
            const startIdx = origIdx

            let endOrigIdx = startIdx, endNormIdx = normIdx
            while (endNormIdx < normIdx + searchText.length && endOrigIdx < nodeText.length) {
              if (/\s/.test(nodeText[endOrigIdx])) {
                while (endOrigIdx < nodeText.length && /\s/.test(nodeText[endOrigIdx])) endOrigIdx++
                endNormIdx++
              } else { endOrigIdx++; endNormIdx++ }
            }

            try {
              const before = nodeText.substring(0, startIdx)
              const match = nodeText.substring(startIdx, endOrigIdx)
              const after = nodeText.substring(endOrigIdx)
              const parent = node.parentNode!

              const underline = document.createElement('span')
              underline.className = 'ocr-ann-underline'
              underline.dataset.annotationId = target.id
              underline.textContent = match

              const marker = document.createElement('span')
              marker.className = 'ocr-ann-marker'
              marker.title = '已注释 · 点击查看'
              marker.dataset.annotationId = target.id
              marker.onclick = (ev) => { ev.stopPropagation(); onAnnotationClick(target.id) }

              if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling)
              parent.insertBefore(underline, node.nextSibling)
              parent.insertBefore(marker, underline)
              if (before) { node.textContent = before } else { parent.removeChild(node) }

              textNodes.splice(ni, 1)
            } catch { /* DOM changed, skip this target */ }
            break
          }
        }
      } catch { /* entire highlight pass failed, ignore */ }
    }

    const raf = requestAnimationFrame(() => applyHighlights())
    return () => cancelAnimationFrame(raf)
  }, deps)
}

// OCR Content component with per-page sections and markdown rendering
function OcrContent({ text, annotations, onAnnotationClick }: {
  text: string
  annotations: Array<{ id: string; selectedText: string }>
  onAnnotationClick: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cleaned = useMemo(() => cleanOcrText(text), [text])

  // Split by page markers if present: "=== 第 N 页 ==="
  const hasPageMarkers = /=== 第 \d+ 页 ===/.test(cleaned)
  const sections = hasPageMarkers
    ? cleaned.split(/\n*=== 第 \d+ 页 ===\n*/).filter(Boolean)
    : [cleaned]

  // Highlight annotations after render
  useAnnotationHighlights(containerRef, annotations, onAnnotationClick, [cleaned, annotations])

  return (
    <div className="ocr-markdown-content" ref={containerRef}>
      {sections.map((pageText, i) => (
        <div key={i} style={{ marginBottom: 28 }}>
          {sections.length > 1 && (
            <div style={{
              fontSize: 12, color: '#bbb', marginBottom: 10,
              paddingBottom: 6, borderBottom: '1px solid #eee',
              fontFamily: '-apple-system, "Microsoft YaHei", sans-serif'
            }}>
              — 第 {i + 1} 页 —
            </div>
          )}
          <Markdown
            components={{
              img: ({ src, alt }) => {
                // Hide bbox image references
                if (src && (src.includes('bbox') || src.includes('page='))) return null
                return <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: 4, margin: '8px 0' }} />
              }
            }}
          >
            {pageText.trim()}
          </Markdown>
        </div>
      ))}
    </div>
  )
}

// HTML viewer: uses iframe for proper rendering + postMessage for text selection
function HtmlViewer({ absPath, onTextSelect }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Listen for text selection messages from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'text-selection' && e.data.text) {
        onTextSelect({
          pageNumber: 1,
          text: e.data.text,
          startOffset: 0,
          endOffset: e.data.text.length,
        })
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onTextSelect])

  // Load HTML and inject selection script
  useEffect(() => {
    if (!iframeRef.current) return
    window.electronAPI.readFileBuffer(absPath).then(buf => {
      const decoder = new TextDecoder('utf-8')
      let html = decoder.decode(buf)

      // Inject a small script before </body> to capture text selection
      const selectionScript = `
<script>
document.addEventListener('mouseup', function() {
  var sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    var text = sel.toString().trim();
    if (text && text.length >= 2) {
      window.parent.postMessage({ type: 'text-selection', text: text }, '*');
    }
  }
});
</script>`

      if (html.includes('</body>')) {
        html = html.replace('</body>', selectionScript + '</body>')
      } else {
        html += selectionScript
      }

      iframeRef.current!.srcdoc = html
    }).catch(() => {
      if (iframeRef.current) iframeRef.current.srcdoc = '<p>无法加载文件</p>'
    })
  }, [absPath])

  return (
    <iframe
      ref={iframeRef}
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
      sandbox="allow-scripts allow-same-origin"
    />
  )
}

// EPUB viewer using epub.js
function EpubViewer({ absPath, onTextSelect }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bookRef = useRef<any>(null)
  const renditionRef = useRef<any>(null)

  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false

    async function loadEpub() {
      const ePub = (await import('epubjs')).default
      const buf = await window.electronAPI.readFileBuffer(absPath)
      const book = ePub(buf.buffer)
      bookRef.current = book

      if (destroyed || !containerRef.current) return

      const rendition = book.renderTo(containerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'scrolled-doc',
      })
      renditionRef.current = rendition

      rendition.themes.default({
        body: { 'font-family': '"Noto Serif SC", "Source Han Serif", Georgia, serif', 'line-height': '2', 'max-width': '760px', 'margin': '0 auto', 'padding': '24px 32px' },
        'h1,h2,h3': { 'font-family': '-apple-system, "Microsoft YaHei", sans-serif' },
      })

      // Capture text selection
      rendition.on('selected', (cfiRange: string, contents: any) => {
        const sel = contents?.window?.getSelection()
        if (sel) {
          const text = sel.toString().trim()
          if (text && text.length >= 2) {
            onTextSelect({ pageNumber: 1, text, startOffset: 0, endOffset: text.length })
          }
        }
      })

      await rendition.display()
    }

    loadEpub().catch(err => console.error('[epub] Load error:', err))

    return () => {
      destroyed = true
      if (renditionRef.current) try { renditionRef.current.destroy() } catch {}
      if (bookRef.current) try { bookRef.current.destroy() } catch {}
    }
  }, [absPath, onTextSelect])

  return <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'auto', background: '#fff' }} />
}

// DOCX viewer: convert to HTML using mammoth
function DocxViewer({ absPath, onTextSelect }: {
  absPath: string
  onTextSelect: (sel: { pageNumber: number; text: string; startOffset: number; endOffset: number } | null) => void
}) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function convert() {
      try {
        const mammoth = await import('mammoth')
        const buf = await window.electronAPI.readFileBuffer(absPath)
        const result = await mammoth.convertToHtml({ arrayBuffer: buf.buffer })
        setHtml(result.value)
      } catch (err: any) {
        setError(err.message)
      }
    }
    convert()
  }, [absPath])

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString().trim()
    if (text && text.length >= 2) {
      onTextSelect({ pageNumber: 1, text, startOffset: 0, endOffset: text.length })
    }
  }, [onTextSelect])

  if (error) return <div className="empty-state"><span>DOCX 解析失败：{error}</span></div>
  if (!html) return <div className="empty-state"><span className="loading-spinner" /><span>正在转换 DOCX...</span></div>

  return (
    <div
      onMouseUp={handleMouseUp}
      style={{ maxWidth: 800, margin: '0 auto', padding: '32px 40px 80px', fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit', lineHeight: 2, fontFamily: 'var(--font-serif)' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// Simple text file reader
function TextFileContent({ absPath }: { absPath: string }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    window.electronAPI.readFileBuffer(absPath).then(buf => {
      const decoder = new TextDecoder('utf-8')
      setText(decoder.decode(buf))
    }).catch(() => setText('无法读取文件'))
  }, [absPath])

  if (!text) return <div style={{ color: 'var(--text-muted)' }}>加载中...</div>
  return (
    <div className="ocr-markdown-content" style={{ fontSize: 14, lineHeight: 2 }}>
      <Markdown>{text}</Markdown>
    </div>
  )
}

type ViewMode = 'pdf' | 'ocr'

export default function PdfViewer() {
  const { currentEntry, currentPdfMeta, updatePdfMeta, updateEntry } = useLibraryStore()
  const { setTextSelection, setActiveAnnotation, glmApiKeyStatus } = useUiStore()
  const [numPages, setNumPages] = useState(0)
  const [scale, setScale] = useState(1.0)
  const [pdfFileUrl, setPdfFileUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [ocrProgress, setOcrProgress] = useState<{ status: string } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('pdf')
  const [ocrFullText, setOcrFullText] = useState<string | null>(null)
  const [ocrFilePath, setOcrFilePath] = useState<string | null>(null)
  const [ocrFontSize, setOcrFontSize] = useState(16)
  const [ocrFontWeight, setOcrFontWeight] = useState(400)
  const [ocrColorDepth, setOcrColorDepth] = useState(80)
  const [ocrBgHue, setOcrBgHue] = useState(40)       // hue: 0-360
  const [ocrBgSat, setOcrBgSat] = useState(30)       // saturation: 0-100
  const [ocrBgLight, setOcrBgLight] = useState(97)    // lightness: 85-100
  const scrollRef = useRef<HTMLDivElement>(null)

  const absPath = currentEntry?.absPath || ''
  const fileExt = absPath.split('.').pop()?.toLowerCase() || ''
  const isPdf = fileExt === 'pdf'
  const isHtml = ['html', 'htm'].includes(fileExt)
  const isText = ['txt', 'md'].includes(fileExt)
  const isOtherDoc = ['docx', 'doc', 'epub'].includes(fileExt)
  const [htmlContent, setHtmlContent] = useState<string | null>(null)

  // Load PDF as file URL + check existing OCR
  useEffect(() => {
    if (!currentEntry) {
      setPdfFileUrl(null); setNumPages(0); setLoadError(null)
      setOcrFullText(null); setOcrFilePath(null); setViewMode('pdf')
      return
    }

    setLoadError(null)
    setHtmlContent(null)

    const fileUrl = 'file:///' + currentEntry.absPath.replace(/\\/g, '/')
    setPdfFileUrl(fileUrl)
    if (scrollRef.current) scrollRef.current.scrollTop = 0

    // Load HTML content for HTML files
    const ext = currentEntry.absPath.split('.').pop()?.toLowerCase() || ''
    if (['html', 'htm'].includes(ext)) {
      window.electronAPI.readFileBuffer(currentEntry.absPath).then(buf => {
        const decoder = new TextDecoder('utf-8')
        setHtmlContent(decoder.decode(buf))
      }).catch(() => setHtmlContent(null))
    }

    // Check for existing OCR text file, default to OCR view if available (PDF only)
    window.electronAPI.readOcrText(currentEntry.absPath).then((result) => {
      if (result.exists && result.text) {
        setOcrFullText(result.text)
        setOcrFilePath(result.path)
        // Only auto-switch to OCR for PDF files; HTML/text render natively
        if (ext === 'pdf') setViewMode('ocr')
        else setViewMode('pdf')
      } else {
        setOcrFullText(null)
        setOcrFilePath(null)
        setViewMode('pdf')
      }
    })
  }, [currentEntry?.id])

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n)
  }, [])

  const onDocumentLoadError = useCallback((err: Error) => {
    setLoadError('PDF 解析失败: ' + err.message)
  }, [])

  // ===== OCR: Send entire PDF file to GLM-OCR =====
  const handleOcr = useCallback(async () => {
    if (!currentPdfMeta || !currentEntry) return
    if (glmApiKeyStatus !== 'set') { alert('请先在设置中填入 GLM API Key'); return }
    setOcrProgress({ status: '正在上传 PDF 并识别文字...' })

    try {
      const result = await window.electronAPI.glmOcrPdf(currentEntry.absPath)

      if (result.success && result.text) {
        // Build text with page markers if we have per-page data
        let textToSave = result.text
        if (result.pageTexts && result.pageTexts.length > 1) {
          textToSave = result.pageTexts
            .map((t, i) => `=== 第 ${i + 1} 页 ===\n\n${t}`)
            .join('\n\n')
        }

        // Save OCR text to local file
        const savedPath = await window.electronAPI.saveOcrText(currentEntry.absPath, textToSave)

        // Update meta
        const pageTexts = result.pageTexts || []
        await updatePdfMeta(meta => ({
          ...meta,
          ocrStatus: 'complete' as const,
          pages: pageTexts.map((t, i) => ({
            pageNumber: i + 1,
            ocrText: t,
            ocrTimestamp: new Date().toISOString()
          }))
        }))

        setOcrFullText(textToSave)
        setOcrFilePath(savedPath)
        // Update entry OCR status
        await updateEntry(currentEntry.id, { ocrStatus: 'complete', ocrFilePath: savedPath })
        setOcrProgress({ status: 'OCR 完成！' })
        setTimeout(() => setOcrProgress(null), 2000)
      } else {
        setOcrProgress({ status: `失败: ${result.error}` })
        setTimeout(() => setOcrProgress(null), 5000)
      }
    } catch (err: any) {
      setOcrProgress({ status: `错误: ${err.message}` })
      setTimeout(() => setOcrProgress(null), 5000)
    }
  }, [currentEntry, currentPdfMeta, glmApiKeyStatus, updatePdfMeta, updateEntry])

  // Text selection handler
  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const text = selection.toString().trim()
    if (!text || text.length < 2) return

    let el: HTMLElement | null = selection.getRangeAt(0).startContainer.parentElement
    let pageNumber = 0
    while (el) {
      const pn = el.getAttribute('data-page-number')
      if (pn) { pageNumber = parseInt(pn); break }
      el = el.parentElement
    }

    setTextSelection({ pageNumber: pageNumber || 1, text, startOffset: 0, endOffset: text.length })
  }, [setTextSelection])

  // ===== RENDER =====

  if (!currentEntry) {
    return (
      <div className="pdf-area">
        <div className="empty-state">
          <span style={{ fontSize: 48 }}></span>
          <span>从左侧选择文献开始阅读</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>支持 PDF · HTML · EPUB · DOCX · TXT · MD</span>
        </div>
      </div>
    )
  }

  return (
    <div className="pdf-area">
      {/* Toolbar */}
      <div className="pdf-toolbar">
        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 250 }}>
          {currentEntry?.title || ''}
        </span>
        {numPages > 0 && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 8, flexShrink: 0 }}>{numPages} 页</span>
        )}
        <div style={{ flex: 1 }} />

        {/* View mode toggle — only for PDF files */}
        {isPdf && (
          <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginRight: 8 }}>
            <button
              className={viewMode === 'pdf' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ borderRadius: 0, border: 'none' }}
              onClick={() => setViewMode('pdf')}
            >
              PDF
            </button>
            <button
              className={viewMode === 'ocr' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ borderRadius: 0, border: 'none', borderLeft: '1px solid var(--border)' }}
              onClick={() => { if (ocrFullText) setViewMode('ocr'); else alert('请先进行 OCR') }}
              disabled={!ocrFullText}
            >
              OCR 文本{ocrFullText ? ' ·' : ''}
            </button>
          </div>
        )}
        {isHtml && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>HTML 文档</span>
        )}
        {isText && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>{fileExt.toUpperCase()} 文本</span>
        )}
        {fileExt === 'epub' && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>EPUB 电子书</span>
        )}
        {['docx', 'doc'].includes(fileExt) && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>Word 文档</span>
        )}

        {isPdf && viewMode === 'pdf' ? (
          <>
            <button className="btn btn-sm" onClick={() => setScale(s => Math.max(0.5, s - 0.2))}>−</button>
            <span style={{ fontSize: 12, minWidth: 45, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
            <button className="btn btn-sm" onClick={() => setScale(s => Math.min(3, s + 0.2))}>+</button>
          </>
        ) : (viewMode === 'ocr' || ['docx', 'doc'].includes(fileExt)) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>字号</span>
            <input type="range" min="12" max="24" value={ocrFontSize}
              onChange={e => setOcrFontSize(Number(e.target.value))}
              style={{ width: 50, height: 3, accentColor: 'var(--accent)' }} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 20 }}>{ocrFontSize}</span>

            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>粗细</span>
            <input type="range" min="200" max="800" step="50" value={ocrFontWeight}
              onChange={e => setOcrFontWeight(Number(e.target.value))}
              style={{ width: 50, height: 3, accentColor: 'var(--accent)' }} />

            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>深浅</span>
            <input type="range" min="10" max="100" value={ocrColorDepth}
              onChange={e => setOcrColorDepth(Number(e.target.value))}
              style={{ width: 40, height: 3, accentColor: 'var(--accent)' }} />

            <span style={{ width: 1, height: 14, background: 'var(--border)', marginLeft: 4 }} />

            {/* Background presets */}
            {[
              { label: '暖', h: 40, s: 30, l: 97 },
              { label: '绿', h: 100, s: 25, l: 95 },
              { label: '蓝', h: 210, s: 20, l: 96 },
              { label: '灰', h: 0, s: 0, l: 94 },
              { label: '暗', h: 30, s: 10, l: 88 },
            ].map(p => (
              <button
                key={p.label}
                onClick={() => { setOcrBgHue(p.h); setOcrBgSat(p.s); setOcrBgLight(p.l) }}
                title={`背景：${p.label}`}
                style={{
                  width: 16, height: 16, borderRadius: '50%', border: '1.5px solid var(--border)',
                  background: `hsl(${p.h}, ${p.s}%, ${p.l}%)`, cursor: 'pointer', padding: 0, flexShrink: 0,
                  outline: (ocrBgHue === p.h && ocrBgSat === p.s && ocrBgLight === p.l) ? '2px solid var(--accent)' : 'none',
                  outlineOffset: 1,
                }}
              />
            ))}
          </div>
        ) : null}

        {isPdf && (
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: 8 }}
            onClick={handleOcr}
            disabled={!!ocrProgress}
          >
            {ocrFullText ? '重新 OCR' : 'OCR 识别'}
          </button>
        )}
      </div>

      {/* OCR Progress */}
      {ocrProgress && (
        <div style={{
          padding: '10px 16px', background: '#fff8f0', borderBottom: '1px solid var(--border)',
          fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8
        }}>
          {!ocrProgress.status.startsWith('OCR 完成') && !ocrProgress.status.startsWith('失败') && !ocrProgress.status.startsWith('错误') && (
            <span className="loading-spinner" />
          )}
          {ocrProgress.status}
        </div>
      )}

      {/* ===== PDF View ===== */}
      {viewMode === 'pdf' && isPdf && (
        <div className="pdf-scroll-area" ref={scrollRef} onMouseUp={handleMouseUp}>
          {loadError ? (
            <div className="empty-state"><span style={{ fontSize: 32 }}>❌</span><span>{loadError}</span></div>
          ) : !pdfFileUrl ? (
            <div className="empty-state"><span>加载中...</span></div>
          ) : (
            <Document
              file={pdfFileUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={<div className="empty-state"><span>解析 PDF...</span></div>}
              error={<div className="empty-state"><span>PDF 解析失败</span></div>}
            >
              {Array.from({ length: numPages }, (_, i) => (
                <div key={i + 1} className="pdf-page-wrapper" data-page-number={i + 1} style={{ position: 'relative' }}>
                  <div style={{
                    position: 'absolute', top: 4, right: 8, fontSize: 11,
                    color: '#999', background: 'rgba(255,255,255,0.85)', padding: '2px 8px',
                    borderRadius: 4, zIndex: 5
                  }}>
                    {i + 1}
                  </div>
                  <Page
                    pageNumber={i + 1}
                    scale={scale}
                    renderTextLayer={true}
                    renderAnnotationLayer={false}
                    loading={
                      <div style={{ width: 600 * scale, height: 800 * scale, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                        第 {i + 1} 页...
                      </div>
                    }
                  />
                </div>
              ))}
            </Document>
          )}
        </div>
      )}

      {/* ===== HTML View (iframe with postMessage for text selection) ===== */}
      {viewMode === 'pdf' && isHtml && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <HtmlViewer absPath={absPath} onTextSelect={setTextSelection} />
        </div>
      )}

      {/* ===== EPUB View ===== */}
      {viewMode === 'pdf' && fileExt === 'epub' && (
        <div className="pdf-scroll-area" style={{ padding: 0 }}>
          <EpubViewer absPath={absPath} onTextSelect={setTextSelection} />
        </div>
      )}

      {/* ===== DOCX View ===== */}
      {viewMode === 'pdf' && ['docx', 'doc'].includes(fileExt) && (
        <div className="pdf-scroll-area" style={{
          alignItems: 'stretch', padding: 0,
          background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`,
          fontSize: ocrFontSize, fontWeight: ocrFontWeight,
          color: `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
        }} onMouseUp={handleMouseUp}>
          <DocxViewer absPath={absPath} onTextSelect={setTextSelection} />
        </div>
      )}

      {/* ===== Text View ===== */}
      {viewMode === 'pdf' && isText && (
        <div className="pdf-scroll-area" style={{ alignItems: 'stretch', padding: 0, background: 'var(--bg-warm)' }} onMouseUp={handleMouseUp}>
          <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 48px', minHeight: '100%' }}>
            <TextFileContent absPath={absPath} />
          </div>
        </div>
      )}

      {/* ===== OCR Text View ===== */}
      {viewMode === 'ocr' && (
        <div
          className="pdf-scroll-area"
          style={{ background: `hsl(${ocrBgHue}, ${ocrBgSat}%, ${ocrBgLight}%)`, alignItems: 'stretch', padding: 0 }}
          onMouseUp={handleMouseUp}
        >
          <div style={{
            maxWidth: 800, margin: '0 auto', padding: '40px 48px 80px',
            background: 'transparent', minHeight: '100%',
            fontSize: ocrFontSize, fontWeight: ocrFontWeight,
            color: `hsl(30, 20%, ${100 - ocrColorDepth}%)`,
          }}>
            <div style={{
              textAlign: 'center', marginBottom: 32, paddingBottom: 20,
              borderBottom: '2px solid #333'
            }}>
              <h2 style={{ fontSize: ocrFontSize + 4, lineHeight: 1.4, marginBottom: 6 }}>
                {currentEntry?.title || ''}
              </h2>
              <div style={{ fontSize: 12, color: '#999', fontWeight: 400 }}>
                OCR 识别文本
                {ocrFilePath && <span> · {ocrFilePath.split(/[/\\]/).pop()}</span>}
              </div>
            </div>

            <OcrContent
              text={ocrFullText || ''}
              annotations={(currentPdfMeta?.annotations || []).map(a => ({
                id: a.id,
                selectedText: a.anchor.selectedText,
              }))}
              onAnnotationClick={(id) => setActiveAnnotation(id)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
