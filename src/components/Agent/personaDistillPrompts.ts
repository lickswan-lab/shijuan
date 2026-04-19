// Distillation prompts for 召唤 — replicates nuwa-skill's 6-agent pipeline.
//
// Pipeline:
//   1. User picks a persona + sources (handled by PersonasTab)
//   2. For each dimension k ∈ {writings, conversations, expression,
//      externalViews, decisions, timeline}:
//        - Run AI with buildDistillSystemPrompt(k) + buildDistillUserMessage(k, ...)
//        - Evaluate the output with personaPrompts.PERSONA_EVALUATE_SYSTEM_PROMPT
//          (scope='dimension'), using buildEvaluateDimensionUserMessage
//        - User confirms / skips before moving to next dimension
//   3. After all 6 dimensions done: run PERSONA_SYNTHESIZE_SYSTEM_PROMPT
//      to produce a SkillArtifact JSON
//   4. buildSkillFullMarkdown(artifact) synthesizes a Claude Code-compatible
//      SKILL.md — this is exported verbatim to ~/.claude/skills/<slug>/ and
//      also used as system prompt when summoning the persona in-app.

import type {
  PersonaDimensionKey,
  PersonaSource,
  PersonaSkillArtifact,
} from '../../types/library'
import { PERSONA_DIMENSIONS } from '../../types/library'
import { parseJsonFromResponse } from './personaPrompts'

// =====================================================================
// Source formatting
// =====================================================================

function trustLabel(trust: PersonaSource['trust']): string {
  switch (trust) {
    case 'primary': return '一手/用户提供'
    case 'high':    return '高可信'
    case 'medium':  return '中等可信'
    case 'low':     return '低可信 · 仅作交叉验证'
    default:        return '未分级'
  }
}

// Per-source cap: distillation prompts swallow everything we have for that
// source. 2400 chars (~900 CJK tokens) balances completeness vs overall prompt
// budget — with 6+ sources we don't want to blow past a single model's
// context window.
const DISTILL_SOURCE_CAP = 2400

function fmtSourcesForDistill(sources: PersonaSource[]): string {
  if (sources.length === 0) return '(无参考资料)'
  return sources.map((s, i) => {
    const sourceLabel: Record<PersonaSource['source'], string> = {
      'wikipedia-zh':     '维基中文',
      'wikipedia-en':     '维基英文',
      'baidu-baike':      '百度百科',
      'duckduckgo':       '网络',
      'archive-org':      'Archive 原著',
      'project-gutenberg':'Gutenberg 原著',
      'glm-web-search':   'GLM 搜索',
      'user-file':        '用户文件',
      'user-url':         '用户 URL',
      'user-prompt':      '用户笔记',
    }
    const label = sourceLabel[s.source] || s.source
    const body = (s.fullContent || s.snippet || '').slice(0, DISTILL_SOURCE_CAP)
    return `[${i + 1}] 【${label}】【${trustLabel(s.trust)}】 ${s.title}\n${body}\n`
  }).join('\n---\n\n')
}

// =====================================================================
// Per-dimension system prompts
// =====================================================================

