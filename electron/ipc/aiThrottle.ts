// 主进程级 per-provider 节流 + 自适应速率限制（chokepoint）。
//
// 为什么放在主进程：
//   1. 渲染进程的 PersonasTab 节流只覆盖 callPersonaAi。但 GLM 在主进程被
//      多个路径调：chat (aiApi) / embeddings (personaEmbeddingApi) /
//      web-search-pro (personas-search-helper)。三个路径并发跑（比如「AI 深度
//      搜索」一边 callPersonaAi 一边 nuwaSearch）会把 GLM 配额炸穿。
//   2. 主进程模块状态在 HMR 不重置 → throttle 状态稳定。
//   3. 单例：所有渲染进程通过 IPC 共用同一份 per-provider queue / adaptive state。
//
// 行为：
//   - 每个 provider 一个独立 FIFO 队列 + worker pool（大小 = maxConcurrency）
//   - 队列按优先级派发：interactive > background。同级按 FIFO
//   - 发请求前先拿 token（每分钟 effectiveRpm 个 token，固定窗口）
//   - 撞 429 / 503 → 记录 hit，effective RPM × 0.7，指数退避等
//     (500ms → 30s)。respected retry-after 头
//   - 5 分钟没再撞墙 → effective RPM 每步 +10% 恢复，直到回到 base
//   - 状态广播：每秒 tick 一次，推给所有 BrowserWindow 的 'ai-throttle-status'
//     channel
//
// 外部 API 核心形状：
//   schedule(providerId, fn, opts?) — 入队执行，opts.priority: 'interactive'|'background'
//   throttleProvider(providerId) — 老式 API（纯等一个 slot）。新代码应用 schedule()
//   bumpProviderInterval(providerId, retryAfterMs?) — 撞墙时调，可带 retry-after
//   isRateLimitError(msg) — 统一 429 detector
//   subscribeStatus(cb) — 订阅状态 tick（内部用；IPC 层桥接给前端）
//   getSnapshot() — 读当前状态
//
// 配置读自 aiRateLimits.ts。用户覆盖通过 setProviderRpmOverride() 传入，
// 内存里即时生效。
// BUG-FIX #D · 覆盖持久化到 ~/.lit-manager/rate-limit-overrides.json。
// loadRpmOverridesFromDisk() 在 app ready 后一次性读入，setProviderRpmOverride
// 同步写回。文件缺失 / 损坏 / 非对象都不阻塞 boot——静默回到默认即可，用户可以
// 在 Settings 里再次覆盖。

