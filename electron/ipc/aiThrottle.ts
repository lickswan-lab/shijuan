// 主进程级 per-provider 节流（chokepoint）。
//
// 为什么放在主进程：
//   1. 渲染进程的 PersonasTab 节流只覆盖 callPersonaAi。但 GLM 在主进程被
//      多个路径调：chat (aiApi) / embeddings (personaEmbeddingApi) /
//      web-search-pro (personas-search-helper)。三个路径并发跑（比如「AI 深度
//      搜索」一边 callPersonaAi 一边 nuwaSearch）会把 GLM 配额炸穿。
//   2. 主进程模块状态在 HMR 不重置 → throttle 状态稳定。
//   3. 单例：所有渲染进程通过 IPC 共用同一份 lastScheduledByProvider。
//
// 行为：
//   - 每个 provider 一个最小间隔。GLM 默认 16s（按整分钟边界 60/4=15 的安全值）。
//   - 撞墙（429 / 1302 / 速率限制）→ adaptive multiplier × 2，上限 8×。
//   - throttleProvider() 用「原子预约 slot」模式：lastScheduled = max(now,
//     last+minMs)。并发调用自然按序通过队列。
//
// 注意：这层不做 retry，只做节流。retry 留给上层（callPersonaAi）。

const PROVIDER_BASE_INTERVAL_MS: Record<string, number> = {
  glm:      16000,   // 按整分钟边界 4 RPM ≈ 15s, 16s 留安全边
  openai:    1100,
  claude:    1100,
  deepseek:  1100,
  doubao:    1100,
  kimi:      1100,
}
const DEFAULT_INTERVAL_MS = 1100

const lastScheduledByProvider: Record<string, number> = {}
const adaptiveMultByProvider: Record<string, number> = {}

export function currentIntervalMs(provider: string): number {
  const p = provider.toLowerCase()
  const base = PROVIDER_BASE_INTERVAL_MS[p] ?? DEFAULT_INTERVAL_MS
  const mult = adaptiveMultByProvider[p] ?? 1
  return base * mult
}

export function getAdaptiveMultiplier(provider: string): number {
  return adaptiveMultByProvider[provider.toLowerCase()] ?? 1
}

// 等待并占用下一个 slot。返回实际等待的毫秒数（用于日志）。
export async function throttleProvider(provider: string): Promise<number> {
  const p = provider.toLowerCase()
  const minMs = currentIntervalMs(p)
  const now = Date.now()
  const last = lastScheduledByProvider[p] ?? 0
  const slotAt = Math.max(now, last + minMs)
  // 同步预约（JS 单线程，read-then-write 之间不会让出控制权）
  lastScheduledByProvider[p] = slotAt
  const wait = slotAt - now
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  return wait
}

// 撞墙后调用，把这个 provider 的间隔翻倍（上限 8×）。返回新的 multiplier。
export function bumpProviderInterval(provider: string): number {
  const p = provider.toLowerCase()
  const cur = adaptiveMultByProvider[p] ?? 1
  const next = Math.min(cur * 2, 8)
  adaptiveMultByProvider[p] = next
  return next
}

// 给 LLM 错误消息判 429 / rate-limit。统一 detector 让所有调用方一致。
export function isRateLimitError(msg: string | undefined | null): boolean {
  if (!msg) return false
  const m = String(msg).toLowerCase()
  return /(429|rate.?limit|1302|速率限制|频率)/i.test(m) || m.includes('rate_limit')
}

// 调试用：dump 当前所有 provider 的状态
export function dumpThrottleState(): Record<string, { intervalMs: number; mult: number; lastSlotAt: number }> {
  const out: Record<string, { intervalMs: number; mult: number; lastSlotAt: number }> = {}
  for (const p of new Set([...Object.keys(lastScheduledByProvider), ...Object.keys(adaptiveMultByProvider)])) {
    out[p] = {
      intervalMs: currentIntervalMs(p),
      mult: getAdaptiveMultiplier(p),
      lastSlotAt: lastScheduledByProvider[p] ?? 0,
    }
  }
  return out
}