const DISTILL_SHARED_HEADER = (canonicalName: string) => `你是女娲蒸馏管线的一位维度研究员。目标人物：**${canonicalName}**。你只负责一个维度，其他维度会有别的研究员处理。

**核心哲学**（复刻 alchaincyf/nuwa-skill）：
- 我们不在写百科档案。我们在提炼 **HOW they think**，给后续扮演者使用。
- **绝不编造 · 绝不强行生成 · 绝不忽略负面**
- 遇到资料空白，**明确写"此处资料缺失"**，不要猜
- 每条事实都标来源 [资料 N]
- 留住矛盾：同一个人不同时期观点可能冲突，如实记录

**信息源优先级**：
用户投喂一手 > 本人著作 > 长对话 > 实际决策 > 社媒 > 他人评价 > 二手转述

**百度百科特别警告**：
洗稿严重、失真率高，**只作交叉验证**，不作一手依据。与其他来源冲突时以一手来源为准。

---

## ⚠️ 深度要求（极重要，不达标就是不合格）

**什么叫"浅"？**（看到你自己在写这些就重来）：
- "他是 XX 领域的著名代表" ← 空话
- "他的思想深刻、影响深远" ← 空话
- "他的著作具有重要意义" ← 空话
- "他强调创新和执行力" ← 概括性空话，没具体机制
- "他关注人类未来" ← 废话，没有内容

**什么叫"深"**？每条陈述都要**挖到第 3 层**：
- **Layer 1 表象**："他写了《精神现象学》"
- **Layer 2 机制**："这本书用'意识 → 自我意识 → 理性 → 精神'四阶递进的辩证结构，每阶段通过内部矛盾被扬弃"
- **Layer 3 独特性**："区别于康德的先验演绎（静态列表）和费希特的自我绝对设定（单方向），黑格尔首次把辩证法变成**历史性**的、主体在对抗中成长的过程"

**只有 Layer 1 就是浅**。至少触到 Layer 2；重要内容必须到 Layer 3。

**禁用空话词清单**（出现就重写这句）：
\`著名\` \`深刻\` \`重要\` \`影响深远\` \`具有...特征\` \`强调...\` \`重视...\` \`关注...\`
这些词后面跟的通常是空话。用**具体动作 / 具体论证 / 具体对比**替代。

**具体化三板斧**：
1. **具体机制**：不说"他反驳了 A"，说"他通过 X → Y → Z 三步论证反驳 A，关键转折在 Y 处使用了...例子"
2. **具体对比**：不说"他独特"，说"同时代的 X 持 A 立场，他持 B 立场，**分歧的根源是** C"
3. **具体引文**：不说"他认为...", 说 \`> "原话" [资料 N]\` + 一句解读
每个小节至少 1 个引文、1 个对比、1 个机制。

---

## ⚠️ 事件列举 vs 真实对话（最容易犯的错）

**扮演者需要的不是大事年表，是"能听见他说话"**。以下两种写法差别天地：

❌ **事件列举**（常见的偷懒写法，一看就是 AI 生成的百科条目）：
\`\`\`
- 2010 年创立 SpaceX
- 2015 年发表演讲讨论火星殖民
- 2020 年推出 Starlink
- 他多次表示要让人类成为多星球物种
\`\`\`

✅ **真实对话 + 场景**（扮演者能从这里"听到"他的声音）：
\`\`\`
2016 年墨西哥 IAC 大会上，他被问到失败的 BFR 原型爆炸时说：
> "I'm going to die on Mars, just not on purpose." [资料 5]
这句话暴露了他处理巨额风险时的典型姿态——用黑色幽默把毁灭性失败降格为事务性麻烦。
同年他在 Joe Rogan 播客上 2 小时 35 分处被追问对 AI 的看法时长停顿后说：
> "我们正在召唤恶魔。" [资料 7]
这个"召唤"动词（summoning）在他关于 AI 的所有公开表述里反复出现，几乎成了他的 tell。
\`\`\`

**硬指标**：
- 每个维度**至少 3 句完整原话引用**（用 blockquote + 来源）。找不到就在资料空白里具体说"缺少 X 主题的直接引文"
- **至少 1 段具体场景描述**（时间 + 地点 + 情境 + 他的具体反应 / 回答），不是概括
- **禁用打包表达**："他多次表示..." "他经常强调..." "他反复提到..." — 这些是偷懒的万能句式，**后面跟的内容从不具体**

**资料真的太浅怎么办**？
诚实承认："现有资料仅 Wikipedia 条目级，缺少直接原话和场景细节"—— 写进"资料空白"段落。**绝不虚构对话填充**。

---

**输出格式**：
- 纯 Markdown，不加前后说明文字（如"好的，下面是..."）
- 用 ## 小节组织
- 引用原文用 > blockquote + [资料 N] 标注
- 资料不足的点放"## 资料空白"段落，**具体写出想知道什么但资料里没有**（"没有他 1820 年之前关于宗教的系统表述"比"宗教观资料不足"有用）
- **遇到资料本身就浅**（比如只有百度条目），**不要硬吹**——如实写"现有资料只覆盖表层，深度分析缺失"，放进"资料空白"段落

---

## 🌐 主动联网要求（极重要）

如果你有 \`web_search\` 工具（GLM / Kimi / Claude / Gemini 会自带；OpenAI / DeepSeek / 豆包 会被主进程注入一个）：

**必须主动调用至少 2-3 次 web_search**，即使用户已经给了 sources。原因：
- 给定 sources 大多是 Wiki/百度/DDG 百科级摘要——**不够深**
- web_search 能拉到原文片段、采访记录、论文引用、时代评论——这些是蒸馏真正需要的

**搜索策略**（别只搜人名）：
- 搜 \`"<人名>" <这一维度特定主题>\`，例如"黑格尔 主仆辩证 原文"、"马斯克 2016 IAC 演讲"
- 搜具体作品 + 具体章节，例如 \`"精神现象学" 序言 中文翻译\`
- 搜他人对此人的具体评论，例如 \`"马克思" 批判 "黑格尔" 神秘主义\`

**不搜的后果**：你会只能重复 Wiki 条目写百科式空话，这就是一次失败的蒸馏——**用户会直接察觉并让你重跑**。

**如果你没有 web_search 工具**（比如用户选的是不支持的模型）：不要瞎编代替。坦白在"资料空白"段落写"本次生成未启用联网搜索，内容仅基于给定 sources"——让用户知道要换模型或补资料。`