import { BrowserWindow, app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import {
  getBaseRateLimit,
  type ProviderRateLimit,
} from './aiRateLimits'
import { atomicWriteJson } from './library'

// ===== Types =====

export type RequestPriority = 'interactive' | 'background'

export interface ScheduleOpts {
  // interactive 排在 background 前面。默认 interactive（用户直接触发的
  // chat / ask / feedback 都算；embedding build / 批量任务才用 background）
  priority?: RequestPriority
  // 调试 / 日志用的可读名
  label?: string
}

export interface ProviderStatus {
  providerId: string
  displayName: string
  // 当前有效 RPM（= baseRpm × adaptiveMultiplier，四舍五入）
  effectiveRpm: number
  baseRpm: number
  adaptiveMultiplier: number  // 1.0 = 健康，0.7^N = 挨过 N 次墙
  // 队列深度
  interactiveQueued: number
  backgroundQueued: number
  running: number
  maxConcurrency: number
  // 最近 5 分钟撞墙次数
  recentRateLimitHits: number
  // 当前是否还在 backoff（未到 nextAllowedAt）
  inBackoff: boolean
  nextAllowedAt: number  // epoch ms
  // 最近一次墙的时间
  lastRateLimitAt: number  // epoch ms, 0 = 从未
}

interface QueuedTask<T = unknown> {
  id: number
  priority: RequestPriority
  label?: string
  run: () => Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
  enqueuedAt: number
}

interface ProviderState {
  providerId: string
  base: ProviderRateLimit
  // In-memory override for the RPM (user setting). null = use base.rpm
  rpmOverride: number | null
  // Adaptive multiplier (0 < x ≤ 1). Starts at 1. Drops to 0.7× on rate-limit.
  // Recovery: +10% per step after RECOVERY_WINDOW_MS of quiet.
  adaptiveMultiplier: number
  // Token bucket (simplified fixed window per minute): we count requests sent
  // in the current minute window. When >= effectiveRpm, we wait until the
  // window rolls over.
  windowStartMs: number
  windowCount: number
  // Concurrency gating
  running: number
  // FIFO queues by priority
  interactive: QueuedTask<unknown>[]
  background: QueuedTask<unknown>[]
  // Rate-limit bookkeeping
  nextAllowedAt: number   // no request may send before this. 0 = no backoff.
  currentBackoffMs: number  // exponential; reset on success
  lastRateLimitAt: number
  recentHits: number[]    // timestamps of recent hits; pruned to last 5 min
  lastRecoveryStepAt: number
}

// ===== Constants (recovery / backoff) =====

// 5 min with no 429 → start recovering effectiveRpm
const RECOVERY_WINDOW_MS = 5 * 60 * 1000
// Each recovery step adds 10% of base back to the multiplier, until 1.0
const RECOVERY_STEP = 0.1
// Minimum gap between recovery steps (so we don't leap back to base in one tick)
const RECOVERY_STEP_INTERVAL_MS = 60 * 1000  // 1 min between steps
// Exponential backoff bounds
const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30 * 1000
// Adaptive knob: every hit multiplies RPM by this (i.e. RPM → 70% of current)
const RATE_LIMIT_RPM_DECAY = 0.7
// How long a "recent hit" stays in the recent-hits window
const RECENT_HITS_WINDOW_MS = 5 * 60 * 1000
// Status broadcast tick
const STATUS_TICK_MS = 1000

// ===== State =====

const stateByProvider: Map<string, ProviderState> = new Map()
let nextTaskId = 1

// Subscribers in-process (used by the IPC layer to broadcast to renderer)
type StatusSubscriber = (snapshot: ProviderStatus[]) => void
const statusSubscribers: Set<StatusSubscriber> = new Set()

let statusTickTimer: NodeJS.Timeout | null = null

// ===== Init / lookup =====

function getState(providerId: string): ProviderState {
  const key = providerId.toLowerCase()
  let s = stateByProvider.get(key)
  if (!s) {
    s = {
      providerId: key,
      base: getBaseRateLimit(key),
      rpmOverride: null,
      adaptiveMultiplier: 1,
      windowStartMs: Date.now(),
      windowCount: 0,
      running: 0,
      interactive: [],
      background: [],
      nextAllowedAt: 0,
      currentBackoffMs: MIN_BACKOFF_MS,
      lastRateLimitAt: 0,
      recentHits: [],
      lastRecoveryStepAt: 0,
    }
    stateByProvider.set(key, s)
  }
  return s
}

// Effective RPM after user override + adaptive decay. Floor at 1 so we never
// lock ourselves out completely.
function effectiveRpm(s: ProviderState): number {
  const baseRpm = s.rpmOverride ?? s.base.rpm
  return Math.max(1, Math.round(baseRpm * s.adaptiveMultiplier))
}

// Current minute window: if it's expired, roll over and reset the count.
function rollWindow(s: ProviderState): void {
  const now = Date.now()
  if (now - s.windowStartMs >= 60000) {
    s.windowStartMs = now
    s.windowCount = 0
  }
}

// How long to wait until a slot is available given:
//   1. Minute window quota (windowCount < effectiveRpm)
//   2. Backoff wall (nextAllowedAt)
// Returns ms >= 0 (0 = go now).
function timeUntilNextSlot(s: ProviderState): number {
  const now = Date.now()
  rollWindow(s)
  const eff = effectiveRpm(s)
  let wait = 0
  if (s.windowCount >= eff) {
    wait = Math.max(wait, s.windowStartMs + 60000 - now)
  }
  if (s.nextAllowedAt > now) {
    wait = Math.max(wait, s.nextAllowedAt - now)
  }
  return wait
}

// ===== Scheduler loop =====
// Each provider has its own implicit "worker pool" via maxConcurrency. We
// don't spawn actual workers; we just pick the next task when capacity opens.

function pickNext(s: ProviderState): QueuedTask<unknown> | null {
  // Interactive always beats background. Within each bucket: FIFO.
  if (s.interactive.length > 0) return s.interactive.shift()!
  if (s.background.length > 0) return s.background.shift()!
  return null
}

async function tryDispatch(s: ProviderState): Promise<void> {
  // Drive until we can't: either no task queued, or concurrency full, or must wait.
  while (s.running < s.base.maxConcurrency) {
    // Wait out window / backoff if needed. Note we only wait if we actually
    // have a task to run — don't sleep for a phantom queue.
    const hasTask = s.interactive.length > 0 || s.background.length > 0
    if (!hasTask) return

    const wait = timeUntilNextSlot(s)
    if (wait > 0) {
      // Schedule a later dispatch. Multiple await waits stack fine because
      // the head task won't be shifted until after the wait (we pop only after
      // slot open). Guard: after sleep, re-check state — another concurrent
      // dispatch may have grabbed the task.
      await new Promise(r => setTimeout(r, Math.min(wait, 60000)))
      continue
    }

    const task = pickNext(s)
    if (!task) return  // another concurrent dispatch drained the queue

    // Consume a slot
    s.running++
    s.windowCount++

    // Fire and forget; task.run resolves/rejects the outer promise
    ;(async () => {
      try {
        const result = await task.run()
        task.resolve(result)
        // Success clears backoff progression (next hit starts over at MIN)
        s.currentBackoffMs = MIN_BACKOFF_MS
      } catch (err) {
        task.reject(err)
      } finally {
        s.running--
        // Try dispatching the next one right away
        void tryDispatch(s)
      }
    })()
  }
}

// ===== Public: schedule a task through the per-provider queue =====

export function schedule<T>(
  providerId: string,
  fn: () => Promise<T>,
  opts?: ScheduleOpts,
): Promise<T> {
  const s = getState(providerId)
  const priority: RequestPriority = opts?.priority || 'interactive'
  return new Promise<T>((resolve, reject) => {
    const task: QueuedTask<T> = {
      id: nextTaskId++,
      priority,
      label: opts?.label,
      run: fn,
      resolve,
      reject,
      enqueuedAt: Date.now(),
    }
    if (priority === 'background') s.background.push(task as QueuedTask<unknown>)
    else s.interactive.push(task as QueuedTask<unknown>)
    void tryDispatch(s)
  })
}

// ===== Legacy API: throttleProvider() — just wait for a slot, no fn wrapping =====
//
// The older code paths in aiApi.ts / personaEmbeddingApi.ts /
// personas-search-helper.ts call `await throttleProvider(id)` then do the
// fetch inline. We keep this API and implement it by scheduling a trivial
// task that resolves immediately — the scheduler's minute window + backoff
// still apply. Less ideal than schedule() (we don't see the actual fetch
// succeed/fail inside the task), but it keeps callers simple. Note:
// bumpProviderInterval() must still be called manually on 429.

export async function throttleProvider(providerId: string, priority: RequestPriority = 'interactive'): Promise<number> {
  const t0 = Date.now()
  await schedule(providerId, async () => { /* consume a slot */ }, { priority, label: 'throttleProvider(legacy)' })
  return Date.now() - t0
}

// ===== Public: rate-limit hit reporting =====
//
// Call after a 429 / 503 / provider-specific rate-limit error. Optionally pass
// the `Retry-After` header value (seconds or a parsed ms number); we'll respect
// it if present, otherwise use exponential backoff.

export function bumpProviderInterval(providerId: string, retryAfterMs?: number): number {
  const s = getState(providerId)
  const now = Date.now()
  s.lastRateLimitAt = now
  s.recentHits.push(now)
  // Drop adaptive multiplier: cur × 0.7, but never below 0.1 (10% of base RPM)
  s.adaptiveMultiplier = Math.max(0.1, s.adaptiveMultiplier * RATE_LIMIT_RPM_DECAY)

  // Backoff wall: respect retry-after if given; else exponential
  let backoff: number
  if (retryAfterMs && retryAfterMs > 0) {
    backoff = Math.min(MAX_BACKOFF_MS, retryAfterMs)
  } else {
    backoff = Math.min(MAX_BACKOFF_MS, s.currentBackoffMs)
    s.currentBackoffMs = Math.min(MAX_BACKOFF_MS, s.currentBackoffMs * 2)
  }
  s.nextAllowedAt = Math.max(s.nextAllowedAt, now + backoff)
  return s.adaptiveMultiplier
}

// ===== Public: current adaptive state =====

export function currentIntervalMs(providerId: string): number {
  // Legacy API — return the average min-interval between requests given
  // effective RPM. Some callers (e.g. diagnostic logging) may use this.
  const s = getState(providerId)
  const rpm = effectiveRpm(s)
  return Math.round(60000 / rpm)
}

export function getAdaptiveMultiplier(providerId: string): number {
  return getState(providerId).adaptiveMultiplier
}

// User setting: override the base RPM (e.g. paid tier). Pass null to reset to
// the default. Adaptive decay still applies on top of this.
export function setProviderRpmOverride(providerId: string, rpm: number | null): void {
  const s = getState(providerId)
  if (rpm !== null && (!Number.isFinite(rpm) || rpm <= 0)) {
    throw new Error(`invalid rpm override for ${providerId}: ${rpm}`)
  }
  s.rpmOverride = rpm
  // BUG-FIX #D · persist to disk so restart preserves the override. Fire and
  // forget — if the write fails the in-memory state is still correct for
  // this session, and the next successful save will reconcile.
  void persistRpmOverrides().catch((e) => {
    console.warn('[aiThrottle] persistRpmOverrides failed:', e?.message || e)
  })
}

// ===== BUG-FIX #D · RPM override persistence =====
//
// Store format: { "openai": 3000, "glm": 120, ... } — provider id (lowercase)
// → override RPM. null overrides are NOT serialized (absence == default),
// keeps the file small and self-healing when defaults change.
//
// Lives at ~/.lit-manager/rate-limit-overrides.json. Tiny file, atomic write.
// Boot flow:
//   1. app ready → aiApi.registerAiApiIpc() is called
//   2. That now calls loadRpmOverridesFromDisk() before startStatusBroadcast()
//   3. Any IPC that calls setProviderRpmOverride() will trigger a resave.

function overridesFilePath(): string {
  return path.join(app.getPath('home'), '.lit-manager', 'rate-limit-overrides.json')
}

async function persistRpmOverrides(): Promise<void> {
  const payload: Record<string, number> = {}
  const states = Array.from(stateByProvider.values())
  for (const s of states) {
    if (s.rpmOverride !== null && Number.isFinite(s.rpmOverride)) {
      payload[s.providerId] = s.rpmOverride
    }
  }
  // Ensure parent dir exists — atomicWriteJson expects it; library.ts doesn't
  // mkdir DATA_DIR in this path because it assumes ensureDirs() has been run
  // via registerLibraryIpc(). aiThrottle can be called before that.
  const file = overridesFilePath()
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
  } catch { /* best effort; atomicWriteJson will throw with a clearer error */ }
  await atomicWriteJson(file, payload)
}

