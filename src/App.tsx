import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react'
import FileTree from './components/Sidebar/FileTree'

// Lazy-load heavy components for faster startup
const PdfViewer = lazy(() => import('./components/PdfViewer/PdfViewer'))
const AnnotationPanel = lazy(() => import('./components/AnnotationPanel/AnnotationPanel'))
const MemoEditor = lazy(() => import('./components/Memo/MemoEditor'))
const ReadingLogView = lazy(() => import('./components/ReadingLog/ReadingLogView'))
const AgentPanel = lazy(() => import('./components/Agent/AgentPanel'))
const QuickOpenModal = lazy(() => import('./components/QuickOpen/QuickOpenModal'))
const BatchOcrRunner = lazy(() => import('./components/BatchOcr/BatchOcrRunner'))
const BatchOcrProgress = lazy(() => import('./components/BatchOcr/BatchOcrProgress'))
import TopBar from './components/TopBar/TopBar'
import ErrorBoundary from './components/ErrorBoundary'
import { useLibraryStore } from './store/libraryStore'
import { useUiStore } from './store/uiStore'
import './styles/globals.css'
// katex CSS moved to components that actually render math (PdfViewer, AnnotationPanel, MemoEditor, ReadingLogView)
// to avoid eager loading on app startup

// Shared position state for the floating toggle (persists across show/hide via ref)
const floatingTogglePosRef = { current: { x: -1, y: -1 } }

function DraggableToggle({ onClick }: { onClick: () => void }) {
  const [pos, setPos] = useState(() => ({ ...floatingTogglePosRef.current }))
  const dragging = useRef(false)
  const moved = useRef(false)
  const startPos = useRef({ x: 0, y: 0, bx: 0, by: 0 })
  // Hold the currently-registered drag listeners so an unmount (e.g. user
  // toggles the panel open mid-drag, which re-renders App and drops this
  // button) doesn't leave them stuck on `document`.
  const activeListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null)

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
      floatingTogglePosRef.current = { x: nx, y: ny }
    }
    const onUp = () => {
      dragging.current = false
      if (!moved.current) onClick()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      activeListenersRef.current = null
    }
    activeListenersRef.current = { move: onMove, up: onUp }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onClick])

  // Unmount safety-net: if the toggle is pulled from the DOM while the user is
  // still holding the mouse button, the mouseup listener would otherwise never
  // fire and stay attached to `document` forever, quietly breaking future drags.
  useEffect(() => {
    return () => {
      const listeners = activeListenersRef.current
      if (listeners) {
        document.removeEventListener('mousemove', listeners.move)
        document.removeEventListener('mouseup', listeners.up)
        activeListenersRef.current = null
      }
    }
  }, [])

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
  const { setGlmApiKeyStatus, annotationPanelCollapsed, toggleAnnotationPanel, activeMemoId, activeReadingLogDate, rightPanel, immersiveMode, dualPageMode } = useUiStore()
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

      // Ctrl+P → Quick open (search entries + memos)
      if (ctrl && e.key === 'p' && !shift) {
        e.preventDefault()
        useUiStore.getState().setShowQuickOpen(true)
        return
      }

      // Esc → Clear search highlight (if any)
      if (e.key === 'Escape' && !isEditing) {
        const sh = useUiStore.getState().searchHighlight
        if (sh) {
          e.preventDefault()
          useUiStore.getState().setSearchHighlight(null)
          return
        }
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

  // Main-process nudge: midnight scheduler wrote a reading log to library.json
  // directly. Reload just the readingLogs slice so our next saveLibrary() doesn't
  // overwrite what it wrote.
  useEffect(() => {
    const off = window.electronAPI.onLibraryChangedOnDisk?.(() => {
      useLibraryStore.getState().reloadReadingLogsFromDisk()
    })
    return () => { if (off) off() }
  }, [])

  // Init library on mount
  useEffect(() => {
    initLibrary().then(() => {
      // Auto-restore last-opened entry (if file still exists).
      // Opt-out: user can disable via localStorage sj-noAutoRestore = "true"
      try {
        if (localStorage.getItem('sj-noAutoRestore') === 'true') return
      } catch { return }
      const lib = useLibraryStore.getState().library
      if (!lib) return
      // Find most recently opened entry (by lastOpenedAt), ignoring the session we
      // just updated in initLibrary. Use a 5-minute fudge window to tolerate that update.
      const entries = lib.entries || []
      if (entries.length === 0) return
      const mostRecent = entries
        .filter(e => e.lastOpenedAt)
        .sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''))[0]
      if (!mostRecent) return
      // Only restore if opened within the last 14 days — avoids auto-opening
      // something the user hasn't touched in months.
      const ageDays = (Date.now() - new Date(mostRecent.lastOpenedAt!).getTime()) / 86400000
      if (ageDays > 14) return
      setTimeout(() => {
        useLibraryStore.getState().openEntry(mostRecent).catch(() => { /* file gone — fine */ })
      }, 300)
    })
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
      // Background update check: only if ≥ 24h since last check (avoid hitting GitHub
      // on every startup). Runs 3s after mount so initial render isn't blocked.
      setTimeout(() => {
        try {
          const last = Number(localStorage.getItem('sj-lastUpdateCheck') || '0')
          if (Date.now() - last < 24 * 3600 * 1000) return
          if (!window.electronAPI?.checkUpdate) return
          window.electronAPI.checkUpdate().then(res => {
            localStorage.setItem('sj-lastUpdateCheck', String(Date.now()))
            if (res.hasUpdate) {
              useUiStore.getState().setUpdateAvailable({
                version: res.latestVersion,
                downloadUrl: res.downloadUrl,
                asarSize: res.asarSize,
              })
            }
          }).catch(() => { /* silent — don't bother user if network flakes */ })
        } catch { /* ignore localStorage errors */ }
      }, 3000)
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

        {/* Main content: Reading log / Memo editor / PDF viewer (lazy-loaded) */}
        <Suspense fallback={<div className="empty-state"><span className="loading-spinner" /></div>}>
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
            {!annotationPanelCollapsed && rightPanel === 'agent' && (
              <ErrorBoundary fallbackLabel="Hermes Agent">
                <AgentPanel />
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
            {(!immersiveMode || !dualPageMode) && !annotationPanelCollapsed && rightPanel === 'agent' && (
              <ErrorBoundary fallbackLabel="Hermes Agent">
                <AgentPanel />
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (!immersiveMode || !dualPageMode) && (
              <DraggableToggle onClick={toggleAnnotationPanel} />
            )}
          </>
        )}
        </Suspense>
      </div>

      {/* Quick open modal (Ctrl+P) */}
      <Suspense fallback={null}>
        <QuickOpenModal />
      </Suspense>

      {/* Batch OCR: headless runner + floating progress bar */}
      <Suspense fallback={null}>
        <BatchOcrRunner />
        <BatchOcrProgress />
      </Suspense>
    </div>
  )
}