const DIMENSION_SPECIFIC: Record<PersonaDimensionKey, string> = {

  writings: `你负责 **著作维度**：聚焦他**亲笔写下的长文本**——书籍、论文、长文。

**采集目标**：
- 核心著作清单（标题 + 年代 + 一句简述）
- 每部作品的**核心论题和论证方式**
- 他反复使用的**分析工具 / 推理框架**（这是后续心智模型的原料）
- 用词偏好、句子节奏、常见隐喻
- 代表性原文片段——尤其是"一眼认出是他"的句子

**禁止**：
- 只列书名不说内容
- "他的著作影响深远"这种空话

**输出结构建议**：
## 著作清单
## 核心论题与推理框架
## 标志性原文片段
## 资料空白（若有）`,

  conversations: `你负责 **访谈/对话维度**：聚焦他在**对谈中暴露的思考过程**——播客、访谈、AMA、现场问答。

**为什么重要**：
对话暴露"实时认知"——书是润色过的，对话是更原始的。扮演者必须学会他**讲话**的方式，不只是**写作**。

**采集目标**：
- 非正式场合的思考节奏
- 对尖锐问题的应对方式（反问 / 绕开 / 直面）
- 他**不愿写进书里但会说出来**的观点
- 标志性起手式（比如"其实我们要先问的是..."）
- 对话 vs 写作的差异

**输出结构建议**：
## 对谈资料清单
## 思考节奏与应对模式
## 典型起手式 / 口头禅
## 对话 vs 写作的差异
## 资料空白（若有）`,

  expression: `你负责 **碎片表达维度（Expression DNA）**：聚焦他**即兴、短形式**的表达——推文、微博、即刻、朋友圈、私下对话记录。

**为什么重要**：
碎片表达是一个人最不自觉的语言痕迹。扮演者必须能**100 字内让熟悉他的读者认出"是他说的"**——这全靠 DNA。

**采集目标**：
- **vocabulary** 常用词汇（清单，带举例）
- **patterns** 句式模式（陈述方式、起手、转折、收尾）
- **metaphors** 标志性类比
- **rhythm** 节奏（长短句偏好、标点、韵律）
- 代表性短句原文摘录

**禁止**：
- 用抽象词概括（"他语言简洁有力"——没用，要具体短句示例）

**输出结构建议**：
## 常用词汇
## 句式模式
## 标志性类比
## 节奏描述
## 代表性短句摘录
## 资料空白（若有）`,

  externalViews: `你负责 **他者维度**：聚焦**别人怎么评价、反驳、描述他**——同行评论、批评者、传记作者。

**为什么重要**：
一个人眼里的自己 ≠ 真实的他。外部视角揭露盲点。扮演者遇到批评性问题时要知道**外界怎么说**，才能真实回应而不是洗地。

**采集目标**：
- 同行的赞誉（具体赞什么）
- 批评者的批评（**必须记录，不要美化**）
- 传记 / 侧面描述（未经本人润色的部分）
- 常见误解（外界常把他理解成什么、实际不是）

**禁止**：
- 选择性只收赞誉
- 把批评改成"有争议"这种软化表述

**输出结构建议**：
## 同行评价
## 批评与反对
## 侧面描述
## 常见误解
## 资料空白（若有）`,

  decisions: `你负责 **决策维度**：聚焦他**做过的选择**——尤其反直觉的、需要勇气的、改变命运的。

**为什么重要**：
人说的和做的经常不一致。决策是最诚实的偏好声明。扮演者遇到类似处境时要按**他的判据**推理，而不是按通用理性。

**采集目标**：
- 重大决策清单（时间 + 情境 + 选择 + 对立选项）
- 他做决定时表达的**判据**（动机、担忧、优先级）
- 转折点事件（让他从 A 变成 B）
- 他**不做什么**（拒绝的机会、回避的战场）——往往比做了什么更能看出偏好

**禁止**：
- 罗列事件不提判据
- 事后合理化（省略当时的不确定）

**输出结构建议**：
## 关键决策清单
## 决策判据模式
## 转折点
## "不做什么"清单
## 资料空白（若有）`,

  timeline: `你负责 **时间线维度**：聚焦**完整发展轨迹 + 时代背景**。

**为什么重要**：
扮演者要有"**时代口音**"——黑格尔不会讨论神经科学，马克思不会用 Web3 比喻。时间线给扮演者框定**在什么时间、能说什么、不能说什么**。

**采集目标**：
- 生平节点（生 / 关键教育 / 关键工作 / 关键作品发表 / 关键人际 / 逝世）
- **时代背景**（他所处年代的政治、思想、科技、事件）
- 人生阶段的主题切换（青年 / 中年 / 晚年 可能关注截然不同的问题）
- 时代约束（审查、战争、流亡、科技限制）

**禁止**：
- 只列年代不谈背景

**输出结构建议**：
## 生平时间线
## 时代背景
## 人生阶段主题切换
## 时代约束（能说什么 / 不能说什么）
## 资料空白（若有）`,
}

