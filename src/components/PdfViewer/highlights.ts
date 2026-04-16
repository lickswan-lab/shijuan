// ===== Robust text highlighting in rendered DOM =====
// Collects all text nodes, builds a flat string, finds match positions,
// then maps back to DOM ranges for wrapping.

import { useEffect } from 'react'

export function collectTextNodes(root: Node): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

export function findAndWrapAll(
  container: HTMLElement,
  targets: Array<{ text: string; [key: string]: any }>,
  wrapFn: (target: any) => HTMLElement,
  skipClass?: string,
) {
  for (const target of targets) {
    const searchText = target.text.replace(/\s+/g, '').trim()
    if (searchText.length < 2) continue

    const textNodes = collectTextNodes(container)

    const charMap: Array<{ ni: number; offset: number }> = []
    let flat = ''
    for (let ni = 0; ni < textNodes.length; ni++) {
      const node = textNodes[ni]
      if (skipClass && (node.parentNode as HTMLElement)?.classList?.contains(skipClass)) continue
      const raw = node.textContent || ''
      for (let ri = 0; ri < raw.length; ri++) {
        if (/\s/.test(raw[ri])) continue
        charMap.push({ ni, offset: ri })
        flat += raw[ri]
      }
    }

    const flatIdx = flat.indexOf(searchText)
    if (flatIdx === -1) continue

    const flatEnd = flatIdx + searchText.length
    const segments: Array<{ node: Text; startOffset: number; endOffset: number }> = []
    let currentNi = -1, segStart = 0, segEnd = 0

    for (let fi = flatIdx; fi < flatEnd; fi++) {
      const cm = charMap[fi]
      if (cm.ni !== currentNi) {
        if (currentNi >= 0) segments.push({ node: textNodes[currentNi], startOffset: segStart, endOffset: segEnd + 1 })
        currentNi = cm.ni
        segStart = cm.offset
      }
      segEnd = cm.offset
    }
    if (currentNi >= 0) segments.push({ node: textNodes[currentNi], startOffset: segStart, endOffset: segEnd + 1 })
    if (segments.length === 0) continue

    try {
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si]
        if (!seg.node.isConnected) continue
        const raw = seg.node.textContent || ''
        const before = raw.substring(0, seg.startOffset)
        const match = raw.substring(seg.startOffset, seg.endOffset)
        const after = raw.substring(seg.endOffset)
        const parent = seg.node.parentNode!

        const wrapper = wrapFn(target)
        wrapper.textContent = match

        if (after) parent.insertBefore(document.createTextNode(after), seg.node.nextSibling)
        parent.insertBefore(wrapper, seg.node.nextSibling)
        if (before) { seg.node.textContent = before } else { parent.removeChild(seg.node) }
      }
    } catch { /* DOM changed, skip */ }
  }
}

export function useAnnotationHighlights(
  containerRef: React.RefObject<HTMLDivElement | null>,
  annotations: Array<{ id: string; selectedText: string }>,
  onAnnotationClick: (id: string) => void,
  deps: any[],
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container || !annotations.length) return

    // Clear old highlights
    container.querySelectorAll('.ocr-ann-underline, .ocr-ann-marker').forEach(el => {
      try {
        const parent = el.parentNode
        if (!parent) return
        if (el.classList.contains('ocr-ann-marker')) { parent.removeChild(el); return }
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
      } catch {}
    })
    try { container.normalize() } catch {}

    const targets = annotations.map(a => ({ text: a.selectedText, id: a.id }))
    findAndWrapAll(container, targets, (target) => {
      const span = document.createElement('span')
      span.className = 'ocr-ann-underline'
      span.dataset.annId = target.id
      return span
    }, 'ocr-ann-underline')

    // Add click markers
    const highlighted = container.querySelectorAll('.ocr-ann-underline[data-ann-id]')
    const seenIds = new Set<string>()
    highlighted.forEach(el => {
      const annId = (el as HTMLElement).dataset.annId
      if (!annId || seenIds.has(annId)) return
      seenIds.add(annId)
      const marker = document.createElement('span')
      marker.className = 'ocr-ann-marker'
      marker.dataset.annId = annId
      marker.addEventListener('click', (e) => { e.stopPropagation(); onAnnotationClick(annId) })
      el.parentNode?.insertBefore(marker, el)
    })

    const raf = requestAnimationFrame(() => {})
    return () => cancelAnimationFrame(raf)
  }, deps)
}
