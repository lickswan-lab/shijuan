import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import { KATEX_FORGIVING as rehypeKatex } from '../../utils/markdownConfig'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { AgentMessage, AgentConversation } from '../../types/library'
import { buildAgentSystemPrompt, type AgentContext } from './agentPrompt'
import { parseToolCalls, hasToolCalls, extractMemoryUpdate, cleanResponse, executeTool } from './agentTools'
// 2026-04-24 apprenticePrompt / apprenticeDialoguePrompt import 已删（学徒观察 UI 全去）
import PersonasTab from './PersonasTab'
import { fetchAiConfig, subscribeAiConfig } from '../../utils/aiConfigCache'
import { fetchAgentMemory, invalidateAgentMemoryCache } from '../../utils/agentMemoryCache'
import { humanizeAiError } from '../../utils/humanizeAiError'
// PERF-R8#14 · 共享 persona 肖像缓存,免每次 AgentPanel mount 都重新 IPC
import { getPortraitDataUrl } from '../../utils/personaPortraitCache'
import ModelSelector from '../common/ModelSelector'

// NOTE: The 'Skills' panel tab was removed in batch 28. Reason:
//   - The 13 built-in tools shown there were display-only (users couldn't
//     enable/disable them, and the list drifted from agentPrompt.ts's real
//     tool descriptions — two sources of truth for the same thing).
//   - Custom skills (user-authored prompt fragments) had near-zero adoption:
//     high prompt-engineering barrier, and the three AI companionship surfaces
//     (instant feedback / daily / apprentice weekly) already cover the space.
//   - The 'learned' skill type was dead code — nothing ever wrote a learned skill.
//
// Kept for back-compat:
//   - agent-load-skills / agent-save-skills IPC stay registered (legacy skills.json
//     files on users' disks continue to read/parse cleanly, just won't be surfaced)
//   - agentPrompt.ts TOOL_DESCRIPTIONS stay — that's what the AI actually sees.

interface ConfiguredProvider {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

// Tab "personas" (UI 名"名家") replaced the old "insights" tab in batch 29.
// Reasons insights was removed:
//   - Prompt was old "AI 助手" voice (gave "个性化建议") — conflicted with
//     拾卷's observer-companion philosophy that严禁 command-form advice
//   - Data source was memory.md (abstract Hermes-authored notes), requiring
//     users to already-have-used-Hermes-a-lot → near-zero adoption
//   - Functional overlap with apprentice weekly (which does this better)
// IPC agent-load-insight / agent-save-insight kept for back-compat with
// existing insights.json files on users' disks.
type PanelTab = 'chat' | 'personas' | 'apprentice'

// Format "X 天前" / "上周" / "N 周前"
function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return '刚刚'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const weeks = Math.floor(days / 7)
  if (weeks === 1) return '上周'
  return `${weeks} 周前`
}

// ===== Resize config =====
// Persist user's preferred panel width so it survives session reloads.
const AGENT_WIDTH_KEY = 'sj-agent-panel-width'
const AGENT_WIDTH_MIN = 320
const AGENT_WIDTH_MAX = 800
const AGENT_WIDTH_DEFAULT = 380

// 2026-04-24 多重召唤
const MAX_SUMMONED = 3
// 辩论模式每次 send 触发 N 轮（每位各发言 N 次）；上限 2 轮防失控烧 token
const DEBATE_ROUNDS_DEFAULT = 2
const DEBATE_ROUNDS_MIN = 1
// 2026-04-25 · 上限从 5 → 15：改成"短交互"风格后每轮发言很短（1-3 句），
// 10 轮一来一回才像真实辩论；成本仍可控，且用户可以随时 STOP / 往下调。
const DEBATE_ROUNDS_MAX = 15

/** 把 legacy summonedPersonaId + 新 summonedPersonas[] 归一化成单一数组 */
function getSummoned(conv: AgentConversation | null): Array<{ id: string; name: string }> {
  if (!conv) return []
  if (conv.summonedPersonas && conv.summonedPersonas.length > 0) return conv.summonedPersonas
  if (conv.summonedPersonaId) {
    return [{ id: conv.summonedPersonaId, name: conv.summonedPersonaName || '召唤人物' }]
  }
  return []
}

/** 更新 conv 的召唤人物：同时刷新两个字段（新 array + legacy primary）*/
function withSummoned(
  conv: AgentConversation,
  personas: Array<{ id: string; name: string }>,
): AgentConversation {
  return {
    ...conv,
    summonedPersonas: personas.length > 0 ? personas : undefined,
    summonedPersonaId: personas[0]?.id,
    summonedPersonaName: personas[0]?.name,
    updatedAt: new Date().toISOString(),
  }
}

/** 解析 user 消息里的 @ 指定：返回 [命中 persona[], 清洗后的 text]
 *  匹配 `@X` 字面量，不走 regex —— 之前 `@孔子\b?` 在 V8 里抛
 *  "Nothing to repeat"（中文字符后 `\b` 是 zero-width assertion，`?` 被视为
 *  无对象可重复）。改成纯字符串 includes/split，安全且对任意 Unicode 人名都通用。 */
function parseMentions(
  text: string,
  available: Array<{ id: string; name: string }>,
): { targets: Array<{ id: string; name: string }>; cleanText: string } {
  if (available.length === 0) return { targets: [], cleanText: text }
  const hits: Array<{ id: string; name: string }> = []
  let cleanText = text
  for (const p of available) {
    const mention = `@${p.name}`
    if (text.includes(mention)) {
      hits.push(p)
      // split/join 同时移除所有出现
      cleanText = cleanText.split(mention).join('').trim()
    }
  }
  return { targets: hits, cleanText }
}

// 2026-04-25 PERF · stagePrefix 模板提到模块层 —— 之前在 runOne 内每次重新拼接
// ~700 字符的字符串，N 人 × M 轮调用累计可观。提到外面，runOne 只需 String.replace
// 一处 ${persona.name} 的占位。
//
// 2026-04-27 Batch 43 · 拆三套场景模板（修 bug "辩论模式关闭之后依然处于辩论状态"）
//   solo       —— 单人召唤：一对一对话，无对手概念
//   roundtable —— 多人 + 辩论关：圆桌座谈，有交流有借鉴但不针锋相对
//   debate     —— 多人 + 辩论开：半辩论半讨论，目标是逼出深刻结论
//
// 之前一套 STAGE_PREFIX_TEMPLATE 把"当面口头辩论 / 拆接反 / 觉得对方蠢"写死，
// 即使 debateMode=false 也注入这个 700 字辩论框架，把"圆桌"软指令完全压过 ——
// 用户感受到"关掉辩论后还在辩"。

// 共用底色：风格化要求 + 禁陈述/枚举腔
const STYLE_RULES = `【节奏：让对方有"想接话"的冲动】
- 这是**当面口头交锋**，对面是另一个活的思想家，不是录音笔，也不是论文读者
- 你说完一段，对方要能立刻接、立刻回——所以**留余地、留勾子、留可被反驳的开口**
- 把对方堆到无话可说不算赢，那是演讲；让对方眼神一变、立刻想反驳，那才是真交锋
- 你的语言风格保持你本人——孔子的短句简白可以，黑格尔的辩证长句也可以
  —— 但**衡量标准不是"我把这个问题讲透了没"，而是"对方听完这一段会怎么接"**
- 禁陈述展开（"三点问题：第一…第二…第三…"），那是写论文的姿态，不是开口的姿态

【面对具体问题：先答，再用你的理论论证】
- 如果用户问的是**具体的事**（预测、选择、评估、谁会赢、哪个更好、会不会发生……），
  你必须**先给出明确的答案 / 判断 / 选择**，再用你的理论框架去论证为什么。
- ❌ 回避到原理讨论："胜负的本质是……"、"竞争的辩证是……"、"我无法预测，但你应该思考……"
- ✓ 先答："凯尔特人会夺冠。" 然后用你的理论论证："因为 [搜到的具体数据]，这印证了我说的 [你的理论]……"
- 不知道也要选——你是带着观点的思想家，不是中立的播报员。
  哪怕你时代不存在 NBA / 互联网 / 某项现代事物，给出的具体信息（包括对话上下文里的搜索结果）就是事实，
  你的工作是**用你的视角把它们解释 / 评判 / 预判清楚**。
- 不要说"我那个时代没有 X"——你被召唤来就是要面对今天这个问题，你要从你的视角对它发言。

【关于具体数据：严格只引用搜索结果，绝不脑补】
- 你的训练数据里可能记得一些球员名 / 历史比分 / 公司名等——**那些是过时记忆，不是事实**。
- 谈具体数据（胜场、比分、球员状态、伤病、转会、市值、时间……）时，你**只能引用对话上下文里搜索结果明确出现的**。
- 如果你想说的具体细节**没在搜索结果里出现**，你必须承认这个空白：
  "搜到的片段没覆盖到这点"、"我看到的资料里没说"——然后**用还看得到的部分做合理判断**，或者说"这点我说不准"。
- ❌ "波尔津吉斯首轮第一场缺阵，第二场打了十七分钟"——除非搜索结果里**逐字写了**这两条，否则不要这么说。
- ✓ "搜到的资料里看到 [搜索片段里的原话]——基于这点，我判断……"
- 数据不一致或时间错位（不同年份的赛季数据混在一起）时，**把这个不确定性说出来**：
  "搜到的几条信息里 X 和 Y 对不上，但更稳的那条是……"
- 编一个具体数字 / 比分 = 你这个人物失信。宁可笼统不要瞎具体。

【你该是谁——以 SKILL.md 为准】
- 你的**语言风格、句法、节奏、修辞偏好、是否用动作描写**，全部以下面【你是谁】里 SKILL.md 的 languageStyle 描述为准
- 上面这些通用规则只描述**场景**（"对方在等你接话"），不规定**形式**（不强制用括号、不强制反问、不强制破折号）
- 孔子的"子曰..."短句简白可以；马克思的辩证长论证可以；柏拉图苏格拉底式问答可以；福柯句法迂回可以
  —— 它们听起来应该**截然不同**。如果柏拉图和孔子说话像同一个人，说明你忽略了 SKILL.md
- 仅当你本人风格里**就有**舞台动作 / 神色描写时才用，**用圆括号**包（不要用 *星号* / **粗体** 标动作）
- 性格气质 / 思维武器：带着你这个人会有的脾气和路数，但**不为风格化而风格化**

【绝对禁止】
- 枚举腔："首先…其次…最后…"、标题、bullet、数字编号
- 套话："综上所述"、"辩证地看"、"从……维度/角度"
- 像新闻稿/论文摘要那样均匀段落

你是活人在开口。让人听一句话就认出是 __PERSONA_NAME__ —— 不是因为通用辩论手法，而是因为只有你这个人会这么说话。`

const STAGE_SOLO_TEMPLATE = `【现在的情境】
你正面对一位读者，对方向你提问。这是一对一的对话 —— 你以本人的口吻回应，不写文章、不做综述。

${STYLE_RULES}

---

【你是谁】

`

const STAGE_ROUNDTABLE_TEMPLATE = `【现在的情境】
你和其他几位学者一起被请来圆桌座谈。各位独立陈述自己的看法 —— 可以呼应、可以借鉴前者发言，也可以发现共通的方向，但**不必正面攻击对方**。这是同行间的相互探问，不是辩论。

【你和别人的关系】
- 听到的不是"对手"，是同样在思考这个问题的人
- 你可以**接前者**："你刚才提到的 X，我也注意到了，不过我会从 Y 入手……"
- 也可以**另起一面**："我从另一个角度看……"
- 不要假装赞同自己不认同的，但也不必为攻击而攻击

${STYLE_RULES}

---

【你是谁】

`

