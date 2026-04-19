// Smoke test for Phase A embedding helper: cosineSim + provider list.
// Doesn't hit the actual API (no key needed) — just verifies math and
// that the exports are shaped correctly.
//
// Run: node scripts/embeddingSmokeTest.mjs
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const SRC = path.join(ROOT, 'electron/ipc/personaEmbeddingApi.ts')
const TMP = path.join(os.tmpdir(), `embHelper-${Date.now()}.cjs`)

await build({
  entryPoints: [SRC],
  bundle: false,
  format: 'cjs',
  target: 'node18',
  platform: 'node',
  outfile: TMP,
  logLevel: 'error',
  loader: { '.ts': 'ts' },
})

const mod = await import(pathToFileURL(TMP).href)
const { cosineSim, getEmbeddingProvider, listEmbeddingProviders, embedTexts } = mod

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${name}`); pass++ }
  else { console.log(`  ❌ ${name} ${extra}`); fail++ }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
const header = (s) => console.log(`\n── ${s} ──`)

// ========== cosineSim ==========
header('cosineSim')
{
  t('identical vectors → 1', near(cosineSim([1, 2, 3], [1, 2, 3]), 1))
  t('orthogonal → 0', near(cosineSim([1, 0], [0, 1]), 0))
  t('opposite → -1', near(cosineSim([1, 2, 3], [-1, -2, -3]), -1))
  t('scaled same direction → 1', near(cosineSim([1, 2, 3], [2, 4, 6]), 1))
  t('empty a → 0', cosineSim([], []) === 0)
  t('length mismatch → 0', cosineSim([1, 2], [1, 2, 3]) === 0)
  t('zero vector → 0', cosineSim([0, 0, 0], [1, 1, 1]) === 0)
  // Partial-overlap realistic case:
  const a = [1, 1, 0, 0]
  const b = [1, 0, 1, 0]
  const expected = 0.5  // dot=1, |a|=√2, |b|=√2, 1/2
  t('partial overlap ≈ 0.5', near(cosineSim(a, b), expected))
  // A "query-ish" vs two "doc-ish" vectors
  const q = [0.7, 0.7, 0.1]
  const d1 = [0.8, 0.6, 0.2]  // should be closer
  const d2 = [0.1, 0.1, 0.9]  // very different
  t('closer doc ranks higher', cosineSim(q, d1) > cosineSim(q, d2))
}

// ========== provider metadata ==========
header('provider metadata')
{
  const openai = getEmbeddingProvider('openai')
  t('openai exists', !!openai)
  t('openai url correct', openai.url.includes('api.openai.com'))
  t('openai defaultDim 1536', openai.defaultDim === 1536)
  t('openai batchSize > 0', openai.batchSize > 0)

  const glm = getEmbeddingProvider('glm')
  t('glm exists', !!glm)
  t('glm url correct', glm.url.includes('bigmodel.cn'))
  t('glm defaultDim > 0', glm.defaultDim > 0)

  let threw = false
  try { getEmbeddingProvider('unknown') } catch { threw = true }
  t('unknown provider throws', threw)
}

// ========== list ==========
header('listEmbeddingProviders')
{
  const list = listEmbeddingProviders()
  t('returns array of 2', Array.isArray(list) && list.length === 2)
  t('has id/displayName fields', list.every(p => p.id && p.displayName && typeof p.defaultDim === 'number'))
  t('openai in list', list.some(p => p.id === 'openai'))
  t('glm in list', list.some(p => p.id === 'glm'))
}

// ========== embedTexts empty input ==========
header('embedTexts (no network)')
{
  const r = await embedTexts([], { providerId: 'openai', apiKey: 'fake' })
  t('empty input → empty result', Array.isArray(r) && r.length === 0)
}

console.log(`\n═══════════════════════════════════════`)
console.log(`  Total: ${pass + fail}  Pass: ${pass}  Fail: ${fail}`)
console.log(`═══════════════════════════════════════`)
process.exit(fail > 0 ? 1 : 0)
