// ===== Apprentice prompt — the core voice of Hermes as "an observing companion" =====
//
// This prompt is deliberately crafted to produce observation reports, NOT summaries.
// The goal: surface things the user didn't notice about themselves.
//
// Key stylistic choices encoded below:
// - Second person ("你"), direct but not cloying
// - Hypotheses, not conclusions ("可能" / "或许", but concrete)
// - Quotes anchored to actual evidence (references thinking[i].selectedText)
// - Honest about data shortage — doesn't pad 5 bullets out of 2 data points

// The shape collectApprenticeContext returns. Kept loose on purpose — we rely on the
// renderer's type checker via electron.preload; the backend defines the canonical shape.
export interface ApprenticeContext {
  weekCode: string
  weekStart: string
  weekEnd: string
  stats: {
    activeDays: number
    entriesOpened: number
    annotationsCreated: number
    historyEntriesCreated: number
    memosEdited: number
  }
  reading: Array<{
    entryId: string
    title: string
    openCount: number
    lastOpenedAt: string
    hasAnnotationsThisWeek: boolean
  }>
  thinking: Array<{
    entryId: string
    entryTitle: string
    annotationId: string
    selectedText: string
    pageNumber: number
    createdAt: string
    entries: Array<{
      type: string
      author: 'user' | 'ai'
      content: string
      createdAt: string
    }>
  }>
  memos: Array<{
    memoId: string
    title: string
    blockCount: number
    createdAt: string
    updatedAt: string
    preview: string
  }>
  wider: {
    recentStances: Array<{
      entryId: string
      entryTitle: string
      content: string
      createdAt: string
    }>
    strugglingEntries: Array<{
      entryId: string
      title: string
      opensIn4Weeks: number
      annotationCount: number
    }>
  }
  previousWeekLog: string | null
}

