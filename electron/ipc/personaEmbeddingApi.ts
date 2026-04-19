// ===== Phase A embedding providers =====
// Thin wrapper over OpenAI / GLM (智谱) embedding endpoints. Batches input up
// to ~64 texts per request (both APIs support larger batches, but 64 is a
// safe floor). On rate-limit / 429, sleeps and retries once. All other errors
// bubble up so the caller can decide whether to abort or switch provider.
//
// Returns per-text vectors in the input order. Dim depends on model:
//   - openai text-embedding-3-small: 1536
//   - openai text-embedding-3-large: 3072
//   - glm  embedding-2:              1024
//   - glm  embedding-3:              2048
//
// 节流：所有 embedding 请求走主进程 aiThrottle，与 chat / web-search-pro 共
// 用同一份 per-provider lastScheduled，避免 GLM 多入口并发把 4 RPM 配额炸穿。

import { throttleProvider, bumpProviderInterval, isRateLimitError } from './aiThrottle'

export type EmbeddingProviderId = 'openai' | 'glm'

interface ProviderSpec {
  id: EmbeddingProviderId
  displayName: string
  url: string
  defaultModel: string
  defaultDim: number
  batchSize: number
  auth: (key: string) => Record<string, string>
}

const PROVIDERS: Record<EmbeddingProviderId, ProviderSpec> = {
  openai: {
    id: 'openai',
    displayName: 'OpenAI Embeddings',
    url: 'https://api.openai.com/v1/embeddings',
    defaultModel: 'text-embedding-3-small',
    defaultDim: 1536,
    batchSize: 64,
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  glm: {
    id: 'glm',
    displayName: '智谱 GLM Embeddings',
    url: 'https://open.bigmodel.cn/api/paas/v4/embeddings',
    defaultModel: 'embedding-2',
    defaultDim: 1024,
    batchSize: 32,
    auth: (key) => ({ Authorization: `Bearer ${key}` }),
  },
}

export function getEmbeddingProvider(id: EmbeddingProviderId): ProviderSpec {
  const p = PROVIDERS[id]
  if (!p) throw new Error(`未知 embedding provider: ${id}`)
  return p
}

export function listEmbeddingProviders(): Array<Pick<ProviderSpec, 'id' | 'displayName' | 'defaultModel' | 'defaultDim'>> {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, displayName: p.displayName, defaultModel: p.defaultModel, defaultDim: p.defaultDim,
  }))
}

interface EmbedOpts {
  providerId: EmbeddingProviderId
  apiKey: string
  model?: string  // override provider default
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** Embed a batch of texts. Returns vectors in input order. Retries 429 once. */
export async function embedTexts(texts: string[], opts: EmbedOpts): Promise<number[][]> {
  if (texts.length === 0) return []
  const prov = getEmbeddingProvider(opts.providerId)
  const model = opts.model || prov.defaultModel
  const out: number[][] = []

  for (let i = 0; i < texts.length; i += prov.batchSize) {
    const batch = texts.slice(i, i + prov.batchSize)
    let attempt = 0
    let lastErr: any = null
    while (attempt < 2) {
      attempt++
      try {
        // 走主进程节流：GLM 与 chat / web-search-pro 共享 lastScheduled
        await throttleProvider(opts.providerId)
        const res = await fetch(prov.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...prov.auth(opts.apiKey) },
          body: JSON.stringify({ model, input: batch }),
          signal: opts.signal,
        })
        if (res.status === 429 && attempt < 2) {
          // 撞墙 → 把这个 provider 的间隔翻倍（×2，上限 8×），下次 throttle 就拉长了
          bumpProviderInterval(opts.providerId)
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          if (isRateLimitError(`${res.status} ${body}`)) bumpProviderInterval(opts.providerId)
          throw new Error(`${prov.displayName} ${res.status}: ${body.slice(0, 200)}`)
        }
        const json = await res.json() as { data: Array<{ embedding: number[]; index: number }> }
        if (!json.data || !Array.isArray(json.data)) {
          throw new Error(`${prov.displayName} 返回格式异常：缺少 data 数组`)
        }
        const sorted = [...json.data].sort((a, b) => a.index - b.index)
        for (const item of sorted) {
          if (!Array.isArray(item.embedding)) throw new Error(`${prov.displayName} 返回格式异常：embedding 不是数组`)
          out.push(item.embedding)
        }
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        if (attempt >= 2) break
      }
    }
    if (lastErr) throw lastErr
    opts.onProgress?.(Math.min(i + prov.batchSize, texts.length), texts.length)
  }

  return out
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
