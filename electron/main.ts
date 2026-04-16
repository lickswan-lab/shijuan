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

// ===== Built-in browser for resource downloading =====
// Uses BrowserWindow directly — loads URLs like a real browser, with IPC for scan/download
let resourceBrowserWin: BrowserWindow | null = null

function openResourceBrowser(parentWindow: BrowserWindow, startUrl?: string) {
  // Reuse existing window if open
  if (resourceBrowserWin && !resourceBrowserWin.isDestroyed()) {
    resourceBrowserWin.focus()
    if (startUrl) resourceBrowserWin.loadURL(startUrl)
    return resourceBrowserWin
  }

  resourceBrowserWin = new BrowserWindow({
    width: 1100,
    height: 800,
    title: '拾卷 - 在线获取资源',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:resource-browser', // Keep login sessions
    },
  })

  // Load the start URL or a blank page
  const url = startUrl || 'https://www.google.com'
  resourceBrowserWin.loadURL(url)

  // Handle downloads — save to ~/.lit-manager/downloads/ and notify main window
  const { session } = resourceBrowserWin.webContents
  session.on('will-download', (_event, item) => {
    const downloadsDir = join(app.getPath('home'), '.lit-manager', 'downloads')
    require('fs').mkdirSync(downloadsDir, { recursive: true })
    const fileName = item.getFilename().replace(/[<>:"/\\|?*]/g, '_')
    item.setSavePath(join(downloadsDir, fileName))
    item.on('done', (_e, state) => {
      if (state === 'completed') {
        parentWindow.webContents.send('resource-downloaded', join(downloadsDir, fileName))
      }
    })
  })

  resourceBrowserWin.on('closed', () => { resourceBrowserWin = null })
  return resourceBrowserWin
}

// IPC: open browser
ipcMain.on('open-resource-browser', (_event, startUrl?: string) => {
  const wins = BrowserWindow.getAllWindows()
  const parent = wins.find(w => w.title === '拾卷') || wins[0]
  if (parent) openResourceBrowser(parent, startUrl)
})

// IPC: scan current page for downloadable resources
ipcMain.handle('scan-browser-resources', async () => {
  if (!resourceBrowserWin || resourceBrowserWin.isDestroyed()) return { success: false, resources: [] }
  try {
    const resources = await resourceBrowserWin.webContents.executeJavaScript(`
      (function() {
        var exts = /\\.(pdf|epub|docx?|txt|md|mobi|djvu|pptx?|xlsx?)$/i;
        var results = [];
        var seen = new Set();
        document.querySelectorAll('a[href]').forEach(function(a) {
          var href = a.href;
          if (!href || seen.has(href)) return;
          var m = href.match(exts);
          if (m) { seen.add(href); results.push({url:href, name:a.textContent.trim()||href.split('/').pop(), ext:m[1].toLowerCase()}); }
        });
        var direct = document.body.innerHTML.match(/https?:\\/\\/[^\\s"'<>]+\\.(pdf|epub|docx?|txt|md)/gi) || [];
        direct.forEach(function(l) { if(!seen.has(l)){seen.add(l); var e=l.match(/\\.(\\w+)$/); results.push({url:l,name:l.split('/').pop().split('?')[0],ext:e?e[1].toLowerCase():''})} });
        return results;
      })()
    `)
    return { success: true, resources, url: resourceBrowserWin.webContents.getURL(), title: resourceBrowserWin.getTitle() }
  } catch (err: any) {
    return { success: false, resources: [], error: err.message }
  }
})

// IPC: navigate browser
ipcMain.on('browser-navigate', (_event, url: string) => {
  if (resourceBrowserWin && !resourceBrowserWin.isDestroyed()) {
    resourceBrowserWin.loadURL(url.startsWith('http') ? url : 'https://' + url)
  }
})

// IPC: download a URL using the browser's authenticated session
ipcMain.on('browser-download', (_event, url: string) => {
  if (resourceBrowserWin && !resourceBrowserWin.isDestroyed()) {
    resourceBrowserWin.webContents.downloadURL(url)
  }
})

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