/** Read stored overrides and apply them to in-memory state. Safe to call
 *  before any provider state has been created — getState() will lazy-init.
 *  Any failure (ENOENT, parse error, non-object, bad value types) is caught
 *  and just means "start with defaults". The file is NOT rewritten on parse
 *  failure so a user who hand-edited it can fix it. */
export async function loadRpmOverridesFromDisk(): Promise<void> {
  const file = overridesFilePath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return  // no overrides saved yet — default state OK
    console.warn('[aiThrottle] reading overrides file failed:', e?.message || e)
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    console.warn('[aiThrottle] overrides file corrupt; ignoring:', e?.message || e)
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[aiThrottle] overrides file not an object; ignoring')
    return
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  for (const [providerId, rpm] of entries) {
    if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0) {
      console.warn(`[aiThrottle] ignoring invalid override for ${providerId}: ${rpm}`)
      continue
    }
    const s = getState(providerId)
    s.rpmOverride = rpm
  }
}

// ===== Public: 429 / rate-limit error detector =====

export function isRateLimitError(msg: string | undefined | null): boolean {
  if (!msg) return false
  const m = String(msg).toLowerCase()
  return /(429|503|rate.?limit|1302|overloaded|速率限制|频率|过于频繁)/i.test(m) || m.includes('rate_limit')
}

