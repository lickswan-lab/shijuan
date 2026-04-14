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

  // AI model
  selectedAiModel: string

  // Annotation color (for next annotation to be created)
  annotationColor: string

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
  setSelectedAiModel: (model: string) => void
  setAnnotationColor: (color: string) => void
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
  aiContextWindow: (() => { try { const v = localStorage.getItem('sj-aiContextWindow'); return v ? Number(v) : 2000 } catch { return 2000 } })(),
  selectedAiModel: 'glm:glm-4-flash',
  annotationColor: 'yellow',

  toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleAnnotationPanel: () => set(s => ({ annotationPanelCollapsed: !s.annotationPanelCollapsed })),
  setTextSelection: (sel) => set({ textSelection: sel, annotationPanelCollapsed: sel ? false : true }),
  setActiveAnnotation: (id) => set({ activeAnnotationId: id, annotationPanelCollapsed: id ? false : true }),
  clearAnnotationFocus: () => set({ activeAnnotationId: null, textSelection: null }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setShowSettings: (show) => set({ showSettings: show }),
  setGlmApiKeyStatus: (status) => set({ glmApiKeyStatus: status }),
  setActiveMemo: (id) => set({ activeMemoId: id, activeReadingLogDate: null, ...(id ? { sidebarTab: 'memos' as const } : {}) }),
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  setActiveReadingLogDate: (date) => set({ activeReadingLogDate: date, activeMemoId: null }),
  setCurrentDocText: (text) => set({ currentDocText: text }),
  setAiContextWindow: (size) => { set({ aiContextWindow: size }); try { localStorage.setItem('sj-aiContextWindow', String(size)) } catch {} },
  setSelectedAiModel: (model) => set({ selectedAiModel: model }),
  setAnnotationColor: (color) => set({ annotationColor: color })
}))
