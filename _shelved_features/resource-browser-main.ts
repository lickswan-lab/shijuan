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
