import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerLibraryIpc } from './ipc/library'
import { registerAiApiIpc } from './ipc/aiApi'
import { registerReadingLogIpc, startMidnightScheduler } from './ipc/readingLog'
import { registerUpdaterIpc } from './updater'
import { registerAgentIpc } from './ipc/agent'  // Needed for Hermes memory + knowledge map
import { registerApprenticeIpc } from './ipc/apprentice'  // Hermes apprentice log (weekly observation)
import { registerDiagnosticIpc, appendCrashLog } from './ipc/diagnostic'
import { registerPersonasIpc } from './ipc/personas'  // 召唤 — persona archives with multi-source web search

// Fire-and-forget startup logger. main.ts can't reliably emit IPC during
// boot, so we just write straight to ~/.lit-manager/crash.log. Errors are
// swallowed inside appendCrashLog itself.
function logStartup(msg: string, extra?: Record<string, unknown>): void {
  const text = extra ? `[startup] ${msg} ${JSON.stringify(extra)}` : `[startup] ${msg}`
  console.log(text)
  void appendCrashLog(text)
}

function createWindow(): BrowserWindow {
  // Hide the menu bar but KEEP Edit roles so Ctrl+C / Ctrl+V / Ctrl+X / Ctrl+A
  // keep working on selected text. Previously we called
  // `Menu.setApplicationMenu(null)` which stripped every accelerator
  // registered by the default menu — that's why users reported "can't copy
  // selected text with Ctrl+C". Electron binds the clipboard shortcuts
  // through the Edit menu's role items, so the menu has to exist even when
  // it's not visible. We pair this with `autoHideMenuBar: true` below so
  // the bar itself never shows up.
  const editMenu = Menu.buildFromTemplate([
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ])
  Menu.setApplicationMenu(editMenu)

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '拾卷',
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    backgroundColor: '#E9E0C8',
    autoHideMenuBar: true,  // Hide the Edit menu bar — shortcuts still fire
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#E9E0C8',
      symbolColor: '#3D3529',
      height: 36
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false  // Allow loading local PDF files
    }
  })

  // Failsafe: if `ready-to-show` never fires (renderer crashed before first
  // paint, preload threw, asar path wrong, etc.) the window stays hidden
  // forever and the user sees a process-only black hole. After 8s force-show
  // anyway and log it — the user gets at minimum a window with a useful
  // error to screenshot, and crash.log records what happened so we can
  // post-mortem.
  const FORCE_SHOW_MS = 8000
  let readyToShowFired = false
  const forceShowTimer = setTimeout(() => {
    if (mainWindow.isDestroyed() || readyToShowFired) return
    logStartup('ready-to-show did not fire within 8s, forcing window.show()', {
      url: mainWindow.webContents.getURL() || '(empty)',
      isLoading: mainWindow.webContents.isLoading(),
    })
    try { mainWindow.show() } catch { /* destroyed mid-flight */ }
  }, FORCE_SHOW_MS)

  mainWindow.on('ready-to-show', () => {
    readyToShowFired = true
    clearTimeout(forceShowTimer)
    mainWindow.show()
  })

  mainWindow.on('closed', () => {
    clearTimeout(forceShowTimer)
  })

  // Surface load failures. Without these the loadFile() promise rejects
  // silently into a `console.error` no one ever sees, and the window stays
  // hidden by `show: false`. Now we log it, force the window visible, and
  // pop a dialog so the user knows what happened.
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return  // sub-frame failures are not fatal
    logStartup('did-fail-load (main frame)', { errorCode, errorDescription, validatedURL })
    try {
      if (!mainWindow.isVisible()) mainWindow.show()
      dialog.showErrorBox(
        '拾卷加载失败',
        `渲染进程加载失败 (code ${errorCode}): ${errorDescription}\nURL: ${validatedURL}`
      )
    } catch { /* dialog blew up too, nothing more to do */ }
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logStartup('render-process-gone', { reason: details.reason, exitCode: details.exitCode })
    try {
      if (!mainWindow.isVisible()) mainWindow.show()
      dialog.showErrorBox(
        '拾卷渲染进程崩溃',
        `渲染进程已退出。\nReason: ${details.reason}\nExit code: ${details.exitCode}`
      )
    } catch { /* fine */ }
  })

  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    logStartup('preload-error', { preloadPath, error: String(error) })
  })

  // Dark mode: update title bar overlay color
  ipcMain.on('set-title-bar-theme', (_event, dark: boolean) => {
    try {
      mainWindow.setTitleBarOverlay({
        color: dark ? '#1a1a20' : '#E9E0C8',
        symbolColor: dark ? '#e0ddd5' : '#3D3529',
      })
      mainWindow.setBackgroundColor(dark ? '#1a1a20' : '#E9E0C8')
    } catch {}
  })

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Open devtools detached to avoid focus stealing
  if (is.dev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // Dev mode: load from Vite dev server; Prod: load from file
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  console.log('[main] is.dev:', is.dev, 'ELECTRON_RENDERER_URL:', rendererUrl)

  const indexFile = join(__dirname, '../renderer/index.html')
  if (is.dev && rendererUrl) {
    mainWindow.loadURL(rendererUrl).catch((err) => {
      logStartup('loadURL failed, falling back to loadFile', { err: String(err), url: rendererUrl })
      mainWindow.loadFile(indexFile).catch((err2) => {
        logStartup('loadFile fallback ALSO failed', { err: String(err2), file: indexFile })
      })
    })
  } else {
    mainWindow.loadFile(indexFile).catch((err) => {
      logStartup('loadFile failed', { err: String(err), file: indexFile })
    })
  }

  return mainWindow
}