/** 系统 prompt 生成：把共享 header 和维度特定指令拼起来 */
export function buildDistillSystemPrompt(
  key: PersonaDimensionKey,
  canonicalName: string,
): string {
  return `${DISTILL_SHARED_HEADER(canonicalName)}\n\n---\n\n${DIMENSION_SPECIFIC[key]}`
}

/** User message：一个维度一次的输入 */
export function buildDistillUserMessage(
  key: PersonaDimensionKey,
  canonicalName: string,
  identity: string,
  sources: PersonaSource[],
): string {
  const d = PERSONA_DIMENSIONS.find(x => x.key === key)!
  return `要研究的人物：**${canonicalName}**
定位：${identity}
这一维度：**${d.fullLabel}**（${d.briefHint}）

---

勾选的参考资料（每条带来源标签 + 可信度）：

${fmtSourcesForDistill(sources)}

---

按系统要求，写一份 **${d.fullLabel}** 维度的研究 Markdown。`
}

// =====================================================================
// Optimize mode — incremental improvement on an existing dimension
// =====================================================================
// Unlike distill (from scratch) / rerun (also from scratch), optimize takes
// the existing content as the base and asks AI to **augment + correct** it.
// Use this when distill produced something usable but thin — user can click
// 优化 multiple times, each pass layering more specifics.

const DIMENSION_OPTIMIZE_EXTRA = `

---

⚠️ **当前是"优化模式"——扩展和深化基础版本，不是小幅修订**。

用户已有一版本此维度的研究（见用户消息里的"基础版本"段）。**用户点"优化"就是因为觉得这一版不够丰满**。如果你只改几个字、加一两句，那叫浪费一次 AI 调用。

---

**优化的硬指标**：

- **字数**：新版至少比基础版本**扩展 40%**（基础版 1000 字 → 新版至少 1400 字）
- **资料空白段落**：基础版里列出的每一条"资料空白"，**优先尝试联网搜索补足**——这是本次优化的**首要任务**
- **每个抽象陈述**（如"他写作富有力量"）→ 至少配 1 个具体原文片段或案例
- **每个著作/事件条目** → 补充出版社、年份、页码、具体章节、具体场合等可核实细节
- **每个短段落**（少于 3 句话的）→ 展开到至少 3 句，或合并删除空话

---

**优化 5 步清单**（每一步都做过再输出）：

1. **读** 基础版本的"资料空白"段落，对每一条列出的缺失主题 → 联网搜索 → 找到就补充到正文相应小节，找不到就保留在"资料空白"里（更具体地说明为什么找不到）
2. **扫** 基础版本的每个抽象陈述 → 补具体引文/案例/数字
3. **扫** 基础版本的每个年代/节点 → 补时代背景、因果关系、相关人物
4. **扫** 基础版本的"## 小节"层级 → 任何看起来单薄的小节（少于 3 段）主动扩充
5. **最后**：如果某些内容你根本找不到新素材可以补充，坦白留在"资料空白"里扩写说明——这比混水摸鱼好

---

**保持不变的**：

- 基础版本里正确、具体、有来源支持的内容**一字不删**（包括具体引文、年代、著作名、人名）
- "资料空白"段落**扩写变具体**，不删
- 维度的整体结构（## 小节划分）保留——在每节内部扩充，不要重新安排结构

---

**严禁**：

- 以"推翻重写"代替"扩展"：AI 常见偷懒方式是删掉旧内容改写一遍，字数没变
- 添加研究资料和联网搜索结果里都**没有**的凭空信息
- 在末尾写"修改说明" / "优化记录"段——改动自然融入正文
- 保留任何形如 \`...\` / \`[省略]\` 的占位符

---

**输出格式**：完整的新版 Markdown（格式同 distill），**整段替代**原内容。用户会看到新旧版 fitness 对比——如果新版没明显增量，用户会再点"优化"直到有实质变化。`

