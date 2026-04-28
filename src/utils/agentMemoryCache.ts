// 2026-04-25 PERF · 共享 agent memory cache
// 之前 AnnotationPanel 在用户每次选中文本时调 agentLoadMemory()，
// PdfViewer 每次进入也加载，AgentPanel mount 时也加载。
// memory.md 文件可能 KB 级别，多次读盘开销不必要。
//
// 现在抽到模块级：
//   - 第一次调用走 IPC，缓存内容
//   - 之后命中 cache，同步返回
//   - 多组件并发请求时 dedupe（共享 in-flight Promise）
//   - 调 invalidateAgentMemoryCache() 失效（agent 自己 update 时调）

let cache: { success: boolean; content?: string; error?: string } | null = null
let inflight: Promise<{ success: boolean; content?: string; error?: string }> | null = null

export async function fetchAgentMemory(): Promise<{ success: boolean; content?: string; error?: string }> {
  if (cache) return cache
  if (inflight) return inflight
  const api = (window as any).electronAPI?.agentLoadMemory
  if (!api) return { success: false, error: 'API not available' }
  inflight = (async () => {
    try {
      const r = await api()
      cache = r
      return r
    } catch (err: any) {
      const fail = { success: false, error: err?.message || 'load failed' }
      cache = fail
      return fail
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Invalidate when agent itself updates memory (e.g. after saveMemory). */
export function invalidateAgentMemoryCache(): void {
  cache = null
  inflight = null
}
