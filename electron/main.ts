import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerFileSystemIpc } from './ipc/fileSystem'
import { registerLibraryIpc } from './ipc/library'
import { registerAiApiIpc } from './ipc/aiApi'
import { registerPdfOperationsIpc } from './ipc/pdfOperations'
import { registerReadingLogIpc, startMidnightScheduler } from './ipc/readingLog'
import { registerLectureIpc } from './ipc/lecture'
import { registerAgentIpc } from './ipc/agent'

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
    backgroundColor: '#F7F3EA',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#F7F3EA',
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
        color: dark ? '#1a1a20' : '#F7F3EA',
        symbolColor: dark ? '#e0ddd5' : '#3D3529',
      })
      mainWindow.setBackgroundColor(dark ? '#1a1a20' : '#F7F3EA')
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

// ===== Single instance lock — prevent opening multiple copies =====
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // Another instance is already running, quit immediately
  app.quit()
} else {
  app.on('second-instance', () => {
    // User tried to open a second instance — focus existing window
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const win = wins[0]
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  // Register all IPC handlers
  registerFileSystemIpc()
  registerLibraryIpc()
  registerAiApiIpc()
  registerPdfOperationsIpc()
  registerReadingLogIpc()
  registerLectureIpc()
  registerAgentIpc()

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
      // Show error dialog if app fails to start (e.g. missing runtime libraries)
      dialog.showErrorBox(
        '拾卷启动失败',
        `应用无法启动，可能缺少运行库。\n\n请尝试安装 Visual C++ 运行库：\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe\n\n错误信息：${err?.message || err}`
      )
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()  // Always quit when all windows closed (including macOS)
  })
}
