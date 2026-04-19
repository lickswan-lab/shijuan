// AI 自主迭代调研 — 借鉴 dzhng/deep-research 的递归算法 +
// stanford-oval/storm 的 Question→Query 两层拆解。
//
// 核心思想（来自 30 分钟 GitHub 调研）：
//   1. STORM 把"我想问什么"和"我搜什么字"拆成两层 prompt 处理——它们是
//      不同的认知任务，混在一起 LLM 容易降智为"再搜一次人名"。
//   2. dzhng 的递归减半：breadth 每轮减半（6→3→2），depth 递减，避免
//      死循环 + 自然收敛。
//   3. 每轮 planner 看的是「池子快照」而非全文，否则上下文会爆。
//
// 不抄的部分：
//   - DSPy Signature（Python 栈）
//   - GraphRAG（对历史人物 ROI 太低）
//   - Co-STORM 的 Moderator（差异化护城河，留给 v2）
//
// 调用方负责：
//   - 多轮循环、abort 控制、把结果写回 persona

import type { Persona, PersonaSource } from '../../types/library'

// ===== Round 1: PLANNER =====
// 给一个池子快照，输出"还缺什么"列表。
// 这个 prompt 故意**禁止**输出搜索词——保持 LLM 在「调研目标」这一层。
export const RESEARCH_PLANNER_SYSTEM = `你是一个学术调研助手。当前正在帮用户深度研究一位历史人物，目标是建立"AI 能像本人一样思考"的资料底盘。

你的任务：基于当前已有的资料池快照，识别"如果要真正理解这个人物的思想，还**缺**什么具体材料"，并提出 5-8 个**知识缺口问题**。

强制要点：
1. 缺口问题不是搜索词。是**研究目标**：「我还想知道 X」「这个池子里没回答 Y」
2. 优先关注一手材料缺口：原著章节、原始文献、同时代回应、关键概念的原文出处
3. **避免**提"再多找一些百科介绍"——百科已经够了，缺的是深度
4. 每个问题给一句"为什么这是缺口"的理由（基于池子里现有内容的不足）
5. 如果觉得池子已经基本足够（包含原著 + 百科 + 至少 3 个一手材料），写 stopReason = "已基本覆盖"

输出严格 JSON（只有 JSON，无其他文字）：
{
  "gaps": [
    { "question": "具体的知识缺口问题（中文）", "why": "当前池子缺这个的具体理由" }
  ],
  "stopReason": null
}`

export function buildResearchPlannerUserMessage(
  persona: Persona,
  poolSnapshot: PersonaSource[],
): string {
  const sources = poolSnapshot.map((s, i) => {
    const trust = s.trust || 'medium'
    const snippet = (s.snippet || s.fullContent || '').slice(0, 150).replace(/\n/g, ' ')
    return `[${i + 1}] [${s.source}] [${trust}] ${s.title}\n  ${snippet}`
  }).join('\n')
  return `人物：${persona.canonicalName || persona.name}
身份：${persona.identity || '（未明确）'}

当前资料池（${poolSnapshot.length} 条）：
${sources || '(空)'}

请提出 5-8 个知识缺口问题。`
}

export interface PlannedGap {
  question: string
  why: string
}

export function parsePlannerOutput(text: string): { gaps: PlannedGap[]; stopReason: string | null } {
  const json = extractJson(text)
  const parsed = JSON.parse(json)
  const rawGaps = Array.isArray(parsed.gaps) ? parsed.gaps : []
  const gaps: PlannedGap[] = rawGaps
    .filter((g: any) => g && typeof g.question === 'string' && typeof g.why === 'string')
    .slice(0, 8)
  return {
    gaps,
    stopReason: typeof parsed.stopReason === 'string' && parsed.stopReason.trim() ? parsed.stopReason.trim() : null,
  }
}

// ===== Round 2: QUERY GENERATOR =====
// 给一个缺口问题，输出 1-2 个**具体的搜索查询**。
// 单独成 prompt 是 STORM 的 QuestionToQuery 模式：让 LLM 切换到
// "我在 google 输入框里打什么字"的认知模式，避免它把研究问题原样当查询。
export const QUERY_GENERATOR_SYSTEM = `你是搜索查询专家。给你一个知识缺口问题，你要把它变成 1-2 个**具体的搜索查询**——能在 Wikipedia / Google / Archive.org / Project Gutenberg 上拿到原文级结果的那种。

强制要点：
1. 查询要**具体到能命中原文／章节／关键概念**，不要泛泛
2. 中英文都生成（除非问题明显只有一种语言能找到，比如 "X 在中国的接受史" 只搜中文）
3. 每个查询不超过 25 字
4. 优先用作品名、章节标题、专有名词；避免"X 哲学" "X 思想" 这种万能词
5. 如果是西方哲学家的核心概念，**英文查询常更能命中 Gutenberg 原版**

输出严格 JSON（只有 JSON，无其他文字）：
{
  "queries": ["搜索查询 1", "搜索查询 2"]
}`

export function buildQueryGeneratorUserMessage(
  personName: string,
  gap: PlannedGap,
): string {
  return `人物：${personName}
知识缺口：${gap.question}
（缺口原因：${gap.why}）

请生成 1-2 个搜索查询。`
}

export function parseQueriesOutput(text: string): string[] {
  const json = extractJson(text)
  const parsed = JSON.parse(json)
  const qs = Array.isArray(parsed.queries) ? parsed.queries : []
  return qs
    .filter((q: any) => typeof q === 'string' && q.trim().length > 0 && q.length <= 60)
    .map((q: string) => q.trim())
    .slice(0, 2)
}

// ===== Helpers =====
// AI 经常回 markdown ```json fenced 或一段铺垫文本+JSON。提取首个 {...}。
function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fence ? fence[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new Error('AI 没返回 JSON')
  return candidate.slice(start, end + 1).trim()
}
