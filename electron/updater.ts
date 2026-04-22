import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { createWriteStream } from 'fs'
import { rename, unlink, stat, writeFile, chmod } from 'fs/promises'
import { spawn } from 'child_process'
import os from 'os'
import https from 'https'
import http from 'http'
import zlib from 'zlib'

const GITHUB_REPO = 'lickswan-lab/shijuan'
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  downloadUrl: string | null
  releaseNotes: string
  asarSize: number
  compressed: boolean
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

    // Prefer gzip-compressed asar if available (~3-5x smaller than raw).
    // Fall back to uncompressed `app.asar` or any `*patch*.asar` variant.
    const asarGzAsset = release.assets.find(a => a.name === 'app.asar.gz')
    const asarAsset = release.assets.find(a =>
      a.name === 'app.asar' ||
      (a.name.includes('patch') && a.name.endsWith('.asar'))
    )

    const hasUpdate = isNewer(latestVersion, currentVersion)
    const downloadAsset = asarGzAsset || asarAsset || null
    const compressed = !!asarGzAsset && downloadAsset === asarGzAsset

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      downloadUrl: downloadAsset?.browser_download_url || null,
      releaseNotes: release.body,
      asarSize: downloadAsset?.size || 0,
      compressed,
    }
  } catch (err: any) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      downloadUrl: null,
      releaseNotes: '',
      asarSize: 0,
      compressed: false,
    }
  }
}

// Download file with progress reporting. When `decompress` is true, the
// response body is piped through gunzip on the fly — the file on disk ends up
// as the decompressed payload, ready to be swapped in place of app.asar.
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (pct: number) => void,
  decompress: boolean
): Promise<void> {
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
        let settled = false
        const fail = (err: Error) => {
          if (settled) return
          settled = true
          file.destroy()
          reject(err)
        }

        // Progress is tracked against the raw (possibly gzipped) bytes off the
        // wire — that matches content-length and gives accurate download %.
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          if (totalSize > 0) {
            onProgress(Math.round((downloaded / totalSize) * 100))
          }
        })

        if (decompress) {
          const gunzip = zlib.createGunzip()
          res.pipe(gunzip).pipe(file)
          gunzip.on('error', fail)
        } else {
          res.pipe(file)
        }

        res.on('error', fail)
        file.on('error', fail)
        file.on('finish', () => {
          if (settled) return
          settled = true
          resolve()
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

  // Download update. If the URL points at an `app.asar.gz` asset the response
  // body is gunzipped in-flight; the file that lands on disk is always the raw
  // asar ready for the swap step.
  ipcMain.handle('download-update', async (_event, downloadUrl: string) => {
    const asarPath = getAsarPath()
    const tempPath = asarPath + '.update'
    const decompress = /\.asar\.gz(\?|$)/i.test(downloadUrl)

    try {
      // Send progress via the focused window
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const sendProgress = (pct: number) => {
        win?.webContents.send('update-progress', pct)
      }

      await downloadFile(downloadUrl, tempPath, sendProgress, decompress)

      // Verify the file was downloaded. After gunzip the file is the raw asar
      // (typically >100MB), so the 1MB floor still catches HTML error pages.
      const s = await stat(tempPath)
      if (s.size < 1000000) {
        await unlink(tempPath).catch(() => {})
        return { success: false, error: '下载的文件太小，可能下载失败' }
      }

      return { success: true, tempPath }
    } catch (err: any) {
      await unlink(tempPath).catch(() => {})
      return { success: false, error: err.message }
    }
  })

  // Apply update: replace app.asar and relaunch.
  // On Windows, app.asar is memory-mapped by the running Electron process, so an in-process
  // `rename` will always fail with EBUSY. We work around this by spawning a detached helper
  // script that waits for this process to exit, then performs the swap and relaunches.
  ipcMain.handle('apply-update', async () => {
    const asarPath = getAsarPath()
    const tempPath = asarPath + '.update'
    const exePath = process.execPath
    const isWin = process.platform === 'win32'
    const scriptPath = join(
      os.tmpdir(),
      `shijuan-update-${Date.now()}.${isWin ? 'cmd' : 'sh'}`
    )

    try {
      // Verify the .update file exists before kicking off the swap
      await stat(tempPath)

      if (isWin) {
        // Retry loop: after app.quit() fires, the asar file lock may linger a second or two.
        // We retry up to 15 times at 1s intervals. `move /Y` replaces atomically once unlocked.
        const script = `@echo off
chcp 65001 >nul
timeout /t 2 /nobreak >nul
set /a RETRIES=15
:retry
move /Y "${tempPath}" "${asarPath}" 1>nul 2>nul
if errorlevel 1 (
  set /a RETRIES-=1
  if %RETRIES% LEQ 0 goto failed
  timeout /t 1 /nobreak >nul
  goto retry
)
start "" "${exePath}"
(goto) 2>nul & del "%~f0"
exit /b 0
:failed
echo Update failed - app.asar still locked after 17 seconds >"${asarPath}.update-error.log"
start "" "${exePath}"
(goto) 2>nul & del "%~f0"
exit /b 1
`
        await writeFile(scriptPath, script, 'utf8')
        const child = spawn('cmd.exe', ['/c', scriptPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
      } else {
        // macOS/Linux: file unlink-then-rename is atomic; the live mmap keeps working via
        // the old inode until this process exits.
        const script = `#!/bin/bash
sleep 2
for i in $(seq 1 15); do
  if mv -f "${tempPath}" "${asarPath}" 2>/dev/null; then
    open "${exePath}" 2>/dev/null || "${exePath}" &
    rm -f "$0"
    exit 0
  fi
  sleep 1
done
echo "Update failed - app.asar still locked" >"${asarPath}.update-error.log"
open "${exePath}" 2>/dev/null || "${exePath}" &
rm -f "$0"
exit 1
`
        await writeFile(scriptPath, script, 'utf8')
        await chmod(scriptPath, 0o755)
        const child = spawn('/bin/bash', [scriptPath], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
      }

      // Quit so the OS releases the file lock. The spawned script will relaunch us.
      setTimeout(() => app.quit(), 200)
      return { success: true }
    } catch (err: any) {
      // Clean up failed temp file and script
      await unlink(tempPath).catch(() => {})
      await unlink(scriptPath).catch(() => {})
      return { success: false, error: err.message }
    }
  })
}
