// ===== Robust text highlighting in rendered DOM =====
// Collects all text nodes, builds a flat string, finds match positions,
// then maps back to DOM ranges for wrapping. Position-aware overlap
// resolution: when two targets cover the same characters, the LATER target
// (higher index in `targets`) wins; the older target's non-overlapping
// portions are still wrapped, so partial overlap renders as 3 spans:
// old-prefix + new + old-suffix (or 2 spans for edge overlap).

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
  // === Phase 1: build flat string + char→DOM map (one pass, before any wrap) ===
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
  if (charMap.length === 0) return

  // === Phase 2: locate each target's [start, end) in the flat string ===
  // idx = original position in `targets` array. Newer marks have higher idx
  // (the caller appends new marks at the end), so higher idx wins on overlap.
  type Range = { target: any; start: number; end: number; idx: number }
  const ranges: Range[] = []
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const searchText = target.text.replace(/\s+/g, '').trim()
    if (searchText.length < 2) continue
    const flatIdx = flat.indexOf(searchText)
    if (flatIdx === -1) continue
    ranges.push({ target, start: flatIdx, end: flatIdx + searchText.length, idx: i })
  }

  // === Phase 3: subtract later ranges from each older range ===
  // For each range r, compute the visible sub-intervals = [r.start, r.end)
  // minus the union of all ranges with idx > r.idx. The result is a set of
  // disjoint intervals that should be wrapped with r.target's style.
  type WrapTask = { target: any; start: number; end: number }
  const tasks: WrapTask[] = []
  for (const r of ranges) {
    let intervals: Array<[number, number]> = [[r.start, r.end]]
    for (const other of ranges) {
      if (other.idx <= r.idx) continue  // only newer ranges trim older ones
      const next: Array<[number, number]> = []
      for (const [a, b] of intervals) {
        if (other.end <= a || other.start >= b) {
          next.push([a, b])  // no overlap
        } else {
          if (other.start > a) next.push([a, other.start])  // left remainder
          if (other.end < b) next.push([other.end, b])      // right remainder
          // (full coverage: nothing pushed → interval dropped)
        }
      }
      intervals = next
      if (intervals.length === 0) break
    }
    for (const [a, b] of intervals) {
      if (b > a) tasks.push({ target: r.target, start: a, end: b })
    }
  }
  if (tasks.length === 0) return

  // === Phase 4: wrap each task, processing right-to-left ===
  // Wrapping a range mutates its text nodes. By processing tasks from highest
  // flat-position to lowest, we never invalidate the charMap entries of tasks
  // we haven't processed yet (their text nodes are to the LEFT of what we
  // just touched, and our left-side text nodes get truncated, not removed).
  tasks.sort((a, b) => b.start - a.start)

  for (const task of tasks) {
    // Map [task.start, task.end) → contiguous segments per text node
    const segments: Array<{ node: Text; startOffset: number; endOffset: number }> = []
    let currentNi = -1, segStart = 0, segEnd = 0
    for (let fi = task.start; fi < task.end; fi++) {
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
      // Within a single task's multi-node range, wrap segments end-to-start
      // for the same reason: don't invalidate left-side offsets in the same
      // text node before we use them.
      for (let si = segments.length - 1; si >= 0; si--) {
        const seg = segments[si]
        if (!seg.node.isConnected) continue
        const parent = seg.node.parentNode
        if (!parent) continue
        const raw = seg.node.textContent || ''
        const before = raw.substring(0, seg.startOffset)
        const match = raw.substring(seg.startOffset, seg.endOffset)
        const after = raw.substring(seg.endOffset)

        const wrapper = wrapFn(task.target)
        wrapper.textContent = match

        if (after) parent.insertBefore(document.createTextNode(after), seg.node.nextSibling)
        parent.insertBefore(wrapper, seg.node.nextSibling)
        if (before) { seg.node.textContent = before } else { parent.removeChild(seg.node) }
      }
    } catch { /* DOM changed mid-highlight, skip safely */ }
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
