import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { registerFileSystemIpc } from './ipc/fileSystem'
import { registerLibraryIpc } from './ipc/library'
import { registerAiApiIpc } from './ipc/aiApi'
import { registerPdfOperationsIpc } from './ipc/pdfOperations'
import { registerReadingLogIpc, startMidnightScheduler } from './ipc/readingLog'

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

// Register all IPC handlers
registerFileSystemIpc()
registerLibraryIpc()
registerAiApiIpc()
registerPdfOperationsIpc()
registerReadingLogIpc()

app.whenReady().then(() => {
  const mainWindow = createWindow()
  startMidnightScheduler(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const win = createWindow()
      startMidnightScheduler(win)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
