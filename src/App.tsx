import { useEffect, useState, useRef, useCallback } from 'react'
import FileTree from './components/Sidebar/FileTree'
import PdfViewer from './components/PdfViewer/PdfViewer'
import AnnotationPanel from './components/AnnotationPanel/AnnotationPanel'
import MemoEditor from './components/Memo/MemoEditor'
import ReadingLogView from './components/ReadingLog/ReadingLogView'
// Shelved: import LectureMode from './components/Lecture/LectureMode'
// Shelved: import AgentPanel from './components/Agent/AgentPanel'
import TopBar from './components/TopBar/TopBar'
import ErrorBoundary from './components/ErrorBoundary'
import { useLibraryStore } from './store/libraryStore'
import { useUiStore } from './store/uiStore'
import './styles/globals.css'
import 'katex/dist/katex.min.css'

// Shared position state for the floating toggle (persists across show/hide)
const floatingTogglePos = { x: -1, y: -1 }

function DraggableToggle({ onClick }: { onClick: () => void }) {
  const [pos, setPos] = useState({ x: floatingTogglePos.x, y: floatingTogglePos.y })
  const dragging = useRef(false)
  const moved = useRef(false)
  const startPos = useRef({ x: 0, y: 0, bx: 0, by: 0 })

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true
    moved.current = false
    const rect = e.currentTarget.getBoundingClientRect()
    startPos.current = { x: e.clientX, y: e.clientY, bx: rect.left, by: rect.top }

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const dx = ev.clientX - startPos.current.x
      const dy = ev.clientY - startPos.current.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true
      const nx = Math.max(0, Math.min(window.innerWidth - 40, startPos.current.bx + dx))
      const ny = Math.max(36, Math.min(window.innerHeight - 40, startPos.current.by + dy))
      setPos({ x: nx, y: ny })
      floatingTogglePos.x = nx
      floatingTogglePos.y = ny
    }
    const onUp = () => {
      dragging.current = false
      if (!moved.current) onClick()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onClick])

  const style: React.CSSProperties = pos.x >= 0
    ? { position: 'fixed', left: pos.x, top: pos.y, right: 'auto', zIndex: 50, width: 36, height: 36, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }
    : {}

  return (
    <button
      className={pos.x < 0 ? 'floating-toggle' : ''}
      style={style}
      onMouseDown={handleMouseDown}
      title="打开注释面板（可拖拽移动）"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    </button>
  )
}

