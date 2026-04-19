// Smoke test for Phase B RAG: chunkSource + bm25Search.
// Runs without the Electron shell — compiles the helper with esbuild and
// imports the result. Prints pass/fail for each case. Deterministic — no
// network, no disk beyond the temp .cjs output.
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const __filename = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(__filename), '..')
const SRC = path.join(ROOT, 'electron/ipc/personaRagHelper.ts')
const TMP = path.join(os.tmpdir(), `ragHelper-${Date.now()}.cjs`)

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
const { chunkSource, bm25Search } = mod

let pass = 0, fail = 0
const t = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✅ ${name}`); pass++ }
  else { console.log(`  ❌ ${name} ${extra}`); fail++ }
}

const header = (s) => console.log(`\n── ${s} ──`)

// ========== chunkSource ==========
header('chunkSource')
{
  const src = { id: 's1', title: '精神现象学', source: 'project-gutenberg', url: '', trust: 'primary',
    snippet: '', fullContent: '' }

  // Empty content
  t('empty content → no chunks', chunkSource(src).length === 0)

  // Single short paragraph → 1 chunk (over 50 chars)
  src.fullContent = '主奴辩证是精神现象学中一个关键段落。它描述了两个自我意识在争取承认时如何陷入生死斗争，最终一方成为主人一方成为奴隶，从而揭示了主体性形成的社会条件。这段文字虽短但意义深远，理解它需要把握'.repeat(1)
  const shortChunks = chunkSource(src)
  t('single short para → ≥1 chunk', shortChunks.length >= 1)
  t('chunk text includes source term', shortChunks[0]?.text.includes('主奴辩证'))
  t('chunk carries sourceId/title/trust', shortChunks[0]?.sourceId === 's1' && shortChunks[0]?.sourceTitle === '精神现象学' && shortChunks[0]?.trust === 'primary')

  // Very small text (<= 50 chars) → no chunks
  src.fullContent = '太短'
  t('<50 chars → no chunks', chunkSource(src).length === 0)

  // Long content with paragraph breaks → multiple chunks
  src.fullContent = Array.from({ length: 6 }, (_, i) =>
    `第${i+1}段：` + '关于主奴辩证的讨论。'.repeat(30)
  ).join('\n\n')
  const longChunks = chunkSource(src)
  t('long multi-para → multiple chunks', longChunks.length >= 2, `got ${longChunks.length}`)
  t('chunks have ascending idx', longChunks.every((c, i) => c.chunkIdx === i))
  t('no chunk exceeds maxChars by much', longChunks.every(c => c.text.length <= 1200),
    `max=${Math.max(...longChunks.map(c => c.text.length))}`)

  // Gigantic single paragraph with no breaks → should still split by sentence
  src.fullContent = '绝对精神自我展开。'.repeat(400)  // ~3200 chars, one "paragraph"
  const giantChunks = chunkSource(src)
  t('giant single para → splits by sentence', giantChunks.length >= 3, `got ${giantChunks.length}`)

  // No fullContent but has snippet → use snippet
  src.fullContent = undefined
  src.snippet = '维基百科搜索结果的摘要段落，约一百字左右，用来作为未 hydrate 资料的兜底内容。虽然只是简短介绍也应当产生一个 chunk 以便 BM25 至少能有索引。'
  const snippetChunks = chunkSource(src)
  t('falls back to snippet', snippetChunks.length === 1)
}

// ========== bm25Search ==========
header('bm25Search (relevance)')
{
  const mk = (id, title, text, trust = 'medium') => ({
    id, title, source: 'project-gutenberg', url: '', trust, snippet: '', fullContent: text
  })
  const hegel = mk('s1', '精神现象学',
    `主奴辩证描述了两个自我意识在争夺承认过程中形成的支配与服从关系。主人占据了形式上的独立性，但实质上依赖奴隶的劳动。而奴隶通过劳动改造外物，反而在物化中确证了自己的主体性。这里的辩证就是通过否定达到扬弃。

    绝对精神是全书的最高概念。它经历了自我异化与复归的全过程。相对于康德的物自体不可知，黑格尔认为精神能够完全认识自己，通过历史的中介达到自我透明。`)
  const marx = mk('s2', '共产党宣言',
    `一切历史都是阶级斗争的历史。资产阶级在取得胜利的同时也创造了自己的掘墓人。无产阶级失去的只是锁链而已，获得的将是整个世界。

    劳动创造了人本身。但在资本主义条件下劳动被异化——工人生产的产品作为异己的力量对立于他。`)
  const wiki = mk('s3', '黑格尔 - 维基百科',
    `黑格尔是著名的德国哲学家。他的思想深刻影响了后世。他写了《精神现象学》和《逻辑学》等重要著作。他被认为是德国古典哲学的集大成者。`, 'low')

  const allChunks = [...chunkSource(hegel), ...chunkSource(marx), ...chunkSource(wiki)]
  t('chunks from 3 sources all produced', allChunks.length >= 3, `got ${allChunks.length}`)

  // Query about 主奴辩证 → top should be Hegel chunks (not Marx, not wiki)
  const topMaster = bm25Search(allChunks, '主奴辩证是什么', 3)
  t('query "主奴辩证" returns results', topMaster.length > 0)
  t('top result is from Hegel primary source', topMaster[0]?.sourceId === 's1',
    `top sourceId=${topMaster[0]?.sourceId}`)
  t('Hegel primary ranks above wiki (trust boost)',
    (topMaster.find(c => c.sourceId === 's1')?.score ?? 0) >
    (topMaster.find(c => c.sourceId === 's3')?.score ?? 0))

  // Query about 阶级斗争 → top should be Marx
  const topClass = bm25Search(allChunks, '阶级斗争和资本主义', 3)
  t('query "阶级斗争" → Marx first', topClass[0]?.sourceId === 's2',
    `top=${topClass[0]?.sourceId} score=${topClass[0]?.score.toFixed(2)}`)

  // Zero-overlap query — no shared characters with any chunk.
  const none = bm25Search(allChunks, 'xyzzy plugh foobar', 5)
  t('zero-overlap query → 0 results', none.length === 0,
    `got ${none.length} (top=${none[0]?.text?.slice(0, 20)})`)

  // Semi-irrelevant query (shares common CJK chars but not topic) — BM25 per-char
  // limitation: it WILL return low-score hits. Assert score is meaningfully lower
  // than a matched query. Phase A embedding RAG is the real fix.
  const semi = bm25Search(allChunks, '量子力学现代物理诠释', 5)
  const topSemiScore = semi[0]?.score ?? 0
  const topMatchScore = topMaster[0]?.score ?? 0
  t('semi-irrelevant score noticeably lower than matched',
    topSemiScore < topMatchScore * 0.85,
    `semi=${topSemiScore.toFixed(2)} matched=${topMatchScore.toFixed(2)}`)

  // Empty query tokens → empty
  t('empty query → 0 results', bm25Search(allChunks, '', 5).length === 0)
  t('whitespace query → 0 results', bm25Search(allChunks, '   \n  ', 5).length === 0)

  // Empty chunks → empty
  t('no chunks → 0 results', bm25Search([], '主奴辩证', 5).length === 0)

  // topK bound
  const t1 = bm25Search(allChunks, '黑格尔精神哲学', 1)
  t('topK=1 → at most 1 result', t1.length <= 1)

  // Trust boost — create two near-identical chunks, one primary one low
  const twin1 = mk('p1', '原著', '主奴辩证是黑格尔的核心概念', 'primary')
  const twin2 = mk('p2', '百科', '主奴辩证是黑格尔的核心概念', 'low')
  const twinChunks = [...chunkSource(twin1), ...chunkSource(twin2)]
  const twinRes = bm25Search(twinChunks, '主奴辩证', 5)
  // primary should outrank low even with identical text — but both chunks may
  // be too short (<50) to even chunk, so verify first
  if (twinChunks.length >= 2 && twinRes.length >= 2) {
    t('trust=primary outranks trust=low for identical text', twinRes[0].trust === 'primary')
  } else {
    console.log(`  (skipped trust-boost: twinChunks=${twinChunks.length} twinRes=${twinRes.length})`)
  }
}

// ========== Edge cases ==========
header('Edge cases')
{
  const mk = (id, text, trust = 'medium') => ({
    id, title: id, source: 'user-file', url: '', trust, snippet: '', fullContent: text
  })

  // Mixed CJK + ASCII
  const mixed = mk('mix', '黑格尔 said that Geist is dialectical. The 辩证法 is the heart of his philosophy. Read 精神现象学 carefully for the 主奴 dialectic.')
  const mixChunks = chunkSource(mixed)
  const mixTop = bm25Search(mixChunks, 'dialectical 辩证法', 3)
  t('mixed CJK+ASCII query works', mixTop.length > 0)

  // Whitespace / punctuation only content
  const punct = mk('punct', '。。。   \n\n\n  !!!  ')
  t('whitespace-only content → 0 chunks', chunkSource(punct).length === 0)

  // Multi-language (English only content)
  const eng = mk('eng', 'Hegel argued that the master-slave dialectic reveals how recognition structures self-consciousness. The Phenomenology of Spirit develops this in detail.')
  const engChunks = chunkSource(eng)
  const engTop = bm25Search(engChunks, 'master slave dialectic', 3)
  t('English-only search works', engTop.length > 0 && engTop[0].sourceId === 'eng')
}

// ========== Summary ==========
console.log(`\n═══════════════════════════════════════`)
console.log(`  Total: ${pass + fail}  Pass: ${pass}  Fail: ${fail}`)
console.log(`═══════════════════════════════════════`)

await fs.unlink(TMP).catch(() => {})
process.exit(fail > 0 ? 1 : 0)
