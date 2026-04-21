// Global translation jobs store — tracks one translation-in-progress per
// library entry so the TranslateModal can be closed ("minimized") without
// aborting the stream. Status/result survive modal unmount because this
// store is a plain-JS Zustand instance that doesn't tear down on React
// render cycles.
//
// Design decisions:
//   - One job per entryId (starting a new translation replaces the old one).
//     This matches the UX: a badge on the per-document 翻译 button only has
//     room to show one status; the user's "latest translation" is what
//     matters.
//   - The chunk loop runs here (not in the modal) so unmounting the modal
//     doesn't abort mid-chunk. electronAPI stream events fire in main
//     process → renderer, so they don't care about React component lifecycle.
//   - `_aborted` is the stop-signal; the loop polls it between chunks so
//     "停止" works even after all the streamIds have been handed off.
//   - We intentionally do NOT persist to disk — if the user closes the app
//     mid-translation, the job is gone. That's fine; the user can restart.
import { create } from 'zustand'
import { v4 as uuid } from 'uuid'

export type TranslateMode = 'selection' | 'current-page' | 'range' | 'full'
export type TranslateStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface TranslationJob {
  entryId: string
  status: TranslateStatus
  mode: TranslateMode
  targetLang: 'zh' | 'en'
  model: string
  // Streaming output — updated continuously while status === 'running'
  result: string
  error?: string
  // Progress
  currentChunk: number
  totalChunks: number
  // What was translated (kept so we can re-display the source preview even
  // after the modal was closed and reopened)
  sourceText: string
  sourceLength: number
  docTitle: string
  // Timestamps for UX ("翻译完成于 3 秒前")
  startedAt: string
  completedAt?: string
  // Internal: current in-flight stream id, used by abort()
  _currentStreamId?: string
  _aborted?: boolean
  // Internal: current cleanup to detach chunk listener when aborting
  _cleanup?: () => void
}

interface JobsStore {
  jobs: Record<string, TranslationJob>  // keyed by entryId

  // Kick off a translation. Replaces any existing job for this entryId.
  // `chunks` is the already-split source segments. The function resolves
  // when the chunk loop finishes (normal completion OR abort).
  startTranslation: (params: {
    entryId: string
    mode: TranslateMode
    targetLang: 'zh' | 'en'
    model: string
    sourceText: string
    chunks: string[]
    docTitle: string
  }) => Promise<void>

  // Request abort — flips the _aborted flag and cancels the current
  // in-flight stream. Safe to call multiple times. If no running job, no-op.
  abortTranslation: (entryId: string) => void

  // Drop a job entirely (used when the user explicitly dismisses the badge).
  clearJob: (entryId: string) => void

  getJob: (entryId: string) => TranslationJob | undefined
}

export const useTranslationJobsStore = create<JobsStore>((set, get) => ({
  jobs: {},

  startTranslation: async ({ entryId, mode, targetLang, model, sourceText, chunks, docTitle }) => {
    // If a job is already running for this entry, abort it first so we don't
    // have two concurrent chunk loops writing to the same result string.
    const existing = get().jobs[entryId]
    if (existing && existing.status === 'running') {
      get().abortTranslation(entryId)
      // Give the stop signal a beat to propagate before we stomp state.
      await new Promise(r => setTimeout(r, 50))
    }

    const initial: TranslationJob = {
      entryId, status: 'running', mode, targetLang, model,
      result: '', currentChunk: 0, totalChunks: chunks.length,
      sourceText, sourceLength: sourceText.length, docTitle,
      startedAt: new Date().toISOString(),
    }
    set(state => ({ jobs: { ...state.jobs, [entryId]: initial } }))

    const target = targetLang === 'zh' ? '中文（简体）' : 'English'
    const style = targetLang === 'zh'
      ? '学术中文，保留原文术语（首次出现用括号标注英文原文），不改写论证结构，忠实逐段对应。公式与引用保持原样。'
      : 'Academic English, preserve original terminology, faithful paragraph-by-paragraph correspondence, keep formulas and citations intact.'
    const systemPrompt = `你是一名学术翻译。请将用户给出的文本翻译为${target}。\n要求：${style}\n直接输出译文，不要添加任何解释、前言、说明、"翻译如下"之类的元话语。`

    let accumulated = ''
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (get().jobs[entryId]?._aborted) break

        // Advance chunk counter
        set(state => {
          const j = state.jobs[entryId]
          if (!j) return state
          return { jobs: { ...state.jobs, [entryId]: { ...j, currentChunk: i + 1 } } }
        })

        const streamId = uuid()
        let chunkText = ''

        // Listener: append incoming chunks to result so the modal (if open)
        // re-renders in real time. The modal reads result directly from
        // state.jobs[entryId].result.
        const cleanup = (window as any).electronAPI.onAiStreamChunk((sid: string, c: string) => {
          if (sid !== streamId) return
          chunkText += c
          set(state => {
            const j = state.jobs[entryId]
            if (!j) return state
            return { jobs: { ...state.jobs, [entryId]: { ...j, result: accumulated + chunkText } } }
          })
        })

        // Stash current streamId + cleanup so abort() can tear them down.
        set(state => {
          const j = state.jobs[entryId]
          if (!j) return state
          return { jobs: { ...state.jobs, [entryId]: { ...j, _currentStreamId: streamId, _cleanup: cleanup } } }
        })

        try {
          await (window as any).electronAPI.aiChatStream(streamId, model, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: chunks[i] },
          ])
        } finally {
          cleanup()
          set(state => {
            const j = state.jobs[entryId]
            if (!j) return state
            return { jobs: { ...state.jobs, [entryId]: { ...j, _currentStreamId: undefined, _cleanup: undefined } } }
          })
        }
        accumulated += (accumulated ? '\n\n' : '') + chunkText
      }

      set(state => {
        const j = state.jobs[entryId]
        if (!j) return state
        const final: TranslationJob = {
          ...j,
          result: accumulated,
          status: j._aborted ? 'aborted' : 'completed',
          completedAt: new Date().toISOString(),
        }
        return { jobs: { ...state.jobs, [entryId]: final } }
      })
    } catch (err: any) {
      set(state => {
        const j = state.jobs[entryId]
        if (!j) return state
        const final: TranslationJob = {
          ...j,
          result: accumulated,
          status: 'failed',
          error: err?.message || String(err),
          completedAt: new Date().toISOString(),
        }
        return { jobs: { ...state.jobs, [entryId]: final } }
      })
    }
  },

  abortTranslation: (entryId) => {
    const j = get().jobs[entryId]
    if (!j || j.status !== 'running') return
    // Flip the flag — the chunk loop checks it between chunks.
    set(state => ({
      jobs: { ...state.jobs, [entryId]: { ...state.jobs[entryId]!, _aborted: true } }
    }))
    // Best-effort: abort the current in-flight stream. If it succeeds, the
    // await in the chunk loop resolves early and the next iteration exits.
    if (j._currentStreamId) {
      (window as any).electronAPI.aiAbortStream?.(j._currentStreamId).catch(() => {})
    }
  },

  clearJob: (entryId) => {
    set(state => {
      const next = { ...state.jobs }
      delete next[entryId]
      return { jobs: next }
    })
  },

  getJob: (entryId) => get().jobs[entryId],
}))
