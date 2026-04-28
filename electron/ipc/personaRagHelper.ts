import type { PersonaSource } from '../../src/types/library'

/** One retrievable chunk from a source. Chunks are 500-800 chars, split on
 *  natural boundaries (paragraph breaks, sentence ends).
 *
 *  2026-04-28 · `sectionPath` 字段:从 markdown 源切出来时,记录 chunk 所属的
 *  ## / ### 标题路径,如 "心智模型集 / 理念论"。citation 显示用,提升可溯源性。
 *  非 markdown 源(纯文本 / 维基扁平段落)留空。 */
export interface RagChunk {
  sourceId: string
  sourceTitle: string
  sourceType: PersonaSource['source']
  trust: NonNullable<PersonaSource['trust']>
  chunkIdx: number
  text: string
  sectionPath?: string  // e.g. "心智模型集 / 理念论 (Theory of Forms)"
}

/** Chunk a source's fullContent into RagChunks.
 *
 *  2026-04-28 · 新增 markdown heading-aware 切分:
 *  - 检测到正文像 markdown(开头几行有 `^#+\s` heading,或者 heading 数 ≥ 2)
 *    → 按 `## XX` / `### XX` 分段,每段一个 chunk(超长时进一步切但保留 sectionPath)
 *    → 每个 chunk 带 sectionPath 标签如 "心智模型集 / 理念论"
 *  - 否则走原段落式切分(纯文本 / 维基)
 *
 *  这让 MENTAL_MODELS.md 这种结构化文档能被精确命中(用户问"理念论"
 *  → 直接命中那一节,而不是被无关段稀释)。 */
export function chunkSource(source: PersonaSource, targetChars = 650, maxChars = 900): RagChunk[] {
  const text = source.fullContent || source.snippet || ''
  if (!text.trim()) return []

  // 检测 markdown:正文里 heading 行(##/###/####)≥ 2 个 → 走 heading split
  const headingMatches = text.match(/^#{2,4}\s+\S/gm)
  const looksLikeMarkdown = (headingMatches?.length || 0) >= 2

  if (looksLikeMarkdown) {
    return chunkByHeadings(source, text, targetChars, maxChars)
  }
  return chunkByParagraphs(source, text, targetChars, maxChars, undefined)
}

/** 按 markdown heading 切分。每个 ## section 是基础单元,超长时再按段落细切,
 *  细切出来的 sub-chunks 全部继承同一个 sectionPath(主标题 / 子标题)。 */
function chunkByHeadings(source: PersonaSource, text: string, targetChars: number, maxChars: number): RagChunk[] {
  const chunks: RagChunk[] = []
  const idxRef = { value: 0 }

  // 切到 ## 级别(把 # H1 当作整篇标题不切),保留 ### H3 在 section 内
  // 用正则找所有 ## 的位置,把它们之间的内容当作一个 section
  const sections: Array<{ heading: string; level: number; content: string }> = []
  const headingRe = /^(#{2,4})\s+(.+)$/gm
  const matches: Array<{ idx: number; level: number; heading: string }> = []
  let m: RegExpExecArray | null
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ idx: m.index, level: m[1].length, heading: m[2].trim() })
  }
  if (matches.length === 0) {
    // 兜底,按段落切(虽然 looksLikeMarkdown 已 ≥ 2,这里防御)
    return chunkByParagraphs(source, text, targetChars, maxChars, undefined)
  }
  // 第一个 match 之前的导言段(如果有内容)
  const intro = text.slice(0, matches[0].idx).trim()
  if (intro && intro.length > 50) {
    sections.push({ heading: '(开篇)', level: 2, content: intro })
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx
    const end = i + 1 < matches.length ? matches[i + 1].idx : text.length
    // section 内容包含 heading 行本身,后面的正文
    const sectionRaw = text.slice(start, end)
    // 去掉 heading 行,只留正文
    const lines = sectionRaw.split('\n')
    const body = lines.slice(1).join('\n').trim()
    if (!body) continue
    sections.push({ heading: matches[i].heading, level: matches[i].level, content: body })
  }

  // 维护当前的 H2 / H3 路径,生成 sectionPath 字符串
  let currentH2 = ''
  for (const sec of sections) {
    if (sec.level === 2) currentH2 = sec.heading
    const sectionPath = sec.level === 2
      ? sec.heading
      : (currentH2 ? `${currentH2} / ${sec.heading}` : sec.heading)

    if (sec.content.length <= maxChars) {
      // 整 section 直接一个 chunk(包含 heading 文本帮助检索匹配)
      chunks.push({
        sourceId: source.id,
        sourceTitle: source.title,
        sourceType: source.source,
        trust: source.trust || 'medium',
        chunkIdx: idxRef.value++,
        text: `## ${sec.heading}\n\n${sec.content}`,
        sectionPath,
      })
    } else {
      // section 太长 → 按段落切,所有 sub-chunk 共享同一 sectionPath
      const subs = chunkByParagraphs(source, sec.content, targetChars, maxChars, sectionPath)
      for (const sub of subs) {
        chunks.push({
          ...sub,
          chunkIdx: idxRef.value++,
          // sub-chunk 第一个加上 heading 前缀,后续保持原文
          text: sub.chunkIdx === 0 ? `## ${sec.heading}\n\n${sub.text}` : sub.text,
        })
      }
    }
  }
  return chunks
}

/** 段落式切分(原逻辑),提取为独立函数以便 chunkByHeadings 在长 section 下复用 */
function chunkByParagraphs(
  source: PersonaSource,
  text: string,
  targetChars: number,
  maxChars: number,
  sectionPath: string | undefined,
): RagChunk[] {
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
        sectionPath,
      })
    }
    buffer = ''
  }

  const splitHugeParagraph = (p: string) => {
    const sentences = p.split(/(?<=[。！？\.!?][」』"'）\)]?)/).filter(s => s.trim())
    for (const s of sentences) {
      if (s.length > maxChars) {
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
