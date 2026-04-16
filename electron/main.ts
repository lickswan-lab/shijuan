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

// ===== Built-in browser for authenticated resource downloading =====
function openResourceBrowser(parentWindow: BrowserWindow, startUrl?: string) {
  const browserWin = new BrowserWindow({
    width: 1100,
    height: 750,
    parent: parentWindow,
    title: '拾卷 - 在线获取资源',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Use persist: partition to keep login sessions across app restarts
      partition: 'persist:resource-browser',
      webviewTag: true,
    },
  })

  // Create a simple toolbar HTML as the initial page
  const toolbarHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, "Microsoft YaHei", sans-serif; background: #2A2520; color: #E8E0D0; display: flex; flex-direction: column; height: 100vh; }
  .toolbar { display: flex; gap: 8px; padding: 8px 12px; background: #1e1e24; border-bottom: 1px solid #3a3a45; flex-shrink: 0; align-items: center; }
  .toolbar input { flex: 1; padding: 6px 12px; border: 1px solid #3a3a45; border-radius: 6px; background: #2A2520; color: #E8E0D0; font-size: 13px; outline: none; }
  .toolbar input:focus { border-color: #C8956C; }
  .toolbar button { padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; flex-shrink: 0; }
  .btn-go { background: #C8956C; color: #fff; }
  .btn-go:hover { background: #B5825A; }
  .btn-scan { background: #3a3a45; color: #C8956C; border: 1px solid #C8956C; }
  .btn-scan:hover { background: #C8956C; color: #fff; }
  .btn-back { background: #3a3a45; color: #E8E0D0; }
  .btn-back:hover { background: #4a4a55; }
  .webview-container { flex: 1; }
  webview { width: 100%; height: 100%; }
  .results { max-height: 200px; overflow: auto; background: #1e1e24; border-top: 1px solid #3a3a45; padding: 8px; font-size: 12px; display: none; }
  .results.show { display: block; }
  .results h4 { color: #C8956C; margin-bottom: 6px; font-size: 12px; }
  .res-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #2A2520; }
  .res-item:hover { background: #2A2520; }
  .res-ext { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; background: rgba(200,149,108,0.15); color: #C8956C; }
  .res-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .res-dl { padding: 3px 10px; border: 1px solid #C8956C; border-radius: 4px; background: none; color: #C8956C; cursor: pointer; font-size: 10px; }
  .res-dl:hover { background: #C8956C; color: #fff; }
  .status { padding: 4px 12px; font-size: 11px; color: #7a7060; }
</style></head><body>
<div class="toolbar">
  <button class="btn-back" id="btn-back">←</button>
  <input type="text" id="url-input" placeholder="输入网址并登录，然后点击扫描获取资源..." value="${startUrl || ''}" />
  <button class="btn-go" id="btn-go">前往</button>
  <button class="btn-scan" id="btn-scan">🔍 扫描资源</button>
  <button class="btn-back" id="btn-bookmark" title="收藏当前页面">⭐</button>
</div>
<div id="bookmarks-bar" style="display:flex;gap:4px;padding:4px 12px;background:#1e1e24;border-bottom:1px solid #3a3a45;flex-wrap:wrap;font-size:11px;"></div>
<div class="status" id="status">输入网址并按回车，登录后点击"扫描资源"。登录状态会自动保存。</div>
<div class="webview-container">
  <webview id="wv" src="${startUrl || 'about:blank'}" style="width:100%;height:100%"></webview>
</div>
<div class="results" id="results"></div>
<script>
  const wv = document.getElementById('wv');
  const urlInput = document.getElementById('url-input');
  const status = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const bookmarksBar = document.getElementById('bookmarks-bar');

  // Bookmarks: load from localStorage
  var bookmarks = JSON.parse(localStorage.getItem('sj-bookmarks') || '[]');
  function renderBookmarks() {
    bookmarksBar.innerHTML = bookmarks.map(function(b, i) {
      return '<span style="padding:2px 8px;background:#2A2520;border:1px solid #3a3a45;border-radius:4px;cursor:pointer;color:#C8B8A0;display:flex;align-items:center;gap:4px" data-idx="'+i+'" data-url="'+b.url+'">'
        + '<span class="bk-label" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (b.title||b.url).substring(0,20) + '</span>'
        + '<span class="bk-del" data-del="'+i+'" style="color:#666;cursor:pointer;font-size:9px">×</span>'
        + '</span>';
    }).join('');
    // Click to navigate
    bookmarksBar.querySelectorAll('[data-url]').forEach(function(el) {
      el.querySelector('.bk-label').addEventListener('click', function() {
        var url = el.getAttribute('data-url');
        urlInput.value = url;
        wv.src = url;
      });
      el.querySelector('.bk-del').addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = parseInt(this.getAttribute('data-del'));
        bookmarks.splice(idx, 1);
        localStorage.setItem('sj-bookmarks', JSON.stringify(bookmarks));
        renderBookmarks();
      });
    });
  }
  renderBookmarks();

  document.getElementById('btn-bookmark').onclick = function() {
    var url = wv.getURL();
    if (!url || url === 'about:blank') return;
    if (bookmarks.some(function(b) { return b.url === url; })) { status.textContent = '已收藏'; return; }
    bookmarks.push({ url: url, title: wv.getTitle() || url });
    localStorage.setItem('sj-bookmarks', JSON.stringify(bookmarks));
    renderBookmarks();
    status.textContent = '已收藏 ⭐';
  };

  function navigate() {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://' + url;
    urlInput.value = url;
    wv.src = url;
    status.textContent = '加载中...';
  }

  document.getElementById('btn-go').onclick = navigate;
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(); });
  document.getElementById('btn-back').onclick = () => { if (wv.canGoBack()) wv.goBack(); };

  wv.addEventListener('did-navigate', () => { urlInput.value = wv.getURL(); status.textContent = '页面已加载'; });
  wv.addEventListener('did-navigate-in-page', () => { urlInput.value = wv.getURL(); });
  wv.addEventListener('page-title-updated', (e) => { status.textContent = e.title; });

  document.getElementById('btn-scan').onclick = async () => {
    status.textContent = '正在扫描页面资源...';
    try {
      const resources = await wv.executeJavaScript(\`
        (function() {
          var exts = /\\\\.(pdf|epub|docx?|txt|md|mobi|djvu|pptx?|xlsx?|zip|rar)$/i;
          var results = [];
          var seen = new Set();
          // Scan all <a> tags
          document.querySelectorAll('a[href]').forEach(function(a) {
            var href = a.href;
            if (!href || seen.has(href)) return;
            var match = href.match(exts);
            if (match) {
              seen.add(href);
              results.push({ url: href, name: a.textContent.trim() || href.split('/').pop(), ext: match[1].toLowerCase() });
            }
          });
          // Scan direct URL patterns in page text
          var textLinks = document.body.innerHTML.match(/https?:\\\\/\\\\/[^\\\\s"'<>]+\\\\.(pdf|epub|docx?|txt|md)/gi) || [];
          textLinks.forEach(function(link) {
            if (!seen.has(link)) {
              seen.add(link);
              results.push({ url: link, name: link.split('/').pop().split('?')[0], ext: link.match(/\\\\.(\\\\w+)$/)[1].toLowerCase() });
            }
          });
          return results;
        })()
      \`);

      if (resources.length === 0) {
        status.textContent = '未发现可下载的文档资源';
        resultsDiv.classList.remove('show');
        return;
      }

      status.textContent = '发现 ' + resources.length + ' 个可下载资源';
      resultsDiv.innerHTML = '<h4>可下载资源</h4>' + resources.map(function(r, i) {
        return '<div class="res-item"><span class="res-ext">' + r.ext.toUpperCase() + '</span><span class="res-name" title="' + r.name + '">' + r.name + '</span><a class="res-dl" href="' + r.url + '" download>下载</a></div>';
      }).join('');
      resultsDiv.classList.add('show');

      // Handle download clicks — use webview's session (has cookies)
      resultsDiv.querySelectorAll('.res-dl').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          var dlUrl = this.getAttribute('href');
          this.textContent = '下载中...';
          this.style.pointerEvents = 'none';
          // Trigger download in webview (uses authenticated session)
          wv.downloadURL(dlUrl);
        });
      });
    } catch(err) {
      status.textContent = '扫描失败: ' + err.message;
    }
  };

  // Handle downloads from webview
  wv.addEventListener('ipc-message', console.log);
</script>
</body></html>`

  // Load the toolbar page
  browserWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(toolbarHtml))

  // Allow webview tag
  browserWin.webContents.on('will-attach-webview', (_event, webPreferences) => {
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
  })

  // Handle downloads from the webview — save to ~/.lit-manager/downloads/
  browserWin.webContents.session.on('will-download', async (_event, item) => {
    const downloadsDir = join(app.getPath('home'), '.lit-manager', 'downloads')
    const fs = require('fs')
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true })

    const fileName = item.getFilename().replace(/[<>:"/\\|?*]/g, '_')
    const savePath = join(downloadsDir, fileName)
    item.setSavePath(savePath)

    item.on('done', (_e, state) => {
      if (state === 'completed') {
        // Notify main window to import the file
        parentWindow.webContents.send('resource-downloaded', savePath)
      }
    })
  })

  return browserWin
}

// IPC to open resource browser
ipcMain.on('open-resource-browser', (_event, startUrl?: string) => {
  const wins = BrowserWindow.getAllWindows()
  const parent = wins.find(w => w.title === '拾卷') || wins[0]
  if (parent) openResourceBrowser(parent, startUrl)
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
