import { create } from 'zustand'

interface TextSelection {
  pageNumber: number
  text: string
  startOffset: number
  endOffset: number
  rect?: { x: number; y: number; width: number; height: number }
}

// ===== Batch OCR queue (v1.2.7) =====
export interface OcrQueueItem {
  entryId: string
  title: string
  absPath: string
}
export interface OcrQueueState {
  items: OcrQueueItem[]
  currentIndex: number        // index of item currently processing; -1 if not started
  status: 'idle' | 'running' | 'done'
  errors: Array<{ entryId: string; title: string; error: string }>
  completed: string[]         // entryIds that finished successfully
  cancelled: boolean          // set by user; runner checks between items
  // Sub-progress: when a large PDF is split into chunks for OCR, report which chunk we're on
  currentChunk: { chunkIndex: number; totalChunks: number } | null
}

interface UiState {
  // Panels
  sidebarCollapsed: boolean
  annotationPanelCollapsed: boolean

  // Selection
  textSelection: TextSelection | null
  activeAnnotationId: string | null

  // Search
  searchQuery: string

  // Settings
  showSettings: boolean
  glmApiKeyStatus: 'set' | 'not-set' | 'checking'

  // Memo
  activeMemoId: string | null
  sidebarTab: 'library' | 'memos'  // 2026-04-28 · 'reading-log' tab 已删

  // 2026-04-28 · Reading log 功能已删,activeReadingLogDate state 移除

  // Current document full text (for AI context)
  currentDocText: string | null
  // AI context window size (chars before + after selection)
  aiContextWindow: number   // 1000 / 2000 / 5000 / 10000 / -1 (full)

  // Lecture mode
  activeLectureId: string | null
  isRecording: boolean

  // AI model
  selectedAiModel: string
  // Batch 43 · 思考强度（reasoning effort），仅对支持 thinking 的 model 生效
  // 'low' | 'medium' | 'high'，前端 UI 仅当当前 model 支持时显示控件
  aiReasoningEffort: 'low' | 'medium' | 'high'
  // Batch 43 · 联网搜索开关（让 persona 辩论前能先查 2026 时事）
  // 持久化到 localStorage，所有 AI 调用 site 共用
  aiWebSearch: boolean

  // Annotation color (for next annotation to be created)
  annotationColor: string

  // Agent
  rightPanel: 'annotation' | 'agent'
  hermesHasInsight: boolean  // notification badge

  // 2026-04-28 CLEAN · 沉浸式阅读模式已下线(用户反馈无用),immersiveMode + dualPageMode
  //   两个 state + 配套 setter 全部移除。darkMode 保留(独立功能)。
  darkMode: boolean

  // Currently visible PDF page — tracked by the PdfViewer IntersectionObserver.
  // AnnotationPanel reads this to auto-expand the "current page" group in
  // its page-grouped annotation list.
  currentVisiblePage: number
  // For EPUBs: flat TOC labels indexed by "page number" (which equals TOC idx+1).
  // Set by EpubViewer when book loads; cleared on doc switch. null for non-EPUB.
  // AnnotationPanel uses this to label annotation groups with actual chapter
  // names ("第一章 好吃嘴") instead of a raw spine index.
  currentDocTocLabels: string[] | null

  // Quick open modal (Ctrl+P)
  showQuickOpen: boolean

  // Search highlight — applied when this entry is open; cleared when user switches away or manually dismisses
  searchHighlight: { query: string; pageNumber?: number; targetEntryId: string } | null

  // Batch OCR queue — sequential OCR over multiple entries
  ocrQueue: OcrQueueState

  // Update check (populated by App.tsx's daily background check)
  updateAvailable: { version: string; downloadUrl: string | null; asarSize: number } | null

  // Onboarding modal — set true to force-show even after dismissal / provider configured.
  // Used by Settings "查看欢迎引导" button so users can re-trigger the wizard on demand.
  forceOnboarding: boolean

  // Feature tour modal — multi-step walkthrough that teaches import / OCR /
  // highlight / annotation / 学徒周报. Same force-trigger pattern as
  // forceOnboarding so users can re-watch the tour from Settings.
  forceFeatureTour: boolean

