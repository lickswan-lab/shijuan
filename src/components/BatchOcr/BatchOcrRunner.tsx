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
  const setOcrChunkProgress = useUiStore(s => s.setOcrChunkProgress)
  const updateEntry = useLibraryStore(s => s.updateEntry)

  // Track which (currentIndex) we've already kicked off, so React re-renders
  // don't retrigger the same OCR request twice.
  const activeIdxRef = useRef<number>(-1)

  // Subscribe to per-chunk OCR progress from the main process. Filtered by entryId
  // so stale events from a previously-running OCR don't bleed in.
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onOcrProgress) return
    const cleanup = api.onOcrProgress((payload) => {
      const currentItem = ocrQueue.items[ocrQueue.currentIndex]
      if (!currentItem) return
      if (payload.entryId && payload.entryId !== currentItem.entryId) return
      // Show (chunkIndex+1)/total at "start"; reset on final "done" of last chunk
      if (payload.phase === 'start') {
        setOcrChunkProgress({ chunkIndex: payload.chunkIndex, totalChunks: payload.totalChunks })
      } else if (payload.phase === 'done' && payload.chunkIndex >= payload.totalChunks - 1) {
        setOcrChunkProgress(null)
      }
    })
    return cleanup
  }, [ocrQueue.items, ocrQueue.currentIndex, setOcrChunkProgress])

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
        // Flip to 'running' so the FileTree badge shows a spinner for this entry.
        await updateEntry(item.entryId, {
          ocrStatus: 'running',
          ocrStatusUpdatedAt: new Date().toISOString(),
          ocrError: undefined,
        })
        // Pass entryId so the backend's chunk-progress events can be correlated here
        const result = await api.glmOcrPdf(item.absPath, { entryId: item.entryId })
        if (stopped) return

        if (result.success && result.text) {
          const savedPath = await api.saveOcrText(item.absPath, result.text)
          await updateEntry(item.entryId, {
            ocrStatus: 'complete',
            ocrFilePath: savedPath,
            ocrStatusUpdatedAt: new Date().toISOString(),
            ocrError: undefined,
          })
          advanceOcrQueue({ entryId: item.entryId, success: true })
        } else {
          await updateEntry(item.entryId, {
            ocrStatus: 'failed',
            ocrStatusUpdatedAt: new Date().toISOString(),
            ocrError: result.error || '未知错误',
          })
          advanceOcrQueue({
            entryId: item.entryId,
            success: false,
            error: result.error || '未知错误',
          })
        }
      } catch (err: any) {
        if (stopped) return
        const msg = err?.message || String(err)
        await updateEntry(item.entryId, {
          ocrStatus: 'failed',
          ocrStatusUpdatedAt: new Date().toISOString(),
          ocrError: msg,
        }).catch(() => {})
        advanceOcrQueue({
          entryId: item.entryId,
          success: false,
          error: msg,
        })
      }
    })()

    return () => { stopped = true }
  }, [ocrQueue.status, ocrQueue.currentIndex, ocrQueue.cancelled, ocrQueue.items, advanceOcrQueue, updateEntry])

  return null
}