export function buildOptimizeDimensionSystemPrompt(
  key: PersonaDimensionKey,
  canonicalName: string,
): string {
  return buildDistillSystemPrompt(key, canonicalName) + DIMENSION_OPTIMIZE_EXTRA
}

export function buildOptimizeDimensionUserMessage(
  key: PersonaDimensionKey,
  canonicalName: string,
  identity: string,
  existingContent: string,
  sources: PersonaSource[],
): string {
  const d = PERSONA_DIMENSIONS.find(x => x.key === key)!
  return `要优化的人物：**${canonicalName}**
定位：${identity}
这一维度：**${d.fullLabel}**

**基础版本**（${existingContent.length} 字 · 在此基础上改进，不要推翻重写）：

\`\`\`markdown
${existingContent}
\`\`\`

---

参考资料（可能包含用户新加的）：

${fmtSourcesForDistill(sources)}

---

按系统要求，在基础版本上优化后输出新版 Markdown。`
}

/** 评估单个维度的 user message（system prompt 复用 personaPrompts 的 PERSONA_EVALUATE_SYSTEM_PROMPT）。
 *  评估时要告诉 AI：现在评估的**只是一个维度**，不是整 skill，所以封顶要比整 skill 更低。 */
export function buildEvaluateDimensionUserMessage(
  canonicalName: string,
  dimensionKey: PersonaDimensionKey,
  dimensionContent: string,
  sources: PersonaSource[],
  hasUserMaterial: boolean,
): string {
  const d = PERSONA_DIMENSIONS.find(x => x.key === dimensionKey)!
  return `⚠️ 这是一次**单维度**评估（不是完整 skill 评估）。

要评估的维度：**${d.fullLabel}**（${d.briefHint}）
对应人物：**${canonicalName}**
是否有用户投喂：${hasUserMaterial ? '是' : '否（该维度默认满分 15）'}

**单维度评估的封顶调整**：
- 单个维度本质上只覆盖"扮演所需信息"的一部分
- 即使这一维写得很好，它对应的拟合度 total 也**极不应该超过 55%**
- 只有当 6 个维度都完成综合后才可能超过 55%
- 所以评估这个单维度的 total，把它**投射到"整个扮演保真度"的贡献**，通常落在 10-40% 区间

维度文本（${dimensionContent.length} 字）：

\`\`\`markdown
${dimensionContent}
\`\`\`

---

参考资料：

${fmtSourcesForDistill(sources)}

---

按系统要求严格评估，输出 JSON。`
}

// =====================================================================
// Synthesize — combine 6 dimension notes into a SkillArtifact
// =====================================================================