export default function App() {
  const { library, initLibrary, importByPaths } = useLibraryStore()
  const { setGlmApiKeyStatus, annotationPanelCollapsed, toggleAnnotationPanel, activeMemoId, activeReadingLogDate, activeLectureId, rightPanel, setRightPanel, immersiveMode, dualPageMode } = useUiStore()
  const [dropActive, setDropActive] = useState(false)
  const dropCounter = useRef(0)  // track nested drag enter/leave

  // ===== Global keyboard shortcuts =====
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey

      // Don't intercept when typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName
      const isEditing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable

      // Ctrl+, → Open settings
      if (ctrl && e.key === ',') {
        e.preventDefault()
        useUiStore.getState().setShowSettings(true)
        return
      }

      // Ctrl+B → Toggle sidebar
      if (ctrl && e.key === 'b' && !shift) {
        e.preventDefault()
        useUiStore.getState().toggleSidebar()
        return
      }

      // Ctrl+Shift+F → Focus search (full-text)
      if (ctrl && shift && e.key === 'F') {
        e.preventDefault()
        useUiStore.getState().setSidebarTab('library')
        // Focus the search input
        setTimeout(() => {
          const input = document.querySelector('.sidebar input[type="text"]') as HTMLInputElement
          if (input) { input.focus(); input.select() }
        }, 50)
        return
      }

      // Ctrl+D → Toggle dark mode
      if (ctrl && e.key === 'd' && !isEditing) {
        e.preventDefault()
        useUiStore.getState().toggleDarkMode()
        return
      }

      // Ctrl+O → Import files
      if (ctrl && e.key === 'o') {
        e.preventDefault()
        useLibraryStore.getState().importFiles()
        return
      }

      // Ctrl+N → New memo
      if (ctrl && e.key === 'n' && !shift) {
        e.preventDefault()
        useUiStore.getState().setSidebarTab('memos')
        useLibraryStore.getState().createMemo()
        return
      }

      // Ctrl+J → Toggle annotation panel
      if (ctrl && e.key === 'j') {
        e.preventDefault()
        useUiStore.getState().toggleAnnotationPanel()
        return
      }

      // Ctrl+1/2/3 → Switch sidebar tabs
      if (ctrl && e.key === '1' && !isEditing) { e.preventDefault(); useUiStore.getState().setSidebarTab('library'); return }
      if (ctrl && e.key === '2' && !isEditing) { e.preventDefault(); useUiStore.getState().setSidebarTab('memos'); return }
      if (ctrl && e.key === '3' && !isEditing) { e.preventDefault(); useUiStore.getState().setSidebarTab('reading-log'); return }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Global drag-drop file import
  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Only respond to external file drops (not internal app drags)
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      dropCounter.current++
      setDropActive(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    dropCounter.current--
    if (dropCounter.current <= 0) {
      dropCounter.current = 0
      setDropActive(false)
    }
  }, [])

  const SUPPORTED_EXTS = /\.(pdf|docx?|epub|html?|txt|md)$/i

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    dropCounter.current = 0
    setDropActive(false)

    const files = e.dataTransfer.files
    if (!files || files.length === 0) return

    // Get file paths using Electron's webUtils API (File.path is deprecated in Electron 28+)
    const rawPaths: string[] = []
    for (let i = 0; i < files.length; i++) {
      try {
        const p = window.electronAPI.getPathForFile(files[i])
        if (p) rawPaths.push(p)
      } catch {
        // Fallback: try legacy .path property
        const p = (files[i] as any).path
        if (p) rawPaths.push(p)
      }
    }

    if (rawPaths.length === 0) return

    try {
      // Expand folders + filter supported types via main process
      const resolved = window.electronAPI?.scanDroppedPaths
        ? await window.electronAPI.scanDroppedPaths(rawPaths)
        : rawPaths.filter(p => /\.(pdf|docx?|epub|html?|txt|md)$/i.test(p))

      if (resolved.length > 0) {
        const added = await importByPaths(resolved)
        if (added > 0) {
          // Switch to library tab to show imported files
          useUiStore.getState().setSidebarTab('library')
        }
      }
    } catch (err) {
      console.error('[drag-drop] error:', err)
    }
  }, [importByPaths])

  // Apply dark mode on mount
  useEffect(() => {
    const dark = useUiStore.getState().darkMode
    document.documentElement.classList.toggle('dark-mode', dark)
    window.electronAPI?.setTitleBarTheme?.(dark)
  }, [])

  // Init library on mount
  useEffect(() => {
    initLibrary()
    if (window.electronAPI?.getGlmApiKeyStatus) {
      window.electronAPI.getGlmApiKeyStatus().then(status => {
        setGlmApiKeyStatus(status)
      }).catch(() => setGlmApiKeyStatus('not-set'))
    } else {
      setGlmApiKeyStatus('not-set')
    }

    // Listen for midnight reading log generation
    if (window.electronAPI?.onReadingLogGenerated) {
      const cleanup = window.electronAPI.onReadingLogGenerated((log) => {
        const { library } = useLibraryStore.getState()
        if (library) {
          useLibraryStore.getState().saveReadingLog(log)
        }
      })
      return cleanup
    }
  }, [])

  if (!library) {
    return (
      <div className="app-layout">
        <TopBar />
        <div className="welcome">
          <span className="loading-spinner" />
          <span style={{ marginTop: 8 }}>加载中...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="app-layout"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dropActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>松开以导入文献</span>
            <span style={{ fontSize: 12, opacity: 0.6 }}>支持 PDF、DOCX、EPUB、HTML、TXT、Markdown</span>
          </div>
        </div>
      )}
      {!immersiveMode && <TopBar />}
      <div className="app-body">
        {!immersiveMode && (
          <ErrorBoundary fallbackLabel="侧栏">
            <FileTree />
          </ErrorBoundary>
        )}

        {/* Main content: Reading log / Memo editor / PDF viewer */}
        {activeReadingLogDate ? (
          <ErrorBoundary fallbackLabel="阅读日志">
            <ReadingLogView />
          </ErrorBoundary>
        ) : activeMemoId ? (
          <>
            <ErrorBoundary fallbackLabel="笔记">
              <MemoEditor />
            </ErrorBoundary>
            {!annotationPanelCollapsed && rightPanel === 'annotation' && (
              <ErrorBoundary fallbackLabel="注释面板">
                <AnnotationPanel />
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (
              <DraggableToggle onClick={toggleAnnotationPanel} />
            )}
          </>
        ) : (
          <>
            <ErrorBoundary fallbackLabel="PDF 阅读器">
              <PdfViewer />
            </ErrorBoundary>
            {(!immersiveMode || !dualPageMode) && !annotationPanelCollapsed && rightPanel === 'annotation' && (
              <ErrorBoundary fallbackLabel="注释面板">
                <AnnotationPanel />
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (!immersiveMode || !dualPageMode) && (
              <DraggableToggle onClick={toggleAnnotationPanel} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
