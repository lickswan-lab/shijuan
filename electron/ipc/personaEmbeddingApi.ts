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
//
// Phase D TODO · Local embeddings fallback:
//   When no provider key is configured, users currently fall all the way back
//   to BM25 at summon time (keyword-only retrieval, decent precision for
//   CJK but lousy semantic coverage). Drop-in plan:
//     1. Add `@xenova/transformers` to deps (~5MB lib, auto-downloads model
//        on first use into `app.getPath('userData')/hf-models/`).
//     2. Preferred model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
//        — 384-dim, multilingual (zh/en), ~120MB after quantization (Q8),
//        OR `Xenova/bge-small-zh-v1.5` (512-dim) for pure-Chinese corpora.
//     3. Add a third provider entry {id:'local', url:'', auth:null}; in
//        embedTexts() detect the 'local' id before the fetch path and call
//        into a lazy-loaded pipeline('feature-extraction', modelId) that
//        yields number[][] directly — same return shape, no throttle.
//     4. Update pickAvailableEmbeddingProvider() in personas.ts to treat
//        'local' as always-available once the model file exists on disk.
//     5. First-build UX: show a toast "正在下载本地模型（~120MB，仅一次）"
//        during model init; subsequent builds reuse the cached weights.
//   Skipped for now because the model-download step needs careful UX and
//   electron-packager side config (don't bundle weights in the asar — let
//   transformers.js download on demand into userData).

import { throttleProvider, bumpProviderInterval, isRateLimitError } from './aiThrottle'

/** When Phase D lands, expand to `'openai' | 'glm' | 'local'`. For now we
 *  keep the union tight so consumers don't have to handle a provider that
 *  doesn't exist yet. */
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
          // BUG-FIX R5#1 · sleep 期间若用户 abort 立即停，不等满 2s。
          // 原实现 `await setTimeout(2000)` 无视 signal，导致取消 RAG 构建后还要
          // 卡 2s（多 batch 会累加），用户以为"点了没反应"。
          await new Promise<void>((resolve, reject) => {
            if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
            const t = setTimeout(resolve, 2000)
            opts.signal?.addEventListener('abort', () => {
              clearTimeout(t)
              reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          })
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

// PERF-R8#18 · RAG 检索热路径优化:`idx.chunks.map(c => cosineSim(queryVec, c.embedding))`
//   每次都重算 queryVec 的范数(1024 ops + sqrt),N 个 chunk 重 N 次。
//   抽 vectorNorm + cosineSimWithNormA,query 端只算一次,N 个 chunk 各只算自己的范数。
//   1000-chunk × 1024-dim 场景下省 ~33% ops 和一半 sqrt。
//
// 用法:
//   const normQ = vectorNorm(queryVec)
//   const scores = chunks.map(c => cosineSimWithNormA(queryVec, normQ, c.embedding))

/** L2 范数(平方和的开方)。 */
export function vectorNorm(v: number[]): number {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  return Math.sqrt(n)
}

/** 调用方已经预先算好 `normA` 的 cosine similarity。
 *  比 cosineSim 少算一次 a 端的 norm,适合"一个 query 对 N 个 chunk"的批量比较。 */
export function cosineSimWithNormA(a: number[], normA: number, b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  if (normA === 0) return 0
  let dot = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    nb += b[i] * b[i]
  }
  const denom = normA * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
