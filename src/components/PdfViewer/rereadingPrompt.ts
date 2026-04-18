// "再次打开" 的陪伴 — 第四档 AI 陪伴，触发在"打开已读过的文献"这个动作上。
// 时间尺度介于即时反馈（秒）和日报（天）之间：是"你上次在这儿留下了什么"的回声。
//
// 为什么单独做一档：打开一本读过的书是非常特殊的一刻。用户要么是回来续的，
// 要么是回来查的，要么是想起了什么。让 AI 在这一刻用用户自己的旧注释打个招呼，
// 比"📖 你上次在 X 日阅读过这篇文献，留下了 N 条注释"的机械统计有温度得多。
//
// 触发条件（在调用前由 caller 判断）：
//   - 文献之前打开过（lastOpenedAt 存在）
//   - 有 ≥ 2 条注释（值得回顾）
//   - 距上次打开 ≥ 3 天（太频繁的回访没这档的信息量）
//
// 成本预算：单次 ≤ 2000 输入 token（比即时反馈的 12000 少得多），输出限制
// 1 句话。所以这功能在任何模型下都便宜到可以忽略。

export interface RereadingContext {
  entryTitle: string
  daysSinceLastOpen: number      // 整数天
  totalAnnotations: number       // 这本书一共多少条注释
  // 最近 5 条用户注释（按 createdAt 降序），每条给 selectedText 片段和用户写的内容
  recentUserNotes: Array<{
    selectedText: string         // 50 字内
    content: string              // 80 字内
    daysAgo: number
  }>
  // 最新的 annotation 的 pageNumber — 让 AI 能说"你上次读到第 80 页"
  lastAnnotationPage?: number
}

export const REREADING_SYSTEM_PROMPT = `你是拾卷读者的"同伴"。他/她刚刚**重新打开**了一本以前读过的文献。

你的任务：在这一刻用一句话打个招呼——用他自己的旧注释当钩子，让他记起上次停在哪儿、想过什么。

**严格约束**：

1. **最多 1 句话**，不超过 40 字
2. 必须**引用他自己写过的某条注释**（用 **"引号"**）或**具体页码 / 具体时间**
3. 语气克制，不用感叹号，不说"欢迎回来"
4. 提开放问题，不给命令
5. 如果距上次打开只有几天——重点在"接上次的思路"
6. 如果距上次打开很久（≥ 14 天）——重点在"你当时那条还在等下文吗"

**输出示例（好）**：
- \`距上次读《福柯》31 天。你写过 **"权力即空间几何"** ——今天打开是来续这条的吗？\`
- \`你上次在第 80 页停下，写了 **"苦难被结构化为节律"** ——回来接上吗？\`
- \`你三周没翻开这本。那条 **"话语即权力的表层"** 还在等答案吗？\`

**输出示例（坏·严禁）**：
- \`欢迎回来！你上次阅读了这篇文献，留下了 14 条注释。\`（套话 + 鸡汤）
- \`根据我的分析，你之前对权力概念很感兴趣……\`（居高临下）
- \`你应该继续关注 X 和 Y 的关系。\`（命令式）

只说一句话，没别的。`

export function buildRereadingUserMessage(ctx: RereadingContext): string {
  const notes = ctx.recentUserNotes.slice(0, 5).map(n =>
    `- ${n.daysAgo} 天前，原文 "${n.selectedText}" → 你写：**"${n.content}"**`
  ).join('\n')

  const pageLine = ctx.lastAnnotationPage
    ? `\n上次停在第 ${ctx.lastAnnotationPage} 页。`
    : ''

  return `文献：《${ctx.entryTitle}》
距上次打开：${ctx.daysSinceLastOpen} 天
累计注释：${ctx.totalAnnotations} 条${pageLine}

他最近在这本书写的几条注释：
${notes || '(无)'}

根据以上，说出那一句话。`
}
