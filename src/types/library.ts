// ===== Central library: stores references to PDFs scattered across the system =====

export interface Library {
  version: string
  createdAt: string
  lastOpenedAt: string
  globalTags: string[]
  // Virtual folders (groups, not real filesystem folders)
  folders: VirtualFolder[]
  // All imported PDF entries
  entries: LibraryEntry[]
  // Thinking memos
  memos: Memo[]
  // Memo folders
  memoFolders: MemoFolder[]
  // Reading logs
  readingLogs: ReadingLog[]
  // Lecture sessions
  lectureSessions: LectureSession[]
}

export interface VirtualFolder {
  id: string
  name: string
  createdAt: string
}

export interface LibraryEntry {
  id: string               // UUID
  absPath: string          // Original absolute path to the PDF (never moved)
  title: string            // User-editable, initially from filename
  authors: string[]
  year?: number
  tags: string[]
  notes: string
  folderId?: string        // Virtual folder ID (null = root level)
  sortIndex?: number       // Manual sort order (lower = higher in list)
  ocrStatus: 'none' | 'partial' | 'complete'
  ocrFilePath?: string     // Path to .ocr.txt (next to PDF)
  addedAt: string          // When imported
  lastOpenedAt?: string
}

export interface PdfMeta {
  version: string
  entryId: string          // Links to LibraryEntry.id
  pages: PageData[]
  annotations: Annotation[]
  marks?: TextMark[]       // 划线/加重标记（无历史链）
  createdAt: string
  updatedAt: string
}

export interface PageData {
  pageNumber: number
  ocrText: string | null
  ocrTimestamp: string | null
}

export interface Annotation {
  id: string
  anchor: {
    pageNumber: number
    startOffset: number
    endOffset: number
    selectedText: string
  }
  historyChain: HistoryEntry[]
  style?: {
    color?: string  // yellow/red/green/blue/purple/orange
  }
  createdAt: string
  updatedAt: string
}

export interface TextMark {
  id: string
  type: 'underline' | 'bold'
  color?: string              // 预设色名（划线用），加重无颜色
  pageNumber: number
  selectedText: string
  createdAt: string
}

export interface HistoryEntry {
  id: string
  type: 'note' | 'question' | 'stance' | 'link' | 'ai_interpretation' | 'ai_qa' | 'ai_feedback' | 'ai_persona'
  //     笔记    质疑         立场       关联      AI解读               AI问答      AI即时反馈     名家召唤批注
  content: string
  userQuery?: string
  contextSent?: string
  contextText?: string           // Additional text the user selected as context for this entry
  linkedRef?: {              // 'link' type: reference to another annotation
    entryId: string          // which literature
    annotationId: string     // which annotation
    selectedText?: string    // preview text from the linked annotation
  }
  author: 'user' | 'ai'
  modelLabel?: string             // e.g. "GLM-5.1", "Claude Opus 4.6"
  /** ai_persona type only: which persona was summoned to annotate. Makes the
   *  entry distinguishable from regular AI Q&A even if modelLabel is generic. */
  personaId?: string
  personaName?: string            // cached display name ("黑格尔") for UI w/o re-fetching
  editedAt?: string
  originalContent?: string
  createdAt: string
}

// ===== BlockRef: address for any piece of thinking =====
// Every note, AI response, Q&A in the system is a "block" that can be cited anywhere

export interface BlockRef {
  entryId: string              // Which PDF
  entryTitle: string           // Cached title
  annotationId: string         // Which annotation
  historyEntryId: string       // Which specific entry in the chain
  selectedText: string         // The anchor text of the annotation
  blockContent: string         // Cached content of the block
  blockAuthor: 'user' | 'ai'  // Who wrote it
}

// ===== Memo: independent thinking notes =====

export interface Memo {
  id: string
  title: string
  content: string              // User's writing (markdown), can contain [[block:id]] references
  filePath?: string            // Future: relative path for .md file storage
  folderId?: string            // Memo folder ID
  blocks: BlockRef[]           // All blocks cited in this memo
  aiHistory: HistoryEntry[]    // AI conversations within memo writing
  createdAt: string
  updatedAt: string
  snapshots: MemoSnapshot[]    // Version history
}

