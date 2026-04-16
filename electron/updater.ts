import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { createWriteStream } from 'fs'
import { rename, unlink, stat } from 'fs/promises'
import https from 'https'
import http from 'http'

const GITHUB_REPO = 'lickswan-lab/shijuan'
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  downloadUrl: string | null
  releaseNotes: string
  asarSize: number
}

// Fetch latest release info from GitHub
async function fetchLatestRelease(): Promise<{
  tagName: string
  body: string
  assets: Array<{ name: string; browser_download_url: string; size: number }>
}> {
  return new Promise((resolve, reject) => {
    const req = https.get(GITHUB_API, {
      headers: { 'User-Agent': 'ShiJuan-Updater', 'Accept': 'application/vnd.github.v3+json' },
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        https.get(res.headers.location!, { headers: { 'User-Agent': 'ShiJuan-Updater' } }, (res2) => {
          let data = ''
          res2.on('data', chunk => data += chunk)
          res2.on('end', () => {
            try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
          })
        }).on('error', reject)
        return
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          resolve({
            tagName: json.tag_name,
            body: json.body || '',
            assets: (json.assets || []).map((a: any) => ({
              name: a.name,
              browser_download_url: a.browser_download_url,
              size: a.size,
            })),
          })
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')) })
  })
}

// Compare versions: "1.2.5" > "1.2.4"
function isNewer(remote: string, local: string): boolean {
  const r = remote.replace(/^v/, '').split('.').map(Number)
  const l = local.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0
    const lv = l[i] || 0
    if (rv > lv) return true
    if (rv < lv) return false
  }
  return false
}

// Check for updates
export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()

  try {
    const release = await fetchLatestRelease()
    const latestVersion = release.tagName.replace(/^v/, '')

    // Find app.asar or patch asset
    const asarAsset = release.assets.find(a =>
      a.name === 'app.asar' ||
      a.name.includes('patch') && a.name.endsWith('.asar')
    )

    // Also check for full zip as fallback
    const zipAsset = release.assets.find(a =>
      a.name.includes('win') && a.name.endsWith('.zip')
    )

    const hasUpdate = isNewer(latestVersion, currentVersion)
    const downloadAsset = asarAsset || null

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      downloadUrl: downloadAsset?.browser_download_url || null,
      releaseNotes: release.body,
      asarSize: downloadAsset?.size || 0,
    }
  } catch (err: any) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      downloadUrl: null,
      releaseNotes: '',
      asarSize: 0,
    }
  }
}

// Download file with progress reporting
function downloadFile(url: string, destPath: string, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (requestUrl: string, redirectCount: number) => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return }

      const proto = requestUrl.startsWith('https') ? https : http
      const req = proto.get(requestUrl, {
        headers: { 'User-Agent': 'ShiJuan-Updater' },
      }, (res) => {
        // Follow redirects
        if (res.statusCode === 302 || res.statusCode === 301) {
          doRequest(res.headers.location!, redirectCount + 1)
          return
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }

        const totalSize = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0
        const file = createWriteStream(destPath)

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          file.write(chunk)
          if (totalSize > 0) {
            onProgress(Math.round((downloaded / totalSize) * 100))
          }
        })

        res.on('end', () => {
          file.end()
          file.on('finish', () => resolve())
        })

        res.on('error', (err) => {
          file.destroy()
          reject(err)
        })
      })

      req.on('error', reject)
      req.setTimeout(300000, () => { req.destroy(); reject(new Error('Download timeout')) })
    }

    doRequest(url, 0)
  })
}

// Get the path to the current app.asar
function getAsarPath(): string {
  // In production: app.getAppPath() returns something like .../resources/app.asar
  // In dev: it returns the project root
  const appPath = app.getAppPath()
  if (appPath.endsWith('.asar')) {
    return appPath
  }
  // Dev mode fallback
  return join(dirname(process.execPath), 'resources', 'app.asar')
}

// Register all updater IPC handlers
export function registerUpdaterIpc() {
  // Check for updates
  ipcMain.handle('check-update', async () => {
    return await checkForUpdate()
  })

  // Download update
  ipcMain.handle('download-update', async (_event, downloadUrl: string) => {
    const asarPath = getAsarPath()
    const tempPath = asarPath + '.update'

    try {
      // Send progress via the focused window
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const sendProgress = (pct: number) => {
        win?.webContents.send('update-progress', pct)
      }

      await downloadFile(downloadUrl, tempPath, sendProgress)

      // Verify the file was downloaded
      const s = await stat(tempPath)
      if (s.size < 1000000) {
        // File too small, probably an error page
        await unlink(tempPath).catch(() => {})
        return { success: false, error: '下载的文件太小，可能下载失败' }
      }

      return { success: true, tempPath }
    } catch (err: any) {
      await unlink(tempPath).catch(() => {})
      return { success: false, error: err.message }
    }
  })

  // Apply update: replace app.asar and relaunch
  ipcMain.handle('apply-update', async () => {
    const asarPath = getAsarPath()
    const tempPath = asarPath + '.update'
    const backupPath = asarPath + '.backup'

    try {
      // Backup current asar
      await rename(asarPath, backupPath).catch(() => {})
      // Move new asar into place
      await rename(tempPath, asarPath)
      // Clean up backup
      await unlink(backupPath).catch(() => {})

      // Relaunch the app
      app.relaunch()
      app.quit()
      return { success: true }
    } catch (err: any) {
      // Try to restore backup
      try { await rename(backupPath, asarPath) } catch {}
      return { success: false, error: err.message }
    }
  })
}
