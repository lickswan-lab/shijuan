// PERF-R8#11 · 共享 persona list 缓存
//
// 之前 AnnotationPanel mount 时拉一遍 personaList,PersonasTab 自己也拉一遍,
// 用户切面板时重复 IPC + 文件读。模式照搬 aiConfigCache,差异:
//   - persona 增删改频率比 AI provider 配置更频繁,所以 invalidate 入口更多
//     (persona 导入 / 删除 / 改名 / 重排都要 invalidate)
//   - cache 仅存最小字段(id / name / canonicalName / currentFitnessTotal)
//     给 AnnotationPanel 召唤 dropdown 用;PersonasTab 自己的 list 仍走原 IPC
//     拿全量字段(后续可统一)
//
// 用法:
//   const list = usePersonaList()                        // React hook,自动订阅
//   const list = await fetchPersonaList()                // 命令式获取(命中缓存即同步)
//   invalidatePersonaListCache()                         // 用户改了 persona 后调
//
// 调用点:AnnotationPanel(mount)、PersonasTab loadList(待迁,本轮先做基础设施)

import { useEffect, useState } from 'react'

export type PersonaListEntry = {
  id: string
  name: string
  canonicalName?: string
  currentFitnessTotal?: number
}

let cache: PersonaListEntry[] | null = null
let inflight: Promise<PersonaListEntry[]> | null = null

type Listener = (list: PersonaListEntry[]) => void
const listeners = new Set<Listener>()

export async function fetchPersonaList(): Promise<PersonaListEntry[]> {
  if (cache) return cache
  if (inflight) return inflight
  const api = (window as any).electronAPI?.personaList
  if (!api) return []
  inflight = (async () => {
    try {
      const r = await api()
      const list: PersonaListEntry[] = r?.success && Array.isArray(r.entries) ? r.entries : []
      cache = list
      return list
    } catch {
      return []
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 失效后主动 re-fetch 并广播给所有订阅者。
 *  调用时机:用户导入/删除/改名 persona 后(从 PersonasTab 的对应 handler 调)。 */
export function invalidatePersonaListCache(): void {
  cache = null
  inflight = null
  if (listeners.size === 0) return
  void fetchPersonaList().then((list) => {
    listeners.forEach((l) => {
      try { l(list) } catch { /* ignore individual subscriber errors */ }
    })
  })
}

export function subscribePersonaList(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** React hook · 自动订阅 cache 变化。 */
export function usePersonaList(): PersonaListEntry[] {
  const [list, setList] = useState<PersonaListEntry[]>(cache || [])
  useEffect(() => {
    let cancelled = false
    fetchPersonaList().then((r) => {
      if (!cancelled) setList(r)
    })
    const unsub = subscribePersonaList((latest) => {
      if (!cancelled) setList(latest)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
  return list
}
