// 召唤对话的会话持久化
// -----------------------------------------------------------------------------
// 痛点：召唤对话只在内存里（PersonasTab useState），切页就丢。
// 方案：每个 persona 一个目录，每个 session 一个 JSON 文件，保存路径
//   ~/.lit-manager/agent/summons/<personaId>/<sessionId>.json
// 前端 debounce 2s 调 save；切页 / 切 persona / 新建对话时 flush。

import { ipcMain, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { atomicWriteJson, safeLoadJsonOrBackup } from './library'

// ===== Paths =====
const DATA_DIR = path.join(app.getPath('home'), '.lit-manager')
const SUMMONS_DIR = path.join(DATA_DIR, 'agent', 'summons')

// BUG-FIX R8#21 · personaId / sessionId 路径清洗(同 personas.ts / R2#γ / R8#16 模式)
//   两个 id 都进 path.join 拼出 SUMMONS_DIR/<personaId>/<sessionId>.json。
//   当前都是 uuid() 安全,但 IPC 暴露,defense-in-depth 挡 ../../../etc/passwd 等。
const SAFE_ID = /^[a-zA-Z0-9_-]+$/
function unsafePersonaId(id: unknown): boolean {
  return typeof id !== 'string' || !SAFE_ID.test(id)
}
function unsafeSessionId(id: unknown): boolean {
  return typeof id !== 'string' || !SAFE_ID.test(id)
}

function personaDir(personaId: string): string {
  return path.join(SUMMONS_DIR, personaId)
}

function sessionFile(personaId: string, sessionId: string): string {
  return path.join(personaDir(personaId), `${sessionId}.json`)
}

async function ensurePersonaDir(personaId: string): Promise<void> {
  await fs.mkdir(personaDir(personaId), { recursive: true })
}

// ===== Shape =====
// SummonMsg mirrors the renderer-side type in PersonasTab.tsx. We keep it loose
// (Record<string, unknown> values) so a frontend-side addition (e.g. new
// metadata field on a message) doesn't require a backend type sync.
interface SummonMsgLike {
  role: 'user' | 'assistant'
  content: string
  [key: string]: unknown
}

export interface SummonSession {
  sessionId: string
  personaId: string
  title?: string
  startedAt: string     // ISO
  updatedAt: string     // ISO
  messages: SummonMsgLike[]
}

export interface SummonSessionSummary {
  sessionId: string
  title?: string
  startedAt: string
  messageCount: number
  firstPreview: string  // first user message, truncated ~80 chars
}

function clip(s: string | undefined | null, n = 80): string {
  if (!s) return ''
  const normalized = s.replace(/\s+/g, ' ').trim()
  return normalized.length > n ? normalized.slice(0, n) + '…' : normalized
}

// ===== IPC handlers =====
export function registerSummonSessionIpc(): void {
  // List sessions for a persona — summary view for the "历史对话" panel.
  // Sorted newest first by startedAt. Sessions with 0 messages still show up
  // so users can see "you started a session but didn't talk" — but their
  // preview is "(空白会话)" rather than empty.
  ipcMain.handle('summon-session-list', async (_event, personaId: string): Promise<{
    success: boolean
    sessions?: SummonSessionSummary[]
    error?: string
  }> => {
    try {
      if (unsafePersonaId(personaId)) return { success: false, error: 'personaId 含非法字符或为空' }
      await ensurePersonaDir(personaId)
      const files = await fs.readdir(personaDir(personaId))
      const sessions: SummonSessionSummary[] = []
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try {
          const full = path.join(personaDir(personaId), f)
          const s = await safeLoadJsonOrBackup<SummonSession | null>(full, null)
          if (!s) continue
          const firstUser = s.messages.find(m => m.role === 'user')
          sessions.push({
            sessionId: s.sessionId,
            title: s.title ? clip(s.title, 48) : undefined,
            startedAt: s.startedAt,
            messageCount: s.messages.length,
            firstPreview: firstUser ? clip(String(firstUser.content)) : '(空白会话)',
          })
        } catch { /* skip corrupt */ }
      }
      sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return { success: true, sessions }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Load one session. Returns the full message array; frontend rehydrates
  // useState from it and continues streaming into the same file.
  ipcMain.handle('summon-session-load', async (_event, personaId: string, sessionId: string): Promise<{
    success: boolean
    session?: SummonSession
    error?: string
  }> => {
    try {
      if (unsafePersonaId(personaId) || unsafeSessionId(sessionId)) return { success: false, error: 'personaId / sessionId 含非法字符或为空' }
      const file = sessionFile(personaId, sessionId)
      const s = await safeLoadJsonOrBackup<SummonSession | null>(file, null)
      if (!s) return { success: false, error: '会话不存在' }
      return { success: true, session: s }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Save (create or update) a session. The renderer debounces 2s to avoid
  // hammering the FS during streaming — a save per token would be ~30 writes
  // per assistant reply. Atomic write guarantees we never leave a torn JSON.
  ipcMain.handle('summon-session-save', async (_event, session: SummonSession): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      if (!session?.sessionId || !session?.personaId) {
        return { success: false, error: 'session 缺少必要字段 (sessionId / personaId)' }
      }
      if (unsafePersonaId(session.personaId) || unsafeSessionId(session.sessionId)) {
        return { success: false, error: 'personaId / sessionId 含非法字符' }
      }
      // Don't persist empty sessions — saves a lot of noise files for users
      // who click "新对话" then navigate away without saying anything.
      if (!Array.isArray(session.messages) || session.messages.length === 0) {
        return { success: true }
      }
      // BUG-FIX #C · serializable precheck
      // SummonMsg is `Record<string, unknown>` (loose by design) so the
      // frontend can tack on new fields without a backend type sync. But
      // that means a future contributor could accidentally stash a Buffer /
      // File / circular object / React element, at which point
      // atomicWriteJson's JSON.stringify throws deep inside the fs write
      // and the UI silently keeps the torn in-memory state. Do a
      // JSON.stringify() upfront so we can return a clean error that the
      // frontend can toast — the user then knows to refresh or check the
      // transcript instead of assuming it was saved.
      try {
        JSON.stringify(session)
      } catch (e: any) {
        return {
          success: false,
          error: 'messages 含不可序列化字段: ' + (e?.message || String(e)),
        }
      }
      await ensurePersonaDir(session.personaId)
      const existing = await safeLoadJsonOrBackup<SummonSession | null>(
        sessionFile(session.personaId, session.sessionId),
        null,
      ).catch(() => null)
      const normalized: SummonSession = {
        sessionId: session.sessionId,
        personaId: session.personaId,
        title: session.title ?? existing?.title,
        startedAt: session.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: session.messages,
      }
      await atomicWriteJson(sessionFile(session.personaId, session.sessionId), normalized)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  // Delete a session. No-op if file is already gone (ENOENT).
  ipcMain.handle('summon-session-delete', async (_event, personaId: string, sessionId: string): Promise<{
    success: boolean
    error?: string
  }> => {
    try {
      if (unsafePersonaId(personaId) || unsafeSessionId(sessionId)) return { success: false, error: 'personaId / sessionId 含非法字符或为空' }
      await fs.unlink(sessionFile(personaId, sessionId)).catch((e) => {
        if (e?.code === 'ENOENT') return  // already gone — still success
        throw e
      })
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })
}