export interface MemoFolder {
  id: string
  name: string
  createdAt: string
}

export interface MemoSnapshot {
  content: string
  savedAt: string
}

// ===== Reading Log =====

export interface ReadingLogEvent {
  id: string
  timestamp: string                // ISO
  type: 'open_doc' | 'annotate' | 'note' | 'question' | 'stance' | 'ai_interaction' | 'memo_create' | 'memo_edit' | 'mark_text'
  entryId?: string
  entryTitle?: string
  memoId?: string
  memoTitle?: string
  annotationId?: string            // For annotate/note/question/stance/ai_interaction — jump target (v1.2.7+)
  detail: string                   // e.g. "在《论法的精神》第3页添加了注释"
  selectedText?: string            // excerpt (≤80 chars)
}

export interface ReadingLog {
  id: string
  date: string                     // YYYY-MM-DD
  events: ReadingLogEvent[]
  aiSummary?: string               // Markdown
  aiModel?: string
  generatedAt: string
}

// ===== Lecture Session =====

export interface TranscriptSegment {
  id: string
  startTime: number               // seconds from recording start
  endTime: number
  text: string
  isFinal: boolean                // final vs interim result
}

export interface LectureSession {
  id: string
  title: string
  date: string                    // ISO
  duration: number                // seconds
  preDocIds: string[]             // associated pre-lecture entry IDs
  transcript: TranscriptSegment[]
  notes: string                   // user notes (Markdown)
  aiSummary?: string              // AI-generated course record
  aiModel?: string
  audioPath?: string              // path to audio file
  provider: 'webspeech' | 'xfyun' | 'aliyun'
  createdAt: string
}

// ===== Hermes Agent =====

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  content: string
  toolName?: string
  toolArgs?: string
  timestamp: string
}

export interface AgentConversation {
  id: string
  title: string
  messages: AgentMessage[]
  createdAt: string
  updatedAt: string
  /** If set, this conversation is in "summon mode" — instead of using the
   *  Hermes agent system prompt + ReAct loop, handleSend uses the persona's
   *  skill-based system prompt and does a plain streaming completion.
   *  User can toggle summon on/off via the summon dropdown in the input bar;
   *  persists across app restarts since it's on the conversation itself. */
  summonedPersonaId?: string
  /** Cached display name so header shows "正在以 XXX 视角对话" without an
   *  extra persona-load roundtrip. Updated when summon is toggled. */
  summonedPersonaName?: string
}

