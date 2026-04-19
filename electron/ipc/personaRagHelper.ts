import type { PersonaSource } from '../../src/types/library'

/** One retrievable chunk from a source. Chunks are 500-800 chars, split on
 *  natural boundaries (paragraph breaks, sentence ends). */
export interface RagChunk {
  sourceId: string
  sourceTitle: string
  sourceType: PersonaSource['source']
  trust: NonNullable<PersonaSource['trust']>
  chunkIdx: number
  text: string
}

/** Chunk a source's fullContent into RagChunks. Prefers paragraph breaks
 *  (\n\n), falls back to sentence boundaries (。 ！ ？ .), then fixed-size
 *  overlap windows. Skips sources with no fullContent. */
export function chunkSource(source: PersonaSource, targetChars = 650, maxChars = 900): RagChunk[] {
  const text = source.fullContent || source.snippet || ''
  if (!text.trim()) return []

  const chunks: RagChunk[] = []
  let idx = 0
  let buffer = ''

  const pushBuffer = () => {
    const t = buffer.trim()
    if (t.length > 50) {
      chunks.push({
        sourceId: source.id,
        sourceTitle: source.title,
        sourceType: source.source,
        trust: source.trust || 'medium',
        chunkIdx: idx++,
        text: t,
      })
    }
    buffer = ''
  }

  const splitHugeParagraph = (p: string) => {
    // Sentence boundary split — CJK 。！？ + ASCII .!? + optional closing quote
    const sentences = p.split(/(?<=[。！？\.!?][」』"'）\)]?)/).filter(s => s.trim())
    for (const s of sentences) {
      if (s.length > maxChars) {
        // Sentence itself is absurdly long (e.g. no punctuation) — hard slice
        for (let i = 0; i < s.length; i += maxChars) {
          if (buffer.length >= targetChars) pushBuffer()
          const slice = s.slice(i, i + maxChars)
          buffer += (buffer ? ' ' : '') + slice
          if (buffer.length >= targetChars) pushBuffer()
        }
        continue
      }
      if (buffer.length + s.length > maxChars) pushBuffer()
      buffer += (buffer && !buffer.endsWith('\n') ? '' : '') + s
      if (buffer.length >= targetChars) pushBuffer()
    }
  }

  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p)
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      pushBuffer()
      splitHugeParagraph(p)
      pushBuffer()
      continue
    }
    if (buffer.length + p.length > maxChars) {
      pushBuffer()
      buffer = p
    } else {
      buffer += (buffer ? '\n\n' : '') + p
    }
    if (buffer.length >= targetChars) pushBuffer()
  }
  pushBuffer()
  return chunks
}

// High-frequency CJK function chars + English stop words. Filtered out of
// BM25 tokens so irrelevant queries that share generic chars ("的/了/是") don't
// score near-equal with relevant queries. Keep conservative — we'd rather miss
// a stop-word match than spuriously rank stop-heavy chunks on top.
const STOP_TOKENS = new Set<string>([
  // CJK function chars (particles, pronouns, common verbs/nouns too generic to discriminate)
  '的', '了', '是', '在', '和', '与', '或', '及', '就', '也', '都', '又', '还', '而',
  '但', '而且', '然后', '所以', '因为', '如果', '虽然',
  '有', '无', '不', '没', '没有', '对', '从', '到', '在', '上', '下', '中', '里', '外',
  '这', '那', '此', '其', '之', '于', '以', '为', '被', '把', '让', '使',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '自己',
  '一', '二', '三', '个', '些', '些', '么', '什么', '怎么', '怎样', '哪', '哪里',
  '吗', '呢', '吧', '啊', '呀', '嗯', '哦', '诶',
  // English stop words (lowercase)
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as', 'about',
  'and', 'or', 'but', 'if', 'so', 'because', 'while',
  'that', 'this', 'these', 'those', 'it', 'its',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'not', 'no', 'yes', 'can', 'could', 'would', 'should', 'may', 'might',
])

/** Tokenize: CJK per-char + ASCII word-boundary, lowercased, stop tokens dropped. */
function tokenize(s: string): string[] {
  const tokens: string[] = []
  let wordBuf = ''
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      if (wordBuf) { tokens.push(wordBuf.toLowerCase()); wordBuf = '' }
      tokens.push(ch)
    } else if (/[\w]/.test(ch)) {
      wordBuf += ch
    } else {
      if (wordBuf) { tokens.push(wordBuf.toLowerCase()); wordBuf = '' }
    }
  }
  if (wordBuf) tokens.push(wordBuf.toLowerCase())
  return tokens.filter(t => t.length > 0 && !STOP_TOKENS.has(t))
}

/** BM25 scorer over chunks. Boosts `trust='primary'` chunks 1.4x so original
 *  texts outrank Wikipedia summaries when both match. */
export function bm25Search(
  chunks: RagChunk[],
  query: string,
  topK = 5,
): Array<RagChunk & { score: number }> {
  if (chunks.length === 0) return []
  const queryTokens = Array.from(new Set(tokenize(query)))
  if (queryTokens.length === 0) return []

  const docs = chunks.map(c => ({ chunk: c, tokens: tokenize(c.text) }))
  const totalLen = docs.reduce((s, d) => s + d.tokens.length, 0)
  const avgDocLen = totalLen > 0 ? totalLen / docs.length : 1
  const docFreq = new Map<string, number>()
  for (const { tokens } of docs) {
    const unique = new Set(tokens)
    unique.forEach(t => docFreq.set(t, (docFreq.get(t) || 0) + 1))
  }

  const k1 = 1.5
  const b = 0.75
  const N = docs.length

  const scored = docs.map(({ chunk, tokens }) => {
    const docLen = tokens.length || 1
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    let score = 0
    for (const q of queryTokens) {
      const freq = tf.get(q) || 0
      if (freq === 0) continue
      const df = docFreq.get(q) || 0
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      const norm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * docLen) / avgDocLen))
      score += idf * norm
    }
    if (chunk.trust === 'primary') score *= 1.4
    else if (chunk.trust === 'high') score *= 1.15
    else if (chunk.trust === 'low') score *= 0.7
    return { ...chunk, score }
  })

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