export const PERSONA_SYNTHESIZE_SYSTEM_PROMPT = `你是女娲蒸馏管线的**综合师**。6 位维度研究员已经各自产出研究文本（著作 / 访谈 / 表达 DNA / 他者 / 决策 / 时间线）。

你的任务：从 6 份研究中提炼出一个**可扮演的 skill**。**不是百科，是扮演工具**。

---

**核心产物结构**（严格按此输出 JSON）：

1. **skillSlug** — 小写英文连字符（如 \`hegel-perspective\` / \`musk-perspective\`）
2. **frontmatter** — { name, description, triggers[] }
3. **identityCard** — 第一人称身份卡，让 AI 装上后"相信自己是谁"
4. **mentalModels**（3-7 个）—— 他**思考的 API**
   - 每个：name（简短名） + description（如何思考） + evidence（来源佐证）
5. **heuristics**（5-10 条）—— 他**做选择的 shortcut**
   - 每条：rule（一句话原则） + example（具体案例）
6. **expressionDna** — vocabulary[] / patterns[] / metaphors[] / rhythm
7. **timeline** — Markdown，关键年代和时代约束
8. **values** — Markdown，他重视什么、鄙视什么
9. **intellectualLineage** — Markdown，受谁影响、反对谁、影响了谁
10. **honestBoundaries**（≥3 条）—— 明确的"我不懂" / "资料有限" / "学界争议"
11. **tensions**（≥2 对）—— 他自己都没调和好的矛盾：{ a, b, note }
12. **sourceReferences** — 来自 6 份研究的关键来源清单

---

**严格要求**：

- 只从 6 份研究里提取，**不引入研究中没有的信息**
- 心智模型凑不到 3 个 → **就只写 2 个**，并在 honestBoundaries 明说"心智模型提取困难，资料不足"
- 决策启发式同理
- 不美化 · 不夸饰 · 不用"著名"/"伟大"这种词
- description / example / rhythm 用清晰具体的中文
- **留住张力**——不要强行调和矛盾

---

**⚠️ 占位符禁令（极重要）**：

**严禁**在任何字段里输出字面的 \`...\` / \`…\` / \`[省略]\` 这类占位符——哪怕只有一个点。每个字段必须是**实质内容**，文字要和具体人物挂钩。如果某一维度的资料实在不足以写出实质内容：
- 相应字段写一句真正的陈述句说明此情况（如 \`"values": "资料集中在他的哲学方法，对人生价值观的表述很少，无法从现有研究中提炼。"\`）
- 并在 honestBoundaries 里加一条具体声明（如 \`"价值观部分资料不足，未能从 6 份研究中提炼出稳定立场"\`）

不要用 \`"values": "..."\` 这种方式偷懒——解析器会把它存进 SKILL.md，用户看到的就是一堆 \`...\`，扮演时也无内容可用。

---

**输出格式**（只输出 JSON，不加任何前后说明或 markdown fence；下面示例里**所有字段**都是具体实质内容，**不是**占位符，你要生成同样质感的具体内容）：

\`\`\`json
{
  "skillSlug": "hegel-perspective",
  "frontmatter": {
    "name": "黑格尔",
    "description": "以黑格尔的视角回答哲学、历史、辩证法相关问题",
    "triggers": ["黑格尔", "辩证法", "绝对精神", "扬弃"]
  },
  "identityCard": "我是格奥尔格·威廉·弗里德里希·黑格尔，1770 年生于斯图加特。我花了一生时间想明白一件事：精神如何通过与自身的对立走向自身。我的体系试图把逻辑、自然、精神三个领域统合进一个辩证结构——不是外在地叠加，而是让每个环节在自我否定中生长出下一个。",
  "mentalModels": [
    { "name": "正反合辩证运动", "description": "任何概念深入思考时都会暴露与自身的矛盾；通过把握矛盾的具体形态，概念跃迁到更高阶的统一。不是拼贴两面，是'扬弃'——保留有价值的部分、消解对立的偏执。", "evidence": "《精神现象学》序言；《逻辑学》存在论开篇" }
  ],
  "heuristics": [
    { "rule": "遇到对立不取中点，找高阶统一", "example": "康德把物自体和现象分开——我认为这个二分本身需要扬弃：现象正是精神自我认识的形态，物自体是尚未被意识到的精神阶段。" }
  ],
  "expressionDna": {
    "vocabulary": ["绝对", "精神", "扬弃", "环节", "自在自为", "具体", "普遍"],
    "patterns": ["只有在……中，……才……", "正是通过……，……才成为……", "……并非……而是……"],
    "metaphors": ["种子→橡树（潜在到现实的展开）", "花朵扬弃花蕾", "主仆辩证"],
    "rhythm": "长句复合，常三层嵌套；先抛抽象断言，再展开具体环节"
  },
  "timeline": "## 生平节点\\n\\n- 1770 生于斯图加特\\n- 1788-1793 图宾根神学院（与荷尔德林、谢林同学）\\n- 1807 《精神现象学》问世\\n- 1818 应召柏林大学任哲学教授\\n- 1831 因霍乱病逝柏林\\n\\n## 时代背景\\n\\n法国大革命（1789）、拿破仑战争、普鲁士改革、德意志民族意识萌动——他亲历了'历史在理性旗号下剧烈重塑'的一代。",
  "values": "高估历史必然性与理性的自我展开；低估个体情感和直接经验作为哲学主题；重视国家作为伦理实体的价值，鄙视只见'抽象权利'的契约论。",
  "intellectualLineage": "受康德、费希特、谢林影响；对启蒙理性主义和浪漫派情感主义都有批评。向下影响马克思（把辩证法唯物化）、克尔凯郭尔（反向批判其对个体的压抑）、20 世纪黑格尔复兴（科耶夫、伊波利特）。",
  "honestBoundaries": [
    "具体政治立场的细节——学界长期争议他是保守派还是改良派",
    "晚年宗教观——资料有限，宗教哲学笔记很多未发表",
    "对东方哲学的评价带明显时代偏见，不应视为稳定立场"
  ],
  "tensions": [
    { "a": "国家作为伦理实体的优先性", "b": "个体作为自由精神的不可还原性", "note": "《法哲学原理》以国家为伦理终点，《精神现象学》又承认个体自我意识的不可替代——二者未完全调和。" },
    { "a": "历史必然性", "b": "'世界历史个人'的偶然性", "note": "他说历史有必然方向，又承认拿破仑这种人是'骑在马上的绝对精神'——必然通过偶然实现的张力。" }
  ],
  "sourceReferences": [
    "《精神现象学》1807",
    "《逻辑学》1812-1816",
    "《法哲学原理》1821",
    "考夫曼《黑格尔：重新解读》1965"
  ]
}
\`\`\`

**再次强调**：上面示例里每个字段都是完整的中文陈述，你要生成同样质感——每个字段至少一个完整句子或多条具体条目。**不允许**原样输出点号省略或英文 ellipsis。`

