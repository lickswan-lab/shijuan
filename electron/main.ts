import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerLibraryIpc } from './ipc/library'
import { registerAiApiIpc } from './ipc/aiApi'
import { registerReadingLogIpc, startMidnightScheduler } from './ipc/readingLog'
import { registerUpdaterIpc } from './updater'
import { registerAgentIpc } from './ipc/agent'  // Needed for Hermes memory + knowledge map
import { registerApprenticeIpc } from './ipc/apprentice'  // Hermes apprentice log (weekly observation)
import { registerDiagnosticIpc } from './ipc/diagnostic'

function createWindow(): BrowserWindow {
  // Remove default menu bar
  Menu.setApplicationMenu(null)

  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '拾卷',
    icon: join(__dirname, '../../build/icon.png'),
    show: false,
    backgroundColor: '#E9E0C8',
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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

  if (is.dev && rendererUrl) {
    mainWindow.loadURL(rendererUrl).catch((err) => {
      console.error('[main] Failed to load renderer URL:', err)
      // Fallback: try loading file
      mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch(console.error)
    })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch(console.error)
  }

  return mainWindow
}

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

  // Register all IPC handlers
  registerLibraryIpc()
  registerAiApiIpc()
  registerReadingLogIpc()
  registerAgentIpc()   // Hermes memory + tools (used by annotation AI)
  registerApprenticeIpc()  // Hermes apprentice weekly observation log
  registerUpdaterIpc()
  registerDiagnosticIpc()

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
