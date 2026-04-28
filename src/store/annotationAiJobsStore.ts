// Global AI-job store for annotation history entries.
//
// Why this exists (vs. local component state):
//   - Previously aiLoading + streamingText lived on AnnotationPanel's local
//     state. When the user navigated away from an annotation mid-stream, the
//     streaming indicator "leaked" into whatever annotation they opened next.
//   - Now each AI call is a global job keyed by (entryId, annotationId,
//     historyEntryId). The chunk loop runs here, independent of which
//     annotation the user is currently viewing. Concurrent asks on different
//     annotations are fine — each has its own job.
//
// Contract:
//   1. Caller appends a placeholder HistoryEntry (author:'ai', aiStatus:'running')
//      to the annotation's historyChain BEFORE starting the job — so the
//      entry is persisted to library.json immediately. On app restart a
//      "running" entry can be surfaced as "failed (app closed before
//      completion)" via a post-boot scan.
//   2. startJob(params) kicks off chunk-loop; the store writes streaming
//      text into the entry via an updater callback. Debounced to ~150 ms to
//      limit library.json write amplification.
//   3. On terminal state (completed/failed/aborted) the store flips the
//      entry's aiStatus + aiError and clears its in-memory job slot.
//   4. abortJob(key) flips _aborted and aborts the in-flight stream.
//   5. markJobViewed(key) sets aiViewed:true so the annotation-list badge hides.
//
// Storage: NOT persisted. Restart clears the in-memory map; persistent state
// lives in library.json under each entry's aiStatus field.
import { create } from 'zustand'
import { v4 as uuid } from 'uuid'

export type AiJobStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface AnnotationAiJob {
  // Composite key — one job per (entry doc, annotation, history entry).
  entryId: string
  annotationId: string
  historyEntryId: string

  status: AiJobStatus
  // Running streaming text. Kept in-memory for the "currently viewing this
  // annotation" case. On completion we write the final text to the
  // HistoryEntry via the passed updater and drop this job.
  streamingText: string
  error?: string
  startedAt: string
  completedAt?: string

  // internals
  _streamId?: string
  _aborted?: boolean
  _cleanupChunk?: () => void
}

// Updater passed by the caller — wraps updatePdfMeta so the store stays
// ignorant of how history entries are stored.
export type HistoryEntryUpdater = (
  entryId: string,
  annotationId: string,
  historyEntryId: string,
  patch: { content?: string; aiStatus?: AiJobStatus; aiError?: string; modelLabel?: string },
) => Promise<void> | void

interface StartJobParams {
  entryId: string
  annotationId: string
  historyEntryId: string
  model: string
  modelLabel?: string
  messages: Array<{ role: string; content: string }>
  updater: HistoryEntryUpdater
}

interface JobsStore {
  jobs: Record<string, AnnotationAiJob>  // key = entryId:annotationId:historyEntryId

  startJob: (params: StartJobParams) => Promise<void>
  abortJob: (entryId: string, annotationId: string, historyEntryId: string) => void
  markJobViewed: (entryId: string, annotationId: string, historyEntryId: string) => void
  getJob: (entryId: string, annotationId: string, historyEntryId: string) => AnnotationAiJob | undefined
}

export const jobKey = (entryId: string, annotationId: string, historyEntryId: string) =>
  `${entryId}:${annotationId}:${historyEntryId}`