// Parse Retry-After from Response headers into ms. Supports seconds-form ("5")
// and HTTP-date-form ("Wed, 21 Oct 2015 07:28:00 GMT"). Returns undefined if
// missing / unparseable.
export function parseRetryAfterHeader(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  // Numeric seconds
  const asNum = Number(raw)
  if (Number.isFinite(asNum) && asNum >= 0) return Math.round(asNum * 1000)
  // HTTP-date
  const t = Date.parse(raw)
  if (Number.isFinite(t)) {
    const delta = t - Date.now()
    return delta > 0 ? delta : 0
  }
  return undefined
}

// ===== Recovery tick & status broadcast =====

function pruneRecentHits(s: ProviderState, now: number): void {
  const cutoff = now - RECENT_HITS_WINDOW_MS
  // Recent hits are pushed in chronological order, so we can just find the
  // first index ≥ cutoff.
  let i = 0
  while (i < s.recentHits.length && s.recentHits[i] < cutoff) i++
  if (i > 0) s.recentHits = s.recentHits.slice(i)
}

function maybeRecover(s: ProviderState, now: number): void {
  // If we've never been hit, nothing to recover
  if (s.adaptiveMultiplier >= 1) {
    s.adaptiveMultiplier = 1
    return
  }
  // Must have had a quiet window since last hit
  if (now - s.lastRateLimitAt < RECOVERY_WINDOW_MS) return
  // And at least RECOVERY_STEP_INTERVAL_MS since last step (so we don't leap
  // back instantly)
  if (now - s.lastRecoveryStepAt < RECOVERY_STEP_INTERVAL_MS) return
  s.adaptiveMultiplier = Math.min(1, s.adaptiveMultiplier + RECOVERY_STEP)
  s.lastRecoveryStepAt = now
}

