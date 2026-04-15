import { useEffect, useState, useRef, useCallback } from 'react'
import FileTree from './components/Sidebar/FileTree'
import PdfViewer from './components/PdfViewer/PdfViewer'
import AnnotationPanel from './components/AnnotationPanel/AnnotationPanel'
import MemoEditor from './components/Memo/MemoEditor'
import ReadingLogView from './components/ReadingLog/ReadingLogView'
import LectureMode from './components/Lecture/LectureMode'
import AgentPanel from './components/Agent/AgentPanel'
import TopBar from './components/TopBar/TopBar'
import ErrorBoundary from './components/ErrorBoundary'
import { useLibraryStore } from './store/libraryStore'
import { useUiStore } from './store/uiStore'
import './styles/globals.css'

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
  const { library, initLibrary } = useLibraryStore()
  const { setGlmApiKeyStatus, annotationPanelCollapsed, toggleAnnotationPanel, activeMemoId, activeReadingLogDate, activeLectureId, rightPanel, setRightPanel } = useUiStore()

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
    <div className="app-layout">
      <TopBar />
      <div className="app-body">
        <ErrorBoundary fallbackLabel="侧栏">
          <FileTree />
        </ErrorBoundary>

        {/* Main content: Lecture / Reading log / Memo editor / PDF viewer */}
        {activeLectureId ? (
          <ErrorBoundary fallbackLabel="听课模式">
            <LectureMode />
          </ErrorBoundary>
        ) : activeReadingLogDate ? (
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
            {!annotationPanelCollapsed && rightPanel === 'agent' && (
              <ErrorBoundary fallbackLabel="Agent">
                <div style={{ width: 360, flexShrink: 0, borderLeft: '1px solid var(--border-light)', height: '100%' }}>
                  <AgentPanel />
                </div>
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
            {!annotationPanelCollapsed && rightPanel === 'annotation' && (
              <ErrorBoundary fallbackLabel="注释面板">
                <AnnotationPanel />
              </ErrorBoundary>
            )}
            {!annotationPanelCollapsed && rightPanel === 'agent' && (
              <ErrorBoundary fallbackLabel="Agent">
                <div style={{ width: 360, flexShrink: 0, borderLeft: '1px solid var(--border-light)', height: '100%' }}>
                  <AgentPanel />
                </div>
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (
              <DraggableToggle onClick={toggleAnnotationPanel} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