export interface HermesSkill {
  id: string
  name: string
  description: string
  type: 'builtin' | 'learned' | 'custom'
  prompt?: string          // Prompt template (custom/learned)
  trigger?: string         // When to activate (e.g. "阅读法学文献时")
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface HermesInsight {
  id: string
  content: string          // AI-generated insight markdown
  basedOn: number          // Number of behavior events analyzed
  generatedAt: string
  model: string            // Which AI model generated it
}

// ===== Persona · 召唤 (batch 29 方向纠偏后) =====
// "召唤"功能的目标产物是一份**可运行 skill**（复刻 alchaincyf/nuwa-skill 的
// 蒸馏机制），不是 markdown 档案。核心流程：
//
//   1. 搜索 + 勾选参考资料     （多源搜索：Wiki/百度降权/DDG）
//   2. AI disambig 识别身份     （候选列表，用户选）
//   3. 6 维度逐步蒸馏           （著作 / 访谈 / 表达 / 他者 / 决策 / 时间线）
//      每维跑完一次 AI + 一次独立评估，用户确认后进入下一维
//   4. 综合成 skill             （心智模型 3-7 + 启发式 5-10 + 表达DNA + 边界）
//   5. 整体拟合度评估           （6 维度按"扮演保真度"）
//
// skill 的三种用法：
//   a. 导出到 ~/.claude/skills/ 给 Claude Code 用（符合官方 skill 规范）
//   b. 拾卷内独立召唤对话（PersonasTab 里"和这个人聊聊"）
//   c. 嵌入到 Hermes 对话 / 注释面板，用户选一个名家，skill 作为 system prompt
//
// 兼容性：用户可能有旧档案（batch 29 前的 content-based Persona）——以
// skillMode='legacy' 保留，UI 提示"升级"；不强删旧数据。

// 一条参考资料（多源搜索 + 用户投喂）
export interface PersonaSource {
  id: string                 // uuid
  title: string              // "卡尔·马克思 - 维基百科"
  snippet: string            // 简述 / 前几句（用于用户初筛）
  url: string                // 原文链接
  source: 'wikipedia-zh' | 'wikipedia-en' | 'baidu-baike' | 'duckduckgo'
    | 'archive-org' | 'project-gutenberg' | 'glm-web-search'
    | 'user-file' | 'user-url' | 'user-prompt'
  fullContent?: string       // fetch 后的正文（用户勾选后填充）
  fetchedAt?: string
  // Trust tier — affects how much the distillation prompt weighs this source.
  // Aligned with nuwa-skill's source priority. baidu-baike is marked 'low' per
  // nuwa's blacklist comment (洗稿严重，仅作交叉验证，不作一手依据).
  // user-* sources are 'primary' (user-curated = highest trust).
  trust?: 'primary' | 'high' | 'medium' | 'low'
}

// AI disambig 阶段：候选身份
export interface PersonaCandidateIdentity {
  canonicalName: string      // "卡尔·马克思"
  identity: string           // "19 世纪德国哲学家、经济学家"
  lifespan?: string          // "1818-1883"
  basedOnSourceIds: string[] // 来源追溯
  confidence: number         // 0-100
}

// ===== Fitness · 6 维"扮演保真度" =====
// 复刻 nuwa-skill 的 Phase 4 评估哲学："如果用这份资料让 AI 扮演该人物，
// 扮演出的'人'和真实人物有多像"——**不是写得顺不顺，是能不能骗过熟悉该人物的读者**。
//
// 参照刻度（硬封顶，保守）：
//   < 500 字档案           ≤ 25%
//   无原文直接引用          ≤ 45%
//   无用户投喂一手材料      ≤ 55%
//   理论上限                ~70%（人是极复杂个体，100% 不可能）
//
// 旧 5 维（completeness/specificity/consistency/verifiability/...）已淘汰：
// 那套按"档案质量"评分，和扮演保真度不匹配（用户明确反馈方向错）。
export interface PersonaFitness {
  total: number              // 0-100，6 维之和
  breakdown: {
    coreThought: number            // 0-20：核心思想覆盖（能否扮出主要命题+推理方式）
    biographicalAnchor: number     // 0-20：生平时代锚定（具体年代/地点/人物关系）
    worldviewBreadth: number       // 0-20：世界观广度（跨议题立场）
    languageStyle: number          // 0-15：语言风格线索（用词/类比/节奏 + 直接引文）
    epistemicHonesty: number       // 0-10：边界诚实（学界争议/史料有限的明确标注）
    userMaterialAlignment: number  // 0-15：用户材料契合（无投喂默认满分且 notes 不写）
  }
  notes: string[]            // 格式 "【维度 -扣分】具体说明"
  evaluatedAt: string
  model: string
  /** 针对"整体 skill"还是某个 dimension。dimension 级在 6 维蒸馏过程中就地用；
   *  full 级在综合 skill 完成后用。 */
  scope?: 'dimension' | 'synthesized'
}

// ===== 蒸馏 6 维 =====
// 映射 nuwa-skill 的 6 个研究 agent。每维独立跑一次 AI，完成后单独评估，
// 用户确认（或跳过）后进入下一维。全部完成才能进"综合"阶段。
export type PersonaDimensionKey =
  | 'writings'         // 01 · 著作与长文：书籍、论文、长文
  | 'conversations'    // 02 · 对话：播客、访谈、AMA
  | 'expression'       // 03 · 碎片表达 DNA：社媒/即刻/推特/微博
  | 'externalViews'    // 04 · 他者评价：批评/传记/评论
  | 'decisions'        // 05 · 决策记录：重大决策、转折点
  | 'timeline'         // 06 · 时间线：完整发展轨迹

export interface PersonaDimension {
  key: PersonaDimensionKey
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error'
  content: string            // Markdown — 这一维的研究产出
  sourcesUsedIds: string[]   // 跑这一维时吸收的 source id
  fitness?: PersonaFitness   // 这一维的独立评估（scope='dimension'）
  distilledAt?: string
  model?: string
  errorMsg?: string          // status='error' 时填
}

// 6 维打包容器
export interface PersonaDistillation {
  dimensions: Record<PersonaDimensionKey, PersonaDimension>
  /** 推荐前端展示顺序，也是逐阶段触发顺序 */
  order?: PersonaDimensionKey[]
}

// ===== Skill Artifact（综合产物）=====
// 6 维蒸馏完成后综合成这个结构。`fullMarkdown` 是最终能导出到 Claude Code
// ~/.claude/skills/<slug>/SKILL.md 的完整文本；其他字段是结构化 mirror，
// 方便 UI 展示 / 前端 chat 注入不同部分。
export interface PersonaSkillArtifact {
  skillSlug: string          // "hegel-perspective" / "musk-perspective" 等目录名
  /** SKILL.md 的 frontmatter */
  frontmatter: {
    name: string             // 人物名 "黑格尔"
    description: string      // "以黑格尔视角回答问题"
    triggers: string[]       // ["黑格尔", "辩证法"]
    model?: string           // 推荐使用的模型
  }
  identityCard: string       // 一段身份卡
  mentalModels: Array<{
    name: string             // "正反合辩证运动"
    description: string      // 一段说明
    evidence?: string        // 来源佐证
  }>                          // 3-7 个
  heuristics: Array<{
    rule: string             // "遇到对立，先找高阶统一"
    example?: string         // 具体案例
  }>                          // 5-10 条
  expressionDna: {
    vocabulary: string[]     // 常用词
    patterns: string[]       // 句式模式
    metaphors: string[]      // 标志性类比
    rhythm: string           // 节奏描述
  }
  timeline: string           // Markdown 的时间线段落
  values: string             // 价值观 Markdown
  intellectualLineage: string // 智识谱系 Markdown
  honestBoundaries: string[] // ≥3 条明确局限
  tensions: Array<{ a: string; b: string; note?: string }>  // ≥2 对内在张力
  sourceReferences: string[] // 调研来源列表
  /** 最终导出 / 召唤用 system prompt 的完整 markdown。
   *  结构和 nuwa-skill 产物保持一致，能直接放到 ~/.claude/skills/<slug>/SKILL.md */
  fullMarkdown: string
  synthesizedAt: string
  model: string              // 综合阶段用的 AI 模型
}

// Persona 的主 content 版本记录。对 distilled 模式：
//   - content 是当前 skill.fullMarkdown 的 snapshot
//   - distillationSnapshot 是该版本下的 6 维 + skill 快照，便于回滚
export interface PersonaVersion {
  content: string            // 当时的主 markdown（legacy 用 content / distilled 用 skill.fullMarkdown）
  generatedAt: string
  model: string
  fitness?: PersonaFitness
  changeNote?: string
  sourcesUsedIds?: string[]
  /** distilled 模式下此字段存在：快照当时 6 维 + skill */
  distillationSnapshot?: PersonaDistillation
  skillSnapshot?: PersonaSkillArtifact
}

// Persona 主体。`skillMode` 区分三种形态：
//   - 'legacy'    batch 29 初版产物：只有 content 字段有效，distillation/skill 为空
//                 UI 上标红"升级到蒸馏版 (重新生成)"
//   - 'distilled' 新蒸馏流程产出：6 维 + skill artifact 齐全
//   - 'imported'  用户从外部（Claude Code 目录 / zip）导入的 nuwa skill：
//                 distillation 可能为空（外部蒸馏的不一定留下研究过程），
//                 skill 一定存在，content = skill.fullMarkdown
export interface Persona {
  id: string
  name: string               // 用户原始输入 "马克思"
  canonicalName?: string     // AI 确认的规范名
  identity?: string          // 一句话身份
  skillMode: 'legacy' | 'distilled' | 'imported'

