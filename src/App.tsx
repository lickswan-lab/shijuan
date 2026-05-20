import { useEffect, useState, useRef, useCallback, lazy, Suspense } from 'react'
import FileTree from './components/Sidebar/FileTree'

// Lazy-load heavy components for faster startup
const PdfViewer = lazy(() => import('./components/PdfViewer/PdfViewer'))
const AnnotationPanel = lazy(() => import('./components/AnnotationPanel/AnnotationPanel'))
const MemoEditor = lazy(() => import('./components/Memo/MemoEditor'))
const ReadingGraphView = lazy(() => import('./components/ReadingGraph/ReadingGraphView'))
// 2026-04-28 · ReadingLogView 已删(readingLog 功能下线)
const AgentPanel = lazy(() => import('./components/Agent/AgentPanel'))
const QuickOpenModal = lazy(() => import('./components/QuickOpen/QuickOpenModal'))
const BatchOcrRunner = lazy(() => import('./components/BatchOcr/BatchOcrRunner'))
const BatchOcrProgress = lazy(() => import('./components/BatchOcr/BatchOcrProgress'))
const OnboardingModal = lazy(() => import('./components/Onboarding/OnboardingModal'))
const FeatureTourModal = lazy(() => import('./components/Onboarding/FeatureTourModal'))
import TopBar from './components/TopBar/TopBar'
import ErrorBoundary from './components/ErrorBoundary'
import { useLibraryStore } from './store/libraryStore'
import { useUiStore } from './store/uiStore'
import { readNumber } from './utils/safeStorageRead'
import './styles/globals.css'
// katex CSS moved to components that actually render math (PdfViewer, AnnotationPanel, MemoEditor, ReadingLogView)
// to avoid eager loading on app startup

// Shared position state for the floating toggle (persists across show/hide via ref)
const floatingTogglePosRef = { current: { x: -1, y: -1 } }

function clampFloatingTogglePos(pos: { x: number; y: number }) {
  if (pos.x < 0) return pos
  return {
    x: Math.max(0, Math.min(window.innerWidth - 40, pos.x)),
    y: Math.max(36, Math.min(window.innerHeight - 40, pos.y)),
  }
}

function DraggableToggle({ onClick }: { onClick: () => void }) {
  const [pos, setPos] = useState(() => ({ ...floatingTogglePosRef.current }))
  const dragging = useRef(false)
  const moved = useRef(false)
  const startPos = useRef({ x: 0, y: 0, bx: 0, by: 0 })
  const posRef = useRef(pos)
  const bodyUserSelectRef = useRef('')
  // Hold the currently-registered drag listeners so an unmount (e.g. user
  // toggles the panel open mid-drag, which re-renders App and drops this
  // button) doesn't leave them stuck on `document`.
  const activeListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: (ev?: MouseEvent) => void } | null>(null)

  useEffect(() => {
    posRef.current = pos
  }, [pos])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    moved.current = false
    const rect = e.currentTarget.getBoundingClientRect()
    startPos.current = { x: e.clientX, y: e.clientY, bx: rect.left, by: rect.top }
    bodyUserSelectRef.current = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      ev.preventDefault()
      const dx = ev.clientX - startPos.current.x
      const dy = ev.clientY - startPos.current.y
      if (!moved.current && Math.hypot(dx, dy) < 6) return
      moved.current = true
      const next = clampFloatingTogglePos({
        x: startPos.current.bx + dx,
        y: startPos.current.by + dy,
      })
      posRef.current = next
      floatingTogglePosRef.current = next
      setPos(next)
    }
    const onUp = (ev?: MouseEvent) => {
      ev?.preventDefault()
      const shouldOpen = !moved.current
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = bodyUserSelectRef.current
      activeListenersRef.current = null
      if (shouldOpen) onClick()
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
      document.body.style.userSelect = bodyUserSelectRef.current
    }
  }, [])

  useEffect(() => {
    const clamp = () => {
      if (dragging.current) return
      const next = clampFloatingTogglePos(posRef.current)
      posRef.current = next
      floatingTogglePosRef.current = next
      setPos(next)
    }
    window.addEventListener('resize', clamp)
    window.addEventListener('shijuan-layout-change', clamp)
    return () => {
      window.removeEventListener('resize', clamp)
      window.removeEventListener('shijuan-layout-change', clamp)
    }
  }, [])

  const style: React.CSSProperties = pos.x >= 0
    ? { position: 'fixed', left: pos.x, top: pos.y, right: 'auto', zIndex: 50, width: 36, height: 36, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg-warm)', color: 'var(--text)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', touchAction: 'none', userSelect: 'none' }
    : {}

  return (
    <button
      type="button"
      className="floating-toggle"
      style={style}
      onMouseDown={handleMouseDown}
      onDragStart={(e) => e.preventDefault()}
      aria-label="打开注释栏"
      title="打开注释栏，可拖动位置"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    </button>
  )
}

