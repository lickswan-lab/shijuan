import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import type { LectureSession } from '../../src/types/library'

const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json')
const AUDIO_DIR = path.join(DATA_DIR, 'audio')

async function ensureAudioDir() {
  await fs.mkdir(AUDIO_DIR, { recursive: true })
}

// ===== Xfyun RTASR signature =====
// Docs: https://www.xfyun.cn/doc/asr/rtasr/API.html
// signa = base64(hmac-sha1(md5(appid + ts), apikey))
function generateXfyunSignedUrl(appid: string, apikey: string): string {
  const ts = Math.floor(Date.now() / 1000).toString()
  // iFlytek requires: signa = base64(hmac-sha1(key=apikey, data=md5_raw_bytes(appid+ts)))
  // IMPORTANT: md5 must produce raw Buffer, NOT hex string
  const md5Raw = crypto.createHash('md5').update(appid + ts).digest()  // raw bytes
  const hmacSha1 = crypto.createHmac('sha1', apikey).update(md5Raw).digest('base64')
  const signa = encodeURIComponent(hmacSha1)
  return `wss://rtasr.xfyun.cn/v1/ws?appid=${appid}&ts=${ts}&signa=${signa}`
}

// ===== Aliyun NLS token =====
// Docs: https://help.aliyun.com/document_detail/450255.html
// Uses Alibaba Cloud common request signature v1
async function fetchAliyunToken(akid: string, aksecret: string): Promise<{ token: string; expireTime: number }> {
  const params: Record<string, string> = {
    AccessKeyId: akid,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    Version: '2019-02-28',
  }

  // Build canonical query string (sorted by key)
  const sortedKeys = Object.keys(params).sort()
  const canonicalQuery = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')

  // StringToSign = HTTPMethod + "&" + encode("/") + "&" + encode(canonicalQuery)
  const stringToSign = `POST&${encodeURIComponent('/')}&${encodeURIComponent(canonicalQuery)}`
  const signature = crypto.createHmac('sha1', aksecret + '&').update(stringToSign).digest('base64')

  // Build POST body with Signature
  const body = canonicalQuery + '&Signature=' + encodeURIComponent(signature)

  const response = await fetch('https://nls-meta.cn-shanghai.aliyuncs.com/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Aliyun token API error ${response.status}: ${errText}`)
  }

  const data = await response.json()
  if (data.ErrMsg) {
    throw new Error(`Aliyun token error: ${data.ErrMsg}`)
  }

  return {
    token: data.Token?.Id || '',
    expireTime: data.Token?.ExpireTime || 0,
  }
}

export function registerLectureIpc(): void {
  // Generate signed WebSocket URL for Xfyun RTASR
  ipcMain.handle('lecture-xfyun-sign', async (_event, appid: string, apikey: string) => {
    try {
      const url = generateXfyunSignedUrl(appid, apikey)
      return { success: true, url }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Fetch Aliyun NLS token
  ipcMain.handle('lecture-aliyun-token', async (_event, akid: string, aksecret: string) => {
    try {
      const result = await fetchAliyunToken(akid, aksecret)
      return { success: true, ...result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
  // Save/update lecture session in library.json
  ipcMain.handle('lecture-save', async (_event, session: LectureSession) => {
    try {
      const content = await fs.readFile(LIBRARY_FILE, 'utf-8')
      const library = JSON.parse(content)
      if (!library.lectureSessions) library.lectureSessions = []

      const idx = library.lectureSessions.findIndex((s: any) => s.id === session.id)
      if (idx >= 0) {
        library.lectureSessions[idx] = session
      } else {
        library.lectureSessions.unshift(session)
      }

      const tmpPath = LIBRARY_FILE + '.tmp'
      await fs.writeFile(tmpPath, JSON.stringify(library, null, 2), 'utf-8')
      await fs.rename(tmpPath, LIBRARY_FILE)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Save audio recording buffer
  ipcMain.handle('lecture-save-audio', async (_event, sessionId: string, buffer: Buffer) => {
    try {
      await ensureAudioDir()
      const filePath = path.join(AUDIO_DIR, `${sessionId}.webm`)
      await fs.writeFile(filePath, buffer)
      return { success: true, path: filePath }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Delete lecture audio file
  ipcMain.handle('lecture-delete-audio', async (_event, sessionId: string) => {
    try {
      const filePath = path.join(AUDIO_DIR, `${sessionId}.webm`)
      await fs.unlink(filePath).catch(() => {})
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