  /** 主 markdown — legacy 时是档案；distilled/imported 时镜像 skill.fullMarkdown */
  content: string

  sourcesUsed: PersonaSource[]   // 累积资料
  userMaterial?: string          // 用户累积投喂笔记（legacy 兼容字段）
  versions: PersonaVersion[]

  distillation?: PersonaDistillation   // distilled 模式填；legacy/imported 可空
  skill?: PersonaSkillArtifact         // distilled/imported 填；legacy 空
  currentFitness?: PersonaFitness      // 最新一次整体评估（scope='synthesized'）

  /** 上次导出到 ~/.claude/skills/ 的时间和目标路径（若有） */
  exportedAt?: string
  exportedPath?: string

  /** 若是 imported，记录来源（目录路径/zip 名） */
  importedFrom?: string

  createdAt: string
  updatedAt: string
}

// 蒸馏维度的展示配置（中文名、顺序、默认描述），供 UI 和 prompt 生成共用
export const PERSONA_DIMENSIONS: Array<{
  key: PersonaDimensionKey
  label: string              // "著作"
  fullLabel: string          // "著作 · 书籍 / 长文 / 论文"
  briefHint: string          // 一句话说明该维度
  filename: string           // 对应 nuwa-skill 的 research md 文件名
}> = [
  { key: 'writings',      label: '著作',     fullLabel: '著作 · 书籍 / 长文 / 论文',        briefHint: '该人物亲笔写下的长文本',            filename: '01-writings.md' },
  { key: 'conversations', label: '访谈',     fullLabel: '访谈 · 播客 / 对话 / AMA',           briefHint: '对谈中暴露的思考过程',              filename: '02-conversations.md' },
  { key: 'expression',    label: '表达 DNA', fullLabel: '碎片表达 · 社媒 / 即刻 / 推特',      briefHint: '即兴、短形式、语言习惯',            filename: '03-expression-dna.md' },
  { key: 'externalViews', label: '他者',     fullLabel: '他者视角 · 批评 / 传记 / 评论',      briefHint: '别人是怎么评价、反驳、描述他的',    filename: '04-external-views.md' },
  { key: 'decisions',     label: '决策',     fullLabel: '决策记录 · 重大决策 / 转折点',       briefHint: '他做过的选择，尤其是反直觉的',      filename: '05-decisions.md' },
  { key: 'timeline',      label: '时间线',   fullLabel: '时间线 · 完整人物发展轨迹',          briefHint: '生平节点与时代背景',                filename: '06-timeline.md' },
]

/** 新建 distilled Persona 的空 distillation（6 维 status='pending'） */
export function createEmptyDistillation(): PersonaDistillation {
  const dims = {} as Record<PersonaDimensionKey, PersonaDimension>
  for (const d of PERSONA_DIMENSIONS) {
    dims[d.key] = {
      key: d.key,
      status: 'pending',
      content: '',
      sourcesUsedIds: [],
    }
  }
  return {
    dimensions: dims,
    order: PERSONA_DIMENSIONS.map(d => d.key),
  }
}

/** 把一条资料的 source 字段映射到默认 trust tier。
 *  user-* 永远 primary；Archive.org / Gutenberg 是公版原著，primary 级；
 *  百度百科单独降到 low（nuwa 黑名单哲学）。 */
export function defaultTrustForSource(source: PersonaSource['source']): PersonaSource['trust'] {
  switch (source) {
    case 'user-file':
    case 'user-url':
    case 'user-prompt':
      return 'primary'
    case 'archive-org':
    case 'project-gutenberg':
      return 'primary'   // 公版原著 = 一手材料
    case 'wikipedia-zh':
    case 'wikipedia-en':
      return 'high'
    case 'duckduckgo':
    case 'glm-web-search':
      return 'medium'
    case 'baidu-baike':
      return 'low'
  }
}

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeNode[]
  hasMeta?: boolean
}

export function createDefaultLibrary(): Library {
  return {
    version: '2.0.0',
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    globalTags: [],
    folders: [],
    entries: [],
    memos: [],
    memoFolders: [],
    readingLogs: [],
    lectureSessions: []
  }
}

export function createDefaultPdfMeta(entryId: string): PdfMeta {
  return {
    version: '1.0.0',
    entryId,
    pages: [],
    annotations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}
