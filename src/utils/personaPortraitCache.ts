// PERF-R8#14 · 共享 persona 肖像缓存
//
// 之前 AgentPanel 用 useState 本地缓存,每次组件 mount 都重新拉一遍肖像 IPC;
// PersonasTab 已经有自己的模块级 cache(loadPortraitOnce + slug fallback)。
// 抽公共 util,让 AgentPanel 也吃到模块级缓存,组件 mount 不重复 IPC。
//
// 这版只做最简形态(无 slug fallback)。slug fallback 是 PersonasTab 的特殊
// 需求(localhost dev assets),AgentPanel 用不到。如果将来需要可以扩。
//
// 失效策略: 跟 PersonasTab 一致,page reload 才清。`invalidatePortraitCache`
// 留给"用户重新生成肖像"路径调用(目前未实现重新生成,留接口)。

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

export async function getPortraitDataUrl(personaId: string): Promise<string | null> {
  if (cache.has(personaId)) return cache.get(personaId) ?? null
  const existing = inflight.get(personaId)
  if (existing) return existing
  const p = (async (): Promise<string | null> => {
    try {
      const r = await (window as any).electronAPI?.personaGetPortrait?.(personaId)
      const result: string | null = r?.success && r.dataUrl ? r.dataUrl : null
      cache.set(personaId, result)
      return result
    } catch {
      cache.set(personaId, null)
      return null
    } finally {
      inflight.delete(personaId)
    }
  })()
  inflight.set(personaId, p)
  return p
}

export function invalidatePortraitCache(personaId?: string): void {
  if (personaId) cache.delete(personaId)
  else cache.clear()
}