function buildSnapshot(): ProviderStatus[] {
  const now = Date.now()
  const out: ProviderStatus[] = []
  // Array.from(...) rather than for...of iterator — tsconfig.node.json targets
  // ES5 without downlevelIteration, so iterating Map directly is a TS error
  // (though it runs fine on Node 20).
  const states = Array.from(stateByProvider.values())
  for (const s of states) {
    pruneRecentHits(s, now)
    maybeRecover(s, now)
    out.push({
      providerId: s.providerId,
      displayName: s.base.displayName,
      effectiveRpm: effectiveRpm(s),
      baseRpm: s.rpmOverride ?? s.base.rpm,
      adaptiveMultiplier: Math.round(s.adaptiveMultiplier * 100) / 100,
      interactiveQueued: s.interactive.length,
      backgroundQueued: s.background.length,
      running: s.running,
      maxConcurrency: s.base.maxConcurrency,
      recentRateLimitHits: s.recentHits.length,
      inBackoff: s.nextAllowedAt > now,
      nextAllowedAt: s.nextAllowedAt,
      lastRateLimitAt: s.lastRateLimitAt,
    })
  }
  return out
}

function broadcastStatus(): void {
  let snapshot: ProviderStatus[] | null = null
  // In-process subscribers (cheap path for the IPC layer)
  if (statusSubscribers.size > 0) {
    snapshot = buildSnapshot()
    const subs = Array.from(statusSubscribers)
    for (const cb of subs) {
      try { cb(snapshot) } catch { /* subscriber blew up — ignore */ }
    }
  }
  // Broadcast to all renderer windows via 'ai-throttle-status'
  try {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length === 0) return
    if (!snapshot) snapshot = buildSnapshot()
    for (const win of wins) {
      try {
        if (win.isDestroyed()) continue
        win.webContents.send('ai-throttle-status', snapshot)
      } catch { /* ignore individual window failures */ }
    }
  } catch { /* no windows etc. */ }
}

// Start the status tick lazily. Safe to call multiple times.
let startedTick = false
export function startStatusBroadcast(): void {
  if (startedTick) return
  startedTick = true
  statusTickTimer = setInterval(broadcastStatus, STATUS_TICK_MS)
  // Don't keep the Node event loop alive just for stats
  if (statusTickTimer.unref) statusTickTimer.unref()
}

// Test-only: stop the tick (so Jest can exit cleanly). No-op in production.
export function stopStatusBroadcast(): void {
  if (statusTickTimer) {
    clearInterval(statusTickTimer)
    statusTickTimer = null
  }
  startedTick = false
}

// ===== In-process subscribe (used by IPC to build explicit subscribe API) =====

export function subscribeStatus(cb: StatusSubscriber): () => void {
  statusSubscribers.add(cb)
  // Prime immediately so a subscriber gets current state without waiting a tick
  try { cb(buildSnapshot()) } catch { /* ignore */ }
  return () => { statusSubscribers.delete(cb) }
}

export function getSnapshot(): ProviderStatus[] {
  return buildSnapshot()
}

// ===== Legacy debug dump (kept for backward compat with old call sites) =====

export function dumpThrottleState(): Record<string, { intervalMs: number; mult: number; lastSlotAt: number }> {
  const out: Record<string, { intervalMs: number; mult: number; lastSlotAt: number }> = {}
  const states = Array.from(stateByProvider.values())
  for (const s of states) {
    out[s.providerId] = {
      intervalMs: currentIntervalMs(s.providerId),
      mult: s.adaptiveMultiplier,
      lastSlotAt: s.windowStartMs + s.windowCount * (60000 / Math.max(1, effectiveRpm(s))),
    }
  }
  return out
}