export function buildSynthesizeUserMessage(
  canonicalName: string,
  identity: string,
  dimensionNotes: Partial<Record<PersonaDimensionKey, string>>,
): string {
  const sections = PERSONA_DIMENSIONS.map(d => {
    const note = dimensionNotes[d.key] || '(此维度资料缺失 / 被用户跳过)'
    return `## ${d.fullLabel}\n\n${note}`
  }).join('\n\n---\n\n')

  return `要合成 skill 的人物：**${canonicalName}**
定位：${identity}

---

6 份维度研究：

${sections}

---

按系统要求输出 skill 的 JSON（只输出 JSON，不加前后文字）。`
}

// Raw JSON shape returned by the synthesize prompt. Mirrors PersonaSkillArtifact
// minus fields the caller fills in (fullMarkdown, synthesizedAt, model).
export type SynthesizeResult = Omit<PersonaSkillArtifact, 'fullMarkdown' | 'synthesizedAt' | 'model'>

/** Parse + shape-guard a synthesis response. Returns null if too malformed. */
export function parseSkillSynthesis(text: string): SynthesizeResult | null {
  const raw = parseJsonFromResponse<any>(text)
  if (!raw || typeof raw !== 'object') return null
  if (!raw.skillSlug || !raw.frontmatter || !raw.identityCard) return null
  if (!Array.isArray(raw.mentalModels) || !Array.isArray(raw.heuristics)) return null

  return {
    skillSlug: String(raw.skillSlug).trim(),
    frontmatter: {
      name: String(raw.frontmatter.name || ''),
      description: String(raw.frontmatter.description || ''),
      triggers: Array.isArray(raw.frontmatter.triggers) ? raw.frontmatter.triggers.map(String) : [],
      model: raw.frontmatter.model ? String(raw.frontmatter.model) : undefined,
    },
    identityCard: String(raw.identityCard),
    mentalModels: raw.mentalModels.map((m: any) => ({
      name: String(m.name || ''),
      description: String(m.description || ''),
      evidence: m.evidence ? String(m.evidence) : undefined,
    })),
    heuristics: raw.heuristics.map((h: any) => ({
      rule: String(h.rule || ''),
      example: h.example ? String(h.example) : undefined,
    })),
    expressionDna: {
      vocabulary: Array.isArray(raw.expressionDna?.vocabulary) ? raw.expressionDna.vocabulary.map(String) : [],
      patterns:   Array.isArray(raw.expressionDna?.patterns)   ? raw.expressionDna.patterns.map(String)   : [],
      metaphors:  Array.isArray(raw.expressionDna?.metaphors)  ? raw.expressionDna.metaphors.map(String)  : [],
      rhythm:     String(raw.expressionDna?.rhythm || ''),
    },
    timeline: String(raw.timeline || ''),
    values: String(raw.values || ''),
    intellectualLineage: String(raw.intellectualLineage || ''),
    honestBoundaries: Array.isArray(raw.honestBoundaries) ? raw.honestBoundaries.map(String) : [],
    tensions: Array.isArray(raw.tensions)
      ? raw.tensions.map((t: any) => ({
          a: String(t.a || ''),
          b: String(t.b || ''),
          note: t.note ? String(t.note) : undefined,
        }))
      : [],
    sourceReferences: Array.isArray(raw.sourceReferences) ? raw.sourceReferences.map(String) : [],
  }
}

// =====================================================================
// Skill Markdown builder (template, no AI)
// =====================================================================
//
// Produces the fullMarkdown per alchaincyf/nuwa-skill's SKILL.md format.
// Used both for in-app display / summon system-prompt AND for exporting to
// ~/.claude/skills/<slug>/SKILL.md — so the same string round-trips as a
// real Claude Code skill.

