import { useEffect, useRef } from 'react'
import { useUiStore } from '../../store/uiStore'
import { useLibraryStore } from '../../store/libraryStore'

/**
 * BatchOcrRunner (headless) — drives the sequential OCR queue.
 *
 * Reads `ocrQueue.status === 'running'` and the current item, invokes GLM OCR,
 * saves .ocr.txt, updates the entry's ocrStatus, then calls advanceOcrQueue().
 * Between items it yields to React (via setTimeout 0) so the progress UI re-renders.
 *
 * Cancellation: if `ocrQueue.cancelled` flips to true, the runner finishes the
 * in-flight request (we can't interrupt a Node fetch cleanly here) and stops
 * before starting the next item.
 */
export default function BatchOcrRunner() {
  const ocrQueue = useUiStore(s => s.ocrQueue)
  const advanceOcrQueue = useUiStore(s => s.advanceOcrQueue)
  const updateEntry = useLibraryStore(s => s.updateEntry)

  // Track which (currentIndex) we've already kicked off, so React re-renders
  // don't retrigger the same OCR request twice.
  const activeIdxRef = useRef<number>(-1)

  useEffect(() => {
    if (ocrQueue.status !== 'running') return
    if (ocrQueue.cancelled) return
    if (ocrQueue.currentIndex >= ocrQueue.items.length) return

    const idx = ocrQueue.currentIndex
    if (activeIdxRef.current === idx) return  // already running this index
    activeIdxRef.current = idx

    const item = ocrQueue.items[idx]
    if (!item) return

    let stopped = false

    ;(async () => {
      try {
        const api = window.electronAPI
        if (!api?.glmOcrPdf) throw new Error('OCR API unavailable')
        const result = await api.glmOcrPdf(item.absPath)
        if (stopped) return

        if (result.success && result.text) {
          // Save OCR text next to the PDF
          const savedPath = await api.saveOcrText(item.absPath, result.text)
          // Update entry metadata
          await updateEntry(item.entryId, {
            ocrStatus: 'complete',
            ocrFilePath: savedPath,
          })
          advanceOcrQueue({ entryId: item.entryId, success: true })
        } else {
          advanceOcrQueue({
            entryId: item.entryId,
            success: false,
            error: result.error || '未知错误',
          })
        }
      } catch (err: any) {
        if (stopped) return
        advanceOcrQueue({
          entryId: item.entryId,
          success: false,
          error: err?.message || String(err),
        })
      }
    })()

    return () => { stopped = true }
    // Re-fire only when status or currentIndex changes
  }, [ocrQueue.status, ocrQueue.currentIndex, ocrQueue.cancelled, ocrQueue.items, advanceOcrQueue, updateEntry])

  return null
}