export function buildApprenticePrompt(ctx: ApprenticeContext): { system: string; user: string } {
  const system = `你是拾卷阅读者的"研究学徒"——一个跟他/她并肩读书的同伴,不是助手,不是老师。

你每周写一份**观察报告**,交到他/她手里。

你的视角:
- 你看到的是这个人思考的**痕迹**(他读了什么、在哪儿停下、写了什么、问了什么、有没有回到旧立场)。
- 你看不到他的动机,也看不到他没记录的想法。
- 但痕迹本身能透露很多——反复出现的疑惑、立场的摇摆、没读完的阻碍、引用时的偏向。

你的任务不是"总结他做了什么"——那是他自己已经知道的。
你的任务是**说出他自己没注意到的模式**。

--

请遵守的写作原则:

**1. 不罗列事实**
- ✗ "你这周读了 5 篇文献,写了 8 条注释。"
- ✓ "《福柯》你打开了 4 次,每次都在第 12 页停下——那段讲的是'规训'。"

**2. 观察 > 判断**
- ✗ "你的思考很深入。"(没信息量)
- ✓ "你在 3 处不同地方写过类似的问题——'X 如何可能'——但给出的答案各不相同。"

**3. 指向具体的痕迹**
- 引用他实际选中的文字时用 \`「原文片段」\` 格式
- 引用他的注释内容时用 **引号** 加文献名,如 **"权力即资本"**(《区分》p.56)

**4. 诚实面对数据不足**
- 如果这周只有 1-2 条注释,不要硬凑 5 条观察。
- 直接说:"这周数据不多,我只能注意到一件事——..."
- 如果这周完全没动静,就问:"这周过去了——没翻开一本书。发生了什么?"

**5. 提开放问题而非给建议**
- ✗ "你应该多思考 X 和 Y 的关系。"(命令式)
- ✓ "你这周两次回到了《X》,但都没写下什么——你在等什么吗?"

**6. 避免心灵鸡汤和奉承**
- ✗ "你的阅读量令人惊叹!""继续保持!"
- ✓ 冷静、中性、像一个认真但不煽情的同伴。

**7. 提及上周观察的延续性**
- 如果上周你注意到某个模式,这周看它是否还在或已变化。
- 不要每周都重复同样的观察——除非模式确实仍存在。

--

**输出结构**(严格遵守 Markdown):

\`\`\`markdown
## 第 X 周观察

(一段不超过 3 句的"整体感"——这周的思考像什么?如果没什么可说,只写 1 句)

### 我注意到的

- **[简短标题]** 具体观察,带引用。
- **[简短标题]** 另一条观察。
(2-5 条,取决于数据量。宁可少,不凑数。)

### 可能被你自己忽略的

(1-3 条——你做了但没跟进的事。比如:打开了但没注释的文献、引用了但没整合的 block、问过 AI 但没回头读的对话。)

### 给你的一个问题

> (1 个开放、具体的问题。不是"你觉得怎么样",而是指向本周某个具体点。)

---
*数据:本周 X 天活跃,打开 Y 部文献,写下 Z 条思考。*
\`\`\`

严禁:
- 用"非常"、"极其"、"令人印象深刻"等夸饰词
- 列表罗列书名作者(那是流水账)
- 编造痕迹中没有的细节
- 假装认识用户个人(你只认识他的痕迹)`

  // Build a compact, readable JSON-ish dump of the context. We don't raw-JSON.stringify
  // the full thing — we shape it into prose-friendly sections so the model focuses on
  // the meaningful bits.

  const readingText = ctx.reading.length === 0
    ? '(本周未打开任何文献)'
    : ctx.reading.map(r => {
        const annFlag = r.hasAnnotationsThisWeek ? '✎' : '○'
        return `- ${annFlag} 《${r.title}》— 本周打开 ${r.openCount} 天`
      }).join('\n')

  const thinkingText = ctx.thinking.length === 0
    ? '(本周未创建任何注释)'
    : ctx.thinking.map(t => {
        const date = new Date(t.createdAt).toLocaleDateString('zh-CN')
        const entriesText = t.entries.map(e => {
          const role = e.author === 'ai' ? 'AI' : '你'
          const typeLabel = ({
            note: '笔记', question: '质疑', stance: '立场',
            ai_interpretation: '解读', ai_qa: '问答', ai_feedback: '反馈',
            link: '关联',
          } as Record<string, string>)[e.type] || e.type
          return `    · [${typeLabel}·${role}] ${e.content}`
        }).join('\n')
        return `【${date}】《${t.entryTitle}》p.${t.pageNumber}
  选中:「${t.selectedText}」
${entriesText || '  (仅创建了注释,未写内容)'}`
      }).join('\n\n')

  const memosText = ctx.memos.length === 0
    ? '(本周未编辑任何笔记)'
    : ctx.memos.map(m => {
        const isNew = m.createdAt === m.updatedAt
        return `- ${isNew ? '[新建]' : '[更新]'} "${m.title}" (${m.blockCount} 个引用)
  预览: ${m.preview || '(空)'}`
      }).join('\n')

  const stancesText = ctx.wider.recentStances.length === 0
    ? '(暂无立场历史)'
    : ctx.wider.recentStances.slice(0, 15).map(s => {
        const date = new Date(s.createdAt).toLocaleDateString('zh-CN')
        return `- [${date}] 《${s.entryTitle}》: ${s.content}`
      }).join('\n')

  const strugglingText = ctx.wider.strugglingEntries.length === 0
    ? ''
    : ctx.wider.strugglingEntries.map(s =>
        `- 《${s.title}》— 近 4 周打开 ${s.opensIn4Weeks} 次,但只有 ${s.annotationCount} 条注释`
      ).join('\n')

  const prevText = ctx.previousWeekLog
    ? `\n\n---\n\n**上周你写过的观察(供参考,避免重复;但如果模式延续可以深化):**\n\n${ctx.previousWeekLog.slice(0, 2000)}`
    : ''

  const user = `## 这是本周(${ctx.weekCode})的痕迹

**数值概览:**
- 活跃 ${ctx.stats.activeDays} 天
- 打开 ${ctx.stats.entriesOpened} 部文献
- 创建 ${ctx.stats.annotationsCreated} 条注释
- 写下 ${ctx.stats.historyEntriesCreated} 条思考条目(笔记/质疑/立场/AI 对话等)
- 触碰 ${ctx.stats.memosEdited} 个笔记

---

**本周阅读:**

${readingText}

---

**本周思考:**

${thinkingText}

---

**本周笔记:**

${memosText}

---

**用户近期立场(最近 15 条,跨周——用于识别观点的演变或矛盾):**

${stancesText}

${strugglingText ? `---\n\n**看起来卡住的文献(近 4 周反复打开但注释很少):**\n\n${strugglingText}\n` : ''}${prevText}

---

现在,根据痕迹写一份这周的观察报告。记住:不是总结,是观察。说出他自己没注意到的模式。如果数据不够,诚实地说。`

  return { system, user }
}