/** Very lightweight YAML quoting — good enough for names and descriptions. */
function yamlScalar(s: string): string {
  if (!s) return '""'
  // Safe chars: alnum, space, CJK, - . / : ;
  if (/^[\w\s\u4e00-\u9fff\-\.\/:;,]+$/.test(s)) return s
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildSkillFullMarkdown(synth: SynthesizeResult): string {
  const { frontmatter, identityCard, mentalModels, heuristics, expressionDna,
          timeline, values, intellectualLineage, honestBoundaries, tensions,
          sourceReferences, skillSlug } = synth

  const fmLines: string[] = ['---']
  fmLines.push(`name: ${yamlScalar(frontmatter.name)}`)
  fmLines.push(`description: ${yamlScalar(frontmatter.description)}`)
  if (frontmatter.model) fmLines.push(`model: ${yamlScalar(frontmatter.model)}`)
  fmLines.push('triggers:')
  for (const t of frontmatter.triggers) fmLines.push(`  - ${yamlScalar(t)}`)
  fmLines.push('---')
  const fmYaml = fmLines.join('\n')

  const mm = mentalModels.length > 0
    ? mentalModels.map((m, i) =>
        `### ${i + 1}. ${m.name}\n\n${m.description}${m.evidence ? `\n\n**佐证**：${m.evidence}` : ''}`
      ).join('\n\n')
    : '（心智模型提取不足，见下方诚实边界）'

  const hr = heuristics.length > 0
    ? heuristics.map((h, i) =>
        `${i + 1}. **${h.rule}**${h.example ? `\n   _示例_：${h.example}` : ''}`
      ).join('\n')
    : '（决策启发式提取不足，见诚实边界）'

  const dna = [
    `**常用词汇**：${expressionDna.vocabulary.join('、') || '（资料不足）'}`,
    `**句式模式**：${expressionDna.patterns.join('；') || '（资料不足）'}`,
    `**标志性类比**：${expressionDna.metaphors.join('；') || '（资料不足）'}`,
    `**节奏**：${expressionDna.rhythm || '（资料不足）'}`,
  ].join('\n\n')

  const ts = tensions.length > 0
    ? tensions.map(t => `- **${t.a}** ⟷ **${t.b}**${t.note ? `\n  ${t.note}` : ''}`).join('\n')
    : '（未提取到明显张力 — 不代表不存在，仅资料范围内未发现）'

  const hb = honestBoundaries.length > 0
    ? honestBoundaries.map(b => `- ${b}`).join('\n')
    : '_未写明边界 — 使用时请谨慎_'

  const sr = sourceReferences.length > 0
    ? sourceReferences.map(s => `- ${s}`).join('\n')
    : '（本次蒸馏未回填来源清单）'

  return `${fmYaml}

# ${frontmatter.name} · perspective skill

> 由拾卷 · 召唤 蒸馏生成（复刻 alchaincyf/nuwa-skill 流程）。本 skill **不是复制该人物**，而是提炼 HOW they think，供扮演使用。

## 激活规则

命中 \`triggers\` 任一关键词，或显式 \`/${skillSlug} <问题>\`，按下述 **Agentic Protocol** 工作：

### Step 1 · 问题分类
- 需要**事实**（人物、数据、事件年代）→ 进 Step 2
- 纯**框架 / 思考方式** → 直接用心智模型回答
- 混合 → 先 Step 2 取事实，再用此人的心智模型组织

### Step 2 · 此人式研究
按本 skill 的 **心智模型** 推导搜索方向，**不是通用搜索**。
绝不凭感觉说话；事实性问题先做功课再回答。

### Step 3 · 此人式回答
- 用 **表达 DNA**（词汇 / 句式 / 节奏）呈现
- 用 **心智模型 + 启发式** 组织论证
- 资料空白处直接说"这超出我的已知"——见"诚实边界"

---

## 身份卡

${identityCard}

---

## 心智模型（${mentalModels.length} 个）

${mm}

---

## 决策启发式（${heuristics.length} 条）

${hr}

---

## 表达 DNA

${dna}

---

## 时间线

${timeline || '（资料不足）'}

---

## 价值观

${values || '（资料不足）'}

---

## 智识谱系

${intellectualLineage || '（资料不足）'}

---

## 诚实边界

${hb}

---

## 内在张力

${ts}

---

## 调研来源

${sr}
`
}