export default function App() {
  // PERF R7#1 · 选择性订阅 · 原来全量解构 `useUiStore()` 会让任何 ui state 变化
  // 都 re-render App（全屏树都要过一遍 reconcile），改成每个字段独立 selector，
  // 只有读到的字段变化才触发 App 层重渲。library 同理。
  const library = useLibraryStore(s => s.library)
  const currentEntryId = useLibraryStore(s => s.currentEntry?.id || null)
  const initLibrary = useLibraryStore(s => s.initLibrary)
  const importByPaths = useLibraryStore(s => s.importByPaths)
  const clearCurrentEntry = useLibraryStore(s => s.clearCurrentEntry)
  const incrementEntryReadingTime = useLibraryStore(s => s.incrementEntryReadingTime)
  const incrementMemoWritingTime = useLibraryStore(s => s.incrementMemoWritingTime)
  const setGlmApiKeyStatus = useUiStore(s => s.setGlmApiKeyStatus)
  const annotationPanelCollapsed = useUiStore(s => s.annotationPanelCollapsed)
  const toggleAnnotationPanel = useUiStore(s => s.toggleAnnotationPanel)
  const activeMemoId = useUiStore(s => s.activeMemoId)
  const mainView = useUiStore(s => s.mainView)
  // 2026-04-28 · activeReadingLogDate 已删(readingLog 功能下线)
  const rightPanel = useUiStore(s => s.rightPanel)
  // 2026-04-28 CLEAN · immersiveMode + dualPageMode 已删(沉浸式阅读下线)
  const [dropActive, setDropActive] = useState(false)
  const [dropImportStatus, setDropImportStatus] = useState<null | { phase: 'scanning' | 'importing'; detail: string }>(null)
  const dropCounter = useRef(0)  // track nested drag enter/leave
  const dropImportingRef = useRef(false)

  useEffect(() => {
    if (!library || !currentEntryId) return
    if (!library.entries.some(entry => entry.id === currentEntryId)) {
      clearCurrentEntry()
    }
  }, [clearCurrentEntry, currentEntryId, library])

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
      if (ctrl && e.key.toLowerCase() === 'n' && !shift) {
        e.preventDefault()
        if (e.repeat) return
        useUiStore.getState().setSidebarTab('memos')
        void useLibraryStore.getState().createMemo().then(memo => {
          useUiStore.getState().setActiveMemo(memo.id)
        }).catch(err => {
          console.error('[shortcut:new-memo] failed:', err)
        })
        return
      }

      // Ctrl+J → Toggle annotation panel
      if (ctrl && e.key === 'j') {
        e.preventDefault()
        useUiStore.getState().toggleAnnotationPanel()
        return
      }

      // Ctrl+1/2 → Switch sidebar tabs (Ctrl+3 reading-log removed 2026-04-28)
      if (ctrl && e.key === '1' && !isEditing) { e.preventDefault(); useUiStore.getState().setSidebarTab('library'); return }
      if (ctrl && e.key === '2' && !isEditing) { e.preventDefault(); useUiStore.getState().setSidebarTab('memos'); return }
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
    if (dropImportingRef.current) return

    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    dropImportingRef.current = true
    setDropImportStatus({ phase: 'scanning', detail: '正在读取拖入的文件...' })

    // Get file paths using Electron's webUtils API (File.path is deprecated in Electron 28+)
    const rawPaths: string[] = []
    try {
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

      // Expand folders + filter supported types via main process
      const resolved = window.electronAPI?.scanDroppedPaths
        ? await window.electronAPI.scanDroppedPaths(rawPaths)
        : rawPaths.filter(p => /\.(pdf|docx?|epub|html?|txt|md)$/i.test(p))

      if (resolved.length > 0) {
        setDropImportStatus({ phase: 'importing', detail: `正在导入 ${resolved.length} 个文件...` })
        const added = await importByPaths(resolved)
        if (added > 0) {
          // Switch to library tab to show imported files
          useUiStore.getState().setSidebarTab('library')
        }
      }
    } catch (err) {
      console.error('[drag-drop] error:', err)
    } finally {
      dropImportingRef.current = false
      setDropImportStatus(null)
    }
  }, [importByPaths])

  // Apply dark mode on mount
  useEffect(() => {
    const dark = useUiStore.getState().darkMode
    document.documentElement.classList.toggle('dark-mode', dark)
    window.electronAPI?.setTitleBarTheme?.(dark)
  }, [])

  // Track active reading/writing time as feedback for the graph. The timer only
  // counts when the app is visible and the main reader/memo surface is open.
  useEffect(() => {
    if (mainView !== 'reader') return
    const target = activeMemoId
      ? { kind: 'memo' as const, id: activeMemoId }
      : currentEntryId
        ? { kind: 'entry' as const, id: currentEntryId }
        : null
    if (!target) return

    let lastTick = Date.now()
    let bufferedMs = 0

    const flush = () => {
      if (bufferedMs < 1000) return
      const ms = bufferedMs
      bufferedMs = 0
      if (target.kind === 'memo') {
        incrementMemoWritingTime(target.id, ms)
      } else {
        incrementEntryReadingTime(target.id, ms)
      }
    }

    const tick = () => {
      const now = Date.now()
      if (document.hidden) {
        lastTick = now
        return
      }
      const delta = Math.max(0, Math.min(now - lastTick, 30_000))
      lastTick = now
      bufferedMs += delta
      if (bufferedMs >= 15_000) flush()
    }

    const timer = setInterval(tick, 5_000)
    const onVisibility = () => {
      if (document.hidden) flush()
      lastTick = Date.now()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', flush)
    return () => {
      flush()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', flush)
    }
  }, [mainView, activeMemoId, currentEntryId, incrementEntryReadingTime, incrementMemoWritingTime])

  // 2026-04-28 · onLibraryChangedOnDisk + reloadReadingLogsFromDisk 已删
  //   (readingLog 功能下线,midnight scheduler 也跟着删了,不再有"主进程改库"事件)

  // Init library on mount
  // BUG-FIX R8#10 · 原 R2 观察项第 2 条:setTimeout(openEntry, 300) 无清理 + 不防 race。
  //   两个问题:
  //   1) 组件 unmount 时 timer 未取消 — orphaned timer(单次启动 renderer 通常不卸载,
  //      但 Ctrl+Shift+R reload 之间瞬间会有);
  //   2) 用户 300ms 内手动 openEntry,再 fire 这个 timer 会 double-open(覆盖用户主动选择)。
  //   修法:timer handle 跟踪 + cleanup 取消 + fire 时检查 currentEntry 已设就跳过。
  useEffect(() => {
    let cancelled = false
    let restoreTimer: ReturnType<typeof setTimeout> | null = null
    initLibrary().then(() => {
      if (cancelled) return
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
      restoreTimer = setTimeout(() => {
        restoreTimer = null
        if (cancelled) return
        // 用户 300ms 内已经手动开了文献 → 跳过 auto-restore,尊重用户选择
        if (useLibraryStore.getState().currentEntry) return
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

    // 2026-04-28 · readingLog 功能已删,onReadingLogGenerated listener 也删。
    //   原本 update-check setTimeout 被嵌在该 listener 块里(意外耦合),拆出来独立跑。
    let updateCheckTimer: ReturnType<typeof setTimeout> | null = null
    // Background update check: only if ≥ 24h since last check (avoid hitting GitHub
    // on every startup). Runs 3s after mount so initial render isn't blocked.
    // BUG-FIX R8#10 · 之前 setTimeout handle 没跟踪,renderer reload 时 timer 漏。
    updateCheckTimer = setTimeout(() => {
      updateCheckTimer = null
      if (cancelled) return
      try {
        // BUG-FIX R8#8 · NaN 防御:坏数据时 last=0 → 总是触发检查(预期行为)
        const last = readNumber('sj-lastUpdateCheck', 0)
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
    // BUG-FIX R8#10 · 统一 cleanup:取消 cancelled 标志 + 两个 timer
    return () => {
      cancelled = true
      if (restoreTimer !== null) clearTimeout(restoreTimer)
      if (updateCheckTimer !== null) clearTimeout(updateCheckTimer)
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
      {(dropActive || dropImportStatus) && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            {dropImportStatus ? (
              <span className="loading-spinner" style={{ width: 34, height: 34, borderWidth: 3 }} />
            ) : (
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            )}
            <span>{dropImportStatus ? dropImportStatus.detail : '松开以导入文献'}</span>
            <span style={{ fontSize: 12, opacity: 0.6 }}>支持 PDF、DOCX、EPUB、HTML、TXT、Markdown</span>
          </div>
        </div>
      )}
      <TopBar />
      <div className="app-body">
        <ErrorBoundary fallbackLabel="侧栏">
          <FileTree />
        </ErrorBoundary>

        {/* Main content: Memo editor / PDF viewer (lazy-loaded)
            2026-04-28 · ReadingLogView 分支已删(readingLog 功能下线) */}
        <Suspense fallback={<div className="empty-state"><span className="loading-spinner" /></div>}>
        {mainView === 'graph' ? (
          <ErrorBoundary fallbackLabel="阅读图谱">
            <ReadingGraphView />
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
              <ErrorBoundary fallbackLabel="学徒面板">
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
            {!annotationPanelCollapsed && rightPanel === 'annotation' && (
              <ErrorBoundary fallbackLabel="注释面板">
                <AnnotationPanel />
              </ErrorBoundary>
            )}
            {!annotationPanelCollapsed && rightPanel === 'agent' && (
              <ErrorBoundary fallbackLabel="学徒面板">
                <AgentPanel />
              </ErrorBoundary>
            )}
            {annotationPanelCollapsed && (
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

      {/* First-launch nudge: shown once when no AI provider is configured. */}
      <Suspense fallback={null}>
        <OnboardingModal />
      </Suspense>

      {/* Feature tour: 6-step walkthrough that fires the first boot after the
          user has any AI key configured (导入 / OCR / 划线 / 注释 / 学徒对话 / 召唤).
          Re-triggerable from Settings via setForceFeatureTour(true). */}
      <Suspense fallback={null}>
        <FeatureTourModal />
      </Suspense>
    </div>
  )
}
