import { useEffect } from 'react'
import FileTree from './components/Sidebar/FileTree'
import PdfViewer from './components/PdfViewer/PdfViewer'
import AnnotationPanel from './components/AnnotationPanel/AnnotationPanel'
import MemoEditor from './components/Memo/MemoEditor'
import TopBar from './components/TopBar/TopBar'
import ErrorBoundary from './components/ErrorBoundary'
import { useLibraryStore } from './store/libraryStore'
import { useUiStore } from './store/uiStore'
import './styles/globals.css'

export default function App() {
  const { library, initLibrary } = useLibraryStore()
  const { setGlmApiKeyStatus, annotationPanelCollapsed, toggleAnnotationPanel, activeMemoId } = useUiStore()

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

        {/* Main content: Memo editor or PDF viewer */}
        {activeMemoId ? (
          <>
            <ErrorBoundary fallbackLabel="思考笔记">
              <MemoEditor />
            </ErrorBoundary>
            {!annotationPanelCollapsed && (
              <ErrorBoundary fallbackLabel="注释面板">
                <AnnotationPanel />
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (
              <button onClick={toggleAnnotationPanel} title="打开注释面板" className="floating-toggle">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
              </button>
            )}
          </>
        ) : (
          <>
            <ErrorBoundary fallbackLabel="PDF 阅读器">
              <PdfViewer />
            </ErrorBoundary>
            {!annotationPanelCollapsed && (
              <ErrorBoundary fallbackLabel="注释面板">
                <AnnotationPanel />
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (
              <button onClick={toggleAnnotationPanel} title="打开注释面板" className="floating-toggle">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