const STAGE_DEBATE_TEMPLATE = `【现在的情境】
你在一场**对立辩论**里，和其他学者面对面交锋。每个人坚守自己的立场 —— 这场辩论**不为达成共识，不为融合结论**，就是要把分歧逼到底、让真正的思想差异显形。

【你和别人的关系】
- 听到对方的核心论点 → 找到你最不同意的那一点，直接拆
- **绝对不要**："先赞同一点再指出分歧"、"对方有道理但..."、"我们的共识在于..."
- 看到对方说对的地方？也只是局部对——剩下的还差什么、为什么仍然不够
- 你的立场要鲜明、要稳，从开场到最后一轮都不要软化、不要妥协
- 直呼对方名字，不用"另一位学者"

【辩论的尺度】
- 锋利但不撒泼。你是在用思想压对方，不是用情绪
- 一次只挑一个点打，但要打得透
- 反复围绕分歧推进，不要急于"全面回应"

${STYLE_RULES}

---

【你是谁】

`

type StageMode = 'solo' | 'roundtable' | 'debate'

function buildStagePrefix(personaName: string, mode: StageMode = 'solo'): string {
  const tpl = mode === 'debate'
    ? STAGE_DEBATE_TEMPLATE
    : mode === 'roundtable'
      ? STAGE_ROUNDTABLE_TEMPLATE
      : STAGE_SOLO_TEMPLATE
  return tpl.replace(/__PERSONA_NAME__/g, personaName)
}