  // Actions
  toggleSidebar: () => void
  toggleAnnotationPanel: () => void
  setTextSelection: (sel: TextSelection | null) => void
  setActiveAnnotation: (id: string | null) => void
  clearAnnotationFocus: () => void
  setSearchQuery: (query: string) => void
  setShowSettings: (show: boolean) => void
  setGlmApiKeyStatus: (status: 'set' | 'not-set' | 'checking') => void
  setActiveMemo: (id: string | null) => void
  setSidebarTab: (tab: 'library' | 'memos') => void
  // 2026-04-28 · setActiveReadingLogDate 已删
  setCurrentDocText: (text: string | null) => void
  setAiContextWindow: (size: number) => void
  setActiveLecture: (id: string | null) => void
  setIsRecording: (recording: boolean) => void
  setSelectedAiModel: (model: string) => void
  setAiReasoningEffort: (effort: 'low' | 'medium' | 'high') => void
  setAiWebSearch: (on: boolean) => void
  setAnnotationColor: (color: string) => void
  setRightPanel: (panel: 'annotation' | 'agent') => void
  setHermesHasInsight: (has: boolean) => void
  toggleDarkMode: () => void
  setCurrentVisiblePage: (page: number) => void
  setCurrentDocTocLabels: (labels: string[] | null) => void
  setShowQuickOpen: (show: boolean) => void
  setSearchHighlight: (h: { query: string; pageNumber?: number; targetEntryId: string } | null) => void
  // Batch OCR
  startOcrQueue: (items: OcrQueueItem[]) => void
  advanceOcrQueue: (result: { entryId: string; success: boolean; error?: string }) => void
  setOcrChunkProgress: (p: { chunkIndex: number; totalChunks: number } | null) => void
  cancelOcrQueue: () => void
  dismissOcrQueue: () => void
  setUpdateAvailable: (u: { version: string; downloadUrl: string | null; asarSize: number } | null) => void
  setForceOnboarding: (on: boolean) => void
  setForceFeatureTour: (on: boolean) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarCollapsed: false,
  annotationPanelCollapsed: true,
  textSelection: null,
  activeAnnotationId: null,
  searchQuery: '',
  showSettings: false,
  glmApiKeyStatus: 'checking',
  activeMemoId: null,
  sidebarTab: 'library',
  // 2026-04-28 · activeReadingLogDate 已删
  currentDocText: null,
  activeLectureId: null,
  isRecording: false,
  // BUG-FIX R5#3 · NaN 防御：如果 localStorage 值被手动改坏（比如存了非数字字符串）
  // 原代码 `Number(v)` 会得 NaN，下游比较 `ctx > 1000` 全 false，AI 请求用不上上下文。
  aiContextWindow: (() => {
    try {
      const v = localStorage.getItem('sj-aiContextWindow')
      const n = v ? Number(v) : 2000
      return Number.isFinite(n) && n > 0 ? n : 2000
    } catch { return 2000 }
  })(),
  selectedAiModel: 'glm:glm-4-flash',
  // Batch 43 · effort 持久化到 localStorage（每次启动恢复用户上次的选择）
  aiReasoningEffort: (() => {
    try {
      const v = localStorage.getItem('sj-aiReasoningEffort')
      if (v === 'low' || v === 'medium' || v === 'high') return v
      return 'medium'
    } catch { return 'medium' }
  })(),
  // Batch 43 · 联网开关持久化（默认关 —— 大多数对话不需要时事，开了浪费 quota）
  aiWebSearch: (() => {
    try { return localStorage.getItem('sj-aiWebSearch') === 'true' } catch { return false }
  })(),
  annotationColor: 'yellow',
  rightPanel: 'annotation',
  hermesHasInsight: false,
  darkMode: (() => { try { return localStorage.getItem('sj-darkMode') === 'true' } catch { return false } })(),
  currentVisiblePage: 1,
  currentDocTocLabels: null,
  showQuickOpen: false,
  searchHighlight: null,
  ocrQueue: {
    items: [],
    currentIndex: -1,
    status: 'idle',
    errors: [],
    completed: [],
    cancelled: false,
    currentChunk: null,
  },
  updateAvailable: null,
  forceOnboarding: false,
  forceFeatureTour: false,

  toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleAnnotationPanel: () => set(s => ({ annotationPanelCollapsed: !s.annotationPanelCollapsed, rightPanel: 'annotation' as const })),
  setTextSelection: (sel) => set({ textSelection: sel, annotationPanelCollapsed: sel ? false : true, rightPanel: 'annotation' as const }),
  setActiveAnnotation: (id) => set({ activeAnnotationId: id, annotationPanelCollapsed: id ? false : true, rightPanel: 'annotation' as const }),
  clearAnnotationFocus: () => set({ activeAnnotationId: null, textSelection: null }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setShowSettings: (show) => set({ showSettings: show }),
  setGlmApiKeyStatus: (status) => set({ glmApiKeyStatus: status }),
  setActiveMemo: (id) => set({ activeMemoId: id, ...(id ? { sidebarTab: 'memos' as const } : {}) }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  // 2026-04-28 · setActiveReadingLogDate 已删
  setCurrentDocText: (text) => set({ currentDocText: text }),
  setAiContextWindow: (size) => { set({ aiContextWindow: size }); try { localStorage.setItem('sj-aiContextWindow', String(size)) } catch {} },
  setActiveLecture: (id) => set({ activeLectureId: id, activeMemoId: null }),
  setIsRecording: (recording) => set({ isRecording: recording }),
  setSelectedAiModel: (model) => set({ selectedAiModel: model }),
  setAiReasoningEffort: (effort) => {
    try { localStorage.setItem('sj-aiReasoningEffort', effort) } catch { /* ignore */ }
    set({ aiReasoningEffort: effort })
  },
  setAiWebSearch: (on) => {
    try { localStorage.setItem('sj-aiWebSearch', String(on)) } catch { /* ignore */ }
    set({ aiWebSearch: on })
  },
  toggleDarkMode: () => set(s => {
    const next = !s.darkMode
    document.documentElement.classList.toggle('dark-mode', next)
    try { localStorage.setItem('sj-darkMode', String(next)) } catch {}
    // Update title bar
    window.electronAPI?.setTitleBarTheme?.(next)
    return { darkMode: next }
  }),
  setAnnotationColor: (color) => set({ annotationColor: color }),
  // 2026-04-28 CLEAN · setImmersiveMode + setDualPageMode 已删(沉浸式阅读下线)。
  setCurrentVisiblePage: (page) => {
    const cur = get().currentVisiblePage
    if (cur !== page) set({ currentVisiblePage: page })
  },
  setCurrentDocTocLabels: (labels) => set({ currentDocTocLabels: labels }),
  setShowQuickOpen: (show) => set({ showQuickOpen: show }),
  setSearchHighlight: (h) => set({ searchHighlight: h }),
  startOcrQueue: (items) => set({
    ocrQueue: {
      items, currentIndex: 0, status: 'running',
      errors: [], completed: [], cancelled: false, currentChunk: null,
    },
  }),
  advanceOcrQueue: (result) => set(s => {
    const q = s.ocrQueue
    const nextIndex = q.currentIndex + 1
    const isDone = nextIndex >= q.items.length || q.cancelled
    return {
      ocrQueue: {
        ...q,
        currentIndex: nextIndex,
        status: isDone ? 'done' : 'running',
        completed: result.success ? [...q.completed, result.entryId] : q.completed,
        errors: result.success ? q.errors : [
          ...q.errors,
          { entryId: result.entryId, title: q.items[q.currentIndex]?.title || '', error: result.error || 'unknown' },
        ],
        currentChunk: null,  // reset sub-progress between items
      },
    }
  }),
  setOcrChunkProgress: (p) => set(s => ({ ocrQueue: { ...s.ocrQueue, currentChunk: p } })),
  cancelOcrQueue: () => set(s => ({
    ocrQueue: { ...s.ocrQueue, cancelled: true },
  })),
  dismissOcrQueue: () => set({
    ocrQueue: {
      items: [], currentIndex: -1, status: 'idle',
      errors: [], completed: [], cancelled: false, currentChunk: null,
    },
  }),
  setUpdateAvailable: (u) => set({ updateAvailable: u }),
  setRightPanel: (panel) => set({ rightPanel: panel, annotationPanelCollapsed: false, ...(panel === 'agent' ? { hermesHasInsight: false } : {}) }),
  setHermesHasInsight: (has) => set({ hermesHasInsight: has }),
  setForceOnboarding: (on) => set({ forceOnboarding: on }),
  setForceFeatureTour: (on) => set({ forceFeatureTour: on }),
}))