export const useAnnotationAiJobsStore = create<JobsStore>((set, get) => ({
  jobs: {},

  startJob: async ({ entryId, annotationId, historyEntryId, model, modelLabel, messages, updater }) => {
    const key = jobKey(entryId, annotationId, historyEntryId)

    const initial: AnnotationAiJob = {
      entryId, annotationId, historyEntryId,
      status: 'running',
      streamingText: '',
      startedAt: new Date().toISOString(),
    }
    set(s => ({ jobs: { ...s.jobs, [key]: initial } }))

    const streamId = uuid()
    let fullText = ''

    // Debounce library.json writes from chunk updates — raw chunks can
    // fire 20-50 times/s; we don't want to hammer atomic-write + observers
    // that fast.
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let pendingFlush = false
    // BUG-FIX R4#1 · updater rejection 以前只 console.warn，UI 还是停留在 'running'
    // 造成"下次启动时假装正在生成"的幽灵状态。catch 时把 job 标为 failed + error
    // 字段，让 UI 显示真实终态。
    const flushToEntry = () => {
      pendingFlush = false
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      Promise.resolve(updater(entryId, annotationId, historyEntryId, { content: fullText }))
        .catch(err => {
          console.warn('[ai-job] flush updater rejected', err)
          // 只有在 running 时才写入失败态——避免覆盖 abort / completed 的正确终态
          set(s => {
            const j = s.jobs[key]
            if (!j || j.status !== 'running') return s
            return {
              jobs: {
                ...s.jobs,
                [key]: { ...j, status: 'failed', error: err?.message || '保存失败', _cleanupChunk: undefined },
              },
            }
          })
        })
    }
    const scheduleFlush = () => {
      pendingFlush = true
      if (flushTimer) return
      flushTimer = setTimeout(() => { if (pendingFlush) flushToEntry() }, 200)
    }

    // Idle timeout — 180s of no new chunks counts as dead.
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let resolveTimeout: ((v: { success: false; error: string }) => void) | null = null
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        resolveTimeout?.({ success: false, error: 'AI 超时（180 秒未收到新内容）' })
      }, 180_000)
    }

    // BUG-FIX R4#2 · 拒绝已终态 job 的后续 chunk
    // 场景：用户 abort 或 idleTimer 触发 → Promise.race 返回 → job 标为 aborted/failed
    // 但 stream 后端还在发 chunk，旧 listener 仍会累加到 fullText，污染错误消息或
    // 幻影追加到已完成消息。顶部检查 status，非 running 直接 return。
    const cleanup = (window as any).electronAPI.onAiStreamChunk((sid: string, chunk: string) => {
      if (sid !== streamId) return
      const currentJob = get().jobs[key]
      if (!currentJob || currentJob.status !== 'running') return
      fullText += chunk
      set(s => {
        const j = s.jobs[key]
        if (!j || j.status !== 'running') return s
        return { jobs: { ...s.jobs, [key]: { ...j, streamingText: fullText } } }
      })
      scheduleFlush()
      armIdle()
    })

    // Stash for abortJob
    set(s => {
      const j = s.jobs[key]
      if (!j) return s
      return { jobs: { ...s.jobs, [key]: { ...j, _streamId: streamId, _cleanupChunk: cleanup } } }
    })
    armIdle()

    try {
      const result = await Promise.race([
        (window as any).electronAPI.aiChatStream(streamId, model, messages),
        new Promise<{ success: false; error: string }>(resolve => { resolveTimeout = resolve }),
      ])
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }

      // One last flush so content is final.
      flushToEntry()

      const aborted = get().jobs[key]?._aborted
      if (aborted) {
        await updater(entryId, annotationId, historyEntryId, {
          content: fullText || '（已取消）',
          aiStatus: 'aborted',
        })
        set(s => ({ jobs: { ...s.jobs, [key]: { ...s.jobs[key]!, status: 'aborted', completedAt: new Date().toISOString() } } }))
      } else if (!result.success) {
        await updater(entryId, annotationId, historyEntryId, {
          content: fullText || `错误：${result.error}`,
          aiStatus: 'failed',
          aiError: result.error,
        })
        set(s => ({
          jobs: {
            ...s.jobs,
            [key]: { ...s.jobs[key]!, status: 'failed', error: result.error, completedAt: new Date().toISOString() },
          },
        }))
      } else {
        await updater(entryId, annotationId, historyEntryId, {
          content: fullText,
          aiStatus: 'completed',
          modelLabel,
        })
        set(s => ({
          jobs: {
            ...s.jobs,
            [key]: { ...s.jobs[key]!, status: 'completed', completedAt: new Date().toISOString() },
          },
        }))
      }
    } catch (err: any) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      flushToEntry()
      const errMsg = err?.message || String(err)
      await updater(entryId, annotationId, historyEntryId, {
        content: fullText || `错误：${errMsg}`,
        aiStatus: 'failed',
        aiError: errMsg,
      })
      set(s => ({
        jobs: {
          ...s.jobs,
          [key]: { ...s.jobs[key]!, status: 'failed', error: errMsg, completedAt: new Date().toISOString() },
        },
      }))
    } finally {
      cleanup()
      if (flushTimer) clearTimeout(flushTimer)
    }
  },

  abortJob: (entryId, annotationId, historyEntryId) => {
    const key = jobKey(entryId, annotationId, historyEntryId)
    const j = get().jobs[key]
    if (!j || j.status !== 'running') return
    set(s => ({ jobs: { ...s.jobs, [key]: { ...s.jobs[key]!, _aborted: true } } }))
    if (j._streamId) {
      ;(window as any).electronAPI.aiAbortStream?.(j._streamId).catch(() => {})
    }
  },

  markJobViewed: (entryId, annotationId, historyEntryId) => {
    const key = jobKey(entryId, annotationId, historyEntryId)
    const j = get().jobs[key]
    if (!j || j.status === 'running') return
    // Remove the in-memory job once the user has seen the terminal state;
    // the persisted entry's aiViewed=true is the source of truth from here on.
    set(s => {
      const next = { ...s.jobs }
      delete next[key]
      return { jobs: next }
    })
  },

  getJob: (entryId, annotationId, historyEntryId) =>
    get().jobs[jobKey(entryId, annotationId, historyEntryId)],
}))
