import { create } from 'zustand'

interface TextSelection {
  pageNumber: number
  text: string
  startOffset: number
  endOffset: number
  rect?: { x: number; y: number; width: number; height: number }
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
  sidebarTab: 'library' | 'memos' | 'reading-log'

  // Reading log
  activeReadingLogDate: string | null

  // Current document full text (for AI context)
  currentDocText: string | null
  // AI context window size (chars before + after selection)
  aiContextWindow: number   // 1000 / 2000 / 5000 / 10000 / -1 (full)

  // Lecture mode
  activeLectureId: string | null
  isRecording: boolean

  // AI model
  selectedAiModel: string

  // Annotation color (for next annotation to be created)
  annotationColor: string

  // Agent
  rightPanel: 'annotation' | 'agent'
  hermesHasInsight: boolean  // notification badge

  // Immersive reading
  immersiveMode: boolean
  darkMode: boolean
  dualPageMode: boolean  // true = dual-page spread in immersive; false = single-page + side annotation

  // Quick open modal (Ctrl+P)
  showQuickOpen: boolean

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
  setSidebarTab: (tab: 'library' | 'memos' | 'reading-log') => void
  setActiveReadingLogDate: (date: string | null) => void
  setCurrentDocText: (text: string | null) => void
  setAiContextWindow: (size: number) => void
  setActiveLecture: (id: string | null) => void
  setIsRecording: (recording: boolean) => void
  setSelectedAiModel: (model: string) => void
  setAnnotationColor: (color: string) => void
  setRightPanel: (panel: 'annotation' | 'agent') => void
  setHermesHasInsight: (has: boolean) => void
  setImmersiveMode: (on: boolean) => void
  toggleDarkMode: () => void
  setDualPageMode: (on: boolean) => void
  setShowQuickOpen: (show: boolean) => void
}

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  annotationPanelCollapsed: true,
  textSelection: null,
  activeAnnotationId: null,
  searchQuery: '',
  showSettings: false,
  glmApiKeyStatus: 'checking',
  activeMemoId: null,
  sidebarTab: 'library',
  activeReadingLogDate: null,
  currentDocText: null,
  activeLectureId: null,
  isRecording: false,
  aiContextWindow: (() => { try { const v = localStorage.getItem('sj-aiContextWindow'); return v ? Number(v) : 2000 } catch { return 2000 } })(),
  selectedAiModel: 'glm:glm-4-flash',
  annotationColor: 'yellow',
  rightPanel: 'annotation',
  hermesHasInsight: false,
  immersiveMode: false,
  darkMode: (() => { try { return localStorage.getItem('sj-darkMode') === 'true' } catch { return false } })(),
  dualPageMode: (() => { try { const v = localStorage.getItem('sj-dualPageMode'); return v !== null ? v === 'true' : true } catch { return true } })(),
  showQuickOpen: false,

  toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleAnnotationPanel: () => set(s => ({ annotationPanelCollapsed: !s.annotationPanelCollapsed, rightPanel: 'annotation' as const })),
  setTextSelection: (sel) => set({ textSelection: sel, annotationPanelCollapsed: sel ? false : true, rightPanel: 'annotation' as const }),
  setActiveAnnotation: (id) => set({ activeAnnotationId: id, annotationPanelCollapsed: id ? false : true, rightPanel: 'annotation' as const }),
  clearAnnotationFocus: () => set({ activeAnnotationId: null, textSelection: null }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setShowSettings: (show) => set({ showSettings: show }),
  setGlmApiKeyStatus: (status) => set({ glmApiKeyStatus: status }),
  setActiveMemo: (id) => set({ activeMemoId: id, activeReadingLogDate: null, ...(id ? { sidebarTab: 'memos' as const } : {}) }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setActiveReadingLogDate: (date) => set({ activeReadingLogDate: date, activeMemoId: null }),
  setCurrentDocText: (text) => set({ currentDocText: text }),
  setAiContextWindow: (size) => { set({ aiContextWindow: size }); try { localStorage.setItem('sj-aiContextWindow', String(size)) } catch {} },
  setActiveLecture: (id) => set({ activeLectureId: id, activeMemoId: null, activeReadingLogDate: null }),
  setIsRecording: (recording) => set({ isRecording: recording }),
  setSelectedAiModel: (model) => set({ selectedAiModel: model }),
  toggleDarkMode: () => set(s => {
    const next = !s.darkMode
    document.documentElement.classList.toggle('dark-mode', next)
    try { localStorage.setItem('sj-darkMode', String(next)) } catch {}
    // Update title bar
    window.electronAPI?.setTitleBarTheme?.(next)
    return { darkMode: next }
  }),
  setAnnotationColor: (color) => set({ annotationColor: color }),
  setImmersiveMode: (on) => {
    const { dualPageMode } = useUiStore.getState()
    set({
      immersiveMode: on,
      sidebarCollapsed: on,
      // In single-page mode (dualPageMode=false), keep annotation panel open for side annotation
      annotationPanelCollapsed: on ? dualPageMode : true,
      rightPanel: 'annotation' as const,
    })
    // Toggle browser fullscreen
    if (on) {
      document.documentElement.requestFullscreen?.().catch(() => {})
    } else {
      document.exitFullscreen?.().catch(() => {})
    }
  },
  setDualPageMode: (on) => { set({ dualPageMode: on }); try { localStorage.setItem('sj-dualPageMode', String(on)) } catch {} },
  setShowQuickOpen: (show) => set({ showQuickOpen: show }),
  setRightPanel: (panel) => set({ rightPanel: panel, annotationPanelCollapsed: false, ...(panel === 'agent' ? { hermesHasInsight: false } : {}) }),
  setHermesHasInsight: (has) => set({ hermesHasInsight: has }),
}))
