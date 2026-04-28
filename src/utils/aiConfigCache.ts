// 2026-04-25 PERF · 共享 AI provider 配置缓存
// 之前 AgentPanel / AnnotationPanel / PdfViewer / TranslateModal 各自独立调
// `window.electronAPI.aiGetConfigured()`，每次组件 mount 都跑一次 IPC + 文件读，
// 用户切换面板时大量重复请求。
//
// 现在抽成模块级 cache：
//   - 第一次调用真正发 IPC
//   - 之后命中 cache（内存 Map），同步返回
//   - 多组件并发请求时共享同一 in-flight Promise，dedupe 去重
//   - 用户更新 API key（在 Settings 里）时调 `invalidateAiConfigCache()` 失效
//
// 2026-04-27 Batch 43 · 修 bug "配置完 deepseek 后学徒模型下拉没更新"：
// 之前 invalidate 只清 cache，但已 mount 的组件仍持着旧 list state，没有
// 重 fetch 信号。现在加 subscribe/notify：invalidate 时主动 re-fetch 一次
// 并广播给所有订阅者，组件用 useAiConfig hook 自动跟随。

import { useEffect, useState } from 'react'

export type ConfiguredProvider = {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

let cache: ConfiguredProvider[] | null = null
let inflight: Promise<ConfiguredProvider[]> | null = null

type Listener = (list: ConfiguredProvider[]) => void
const listeners = new Set<Listener>()

export async function fetchAiConfig(): Promise<ConfiguredProvider[]> {
  if (cache) return cache
  if (inflight) return inflight
  const api = (window as any).electronAPI?.aiGetConfigured
  if (!api) return []
  inflight = (async () => {
    try {
      const r = await api()
      const list: ConfiguredProvider[] = Array.isArray(r) ? r : []
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

/** Force re-fetch on next call (e.g. after user saves API keys in Settings).
 *  Batch 43: 失效后主动广播给所有订阅者，让它们自动 re-fetch 并更新 state。 */
export function invalidateAiConfigCache(): void {
  cache = null
  inflight = null
  if (listeners.size === 0) return
  // fire-and-forget: 拉新数据后广播
  void fetchAiConfig().then((list) => {
    listeners.forEach((l) => {
      try { l(list) } catch { /* ignore individual subscriber errors */ }
    })
  })
}

/** Subscribe to cache invalidations. The listener fires after the cache has
 *  been refreshed with the new data. Returns an unsubscribe function. */
export function subscribeAiConfig(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React hook · 自动订阅 cache 变化。组件用这个就不用手写 useEffect + subscribe。
 *  初始值取 cache（同步可用），cache 为空时返回 []，组件首次渲染后再 fetch。 */
export function useAiConfig(): ConfiguredProvider[] {
  const [list, setList] = useState<ConfiguredProvider[]>(cache || [])
  useEffect(() => {
    let cancelled = false
    fetchAiConfig().then((r) => {
      if (!cancelled) setList(r)
    })
    const unsub = subscribeAiConfig((latest) => {
      if (!cancelled) setList(latest)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
  return list
}