// ===== Process-level traps =====
// Catch anything that escapes a try/catch (including async errors from IPC
// handler registration) and write it to crash.log. Without this, a throw in
// e.g. registerPersonasIpc() would tear down main with no record except
// stderr — which is invisible when launched from a Start menu shortcut.
process.on('uncaughtException', (err) => {
  const msg = `[uncaughtException] ${err?.stack || err?.message || String(err)}`
  console.error(msg)
  void appendCrashLog(msg)
})
process.on('unhandledRejection', (reason) => {
  const r = reason as { stack?: string; message?: string } | undefined
  const msg = `[unhandledRejection] ${r?.stack || r?.message || String(reason)}`
  console.error(msg)
  void appendCrashLog(msg)
})

logStartup(`boot v${app.getVersion?.() ?? '?'} pid=${process.pid} platform=${process.platform} arch=${process.arch}`)

// ===== Single instance lock =====
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // Another instance is running — it will auto-focus its window via second-instance event
  app.quit()
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const win = wins[0]
      if (win.isMinimized()) win.restore()
      win.focus()
      win.flashFrame(true)
      setTimeout(() => win.flashFrame(false), 3000)
    }
  })

  // Register all IPC handlers. Each in its own try/catch so a single bad
  // module (e.g. native dep failing to load) can't black-hole the whole boot.
  // The crash log records which one died, so we can ship without that
  // feature instead of hanging on a hidden window.
  // (const arrow rather than `function` decl so we don't trip the
  //  "no nested function decls in strict mode under ES5 target" rule
  //  in tsconfig.node.json.)
  const safeRegister = (name: string, fn: () => void): void => {
    try { fn() } catch (err: any) {
      logStartup(`IPC register failed: ${name}`, { err: err?.stack || String(err) })
    }
  }
  safeRegister('library', registerLibraryIpc)
  safeRegister('aiApi', registerAiApiIpc)
  safeRegister('readingLog', registerReadingLogIpc)
  safeRegister('agent', registerAgentIpc)
  safeRegister('apprentice', registerApprenticeIpc)
  safeRegister('personas', registerPersonasIpc)
  safeRegister('updater', registerUpdaterIpc)
  safeRegister('diagnostic', registerDiagnosticIpc)

  app.whenReady().then(() => {
    try {
      const mainWindow = createWindow()
      startMidnightScheduler(mainWindow)

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          const win = createWindow()
          startMidnightScheduler(win)
        }
      })
    } catch (err: any) {
      dialog.showErrorBox(
        '拾卷启动失败',
        `应用无法启动，可能缺少运行库。\n\n请尝试安装 Visual C++ 运行库：\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe\n\n错误信息：${err?.message || err}`
      )
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