// ===== Memoized Message Bubble =====
// 2026-04-25 PERF · 抽出独立子组件并用 React.memo —— streaming chunk 高频触发
// AgentPanel re-render，但每条历史消息的 props（msg + portraitSrc）不变时，
// memo 直接复用 → ReactMarkdown 不重新解析 markdown（解析很重），
// 节省大量 CPU。需配合 displayMessages useMemo 让 props.msg 引用稳定。
const MessageBubble = memo(function MessageBubble(props: {
  msg: AgentMessage
  portraitSrc: string | null
}) {
  const { msg, portraitSrc } = props
  const isUser = msg.role === 'user'
  const persona = msg.personaAtMoment
  return (
    <div style={{
      marginBottom: 12, display: 'flex',
      flexDirection: isUser ? 'row-reverse' : 'row',
      alignItems: 'flex-start', gap: isUser ? 0 : 8,
    }}>
      {!isUser && (
        persona && portraitSrc ? (
          <img
            src={portraitSrc}
            alt={persona.name}
            title={persona.name}
            loading="lazy"
            decoding="async"
            style={{
              width: 30, height: 30, borderRadius: '50%',
              objectFit: 'cover', flexShrink: 0,
              border: '1px solid var(--accent)',
            }}
          />
        ) : (
          <div style={{
            width: 30, height: 30, borderRadius: '50%',
            background: 'var(--bg-warm)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }} title={persona?.name || '学徒'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
        )
      )}
      <div style={{
        maxWidth: isUser ? '85%' : 'calc(100% - 46px)',
        display: 'flex', flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
      }}>
        {!isUser && (
          <div style={{
            fontSize: 10.5, color: 'var(--text-muted)',
            marginBottom: 3, marginLeft: 2, letterSpacing: '0.3px',
          }}>
            {persona?.name || '学徒'}
          </div>
        )}
        <div style={{
          padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.7,
          ...(isUser
            ? { background: 'var(--accent)', color: '#fff', borderBottomRightRadius: 2 }
            : { background: 'var(--bg-warm)', color: 'var(--text)', border: '1px solid var(--border-light)', borderTopLeftRadius: 2 }),
        }}>
          {msg.role === 'assistant' ? <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{msg.content}</ReactMarkdown> : <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}
        </div>
      </div>
    </div>
  )
})

// ===== Main Component =====
export default function AgentPanel() {
  // 2026-04-25 PERF · 选择性订阅替代全量解构 ——
  // 之前 streaming chunk 每帧 setState 叠加任何 ui/library 全字段变化都触发 AgentPanel
  // re-render；改成只订阅这 7 个字段后，无关字段（sidebar、modal 等）变化不再波及。
  const library = useLibraryStore(s => s.library)
  const currentEntry = useLibraryStore(s => s.currentEntry)
  const currentPdfMeta = useLibraryStore(s => s.currentPdfMeta)
  const createMemo = useLibraryStore(s => s.createMemo)
  const updateMemo = useLibraryStore(s => s.updateMemo)
  const selectedAiModel = useUiStore(s => s.selectedAiModel)
  const textSelection = useUiStore(s => s.textSelection)

  // P2-9 · 从 AnnotationPanel 空态引导按钮过来时会在 localStorage 存
  // 'sj-agent-tab-pending'，第一次挂载时消费一次，让用户直接落在 personas tab。
  const [tab, setTab] = useState<PanelTab>(() => {
    try {
      const pending = localStorage.getItem('sj-agent-tab-pending')
      if (pending === 'personas' || pending === 'apprentice' || pending === 'chat') {
        localStorage.removeItem('sj-agent-tab-pending')
        return pending as PanelTab
      }
    } catch { /* ignore */ }
    return 'chat'
  })

  // Chat state
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [activeConv, setActiveConv] = useState<AgentConversation | null>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [toolStatus, setToolStatus] = useState('')
  const [memory, setMemory] = useState('')
  // 2026-04-24 合并方案 A v2 · 历史对话 UI
  // 顶部：[+ 新对话] [历史对话 ▾]
  //   ▾ 点开下拉 → 最近 5 条 + "查看更多历史对话" 链接
  //   点"查看更多" → 进入全页历史列表视图（showHistoryFullPage=true）
  // 替代原来的顶部横向 pill tabs。
  const [historyPopoverOpen, setHistoryPopoverOpen] = useState(false)
  const [showHistoryFullPage, setShowHistoryFullPage] = useState(false)
  const historyPopoverRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!historyPopoverOpen) return
    function onDocClick(e: MouseEvent) {
      if (historyPopoverRef.current && !historyPopoverRef.current.contains(e.target as Node)) {
        setHistoryPopoverOpen(false)
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setHistoryPopoverOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [historyPopoverOpen])

  // Model
  const [agentModel, setAgentModel] = useState(() => {
    try { return localStorage.getItem('sj-agentModel') || selectedAiModel } catch { return selectedAiModel }
  })
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])

  // Batch 43 · effort（思考强度）控件
  // 仅当当前 agentModel 在主进程被 modelSupportsEffort 判定为支持时显示
  const aiReasoningEffort = useUiStore(s => s.aiReasoningEffort)
  const setAiReasoningEffort = useUiStore(s => s.setAiReasoningEffort)
  // Batch 43 · 联网搜索开关（让 persona 辩论前先查 2026 时事）
  const aiWebSearch = useUiStore(s => s.aiWebSearch)
  const setAiWebSearch = useUiStore(s => s.setAiWebSearch)
  const [effortSupported, setEffortSupported] = useState(false)
  // Batch 43 · 当前 provider 是否支持 web search（原生 or manual loop 任一）。
  // GLM/Claude/Kimi/Gemini 走原生；OpenAI/DeepSeek/Doubao 走 manual loop（升级版能解析
  // DeepSeek V4 的 DSML 协议）；Ollama/Claude CLI 不支持。
  const [webSearchSupported, setWebSearchSupported] = useState(false)
  // 2026-04-28 · web search 是否单独付费(GLM/Claude),用于 🌐 tooltip 加付费提示
  const [webSearchIsPaid, setWebSearchIsPaid] = useState(false)
  useEffect(() => {
    let cancelled = false
    const [pid] = agentModel.includes(':') ? agentModel.split(':', 2) : [agentModel]
    if (!pid) { setWebSearchSupported(false); setWebSearchIsPaid(false); return }
    window.electronAPI.aiProviderSupportsWebSearch?.(pid).then(ok => {
      if (!cancelled) setWebSearchSupported(!!ok)
    }).catch(() => { if (!cancelled) setWebSearchSupported(false) })
    window.electronAPI.aiProviderWebSearchIsPaid?.(pid).then(paid => {
      if (!cancelled) setWebSearchIsPaid(!!paid)
    }).catch(() => { if (!cancelled) setWebSearchIsPaid(false) })
    return () => { cancelled = true }
  }, [agentModel])
  useEffect(() => {
    let cancelled = false
    const [pid, mid] = agentModel.includes(':') ? agentModel.split(':', 2) : [agentModel, '']
    if (!pid || !mid) { setEffortSupported(false); return }
    window.electronAPI.aiModelSupportsEffort?.(pid, mid).then(ok => {
      if (!cancelled) setEffortSupported(!!ok)
    }).catch(() => { if (!cancelled) setEffortSupported(false) })
    return () => { cancelled = true }
  }, [agentModel])

  // Batch 43 · 检测持久化的 agentModel 是否在新版 PROVIDERS 列表里仍有效；
  // 失效时自动 fallback 到第一个可用 model（保护用户旧 localStorage 字符串）。
  // 例如 deepseek-v4 已被改为 deepseek-v4-pro，老用户的 sj-agentModel
  // = "deepseek:deepseek-v4" 不在新列表里，发请求会 400 → 这里替换。
  useEffect(() => {
    if (configuredProviders.length === 0) return  // providers 还没加载，等下一帧
    const [pid, mid] = agentModel.includes(':') ? agentModel.split(':', 2) : [agentModel, '']
    const stillValid = configuredProviders.some(p => p.id === pid && p.models.some(m => m.id === mid))
    if (stillValid) return
    // 找第一个可用 model
    const firstProvider = configuredProviders[0]
    if (!firstProvider || firstProvider.models.length === 0) return
    const fallback = `${firstProvider.id}:${firstProvider.models[0].id}`
    console.warn(`[AgentPanel] saved model "${agentModel}" 不在当前 providers 列表里，fallback 到 ${fallback}`)
    setAgentModel(fallback)
    try { localStorage.setItem('sj-agentModel', fallback) } catch { /* ignore */ }
  }, [configuredProviders, agentModel])

  // 2026-04-24 多重召唤 · 流式消息正在说的人物（用于流式气泡的头像+名字）
  // 多人回复时每位 persona 顺序说，UI 气泡头像应跟着"当前说话的那位"切换。
  // 2026-04-25 · 必须用 state 而非 ref —— ref 不触发 re-render，下一位 runOne
  // 刚开始 await system-prompt 时 UI 仍用上一位的头像；用 state 触发重渲染即可。
  const [streamingPersona, setStreamingPersona] = useState<{ id: string; name: string } | null>(null)

  // 2026-04-24 头像缓存 · 按 personaId 缓存 dataUrl · 历史消息用各自刻印的
  // personaAtMoment.id 去查（而非当前对话的 summonedPersonaId），切换召唤后
  // 历史消息头像保持不变。
  // PERF-R8#14 · 之前用 useState 组件局部 cache,AgentPanel mount/unmount 之间
  //   重复 IPC。改成走 src/utils/personaPortraitCache.ts 模块级共享 cache;
  //   useState 仅留作"哪些已经在本组件 state 里"的 trigger,初始空,getPortraitDataUrl
  //   命中 module cache 即同步返回(无 IPC),仍 setState 通知 React 重渲。
  const [portraitCache, setPortraitCache] = useState<Record<string, string>>({})
  useEffect(() => {
    const idSet = new Set<string>()
    if (activeConv?.summonedPersonaId) idSet.add(activeConv.summonedPersonaId)
    for (const m of activeConv?.messages || []) {
      if (m.personaAtMoment?.id) idSet.add(m.personaAtMoment.id)
    }
    const missing = Array.from(idSet).filter(id => !portraitCache[id])
    if (missing.length === 0) return
    let cancelled = false
    ;(async () => {
      for (const id of missing) {
        const dataUrl = await getPortraitDataUrl(id)
        if (cancelled) return
        if (dataUrl) {
          setPortraitCache(prev => prev[id] ? prev : { ...prev, [id]: dataUrl })
        }
      }
    })()
    return () => { cancelled = true }
  }, [activeConv?.id, activeConv?.messages?.length, activeConv?.summonedPersonaId])

  // Insights tab removed — see PanelTab comment above.
  // 2026-04-24 PERF · 学徒观察 UI 全删后的 dead state 清理（~30 行 state / 2 useRef
  // 去掉）。包括 apprentice 周报 state、dialogue 追问 state、custom range picker、
  // historyExpanded —— 都是 UI 早就不渲染的数据。若将来要港成 skill，从 git 恢复。

  const messagesEndRef = useRef<HTMLDivElement>(null)
  // 2026-04-25 · 智能 auto-scroll —— 仅当用户停留在底部附近时才跟随滚动
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  // 2026-04-25 PERF · streamingText rAF 节流 —— chunk 频率可达每秒几十次，
  // 直接 setState 会让整个 AgentPanel 每帧 re-render 多次。改成累积到 ref，
  // requestAnimationFrame 一帧一次同步到 state，render 频率压到 60fps。
  const streamingTextRef = useRef('')
  const streamingRafRef = useRef<number | null>(null)
  const flushStreamingText = useCallback((text: string) => {
    streamingTextRef.current = text
    if (streamingRafRef.current !== null) return
    streamingRafRef.current = requestAnimationFrame(() => {
      streamingRafRef.current = null
      setStreamingText(streamingTextRef.current)
    })
  }, [])
  // 清空 streamingText —— 同时 cancel 任何 pending rAF，避免延迟 chunk 覆盖空状态
  const clearStreamingText = useCallback(() => {
    if (streamingRafRef.current !== null) {
      cancelAnimationFrame(streamingRafRef.current)
      streamingRafRef.current = null
    }
    streamingTextRef.current = ''
    setStreamingText('')
  }, [])
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)
  // 距底阈值：80px 以内视为"粘底"，继续 auto-scroll；超出就不打扰
  const BOTTOM_THRESHOLD = 80
  // Track the streamId of the current in-flight AI request so the user can abort it.
  // Only one stream runs at a time in this panel (chat, insight, or apprentice).
  const currentStreamIdRef = useRef<string | null>(null)

  // Resizable panel width. Left edge is a drag handle — user pulls left to make
  // the panel wider (because the panel sits on the right side of the app).
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(AGENT_WIDTH_KEY))
      return v >= AGENT_WIDTH_MIN && v <= AGENT_WIDTH_MAX ? v : AGENT_WIDTH_DEFAULT
    } catch { return AGENT_WIDTH_DEFAULT }
  })
  const panelWidthRef = useRef(panelWidth)
  panelWidthRef.current = panelWidth

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidthRef.current
    const onMove = (ev: MouseEvent) => {
      // Pulling mouse LEFT (decreasing clientX) widens the panel
      const dx = startX - ev.clientX
      const next = Math.max(AGENT_WIDTH_MIN, Math.min(AGENT_WIDTH_MAX, startW + dx))
      setPanelWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem(AGENT_WIDTH_KEY, String(panelWidthRef.current)) } catch { /* ignore */ }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const handleStopStream = useCallback(() => {
    const sid = currentStreamIdRef.current
    if (sid) {
      window.electronAPI.aiAbortStream?.(sid).catch(() => {})
    }
    // 兜底：即使没有活跃 stream（比如前一次异常把 streaming 卡死），也强制把 UI 解锁，
    // 让用户能继续发送 —— 否则"点不了发送"时用户连 STOP 都点不动，只能重启。
    setStreamingPersona(null)
    clearStreamingText()
    setStreaming(false)
    setToolStatus('')
  }, [clearStreamingText])

  // 2026-04-25 · 之前在 unmount 时 abort 当前 stream（省 token）。但 dev 环境
  // HMR 每次改代码加新 hook 都会让 React Fast Refresh 强制 remount AgentPanel，
  // 触发这个 cleanup → 流式一半的对话被中途掐断，用户看到"输出到一半突然没了"。
  // 代价权衡：关闭面板后让后端 stream 自然完成（多消耗一次 token，不大），
  // 换来 dev 和 production 都不会出现"莫名其妙中断"。用户要主动停，点 STOP 按钮
  // 仍然可以（handleStopStream 保留完整 abort 语义）。
  // 但 rAF 节流的 pending frame 必须在 unmount 时 cancel 防泄漏
  useEffect(() => {
    return () => {
      if (streamingRafRef.current !== null) {
        cancelAnimationFrame(streamingRafRef.current)
        streamingRafRef.current = null
      }
    }
  }, [])

  // 2026-04-24 Esc-from-apprentice useEffect 已移除（学徒观察 UI 全删）
  // 2026-04-24 Esc 从全页历史对话返回
  useEffect(() => {
    if (!showHistoryFullPage) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowHistoryFullPage(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showHistoryFullPage])

  // 2026-04-25 PERF · loadMemory dead code 已删（未引用，已并入下面 mount effect）

  // Persona list — used by the summon dropdown in chat tab so the user can
  // switch the conversation to "speak as <person>" mode. Loaded once on mount;
  // refreshed whenever the user creates a new persona via the 召唤 tab.
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string; canonicalName?: string; identity?: string; skillMode?: 'legacy' | 'distilled' | 'imported'; updatedAt: string; currentFitnessTotal?: number }>>([])
  const [showSummonMenu, setShowSummonMenu] = useState(false)

  const refreshPersonaList = useCallback(async () => {
    const r = await window.electronAPI.personaList?.()
    if (r?.success) setPersonaList(r.entries)
  }, [])

  // BUG-FIX AGENT#1 · cancellation flag so the 5+ async IPC calls in this
  // mount-effect don't setState after the user closes the Agent panel.
  // (AgentPanel unmounts when rightPanel !== 'agent' — happens every time
  // the user toggles back to the annotation side.)
  useEffect(() => {
    let cancelled = false
    // 2026-04-25 PERF · 走 cache
    fetchAgentMemory().then(r => {
      if (cancelled) return
      if (r.success) setMemory(r.content || '')
    })
    // 2026-04-25 PERF · 走共享 cache，命中后无 IPC
    // Batch 43 · 加订阅：用户在 Settings 里改 API key → invalidateAiConfigCache
    // 触发 → 这里自动 setState 拿到最新 providers（修 deepseek 配完不显示问题）
    fetchAiConfig().then(r => { if (!cancelled) setConfiguredProviders(r) })
    const unsubAiCfg = subscribeAiConfig(latest => {
      if (!cancelled) setConfiguredProviders(latest)
    })
    window.electronAPI.agentLoadConversations().then(r => {
      if (cancelled) return
      if (r.success) {
        setConversations(r.conversations)
        if (r.conversations.length > 0) setActiveConv(r.conversations[0])
      }
    })
    window.electronAPI.personaList?.().then(r => {
      if (cancelled) return
      if (r?.success) setPersonaList(r.entries)
    })
    // 2026-04-24 apprenticeList mount 加载已删（UI 全去）
    // 2026-04-25 PERF · 移除 4 秒后冗余 reload memory —— 没有有效场景；
    // memory 只在本 agent 自己 update，不会被外部并发改写
    return () => {
      cancelled = true
      unsubAiCfg()
    }
  }, [])

  // 2026-04-25 · 智能 auto-scroll ——
  // 之前每个 streaming chunk 都 smooth scroll 一次，`behavior:'smooth'` 会叠加取消，
  // 看起来像"抽搐"；更糟的是用户上滚看历史也会被强行拉回。
  // 修法：
  //   1. 监听滚动容器，实时维护 isAtBottomRef（距底 < 80px 视为粘底）
  //   2. 消息/流式变化时只在粘底状态下滚；否则不打扰用户
  //   3. streamingText 用 'auto' 瞬时滚（避免 smooth 叠加抽搐）；messages.length 用 'smooth'（新消息淡入）
  //   4. 用户离开底部时显示 "↓ 回到最新" 浮标
  // 2026-04-25 PERF · scroll listener 只在 mount 时 attach 一次。之前 deps 包含
  // streaming 和 messages.length → 每次新消息或 streaming 切换都 teardown + 重建
  // listener。改用 ref 读最新 streaming/conv 状态，listener 永久 attach。
  const scrollDecisionStateRef = useRef({ streaming: false, hasMessages: false })
  useEffect(() => {
    scrollDecisionStateRef.current = {
      streaming,
      hasMessages: (activeConv?.messages.length || 0) > 0,
    }
  })
  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const atBottom = distFromBottom < BOTTOM_THRESHOLD
      isAtBottomRef.current = atBottom
      const { streaming: s, hasMessages: h } = scrollDecisionStateRef.current
      setShowJumpToBottom(!atBottom && (s || h))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 消息数变化 —— 粘底才滚（smooth 让新消息淡入）
  useEffect(() => {
    if (isAtBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    } else {
      // 用户在上方看历史 —— 提示有新消息
      setShowJumpToBottom(true)
    }
  }, [activeConv?.messages.length])

  // streaming chunk 变化 —— 粘底才滚（auto 瞬时，避免 smooth 叠加抽搐）
  useEffect(() => {
    if (isAtBottomRef.current && streamingText) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [streamingText])

  // 发送消息 / 切换对话时，强制滚到底部（重置粘底状态）
  useEffect(() => {
    isAtBottomRef.current = true
    setShowJumpToBottom(false)
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [activeConv?.id])

  const jumpToBottom = useCallback(() => {
    isAtBottomRef.current = true
    setShowJumpToBottom(false)
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // Store helpers · 2026-04-24 用 useMemo 稳定引用
  // 之前每次 render 都重建 → 导致 handleSend useCallback 也每次重建 → 按钮 onClick
  // 可能在 click 进行时换了引用。React 事件系统其实能容忍这种情况，但 useMemo 能
  // 显著减少 handleSend 的重建次数，让"召唤后每次 state tick 都重建 handler"的路径消失。
  const storeHelpers = useMemo(() => ({
    getLibrary: () => library,
    getCurrentEntry: () => currentEntry,
    getSelectedText: () => textSelection?.text || null,
    getCurrentPdfMeta: () => currentPdfMeta,
    createMemo, updateMemo,
  }), [library, currentEntry, textSelection, currentPdfMeta, createMemo, updateMemo])

  const buildContext = useCallback((): AgentContext => {
    const ctx: AgentContext = { memory }
    if (currentEntry) { ctx.currentEntryTitle = currentEntry.title; ctx.currentEntryId = currentEntry.id }
    if (textSelection?.text) ctx.selectedText = textSelection.text
    if (currentPdfMeta?.annotations) {
      ctx.recentAnnotations = currentPdfMeta.annotations.slice(-5).map(a => ({
        text: a.anchor?.selectedText || '', note: a.historyChain?.[a.historyChain.length - 1]?.content || '',
      }))
    }
    return ctx
  }, [memory, currentEntry, textSelection, currentPdfMeta])

  // ===== Chat logic =====
  // Delete a conversation: opens an in-app confirm modal (replaces native
  // window.confirm which looked foreign against the warm 拾卷 palette).
  // executeDeleteConversation does the actual disk + in-memory removal.
  const [confirmingDelete, setConfirmingDelete] = useState<{ id: string; title: string } | null>(null)

  const handleDeleteConversation = useCallback((convId: string) => {
    const c = conversations.find(x => x.id === convId)
    setConfirmingDelete({ id: convId, title: c?.title || '未命名对话' })
  }, [conversations])

  const executeDeleteConversation = useCallback(async () => {
    const convId = confirmingDelete?.id
    if (!convId) return
    setConfirmingDelete(null)
    try {
      await window.electronAPI.agentDeleteConversation?.(convId)
    } catch { /* ignore — UI will re-sync from disk next load */ }
    const remaining = conversations.filter(c => c.id !== convId)
    setConversations(remaining)
    if (activeConv?.id === convId) {
      // Batch 43 · 删当前对话前 abort 流式 + 清残留状态（避免上个对话 streamingPersona 残留到 fallback 对话）
      handleStopStream()
      setActiveConv(remaining[0] || null)
    }
  }, [confirmingDelete, conversations, activeConv, handleStopStream])

  // ESC closes the confirm modal
  useEffect(() => {
    if (!confirmingDelete) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmingDelete(null)
      else if (e.key === 'Enter') executeDeleteConversation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmingDelete, executeDeleteConversation])

  const handleNewConversation = useCallback(() => {
    // Batch 43 · 切新对话前先 abort + 清空当前流式状态。
    // 修 bug：原对话某 persona 正在思考时点新对话，"XX 思考中…"气泡会残留到
    // 新对话顶部（streamingPersona / streamingText / streaming flag 都没清）。
    // 复用 handleStopStream 的完整 cleanup 语义（abort stream + 清三个 state）。
    handleStopStream()
    const conv: AgentConversation = {
      id: uuid(), title: '新对话', messages: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    setActiveConv(conv)
    setConversations(prev => [conv, ...prev])
    setTab('chat')
  }, [handleStopStream])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    let conv = activeConv
    if (!conv) {
      conv = { id: uuid(), title: text.slice(0, 30), messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      setConversations(prev => [conv!, ...prev])
    }

    // ===== 多重召唤 · 决定谁来回答 =====
    const allSummoned = getSummoned(conv)
    const { targets: mentionedTargets, cleanText } = parseMentions(text, allSummoned)
    // 优先级：@ 指定 > 全员
    const respondents = mentionedTargets.length > 0 ? mentionedTargets : allSummoned
    const debateMode = conv.debateMode && respondents.length >= 2

    // user 消息（如果有 @ 则用 cleanText；但显示保留原文便于历史对照）
    const userMsg: AgentMessage = { id: uuid(), role: 'user', content: text, timestamp: new Date().toISOString() }
    let workingMessages = [...conv.messages, userMsg]
    conv = { ...conv, messages: workingMessages, updatedAt: new Date().toISOString() }
    if (conv.messages.length === 1) conv.title = text.slice(0, 30)
    setActiveConv(conv)
    setInput('')
    setStreaming(true)
    clearStreamingText()

    // ===== Summon branch =====
    // If any persona is summoned, skip Hermes ReAct and use persona-voice replies.
    if (respondents.length > 0) {
      // 2026-04-24 · 整段包 try/finally：任何未捕获异常都不能把 streaming 卡住
      // （否则"点不了发送"——用户看到的就是 STOP 按钮变灰 or 仍旧 disabled）
      try {
      // 2026-04-25 PERF · 预加载所有 persona 的 system prompts（并行）
      // 之前：每轮都 IPC 加载一次 → 3 人 × 10 轮 = 30 次串行文件读 + RAG 查询
      // 现在：单次 handleSend 的 query 不变（cleanText || text），所以每人加载一次即可。
      //      Promise.all 并行，一次等待取代串行 N×M 次。
      const query = cleanText || text
      const systemPromptCache = new Map<string, string>()
      const preloadResults = await Promise.all(
        respondents.map(async p => {
          try {
            const r = await window.electronAPI.personaGetSystemPrompt?.(p.id, query)
            return r?.success && r.systemPrompt ? { id: p.id, name: p.name, prompt: r.systemPrompt, error: null } : { id: p.id, name: p.name, prompt: null, error: r?.error || `无法加载 ${p.name} 的 skill` }
          } catch (err: any) {
            return { id: p.id, name: p.name, prompt: null, error: err.message || '加载失败' }
          }
        }),
      )
      for (const r of preloadResults) {
        if (r.prompt) systemPromptCache.set(r.id, r.prompt)
      }
      // 2026-04-27 Batch 43 · 决定 stage mode（修 bug "辩论模式关闭仍处于辩论"）
      //   1 人 → solo（一对一对话）
      //   2+ 人 + debateMode=false → roundtable（圆桌座谈，独立陈述但可呼应）
      //   2+ 人 + debateMode=true  → debate（半辩论半讨论，目标是逼出深刻结论）
      const stageMode: StageMode = respondents.length === 1
        ? 'solo'
        : debateMode ? 'debate' : 'roundtable'
      // 辅助函数：让某位 persona 按当前 workingMessages 回一条
      // totalRounds 用于判断"最终轮"（仅 debateMode 下使用）
      const runOne = async (persona: { id: string; name: string }, debateRound?: number, totalRounds?: number): Promise<boolean> => {
        try {
          // 2026-04-25 · 必须在第一次 await 之前 setStreamingPersona —— 否则 UI 在
          // "await personaGetSystemPrompt"期间仍用上一位的头像。同时清空 streamingText
          // 让"思考中..."立即显示在新气泡下。
          setStreamingPersona(persona)
          clearStreamingText()
          // 从预加载缓存拿 system prompt（省去每轮的 IPC + 文件 I/O + RAG 查询）
          const cachedPrompt = systemPromptCache.get(persona.id)
          if (!cachedPrompt) {
            const errInfo = preloadResults.find(r => r.id === persona.id)
            throw new Error(errInfo?.error || `无法加载 ${persona.name} 的 skill`)
          }
          // 2026-04-25 v6 · 辩论味道 + AI 腔双治
          // v4 stage 在 user message 末尾 → AI 把它当任务做，AI 腔浓
          // v5 stage 挪到 system prompt 末尾 → 权重低，被 persona 正经立论盖过，辩论味没了
          // v6: stage 前置到 persona prompt 之前（先激活"辩论现场"再给角色设定），
          //     user message 末尾再补一条**戏剧化激活 cue**（不是任务命令，是场景提示）
          // 2026-04-25 v7 · stagePrefix 模板已提到模块层（见 STAGE_*_TEMPLATE）
          // 2026-04-27 Batch 43 · 按 stageMode 选不同模板
          const stagePrefix = buildStagePrefix(persona.name, stageMode)
          const llmMessages: Array<{ role: string; content: string }> = [
            { role: 'system', content: stagePrefix + cachedPrompt },
          ]
          // 多人模式下需要把其他人的发言当做"前一位学者说"的 user-role 注入
          for (const msg of workingMessages) {
            if (msg.role === 'user') {
              llmMessages.push({ role: 'user', content: msg.content })
            } else if (msg.role === 'assistant') {
              const speaker = msg.personaAtMoment?.name
              if (speaker && speaker !== persona.name) {
                // 别人说的 → 以"另一位学者 X 说：..."的 user 消息注入（去掉尾部软指令，
                // 由下面的专用 instruction 统一控制辩论/圆桌语气）
                llmMessages.push({
                  role: 'user',
                  content: `【${speaker} 刚才说】\n${msg.content}`,
                })
              } else {
                llmMessages.push({ role: 'assistant', content: msg.content })
              }
            }
          }

          // 2026-04-25 · 辩论/圆桌指令
          // 之前每人只收到用户原问题 + 软性"回应或继续讨论"提示，导致每位都做"独立小总结"，
          // 不像真实辩论。现在根据是否 debateMode 和是否首位发言，追加一条明确的 user
          // instruction，让后来者必须针对前者的**具体论点**交锋。
          const hasPrevSpeaker = workingMessages.some(
            m => m.role === 'assistant' && m.personaAtMoment?.name && m.personaAtMoment.name !== persona.name
          )
          const isFirstSpeaker = !hasPrevSpeaker
          // 2026-04-25 v6 · instruction 放 user message 末尾（高注意力位置），
          // 写成**戏剧化场景激活**，不是"任务命令"（你要/必须/应该），
          // 并且动态拼入"对手名字"，让 persona 被明确指向"刚才 X 说的那番话"
          // 而不是泛泛的"上面那几位"。
          const lastOpponentName = [...workingMessages]
            .reverse()
            .find(m => m.role === 'assistant' && m.personaAtMoment?.name && m.personaAtMoment.name !== persona.name)
            ?.personaAtMoment?.name
          // 2026-04-27 Batch 43 · 辩论模式 instruction（保持立场、不融合结论）
          // 用户校准方向："辩论模式则应该有明显的个人立场，不融合出结论，
          // 而是不断反驳他人和论证自己的观点。"
          // 所以最终轮也不收束、不和解，而是再次亮立场 / 再补一次反驳。
          //
          // 软约束 · 场景化提示对抗多轮累积的"越说越长"bias。
          // 不用数字命令、不用 max_tokens 硬限——LLM 对场景化描述的服从度更高，
          // 也不会抹平思想家本人的语言风格（黑格尔辩证长句 / 孔子短句各自保留)。
          //
          // 联网开启时额外提醒"搜到的是真实事实，必须基于它发言"——对抗历史名家
          // RLHF 倾向的"我不知道现代事物所以不答"回避模式。
          const isLastDebateRound = debateMode && debateRound != null && totalRounds != null && debateRound === totalRounds
          const webSearchHint = aiWebSearch
            ? '系统已为你联网搜索了 2026 真实信息（在工具调用结果里）。**那些是真实事实**，必须基于它们发言、做出明确判断 —— 不要绕过它们回到你时代的纯理论讨论。\n\n**但是**：你只能引用搜索片段里**逐字出现**的具体数据（人名 / 数字 / 比分 / 状态 / 时间）。**禁止**用你训练记忆里的过时数据补全。如果你想说的细节没在搜索片段里，承认空白（"搜到的资料里没覆盖这点"），然后用看得到的部分做判断。**编一个具体数字 = 你这个人物失信**。'
            : ''
          const wordLimit = `\n\n（对面在等你说完接话——说完一段就停，让对方有空隙反驳，不要把话全说完。${webSearchHint ? '\n\n' + webSearchHint : ''}）`

          let instruction = ''
          if (debateMode) {
            if (isLastDebateRound) {
              if (isFirstSpeaker) {
                instruction = `*第 ${debateRound} 轮（最终轮）。再亮一次你的核心立场 —— 不是收束、不是找共识，是把你最坚持的那一点再次说清楚，让所有人知道你**没有让步**。*`
              } else {
                const target = lastOpponentName || '对方'
                instruction = `*第 ${debateRound} 轮（最终轮）。${persona.name}，${target} 刚才那番话里，你最不能接受的是哪一点？就抓住它再反驳一次 —— 不要试图"达成共识"或"合流"，要的是把你的立场再压实一遍。*`
              }
            } else if (isFirstSpeaker) {
              instruction = `*第 ${debateRound || 1} 轮。轮到你开场。立场亮出来，开门见山 —— 让后面的人有东西可反驳。*`
            } else {
              const target = lastOpponentName || '对方'
              instruction = `*第 ${debateRound || 1} 轮。${persona.name}，${target} 刚才那番话哪一句最让你不同意？就从那里下手反驳，论证你自己的观点。不要妥协，不要找共识。*`
            }
          } else if (stageMode === 'roundtable') {
            // 多人 + 辩论关：圆桌座谈，可呼应可借鉴，不必针锋相对
            if (!isFirstSpeaker) {
              const target = lastOpponentName || '前面那位'
              instruction = `*${persona.name}，${target} 刚才说完了。这是同行间的圆桌座谈 —— 你可以接前者的话头，也可以另起一面。带着你这个人的路数开口，不必为分歧而分歧。*`
            } else {
              instruction = `*${persona.name}，轮到你开口。这是圆桌座谈，独立陈述你的看法，带着你的路数与口吻。*`
            }
          } else {
            // solo: 单人召唤
            instruction = `*${persona.name}，对方在等你开口。带着你的神色与路子。*`
          }
          // Batch 43 · 字数硬上限拼到 instruction 末尾（高注意力位置）
          // 每轮独立提醒，对抗多轮上下文累积导致的"越说越长"bias
          instruction = instruction + wordLimit
          llmMessages.push({ role: 'user', content: instruction })
          const streamId = uuid()
          currentStreamIdRef.current = streamId
          // streamingPersona 已在 runOne 最顶部 setState（第一次 await 之前）
          let fullText = ''
          let wasAborted = false
          const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
            if (sid === streamId) { fullText += chunk; flushStreamingText(fullText) }
          })
          try {
            // Batch 43 · 透传 effort + webSearch（让历史名家辩论前能查 2026 时事）
            const res = await window.electronAPI.aiChatStream(streamId, agentModel, llmMessages, { effort: aiReasoningEffort, webSearch: aiWebSearch })
            if (res.aborted) {
              // 2026-04-25 · abort 时不抛错：保留 fullText（已流式到的内容），
              // 标记 wasAborted 让外层循环 break。用户看到部分输出 + "（已中断）"
              // 标尾，而不是"（孔子: 已取消）"这种全量覆盖。
              wasAborted = true
            } else if (!res.success) {
              throw new Error(res.error || 'AI 调用失败')
            } else if (res.text) {
              fullText = res.text
            }
          } finally { cleanup(); currentStreamIdRef.current = null }
          const finalContent = wasAborted
            ? (fullText ? fullText + '\n\n*（已中断）*' : '*（已中断）*')
            : fullText
          const assistantMsg: AgentMessage = {
            id: uuid(),
            role: 'assistant',
            content: finalContent,
            timestamp: new Date().toISOString(),
            personaAtMoment: persona,
            debateRound,
          }
          workingMessages = [...workingMessages, assistantMsg]
          const nextConv: AgentConversation = { ...conv!, messages: workingMessages, updatedAt: new Date().toISOString() }
          conv = nextConv
          setActiveConv(nextConv)
          setConversations(prev => prev.map(c => c.id === nextConv.id ? nextConv : c))
          clearStreamingText()
          // aborted 时返回 false 让外层 break，其他学者不继续发言
          return !wasAborted
        } catch (err: any) {
          // Batch 43 · 多人召唤 inner catch 也走 humanize（之前裸显 err.message
          // 用户看到 "fetch failed" / "Model Not Exist" 这种字符串）
          const h = humanizeAiError(err)
          const errText = h.silent
            ? '已中断'
            : (h.hint ? `${h.message}（${h.hint}）` : h.message)
          const errMsg: AgentMessage = {
            id: uuid(),
            role: 'assistant',
            content: `（${persona.name}：${errText}）`,
            timestamp: new Date().toISOString(),
            personaAtMoment: persona,
          }
          workingMessages = [...workingMessages, errMsg]
          const nextConv: AgentConversation = { ...conv!, messages: workingMessages, updatedAt: new Date().toISOString() }
          conv = nextConv
          setActiveConv(nextConv)
          return false
        }
      }

      // 执行：辩论 N 轮 or 圆桌 1 轮（N 从 conv.debateRounds 读，用户可在辩论卡片调）
      const configuredRounds = Math.min(
        DEBATE_ROUNDS_MAX,
        Math.max(DEBATE_ROUNDS_MIN, conv.debateRounds || DEBATE_ROUNDS_DEFAULT),
      )
      const rounds = debateMode ? configuredRounds : 1
      // 2026-04-25 · runOne 返回 false（中断 / 错误）时立刻 break —— 避免"孔子被
      // 中断、柏拉图还在继续说"的混乱。runOne 内部已经把错误/中断消息写进 messages。
      outer: for (let r = 1; r <= rounds; r++) {
        for (const persona of respondents) {
          // Batch 43: 把 totalRounds 也传进去让 runOne 判断"最终轮"
          const ok = await runOne(persona, debateMode ? r : undefined, debateMode ? rounds : undefined)
          if (!ok) break outer
        }
      }

      // 最终存盘（单独 try，存盘失败不该阻塞 streaming 重置）
      try {
        if (conv) {
          await window.electronAPI.agentSaveConversation(conv)
        }
      } catch (saveErr) {
        console.error('[summon] 存盘失败', saveErr)
      }
      } catch (err) {
        // 多人召唤分支的兜底：即使 runOne 外部 throw，也要让 UI 恢复可点
        console.error('[summon] 未捕获异常', err)
      } finally {
        setStreamingPersona(null)
        clearStreamingText()
        setStreaming(false)
      }
      return
    }

    // ===== Hermes mode (no summon, default "学徒" agent with ReAct + tools) =====
    try {
      const systemPrompt = buildAgentSystemPrompt(buildContext())

      const llmMessages: Array<{ role: string; content: string }> = [{ role: 'system', content: systemPrompt }]
      for (const msg of workingMessages) {
        if (msg.role === 'user') llmMessages.push({ role: 'user', content: msg.content })
        else if (msg.role === 'assistant') llmMessages.push({ role: 'assistant', content: msg.content })
        else if (msg.role === 'tool_result') llmMessages.push({ role: 'user', content: `<tool_result name="${msg.toolName}">${msg.content}</tool_result>` })
      }

      let maxIter = 5, finalResponse = ''
      while (maxIter-- > 0) {
        const streamId = uuid()
        currentStreamIdRef.current = streamId
        let fullText = ''
        clearStreamingText()
        const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => { if (sid === streamId) { fullText += chunk; flushStreamingText(fullText) } })
        // Batch 43 · 透传 effort + webSearch
        try { await window.electronAPI.aiChatStream(streamId, agentModel, llmMessages, { effort: aiReasoningEffort, webSearch: aiWebSearch }) } finally { cleanup(); currentStreamIdRef.current = null }
        clearStreamingText()
        if (!fullText) { finalResponse = ''; break }

        if (hasToolCalls(fullText)) {
          for (const call of parseToolCalls(fullText)) {
            setToolStatus(`${call.toolName}...`)
            const result = await executeTool(call.toolName, call.argsJson, storeHelpers)
            workingMessages.push(
              { id: uuid(), role: 'tool_call', content: call.argsJson, toolName: call.toolName, toolArgs: call.argsJson, timestamp: new Date().toISOString() },
              { id: uuid(), role: 'tool_result', content: result, toolName: call.toolName, timestamp: new Date().toISOString() },
            )
            llmMessages.push({ role: 'assistant', content: fullText }, { role: 'user', content: `<tool_result name="${call.toolName}">${result}</tool_result>` })
          }
          setToolStatus('')
          continue
        }
        finalResponse = fullText
        break
      }
      setToolStatus('')

      const memUpdate = extractMemoryUpdate(finalResponse)
      if (memUpdate) {
        const newMem = memory ? `${memory}\n\n---\n\n${memUpdate}` : memUpdate
        setMemory(newMem)
        await window.electronAPI.agentSaveMemory(newMem)
        invalidateAgentMemoryCache()  // 让其他读 memory 的组件 re-fetch 到最新
      }

      const cleaned = cleanResponse(finalResponse)
      // Hermes 回复没有 persona（学徒默认），personaAtMoment 不刻
      const finalMessages = [...workingMessages, { id: uuid(), role: 'assistant' as const, content: cleaned, timestamp: new Date().toISOString() }]
      const finalConv: AgentConversation = { ...conv, messages: finalMessages, updatedAt: new Date().toISOString() }
      setActiveConv(finalConv)
      setConversations(prev => prev.map(c => c.id === finalConv.id ? finalConv : c))
      await window.electronAPI.agentSaveConversation(finalConv)
    } catch (err: any) {
      // Batch 43: humanize raw API errors for friendlier display in chat bubble
      const h = humanizeAiError(err)
      const errText = h.silent
        ? '（已中断）'
        : (h.hint ? `${h.message}（${h.hint}）` : h.message)
      setActiveConv({ ...conv, messages: [...workingMessages, { id: uuid(), role: 'assistant', content: `Agent 出错：${errText}`, timestamp: new Date().toISOString() }] })
    }
    setStreaming(false)
  }, [input, streaming, activeConv, agentModel, memory, buildContext, storeHelpers, aiReasoningEffort, aiWebSearch])

  // 2026-04-24 PERF · 4 个 apprentice useCallback 全删（~160 行）
  // 对应 UI 早已移除，dead code 不再占 bundle / render 预算。
  // 想把功能港成 skill 时从 git 历史找（这次 commit 之前的版本）。

  // Skill CRUD (saveSkill / deleteSkill / toggleSkill) and the Skills tab UI
  // were removed in batch 28. See the note at the top of this file for why.

  // ===== Render helpers =====
  // 2026-04-25 PERF · useMemo 缓存过滤结果 —— 之前每次 render 都重新 filter
  // （streaming chunk 高频触发 render，每次都 O(n) 扫描所有消息）
  const displayMessages = useMemo(
    () => activeConv?.messages.filter(m => m.role === 'user' || m.role === 'assistant') || [],
    [activeConv?.messages],
  )
  // behaviorCount was only used by the removed Insights tab (batch 29)

  const tabStyle = (t: PanelTab) => ({
    flex: 1, padding: '8px 0', fontSize: 11, fontWeight: tab === t ? 600 : 400,
    letterSpacing: tab === t ? '1px' : '0.5px',
    border: 'none', borderBottom: tab === t ? '1.5px solid var(--accent)' : '1.5px solid transparent',
    background: 'none', color: tab === t ? 'var(--accent-hover)' : 'var(--text-muted)',
    cursor: 'pointer', transition: 'color 220ms cubic-bezier(0.4, 0, 0.2, 1), border-color 220ms cubic-bezier(0.4, 0, 0.2, 1), letter-spacing 220ms cubic-bezier(0.4, 0, 0.2, 1)',
  })

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg)',
      width: panelWidth, flexShrink: 0,
      position: 'relative',
      borderLeft: '1px solid var(--border-light)',
    }}>
      {/* Resize handle — 4px invisible strip on the left edge; 1px visible
          border above gives the visual separation. Hover shows the col-resize
          cursor. Active drag is handled via document-level mouse events in
          handleResizeMouseDown so the cursor stays even if you drag off the strip. */}
      <div
        onMouseDown={handleResizeMouseDown}
        title="拖动调整面板宽度"
        style={{
          position: 'absolute', top: 0, bottom: 0, left: -3,
          width: 7, cursor: 'col-resize',
          zIndex: 10,
        }}
      />
      {/* Header */}
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border-light)', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', letterSpacing: '0.6px' }}>学徒</span>
        {/* Batch 43 · 自定义 ModelSelector：按厂商可折叠，默认仅当前 provider 展开 */}
        <ModelSelector
          value={agentModel}
          onChange={(next) => {
            setAgentModel(next)
            try { localStorage.setItem('sj-agentModel', next) } catch { /* ignore */ }
          }}
          groups={configuredProviders}
          size="sm"
        />
        {/* Batch 43 · effort 控件：仅当当前 model 支持 thinking 时显示 */}
        {effortSupported && (
          <select
            value={aiReasoningEffort}
            onChange={e => setAiReasoningEffort(e.target.value as 'low' | 'medium' | 'high')}
            title="思考强度（仅支持 reasoning 的模型生效）"
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            onMouseEnter={e => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderColor = 'var(--accent-soft, rgba(200,149,108,0.35))' }}
            onMouseLeave={e => { if (document.activeElement !== e.currentTarget) e.currentTarget.style.borderColor = 'var(--border)' }}
            style={{ flexShrink: 0, padding: '3px 5px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 5, outline: 'none', background: 'var(--bg)', color: 'var(--text-secondary)', cursor: 'pointer', transition: 'border-color 180ms cubic-bezier(0.4, 0, 0.2, 1)' }}
          >
            <option value="low">思考·低</option>
            <option value="medium">思考·中</option>
            <option value="high">思考·高</option>
          </select>
        )}
        {/* Batch 43 · 联网搜索开关 —— 让 persona 辩论前可先查 2026 时事
            仅当前 provider 原生支持 web search 时可点 (GLM/Claude/Kimi/Gemini)；
            其他 provider (OpenAI/DeepSeek/豆包) 灰掉 + tooltip 提示原因 */}
        {(() => {
          const effective = aiWebSearch && webSearchSupported  // 实际生效状态
          // 2026-04-28 · 付费 provider(GLM/Claude)的 web search 是单独计费的工具,
          //   tooltip 明确警告;免费/包含在 token 里的(Kimi/manual loop)不警告。
          const paidWarn = webSearchIsPaid
            ? '\n⚠ 该 provider 联网调用付费工具(如 GLM web_search_pro 约 ¥0.03/次, Claude web_search 约 $0.01/次),会从你的 provider 账户扣费'
            : ''
          const tip = !webSearchSupported
            ? '当前 provider 不支持联网搜索（仅 Ollama / Claude CLI 不支持，请切换 provider）'
            : (effective
                ? '已开启联网搜索：persona 辩论前可查时事 / 实时信息（关闭可省 quota）' + paidWarn
                : '点击开启联网搜索 —— 历史名家不了解 2026 时事，开启后可让 AI 先搜真实信息再辩论' + paidWarn)
          return (
            <button
              type="button"
              disabled={!webSearchSupported}
              onClick={() => { if (webSearchSupported) setAiWebSearch(!aiWebSearch) }}
              title={tip}
              style={{
                flexShrink: 0,
                padding: '3px 8px',
                fontSize: 10,
                border: `1px solid ${effective ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 5,
                outline: 'none',
                background: effective ? 'var(--accent)' : 'var(--bg)',
                color: effective ? '#fff' : (webSearchSupported ? 'var(--text-secondary)' : 'var(--text-muted)'),
                cursor: webSearchSupported ? 'pointer' : 'not-allowed',
                opacity: webSearchSupported ? 1 : 0.5,
                transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1), color 180ms, border-color 180ms, opacity 180ms',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
              }}
              onMouseEnter={e => { if (webSearchSupported && !effective) e.currentTarget.style.borderColor = 'var(--accent-soft, rgba(200,149,108,0.35))' }}
              onMouseLeave={e => { if (webSearchSupported && !effective) e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              <span style={{ fontSize: 11 }}>🌐</span>
              <span>{effective ? '联网·开' : '联网'}</span>
            </button>
          )
        })()}
        {/* 2026-04-24 · 退出按钮 · 完全折叠右栏（不弹注释面板） */}
        <button
          onClick={() => {
            // 直接折叠整个右栏 —— 退出学徒就是退出，不替换成别的面板。
            // 把 rightPanel 切回 'annotation' 是为了下次展开时默认落在注释（而不是还停在 agent）。
            useUiStore.setState({ annotationPanelCollapsed: true, rightPanel: 'annotation' })
          }}
          title="退出学徒（折叠右栏）"
          style={{
            padding: '3px 6px', flexShrink: 0,
            background: 'none', border: 'none',
            color: 'var(--text-muted)', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center',
            borderRadius: 4,
            transition: 'color 180ms cubic-bezier(0.4, 0, 0.2, 1), background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Tab bar — 2026-04-24 合并方案 A：移除"观察"tab（功能迁到对话输入栏的 ✍ 按钮）。
          保留"对话 / 召唤"两个 tab。"观察" view body 仍能通过 `tab === 'apprentice'`
          渲染，由对话工具栏的 ✍ 和 📖 按钮触发 setTab('apprentice') 进入。 */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
        <button style={tabStyle('chat')} onClick={() => setTab('chat')}>对话</button>
        {/* 召唤 tab — enabled 2026-04-24. Persona system prompt loads a single
            SKILL.md (~15-25 KB / ~10-15K tokens) + optional RAG chunk injection
            on each turn. Works on any 64K+ context model. */}
        <button
          style={{ ...tabStyle('personas'), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
          onClick={() => setTab('personas')}
          title="召唤一个人物 persona 与你对话"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.55L12 14.77 7.06 17.45 8 11.9 4 8l5.61-1.16L12 2z"/>
          </svg>
          召唤
        </button>
      </div>

      {/* ===== Tab: Chat ·全页历史对话视图（从下拉"查看更多"进） ===== */}
      {tab === 'chat' && showHistoryFullPage && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
          {/* Header */}
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid var(--border-light)',
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          }}>
            <button
              onClick={() => setShowHistoryFullPage(false)}
              style={{
                padding: '5px 7px', fontSize: 11,
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)',
                display: 'inline-flex', alignItems: 'center',
                borderRadius: 4,
                transition: 'color 180ms cubic-bezier(0.4, 0, 0.2, 1), background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}
              title="返回对话（Esc）"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', fontFamily: 'var(--font-serif)', letterSpacing: '1.2px' }}>
              历史对话
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
              共 {conversations.length} 条
            </span>
          </div>
          {/* List — 2026-04-24 用户反馈：稍小一点 + 轻微边框
              每行改成"卡片式"：padding 压缩 10/16 → 7/11，字号 13/11/10 → 12/10.5/9.5，
              加一层 1px border-light 边框 + 4px radius + 行距 4px，整体更紧凑、有书页感。 */}
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px' }}>
            {conversations.length === 0 ? (
              <div style={{ padding: '48px 16px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                还没有对话记录
              </div>
            ) : conversations.map(c => {
              const isActive = c.id === activeConv?.id
              const preview = c.messages.find(m => m.role === 'user')?.content.slice(0, 60) || '（空对话）'
              return (
                <div
                  key={c.id}
                  onClick={() => {
                    // Batch 43 · 切到别的历史对话前 abort 流式 + 清残留
                    handleStopStream()
                    setActiveConv(c)
                    setShowHistoryFullPage(false)
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'var(--bg-warm, #FBF8F1)'
                      e.currentTarget.style.borderColor = 'var(--border)'
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.borderColor = 'var(--border-light)'
                    }
                  }}
                  style={{
                    padding: '7px 11px', cursor: 'pointer',
                    marginBottom: 4,
                    border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border-light)'}`,
                    borderLeft: isActive ? '3px solid var(--accent)' : '1px solid var(--border-light)',
                    borderRadius: 4,
                    background: isActive ? 'var(--accent-soft)' : 'transparent',
                    transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1), border-color 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, color: isActive ? 'var(--accent-hover)' : 'var(--text)',
                      fontWeight: isActive ? 500 : 400,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      marginBottom: 2,
                    }}>{c.title}</div>
                    <div style={{
                      fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.4,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{preview}</div>
                    <div style={{ fontSize: 9.5, color: 'var(--text-faint, #A89B8C)', marginTop: 2 }}>
                      {c.messages.length} 条 · {formatTimeAgo(c.updatedAt)}
                      {c.summonedPersonaName && <span style={{ marginLeft: 8, color: 'var(--accent)' }}>🧙 {c.summonedPersonaName}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteConversation(c.id) }}
                    title="删除"
                    style={{
                      padding: '4px 8px', fontSize: 13, lineHeight: 1,
                      background: 'none', border: 'none', color: 'var(--text-muted)',
                      cursor: 'pointer', opacity: 0.4, borderRadius: 3,
                      transition: 'opacity 180ms, color 180ms, background 180ms',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.background = 'rgba(201,112,112,0.08)' }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '0.4'; e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'none' }}
                  >×</button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ===== Tab: Chat ===== */}
      {tab === 'chat' && !showHistoryFullPage && (
        <>
          {/* 2026-04-24 合并方案 A v2 · 顶部左上角操作栏
              替代原来的横向 pill tabs。[+ 新对话] [历史对话 ▾] */}
          <div style={{
            padding: '6px 10px', borderBottom: '1px solid var(--border-light)',
            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            background: 'var(--bg)',
          }}>
            <button
              onClick={handleNewConversation}
              title="新对话"
              style={{
                padding: '4px 10px', fontSize: 11,
                background: 'none', border: '1px solid var(--border)',
                borderRadius: 5, cursor: 'pointer', color: 'var(--text-muted)',
                display: 'inline-flex', alignItems: 'center', gap: 4,
                transition: 'border-color 180ms cubic-bezier(0.4, 0, 0.2, 1), color 180ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              新对话
            </button>
            <div ref={historyPopoverRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                onClick={() => setHistoryPopoverOpen(v => !v)}
                title={conversations.length === 0 ? '还没有对话历史' : `历史对话（共 ${conversations.length} 条）`}
                disabled={conversations.length === 0}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: historyPopoverOpen ? 'var(--accent-soft)' : 'none',
                  border: `1px solid ${historyPopoverOpen ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 5,
                  cursor: conversations.length === 0 ? 'not-allowed' : 'pointer',
                  color: historyPopoverOpen ? 'var(--accent-hover)' : 'var(--text-muted)',
                  opacity: conversations.length === 0 ? 0.5 : 1,
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  transition: 'border-color 180ms cubic-bezier(0.4, 0, 0.2, 1), color 180ms cubic-bezier(0.4, 0, 0.2, 1), background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                }}
                onMouseEnter={e => { if (!historyPopoverOpen && conversations.length > 0) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' } }}
                onMouseLeave={e => { if (!historyPopoverOpen) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' } }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
                历史对话
                {conversations.length > 0 && <span style={{ fontSize: 9, opacity: 0.7, fontWeight: 400 }}>{conversations.length}</span>}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ transform: historyPopoverOpen ? 'rotate(180deg)' : 'none', transition: 'transform 180ms cubic-bezier(0.4, 0, 0.2, 1)' }}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </button>
              {historyPopoverOpen && conversations.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 6,
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 8, boxShadow: '0 10px 28px rgba(58,47,31,0.14), 0 2px 6px rgba(58,47,31,0.06)',
                  minWidth: 220, maxWidth: 320, zIndex: 100,
                  padding: '6px 0',
                  animation: 'sj-pop-in 0.16s cubic-bezier(.2,.9,.3,1.2)',
                }}>
                  <div style={{ fontSize: 10, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--text-faint, #A89B8C)', padding: '8px 14px 6px', fontWeight: 500 }}>
                    最近对话
                  </div>
                  {conversations.slice(0, 5).map(c => {
                    const isActive = c.id === activeConv?.id
                    return (
                      <div
                        key={c.id}
                        onClick={() => {
                          // Batch 43 · 同 handleNewConversation：切对话前 abort 流式
                          handleStopStream()
                          setActiveConv(c)
                          setHistoryPopoverOpen(false)
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm, #FBF8F1)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        style={{
                          padding: '7px 14px', cursor: 'pointer',
                          background: 'transparent',
                          borderLeft: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                          transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                          display: 'flex', alignItems: 'center', gap: 8,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 12, color: isActive ? 'var(--accent-hover)' : 'var(--text)',
                            fontWeight: isActive ? 500 : 400,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>{c.title}</div>
                          <div style={{
                            fontSize: 9.5, color: 'var(--text-muted)', marginTop: 1,
                            opacity: 0.8,
                          }}>
                            {c.messages.length} 条 · {formatTimeAgo(c.updatedAt)}
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteConversation(c.id) }}
                          title="删除"
                          style={{
                            padding: '2px 6px', fontSize: 12, lineHeight: 1,
                            background: 'none', border: 'none', color: 'var(--text-muted)',
                            cursor: 'pointer', opacity: 0.5, borderRadius: 3,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--danger)' }}
                          onMouseLeave={e => { e.currentTarget.style.opacity = '0.5'; e.currentTarget.style.color = 'var(--text-muted)' }}
                        >×</button>
                      </div>
                    )
                  })}
                  {conversations.length > 5 && (
                    <div style={{ borderTop: '1px solid var(--border-light)', marginTop: 4 }}>
                      <button
                        onClick={() => { setHistoryPopoverOpen(false); setShowHistoryFullPage(true) }}
                        style={{
                          width: '100%', padding: '8px 14px', fontSize: 11,
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--accent)', textAlign: 'left',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          transition: 'background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm, #FBF8F1)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <span>查看更多历史对话（{conversations.length}）</span>
                        <span style={{ fontSize: 10 }}>→</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div ref={messagesScrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px', position: 'relative' }}>
            {displayMessages.length === 0 && !streaming && (
              <div style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>问学徒任何关于你的研究的问题</div>
                <div style={{ fontSize: 11 }}>「我最近在读什么？」「帮我整理这个主题的笔记」</div>
              </div>
            )}

            {/* 2026-04-24 · assistant 消息带头像（按 msg.personaAtMoment 刻印的人物）
                 严格按刻印渲染 —— 切换召唤人物不影响历史消息。
                 旧消息（2026-04-24 之前发的、没有 personaAtMoment）→ 显示为"学徒"默认头像。
                 user 消息不带头像（右对齐就能看出是"我"） */}
            {displayMessages.map(msg => {
              const persona = msg.personaAtMoment
              const portraitSrc = persona ? (portraitCache[persona.id] || null) : null
              return <MessageBubble key={msg.id} msg={msg} portraitSrc={portraitSrc} />
            })}

            {streaming && (() => {
              // 流式消息用"当前正在说话的人物"（多人模式下逐位切换；单人/无人则 fallback 到 conv 的主召唤）
              // 2026-04-25 · 改用 state（streamingPersona）替代 ref —— ref 不触发重渲染，
              // 导致 runOne 前期 await 期间 UI 仍用上一位的头像。
              const pid = streamingPersona?.id || activeConv?.summonedPersonaId
              const pname = streamingPersona?.name || activeConv?.summonedPersonaName
              const portraitSrc = pid ? portraitCache[pid] : null
              return (
                <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  {pid && portraitSrc ? (
                    <img
                      src={portraitSrc}
                      alt={pname || '召唤人物'}
                      loading="lazy"
                      decoding="async"
                      style={{
                        width: 30, height: 30, borderRadius: '50%',
                        objectFit: 'cover', flexShrink: 0,
                        border: '1px solid var(--accent)',
                      }}
                    />
                  ) : (
                    <div style={{
                      width: 30, height: 30, borderRadius: '50%',
                      background: 'var(--bg-warm)', border: '1px solid var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
                        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                      </svg>
                    </div>
                  )}
                  <div style={{ maxWidth: 'calc(100% - 46px)', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <div style={{
                      fontSize: 10.5, color: 'var(--text-muted)',
                      marginBottom: 3, marginLeft: 2, letterSpacing: '0.3px',
                    }}>
                      {pname || '学徒'}
                    </div>
                    {toolStatus && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}><span className="loading-spinner" style={{ width: 10, height: 10 }} />{toolStatus}</div>}
                    <div style={{ padding: '8px 12px', borderRadius: 10, background: 'var(--bg-warm)', border: '1px solid var(--border-light)', borderTopLeftRadius: 2, fontSize: 13, lineHeight: 1.7 }}>
                      {streamingText ? <><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{cleanResponse(streamingText)}</ReactMarkdown><span className="streaming-cursor" /></> : <span style={{ color: 'var(--text-muted)' }}>{toolStatus ? '处理中...' : '思考中...'}</span>}
                    </div>
                  </div>
                </div>
              )
            })()}
            <div ref={messagesEndRef} />
            {/* 2026-04-25 · 回到最新 浮标 —— 用户上翻看历史时浮在右下，
                流式生成中仍保留，点击滑回底部。粘底时不显示。 */}
            {showJumpToBottom && (
              <button
                onClick={jumpToBottom}
                title="回到最新"
                style={{
                  position: 'sticky', bottom: 8, marginLeft: 'auto', marginRight: 4,
                  display: 'flex', float: 'right',
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'var(--accent)', color: '#fff',
                  border: '1px solid var(--accent-hover)',
                  boxShadow: '0 3px 10px rgba(58,47,31,0.2)',
                  cursor: 'pointer',
                  alignItems: 'center', justifyContent: 'center',
                  zIndex: 20, opacity: 0.85,
                  transition: 'opacity 180ms cubic-bezier(0.4, 0, 0.2, 1), transform 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'translateY(-1px)' }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '0.85'; e.currentTarget.style.transform = 'none' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
            )}
          </div>

          {/* 2026-04-24 原"正以 X 视角对话"横幅已移除——召唤身份通过底部按钮显示人物名
              + 输入框 placeholder"问 X..."来表达，不再占一整行横幅。 */}

          {/* Summon menu — expanded on click of the 召唤 button. Lists existing
              personas (distilled / imported only; legacy skipped since they
              have no skill artifact). Selecting one sets this conv's
              summonedPersonaId + saves. */}
          {showSummonMenu && (() => {
            const summoned = getSummoned(activeConv)
            const summonedIds = new Set(summoned.map(s => s.id))
            const atCap = summoned.length >= MAX_SUMMONED
            const toggleSummon = async (p: { id: string; name: string; canonicalName?: string }) => {
              const displayName = p.canonicalName || p.name
              let next: Array<{ id: string; name: string }>
              if (summonedIds.has(p.id)) {
                next = summoned.filter(s => s.id !== p.id)
              } else {
                if (atCap) return
                next = [...summoned, { id: p.id, name: displayName }]
              }
              if (!activeConv) {
                const freshConv: AgentConversation = {
                  id: uuid(), title: next[0] ? `召唤 ${next[0].name}` : '新对话', messages: [],
                  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                }
                const withSum = withSummoned(freshConv, next)
                setConversations(prev => [withSum, ...prev])
                setActiveConv(withSum)
                await window.electronAPI.agentSaveConversation(withSum)
              } else {
                const updated = withSummoned(activeConv, next)
                setActiveConv(updated)
                setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
                await window.electronAPI.agentSaveConversation(updated)
              }
            }
            const toggleDebate = async () => {
              if (!activeConv || summoned.length < 2) return
              const updated: AgentConversation = { ...activeConv, debateMode: !activeConv.debateMode, updatedAt: new Date().toISOString() }
              setActiveConv(updated)
              setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
              await window.electronAPI.agentSaveConversation(updated)
            }
            // 2026-04-25 · 辩论轮数调节 （仅辩论模式开启时可调）
            const adjustRounds = async (delta: number) => {
              if (!activeConv || !activeConv.debateMode) return
              const cur = activeConv.debateRounds || DEBATE_ROUNDS_DEFAULT
              const next = Math.min(DEBATE_ROUNDS_MAX, Math.max(DEBATE_ROUNDS_MIN, cur + delta))
              if (next === cur) return
              const updated: AgentConversation = { ...activeConv, debateRounds: next, updatedAt: new Date().toISOString() }
              setActiveConv(updated)
              setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
              await window.electronAPI.agentSaveConversation(updated)
            }
            const clearAll = async () => {
              if (!activeConv) return
              const updated = withSummoned({ ...activeConv, debateMode: false }, [])
              setActiveConv(updated)
              setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
              await window.electronAPI.agentSaveConversation(updated)
              setShowSummonMenu(false)
            }
            return (
            <div style={{
              margin: '0 12px', marginBottom: 4,
              padding: '8px 10px',
              background: 'var(--bg-warm)', border: '1px solid var(--border)', borderRadius: 6,
              maxHeight: 320, overflowY: 'auto',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginBottom: 6,
              }}>
                {/* 2026-04-24 左上角回退符 · 替代底部的"关闭"按钮 */}
                <button
                  onClick={() => setShowSummonMenu(false)}
                  title="收起"
                  style={{
                    padding: '2px 5px', fontSize: 11,
                    background: 'none', border: 'none',
                    color: 'var(--text-muted)', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center',
                    borderRadius: 3, flexShrink: 0,
                    transition: 'color 180ms cubic-bezier(0.4, 0, 0.2, 1), background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent' }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>
                  {summoned.length > 0 ? (
                    <>
                      当前召唤（{summoned.length}/{MAX_SUMMONED}）：
                      <span style={{ color: 'var(--accent-hover)', fontWeight: 600 }}>
                        {summoned.map(s => s.name).join(' · ')}
                      </span>
                    </>
                  ) : (
                    <span style={{ fontSize: 10 }}>可召唤最多 {MAX_SUMMONED} 位名家 · 多人时可开辩论模式</span>
                  )}
                </div>
                {/* 全部取消 · 仅当前会话有召唤人物时显示 */}
                {summoned.length > 0 && (
                  <button
                    onClick={clearAll}
                    style={{
                      padding: '2px 8px', fontSize: 10,
                      border: '1px solid var(--accent)', borderRadius: 3,
                      background: 'transparent', color: 'var(--accent)',
                      cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    全部取消
                  </button>
                )}
              </div>

              {/* 辩论模式开关 + 轮数调节 · 2+ 人时显示 */}
              {summoned.length >= 2 && (() => {
                const debateOn = !!activeConv?.debateMode
                const rounds = activeConv?.debateRounds || DEBATE_ROUNDS_DEFAULT
                const canDec = debateOn && rounds > DEBATE_ROUNDS_MIN
                const canInc = debateOn && rounds < DEBATE_ROUNDS_MAX
                return (
                  <div style={{
                    padding: '6px 10px', marginBottom: 6,
                    background: debateOn ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${debateOn ? 'var(--accent)' : 'var(--border-light)'}`,
                    borderRadius: 4,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>
                        <strong style={{ color: debateOn ? 'var(--accent-hover)' : 'var(--text)' }}>
                          {debateOn ? '⚔ 辩论模式 · 开' : '☐ 辩论模式'}
                        </strong>
                        <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 2 }}>
                          {debateOn
                            ? `你问一次 → ${rounds} 轮交锋（每位说 ${rounds} 次）`
                            : '关 · 每次各自独立回答一次（圆桌）'}
                        </div>
                      </div>
                      <button
                        onClick={toggleDebate}
                        style={{
                          padding: '3px 10px', fontSize: 10, flexShrink: 0,
                          border: `1px solid ${debateOn ? 'var(--accent)' : 'var(--border)'}`,
                          borderRadius: 3,
                          background: debateOn ? 'var(--accent)' : 'transparent',
                          color: debateOn ? '#fff' : 'var(--text-muted)',
                          cursor: 'pointer',
                        }}
                      >
                        {debateOn ? '关闭' : '开启'}
                      </button>
                    </div>
                    {/* 轮数调节 · 仅辩论开启时显示 */}
                    {debateOn && (
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        marginTop: 6, paddingTop: 6,
                        borderTop: '1px dashed var(--border-light)',
                      }}>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>交锋轮数</span>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <button
                            onClick={() => adjustRounds(-1)}
                            disabled={!canDec}
                            title={canDec ? '减少一轮' : `最少 ${DEBATE_ROUNDS_MIN} 轮`}
                            style={{
                              width: 20, height: 20, fontSize: 12, lineHeight: 1,
                              border: `1px solid ${canDec ? 'var(--accent)' : 'var(--border-light)'}`,
                              borderRadius: 3,
                              background: canDec ? 'transparent' : 'var(--bg-warm)',
                              color: canDec ? 'var(--accent)' : 'var(--text-faint)',
                              cursor: canDec ? 'pointer' : 'not-allowed',
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              padding: 0,
                            }}
                          >−</button>
                          <span style={{
                            minWidth: 22, textAlign: 'center',
                            fontSize: 12, fontWeight: 600, color: 'var(--accent-hover)',
                          }}>{rounds}</span>
                          <button
                            onClick={() => adjustRounds(1)}
                            disabled={!canInc}
                            title={canInc ? '增加一轮' : `最多 ${DEBATE_ROUNDS_MAX} 轮`}
                            style={{
                              width: 20, height: 20, fontSize: 12, lineHeight: 1,
                              border: `1px solid ${canInc ? 'var(--accent)' : 'var(--border-light)'}`,
                              borderRadius: 3,
                              background: canInc ? 'transparent' : 'var(--bg-warm)',
                              color: canInc ? 'var(--accent)' : 'var(--text-faint)',
                              cursor: canInc ? 'pointer' : 'not-allowed',
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              padding: 0,
                            }}
                          >+</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}

              {personaList.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '6px 0' }}>
                  还没有蒸馏好的 skill——先去「召唤」tab 蒸馏一位名家。
                </div>
              )}
              {/* 2026-04-25 · 行紧凑化 —— 之前 identity 介绍占第二行让 popover 太长。
                  改成单行（identity 移到 title hover），padding 收紧。 */}
              {personaList.map(p => {
                const isSelected = summonedIds.has(p.id)
                const disabled = !isSelected && atCap
                const displayName = p.canonicalName || p.name
                return (
                  <div key={p.id}
                       onClick={() => { if (!disabled) void toggleSummon(p) }}
                       title={p.identity || displayName}
                       style={{
                         padding: '4px 8px', marginBottom: 2, borderRadius: 4,
                         cursor: disabled ? 'not-allowed' : 'pointer',
                         background: isSelected ? 'var(--accent-soft)' : 'var(--bg)',
                         border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border-light)'}`,
                         borderLeft: isSelected ? '3px solid var(--accent)' : '1px solid var(--border-light)',
                         fontSize: 11,
                         opacity: disabled ? 0.4 : 1,
                         display: 'flex', alignItems: 'center', gap: 8,
                         transition: 'border-color 180ms cubic-bezier(0.4, 0, 0.2, 1), background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                       }}
                       onMouseEnter={e => { if (!isSelected && !disabled) e.currentTarget.style.borderColor = 'var(--accent)' }}
                       onMouseLeave={e => { if (!isSelected) e.currentTarget.style.borderColor = 'var(--border-light)' }}>
                    {/* checkbox-style 选中指示 */}
                    <div style={{
                      width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                      border: `1.5px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                      background: isSelected ? 'var(--accent)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isSelected && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="4 12 10 18 20 6"/>
                        </svg>
                      )}
                    </div>
                    <div style={{
                      flex: 1, minWidth: 0,
                      fontWeight: isSelected ? 600 : 500,
                      color: isSelected ? 'var(--accent-hover)' : 'var(--text)',
                      display: 'flex', alignItems: 'center', gap: 6,
                      overflow: 'hidden',
                    }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {displayName}
                      </span>
                      {typeof p.currentFitnessTotal === 'number' && (
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 8,
                          background: p.currentFitnessTotal >= 40 ? 'var(--success)' : 'var(--warning)',
                          color: '#fff', flexShrink: 0,
                        }}>
                          {p.currentFitnessTotal}%
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
              {atCap && (
                <div style={{ fontSize: 10, color: 'var(--text-faint)', textAlign: 'center', marginTop: 6, fontStyle: 'italic' }}>
                  已达上限（{MAX_SUMMONED} 位）· 先取消一位再加
                </div>
              )}
              {summoned.length > 0 && (
                <div style={{ fontSize: 9.5, color: 'var(--text-faint)', textAlign: 'center', marginTop: 6, letterSpacing: '0.3px' }}>
                  💡 消息里用 @{summoned[0].name} 指定单人回答 · 否则所有召唤者轮流
                </div>
              )}
            </div>
            )
          })()}

          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-light)', flexShrink: 0, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            {/* 2026-04-24 召唤按钮 · 多重召唤版
                未召唤显示 "☆ 召唤"；1 人显示名字；2-3 人显示"孔子·墨子 (+1)"或省略号
                辩论模式加 ⚔ 前缀标记 */}
            {(() => {
              const sum = getSummoned(activeConv)
              const label = sum.length === 0
                ? '召唤'
                : sum.length === 1
                  ? sum[0].name
                  : `${sum[0].name} +${sum.length - 1}`
              const hasAny = sum.length > 0
              const debate = hasAny && activeConv?.debateMode
              return (
                <button
                  onClick={() => { setShowSummonMenu(!showSummonMenu); refreshPersonaList() }}
                  style={{
                    padding: '6px 10px',
                    background: hasAny ? 'var(--accent-soft)' : 'none',
                    border: `1px solid ${hasAny ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 6, cursor: 'pointer',
                    color: hasAny ? 'var(--accent-hover)' : 'var(--text-muted)',
                    flexShrink: 0, fontSize: 11,
                    fontWeight: hasAny ? 500 : 400,
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    maxWidth: 180,
                    transition: 'border-color 180ms cubic-bezier(0.4, 0, 0.2, 1), color 180ms cubic-bezier(0.4, 0, 0.2, 1), background 180ms cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                  onMouseEnter={e => { if (!hasAny) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' } }}
                  onMouseLeave={e => { if (!hasAny) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' } }}
                  title={hasAny ? `召唤中：${sum.map(s => s.name).join(' · ')}${debate ? '（辩论模式）' : ''}` : '召唤一位或多位名家（最多 3）'}>
                  {debate ? (
                    <span style={{ fontSize: 11, flexShrink: 0 }}>⚔</span>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.55L12 14.77 7.06 17.45 8 11.9 4 8l5.61-1.16L12 2z"/>
                    </svg>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                </button>
              )
            })()}
            {/* 2026-04-24 ✍ 学徒观察入口已移除（用户决定：功能以 skill 形式保留，不再单独 UI） */}
            <textarea value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder={(() => {
                const sum = getSummoned(activeConv)
                if (sum.length === 0) return '问学徒...'
                if (sum.length === 1) return `问 ${sum[0].name}...`
                return `问所有召唤者 · 或 @${sum[0].name} 指定...`
              })()} rows={1}
              style={{ flex: 1, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, outline: 'none', resize: 'none', fontFamily: 'var(--font)', background: 'var(--bg)', color: 'var(--text)', lineHeight: 1.5, maxHeight: 100, overflow: 'auto' }}
              onFocus={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
              onInput={e => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 100) + 'px' }}
            />
            {streaming ? (
              <button onClick={handleStopStream} title="停止生成" style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#d32f2f', color: '#fff', flexShrink: 0 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              </button>
            ) : (
              <button onClick={handleSend} disabled={!input.trim()} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: input.trim() ? 'pointer' : 'not-allowed', background: input.trim() ? 'var(--accent)' : 'var(--border)', color: '#fff', flexShrink: 0, opacity: input.trim() ? 1 : 0.5 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            )}
          </div>
        </>
      )}

      {/* ===== Tab: Apprentice (weekly observation log) =====
           2026-04-24 UI 全部移除（用户决定：学徒观察功能保留为内置 skill，走召唤系统）。
           保留的死代码：generateApprentice / loadApprenticeWeek / sendDialogueQuestion /
           apprentice 相关 state 与 IPC wiring —— 方便后续港到 skills/apprentice/ 作为
           内置 skill 使用。永久删除这些代码在 skill 落地后另起一轮 refactor。 */}

      {/* ===== Tab: 召唤 (Personas — WIP batch 29) =====
          Progressive persona generation:
          user types a name → multi-source web search (Wikipedia + Baidu Baike
          + DuckDuckGo) → AI disambig from combined candidates → AI generates
          initial archive → user can refine / feed material / rename.
          Each revision carries a rigorous 5-dimension fitness score. */}
      {tab === 'personas' && <PersonasTab />}

      {/* Skills tab removed in batch 28 — see note at top of file. */}

      {/* Custom delete-confirm modal — replaces native window.confirm so the
          dialog matches the warm 拾卷 palette instead of showing a stark
          system-style "shijuan / 删除这个对话?" popup. */}
      {confirmingDelete && (
        <div
          onClick={() => setConfirmingDelete(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(40, 30, 20, 0.32)',
            backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            animation: 'sj-fade-in 0.14s ease-out',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              minWidth: 320, maxWidth: 380,
              background: 'var(--bg-paper, #faf6ef)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--accent)',
              borderRadius: 6,
              padding: '18px 20px 16px',
              boxShadow: '0 12px 36px rgba(60, 40, 20, 0.18)',
              fontFamily: 'inherit',
              animation: 'sj-pop-in 0.18s cubic-bezier(.2,.9,.3,1.2)',
            }}
          >
            <div style={{
              fontSize: 14, fontWeight: 600, color: 'var(--text-primary)',
              marginBottom: 8, letterSpacing: 0.3,
            }}>
              删除对话
            </div>
            <div style={{
              fontSize: 12.5, lineHeight: 1.6, color: 'var(--text-secondary)',
              marginBottom: 18,
            }}>
              确定删除「<span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                {confirmingDelete.title.length > 24
                  ? confirmingDelete.title.slice(0, 24) + '…'
                  : confirmingDelete.title}
              </span>」？<br />
              <span style={{ fontSize: 11, opacity: 0.7 }}>此操作无法撤销。</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setConfirmingDelete(null)}
                style={{
                  padding: '6px 14px', fontSize: 12,
                  border: '1px solid var(--border)', borderRadius: 4,
                  background: 'transparent', color: 'var(--text-secondary)',
                  cursor: 'pointer', transition: 'background 0.12s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                取消
              </button>
              <button
                onClick={executeDeleteConversation}
                autoFocus
                style={{
                  padding: '6px 16px', fontSize: 12, fontWeight: 500,
                  border: '1px solid #c45a3a', borderRadius: 4,
                  background: '#c45a3a', color: '#fff',
                  cursor: 'pointer', transition: 'background 0.12s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#a84826')}
                onMouseLeave={e => (e.currentTarget.style.background = '#c45a3a')}
              >
                删除
              </button>
            </div>
          </div>
          <style>{`
            @keyframes sj-fade-in { from { opacity: 0 } to { opacity: 1 } }
            @keyframes sj-pop-in {
              from { opacity: 0; transform: translateY(-6px) scale(0.97) }
              to { opacity: 1; transform: translateY(0) scale(1) }
            }
          `}</style>
        </div>
      )}
    </div>
  )
}
