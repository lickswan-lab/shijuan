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
import { registerUpdaterIpc } from './updater'

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

// ===== Single instance lock =====
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // dialog can only be used after app is ready
  app.whenReady().then(() => {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: '拾卷',
      message: '拾卷已经在运行中',
      detail: '检测到拾卷已有一个实例正在运行。\n\n你可以结束旧进程并重新启动，或者取消本次启动去找到已打开的窗口。',
      buttons: ['结束旧进程并重启', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 0) {
      app.releaseSingleInstanceLock()
      app.relaunch()
    }
    app.quit()
  })
} else {
  app.on('second-instance', () => {
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
  registerUpdaterIpc()

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
