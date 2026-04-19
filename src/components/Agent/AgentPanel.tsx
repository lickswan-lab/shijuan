import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import { KATEX_FORGIVING as rehypeKatex } from '../../utils/markdownConfig'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { AgentMessage, AgentConversation } from '../../types/library'
import { buildAgentSystemPrompt, type AgentContext } from './agentPrompt'
import { parseToolCalls, hasToolCalls, extractMemoryUpdate, cleanResponse, executeTool } from './agentTools'
import { buildApprenticePrompt } from './apprenticePrompt'
import { APPRENTICE_DIALOGUE_SYSTEM_PROMPT, buildApprenticeDialogueUserMessage } from './apprenticeDialoguePrompt'
import PersonasTab from './PersonasTab'

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

// ===== Main Component =====
export default function AgentPanel() {
  const { library, currentEntry, currentPdfMeta, createMemo, updateMemo } = useLibraryStore()
  const { selectedAiModel, textSelection } = useUiStore()

  const [tab, setTab] = useState<PanelTab>('chat')

  // Chat state
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [activeConv, setActiveConv] = useState<AgentConversation | null>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [toolStatus, setToolStatus] = useState('')
  const [memory, setMemory] = useState('')

  // Model
  const [agentModel, setAgentModel] = useState(() => {
    try { return localStorage.getItem('sj-agentModel') || selectedAiModel } catch { return selectedAiModel }
  })
  const [configuredProviders, setConfiguredProviders] = useState<ConfiguredProvider[]>([])

  // Insights tab removed — see PanelTab comment above.

  // Apprentice — weekly observation logs written by Hermes-as-companion
  const [apprenticeEntries, setApprenticeEntries] = useState<Array<{ weekCode: string; size: number; mtime: string }>>([])
  const [currentApprenticeWeek, setCurrentApprenticeWeek] = useState<string | null>(null)
  const [currentApprenticeContent, setCurrentApprenticeContent] = useState<string>('')
  const [generatingApprentice, setGeneratingApprentice] = useState(false)
  const [apprenticeStreamText, setApprenticeStreamText] = useState('')

  // History list collapsed by default when there are ≥ 3 reports. Keeps the
  // bottom strip compact so the report body above gets more screen.
  const [historyExpanded, setHistoryExpanded] = useState(false)

  // Custom-range picker visibility. Default flow is 1-click "last 7 days",
  // but power users can expand this and pick any [start, end] span up to 56 days.
  const [showCustomRange, setShowCustomRange] = useState(false)
  const todayIso = new Date().toISOString().slice(0, 10)
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
  const [customStart, setCustomStart] = useState(sevenDaysAgoIso)
  const [customEnd, setCustomEnd] = useState(todayIso)
  const [customRangeError, setCustomRangeError] = useState<string | null>(null)

  // Apprentice dialogue — follow-up questions on the currently-viewed weekly report.
  // History is ephemeral (not persisted) — it's about "this reading session's
  // follow-ups," not a long-term record. The report itself remains the persisted
  // artifact. Reset when switching weeks so you don't carry stale context.
  const [dialogueHistory, setDialogueHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [dialogueInput, setDialogueInput] = useState('')
  const [dialogueStreaming, setDialogueStreaming] = useState(false)
  const [dialogueStreamText, setDialogueStreamText] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
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
  }, [])

  // Abort any in-flight stream on unmount so the backend fetch is cancelled
  // (otherwise it keeps consuming tokens after the panel closes).
  useEffect(() => {
    return () => {
      const sid = currentStreamIdRef.current
      if (sid) {
        window.electronAPI.aiAbortStream?.(sid).catch(() => {})
      }
    }
  }, [])

  // Load everything on mount
  const loadMemory = useCallback(() => {
    window.electronAPI.agentLoadMemory().then(r => { if (r.success) setMemory(r.content || '') })
  }, [])

  // Persona list — used by the summon dropdown in chat tab so the user can
  // switch the conversation to "speak as <person>" mode. Loaded once on mount;
  // refreshed whenever the user creates a new persona via the 召唤 tab.
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string; canonicalName?: string; identity?: string; skillMode?: 'legacy' | 'distilled' | 'imported'; updatedAt: string; currentFitnessTotal?: number }>>([])
  const [showSummonMenu, setShowSummonMenu] = useState(false)

  const refreshPersonaList = useCallback(async () => {
    const r = await window.electronAPI.personaList?.()
    if (r?.success) setPersonaList(r.entries)
  }, [])

  useEffect(() => {
    loadMemory()
    window.electronAPI.aiGetConfigured?.().then(setConfiguredProviders).catch(() => {})
    window.electronAPI.agentLoadConversations().then(r => {
      if (r.success) {
        setConversations(r.conversations)
        if (r.conversations.length > 0) setActiveConv(r.conversations[0])
      }
    })
    refreshPersonaList()
    // Load apprentice logs list — pick the most recent one to display first
    window.electronAPI.apprenticeList?.().then(r => {
      if (!r.success) return
      setApprenticeEntries(r.entries)
      if (r.entries.length > 0) {
        const latest = r.entries[0].weekCode
        setCurrentApprenticeWeek(latest)
        window.electronAPI.apprenticeLoad!(latest).then(l => {
          if (l.success && l.content) setCurrentApprenticeContent(l.content)
        })
      }
    })
    const timer = setTimeout(loadMemory, 4000)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeConv?.messages.length, streamingText])

  // Store helpers
  const storeHelpers = {
    getLibrary: () => library,
    getCurrentEntry: () => currentEntry,
    getSelectedText: () => textSelection?.text || null,
    getCurrentPdfMeta: () => currentPdfMeta,
    createMemo, updateMemo,
  }

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
      setActiveConv(remaining[0] || null)
    }
  }, [confirmingDelete, conversations, activeConv])

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
    const conv: AgentConversation = {
      id: uuid(), title: '新对话', messages: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    setActiveConv(conv)
    setConversations(prev => [conv, ...prev])
    setTab('chat')
  }, [])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    let conv = activeConv
    if (!conv) {
      conv = { id: uuid(), title: text.slice(0, 30), messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      setConversations(prev => [conv!, ...prev])
    }

    const userMsg: AgentMessage = { id: uuid(), role: 'user', content: text, timestamp: new Date().toISOString() }
    const updatedMessages = [...conv.messages, userMsg]
    conv = { ...conv, messages: updatedMessages, updatedAt: new Date().toISOString() }
    if (conv.messages.length === 1) conv.title = text.slice(0, 30)
    setActiveConv(conv)
    setInput('')
    setStreaming(true)
    setStreamingText('')

    // ===== Summon mode branch =====
    // If this conversation is in summon mode (user picked a persona), skip
    // Hermes's ReAct loop + tool calls entirely — the user wants to speak
    // with the persona, not the agent. Use the persona's distilled skill as
    // system prompt and do a plain streaming completion.
    if (conv.summonedPersonaId) {
      try {
        // Pass the current user query so the backend can BM25-retrieve relevant
        // original-text snippets from sourcesUsed and inject them as [资料 N]
        // citations — this is what makes the persona cite real passages instead
        // of reciting pretrained impressions (Phase B RAG).
        const sysRes = await window.electronAPI.personaGetSystemPrompt?.(conv.summonedPersonaId, text)
        if (!sysRes?.success || !sysRes.systemPrompt) {
          throw new Error(sysRes?.error || '无法加载人物 skill（档案可能被删除）')
        }
        const llmMessages: Array<{ role: string; content: string }> = [
          { role: 'system', content: sysRes.systemPrompt },
        ]
        for (const msg of updatedMessages) {
          if (msg.role === 'user') llmMessages.push({ role: 'user', content: msg.content })
          else if (msg.role === 'assistant') llmMessages.push({ role: 'assistant', content: msg.content })
        }
        const streamId = uuid()
        currentStreamIdRef.current = streamId
        let fullText = ''
        const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
          if (sid === streamId) { fullText += chunk; setStreamingText(fullText) }
        })
        try {
          const res = await window.electronAPI.aiChatStream(streamId, agentModel, llmMessages)
          if (!res.success) throw new Error(res.error || 'AI 调用失败')
          if (res.text) fullText = res.text
        } finally { cleanup(); currentStreamIdRef.current = null }
        setStreamingText('')
        const finalMessages = [...updatedMessages, { id: uuid(), role: 'assistant' as const, content: fullText, timestamp: new Date().toISOString() }]
        const finalConv: AgentConversation = { ...conv, messages: finalMessages, updatedAt: new Date().toISOString() }
        setActiveConv(finalConv)
        setConversations(prev => prev.map(c => c.id === finalConv.id ? finalConv : c))
        await window.electronAPI.agentSaveConversation(finalConv)
      } catch (err: any) {
        setActiveConv({ ...conv, messages: [...updatedMessages, { id: uuid(), role: 'assistant', content: `召唤对话出错：${err.message}`, timestamp: new Date().toISOString() }] })
      }
      setStreaming(false)
      return
    }

    try {
      const systemPrompt = buildAgentSystemPrompt(buildContext())

      const llmMessages: Array<{ role: string; content: string }> = [{ role: 'system', content: systemPrompt }]
      for (const msg of updatedMessages) {
        if (msg.role === 'user') llmMessages.push({ role: 'user', content: msg.content })
        else if (msg.role === 'assistant') llmMessages.push({ role: 'assistant', content: msg.content })
        else if (msg.role === 'tool_result') llmMessages.push({ role: 'user', content: `<tool_result name="${msg.toolName}">${msg.content}</tool_result>` })
      }

      let maxIter = 5, finalResponse = ''
      while (maxIter-- > 0) {
        const streamId = uuid()
        currentStreamIdRef.current = streamId
        let fullText = ''
        setStreamingText('')
        const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => { if (sid === streamId) { fullText += chunk; setStreamingText(fullText) } })
        try { await window.electronAPI.aiChatStream(streamId, agentModel, llmMessages) } finally { cleanup(); currentStreamIdRef.current = null }
        setStreamingText('')
        // If the user aborted, fullText may be empty — bail without looping into another tool call.
        if (!fullText) { finalResponse = ''; break }

        if (hasToolCalls(fullText)) {
          for (const call of parseToolCalls(fullText)) {
            setToolStatus(`${call.toolName}...`)
            const result = await executeTool(call.toolName, call.argsJson, storeHelpers)
            updatedMessages.push(
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
      }

      const cleaned = cleanResponse(finalResponse)
      const finalMessages = [...updatedMessages, { id: uuid(), role: 'assistant' as const, content: cleaned, timestamp: new Date().toISOString() }]
      const finalConv: AgentConversation = { ...conv, messages: finalMessages, updatedAt: new Date().toISOString() }
      setActiveConv(finalConv)
      setConversations(prev => prev.map(c => c.id === finalConv.id ? finalConv : c))
      await window.electronAPI.agentSaveConversation(finalConv)
    } catch (err: any) {
      setActiveConv({ ...conv, messages: [...updatedMessages, { id: uuid(), role: 'assistant', content: `Agent 出错：${err.message}`, timestamp: new Date().toISOString() }] })
    }
    setStreaming(false)
  }, [input, streaming, activeConv, agentModel, memory, buildContext, storeHelpers])

  // generateInsight removed with the insights tab in batch 29.
  // ===== Apprentice: generate this week's observation =====
  // generateApprentice(range?) — range is optional {startIso, endIso}.
  // Omit to use the default "last 7 days ending now" sliding window.
  // Hard cap enforced backend-side: ≤ 56 days.
  const generateApprentice = useCallback(async (range?: { startIso: string; endIso: string }) => {
    if (generatingApprentice) return
    setGeneratingApprentice(true)
    setApprenticeStreamText('')

    try {
      // 1. Collect context from the backend
      const ctxResult = await window.electronAPI.apprenticeCollectContext(range)
      if (!ctxResult.success || !ctxResult.context) {
        throw new Error(ctxResult.error || '收集本周痕迹失败')
      }
      const ctx = ctxResult.context

      // 2. Build prompt + stream AI response
      const { system, user } = buildApprenticePrompt(ctx)
      const streamId = uuid()
      currentStreamIdRef.current = streamId
      let fullText = ''
      const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
        if (sid === streamId) { fullText += chunk; setApprenticeStreamText(fullText) }
      })
      try {
        const res = await window.electronAPI.aiChatStream(streamId, agentModel, [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ])
        if (!res.success) throw new Error(res.error || 'AI 调用失败')
      } finally { cleanup(); currentStreamIdRef.current = null }

      if (!fullText.trim()) throw new Error('AI 未返回任何内容')

      // 3. Persist
      await window.electronAPI.apprenticeSave(ctx.weekCode, fullText)

      // 4. Refresh list + select this week
      setCurrentApprenticeWeek(ctx.weekCode)
      setCurrentApprenticeContent(fullText)
      const listRes = await window.electronAPI.apprenticeList()
      if (listRes.success) setApprenticeEntries(listRes.entries)
    } catch (err: any) {
      setCurrentApprenticeContent(`生成失败：${err.message || err}\n\n你可能需要先在设置里配置一个 AI Key。`)
    } finally {
      setGeneratingApprentice(false)
      setApprenticeStreamText('')
    }
  }, [agentModel, generatingApprentice])

  const loadApprenticeWeek = useCallback(async (weekCode: string) => {
    const r = await window.electronAPI.apprenticeLoad(weekCode)
    if (r.success && r.content) {
      setCurrentApprenticeWeek(weekCode)
      setCurrentApprenticeContent(r.content)
      setDialogueInput('')
      setDialogueStreamText('')
      // Load the follow-up dialogue sidecar for this week, if any.
      // Keeps "追问学徒" conversation persistent across sessions — each
      // week's dialogue lives in apprentice/{weekCode}.dialogue.json.
      try {
        const d = await window.electronAPI.apprenticeLoadDialogue?.(weekCode)
        if (d?.success && Array.isArray(d.history)) {
          setDialogueHistory(d.history.map(m => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content,
          })) as Array<{ role: 'user' | 'assistant'; content: string }>)
        } else {
          setDialogueHistory([])
        }
      } catch {
        setDialogueHistory([])
      }
    }
  }, [])

  // Send a follow-up question to the apprentice about the currently-viewed report
  const sendDialogueQuestion = useCallback(async () => {
    const q = dialogueInput.trim()
    if (!q || !currentApprenticeContent || !currentApprenticeWeek || dialogueStreaming) return

    // Capture current state, then clear input and add user turn immediately
    // so the UI feels responsive (user sees their question appear).
    const historyBefore = dialogueHistory
    setDialogueHistory([...historyBefore, { role: 'user', content: q }])
    setDialogueInput('')
    setDialogueStreaming(true)
    setDialogueStreamText('')

    const userMsg = buildApprenticeDialogueUserMessage({
      weeklyReport: currentApprenticeContent,
      weekCode: currentApprenticeWeek,
      history: historyBefore,
      latestQuestion: q,
    })

    const streamId = uuid()
    currentStreamIdRef.current = streamId
    let fullText = ''
    const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
      if (sid !== streamId) return
      fullText += chunk
      setDialogueStreamText(fullText)
    })
    try {
      const res = await window.electronAPI.aiChatStream(streamId, agentModel, [
        { role: 'system', content: APPRENTICE_DIALOGUE_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ])
      if (!res.success) {
        fullText = `（学徒暂时答不上来：${res.error || '未知错误'}）`
      } else if (res.text) {
        fullText = res.text
      }
    } catch (err: any) {
      fullText = `（出错了：${err.message || err}）`
    } finally {
      cleanup()
      currentStreamIdRef.current = null
    }

    const now = new Date().toISOString()
    const finalHistory = [
      ...historyBefore,
      { role: 'user' as const, content: q, createdAt: now },
      { role: 'assistant' as const, content: fullText.trim(), createdAt: new Date().toISOString() },
    ]
    setDialogueHistory(finalHistory)
    setDialogueStreaming(false)
    setDialogueStreamText('')

    // Persist to disk so the conversation survives app restart. Sidecar file
    // is apprentice/{weekCode}.dialogue.json — separate from the report md.
    if (window.electronAPI.apprenticeSaveDialogue && currentApprenticeWeek) {
      try {
        await window.electronAPI.apprenticeSaveDialogue(currentApprenticeWeek, finalHistory)
      } catch (err) {
        console.warn('[apprentice-dialogue] save failed:', err)
      }
    }
  }, [dialogueInput, currentApprenticeContent, currentApprenticeWeek, dialogueHistory, dialogueStreaming, agentModel])

  const deleteApprenticeWeek = useCallback(async (weekCode: string) => {
    if (!confirm(`删除 ${weekCode} 的观察报告？`)) return
    await window.electronAPI.apprenticeDelete(weekCode)
    const listRes = await window.electronAPI.apprenticeList()
    if (listRes.success) {
      setApprenticeEntries(listRes.entries)
      // If we deleted the currently displayed one, pick the next most recent
      if (currentApprenticeWeek === weekCode) {
        if (listRes.entries.length > 0) {
          loadApprenticeWeek(listRes.entries[0].weekCode)
        } else {
          setCurrentApprenticeWeek(null)
          setCurrentApprenticeContent('')
        }
      }
    }
  }, [currentApprenticeWeek, loadApprenticeWeek])

  // Skill CRUD (saveSkill / deleteSkill / toggleSkill) and the Skills tab UI
  // were removed in batch 28. See the note at the top of this file for why.

  // ===== Render helpers =====
  const displayMessages = activeConv?.messages.filter(m => m.role === 'user' || m.role === 'assistant') || []
  // behaviorCount was only used by the removed Insights tab (batch 29)

  const tabStyle = (t: PanelTab) => ({
    flex: 1, padding: '6px 0', fontSize: 11, fontWeight: tab === t ? 600 : 400,
    border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none', color: tab === t ? 'var(--accent-hover)' : 'var(--text-muted)',
    cursor: 'pointer',
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
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Hermes</span>
        <select value={agentModel} onChange={e => { setAgentModel(e.target.value); try { localStorage.setItem('sj-agentModel', e.target.value) } catch {} }}
          style={{ flex: 1, minWidth: 0, padding: '2px 4px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 4, outline: 'none', background: 'var(--bg)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          {configuredProviders.map(p => (<optgroup key={p.id} label={p.name}>{p.models.map(m => (<option key={`${p.id}:${m.id}`} value={`${p.id}:${m.id}`}>{m.name}</option>))}</optgroup>))}
        </select>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
        <button style={tabStyle('chat')} onClick={() => setTab('chat')}>对话</button>
        <button style={tabStyle('apprentice')} onClick={() => setTab('apprentice')}>
          学徒{apprenticeEntries.length > 0 && <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>({apprenticeEntries.length})</span>}
        </button>
        {/* 召唤 tab is LOCKED — feature gating, not yet ready for users.
            The button is rendered as disabled (low opacity + lock badge), and clicking
            it routes to the locked placeholder view instead of the full PersonasTab.
            To re-enable: remove the disabled+opacity styling and the personas-locked
            branch below; restore onClick to setTab('personas'). */}
        <button
          style={{
            ...tabStyle('personas'),
            opacity: 0.5,
            cursor: 'not-allowed',
            position: 'relative',
          }}
          onClick={() => setTab('personas')}
          title="召唤功能正在打磨中，敬请期待"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            召唤
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </span>
        </button>
      </div>

      {/* ===== Tab: Chat ===== */}
      {tab === 'chat' && (
        <>
          {conversations.length > 1 && (
            <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border-light)', display: 'flex', gap: 4, overflow: 'auto', flexShrink: 0 }}>
              {conversations.slice(0, 8).map(c => {
                const isActive = c.id === activeConv?.id
                return (
                  <div key={c.id} style={{
                    display: 'inline-flex', alignItems: 'center',
                    borderRadius: 10,
                    border: isActive ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: isActive ? 'var(--accent-soft)' : 'transparent',
                    color: isActive ? 'var(--accent-hover)' : 'var(--text-muted)',
                    flexShrink: 0,
                  }}>
                    <button onClick={() => setActiveConv(c)} style={{
                      padding: '2px 4px 2px 8px', fontSize: 10,
                      cursor: 'pointer', background: 'none', border: 'none',
                      color: 'inherit',
                      whiteSpace: 'nowrap', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis',
                    }} title={c.title}>{c.title}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteConversation(c.id) }}
                      title="删除对话"
                      style={{
                        padding: '0 6px 0 3px', fontSize: 12, lineHeight: 1,
                        background: 'none', border: 'none',
                        color: 'var(--text-muted)', cursor: 'pointer',
                        opacity: 0.6,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--danger)' }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.color = 'var(--text-muted)' }}
                    >×</button>
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
            {displayMessages.length === 0 && !streaming && (
              <div style={{ textAlign: 'center', padding: '30px 16px', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>问 Hermes 任何关于你的研究的问题</div>
                <div style={{ fontSize: 11 }}>「我最近在读什么？」「帮我整理这个主题的笔记」</div>
              </div>
            )}

            {displayMessages.map(msg => (
              <div key={msg.id} style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '90%', padding: '8px 12px', borderRadius: 10, fontSize: 13, lineHeight: 1.7,
                  ...(msg.role === 'user'
                    ? { background: 'var(--accent)', color: '#fff', borderBottomRightRadius: 2 }
                    : { background: 'var(--bg-warm)', color: 'var(--text)', border: '1px solid var(--border-light)', borderBottomLeftRadius: 2 }),
                }}>
                  {msg.role === 'assistant' ? <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{msg.content}</ReactMarkdown> : <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>}
                </div>
              </div>
            ))}

            {streaming && (
              <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                {toolStatus && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}><span className="loading-spinner" style={{ width: 10, height: 10 }} />{toolStatus}</div>}
                <div style={{ maxWidth: '90%', padding: '8px 12px', borderRadius: 10, background: 'var(--bg-warm)', border: '1px solid var(--border-light)', borderBottomLeftRadius: 2, fontSize: 13, lineHeight: 1.7 }}>
                  {streamingText ? <><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{cleanResponse(streamingText)}</ReactMarkdown><span className="streaming-cursor" /></> : <span style={{ color: 'var(--text-muted)' }}>{toolStatus ? '处理中...' : '思考中...'}</span>}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Summon banner — shown above the input bar when this conv is in
              summon mode. Gives the user a clear visual that they're speaking
              to a persona, not Hermes, + a one-click exit to Hermes mode. */}
          {activeConv?.summonedPersonaId && (
            <div style={{
              padding: '6px 12px', margin: '0 12px', marginBottom: 4,
              borderRadius: 6, background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 11, color: 'var(--accent-hover)',
            }}>
              <span style={{ flex: 1 }}>
                🧙 正以 <b>{activeConv.summonedPersonaName || '某位名家'}</b> 视角对话
              </span>
              <button
                onClick={async () => {
                  const updated: AgentConversation = { ...activeConv, summonedPersonaId: undefined, summonedPersonaName: undefined, updatedAt: new Date().toISOString() }
                  setActiveConv(updated)
                  setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
                  await window.electronAPI.agentSaveConversation(updated)
                }}
                style={{ padding: '2px 8px', fontSize: 10, border: '1px solid var(--accent)', borderRadius: 3, background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>
                取消召唤
              </button>
            </div>
          )}

          {/* Summon menu — expanded on click of the 🧙 button. Lists existing
              personas (distilled / imported only; legacy skipped since they
              have no skill artifact). Selecting one sets this conv's
              summonedPersonaId + saves. */}
          {showSummonMenu && (
            <div style={{
              margin: '0 12px', marginBottom: 4,
              padding: '8px 10px',
              background: 'var(--bg-warm)', border: '1px solid var(--border)', borderRadius: 6,
              maxHeight: 240, overflowY: 'auto',
            }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>
                召唤一位名家接管这段对话（skill 作为 system prompt）
              </div>
              {personaList.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '6px 0' }}>
                  还没有蒸馏好的 skill——先去「召唤」tab 蒸馏一位名家。
                </div>
              )}
              {personaList.map(p => (
                <div key={p.id}
                     onClick={async () => {
                       if (!activeConv) {
                         // need to create a fresh conv first
                         const freshConv: AgentConversation = {
                           id: uuid(), title: `召唤 ${p.canonicalName || p.name}`, messages: [],
                           summonedPersonaId: p.id, summonedPersonaName: p.canonicalName || p.name,
                           createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                         }
                         setConversations(prev => [freshConv, ...prev])
                         setActiveConv(freshConv)
                         await window.electronAPI.agentSaveConversation(freshConv)
                       } else {
                         const updated: AgentConversation = { ...activeConv, summonedPersonaId: p.id, summonedPersonaName: p.canonicalName || p.name, updatedAt: new Date().toISOString() }
                         setActiveConv(updated)
                         setConversations(prev => prev.map(c => c.id === updated.id ? updated : c))
                         await window.electronAPI.agentSaveConversation(updated)
                       }
                       setShowSummonMenu(false)
                     }}
                     style={{
                       padding: '6px 10px', marginBottom: 3, borderRadius: 4,
                       cursor: 'pointer', background: 'var(--bg)', border: '1px solid var(--border-light)',
                       fontSize: 11,
                     }}
                     onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                     onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-light)'}>
                  <div style={{ fontWeight: 500, color: 'var(--text)' }}>
                    {p.canonicalName || p.name}
                    {typeof p.currentFitnessTotal === 'number' && (
                      <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 5px', borderRadius: 8, background: p.currentFitnessTotal >= 40 ? 'var(--success)' : 'var(--warning)', color: '#fff' }}>
                        {p.currentFitnessTotal}%
                      </span>
                    )}
                  </div>
                  {p.identity && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{p.identity}</div>
                  )}
                </div>
              ))}
              <div style={{ marginTop: 6, textAlign: 'right' }}>
                <button onClick={() => setShowSummonMenu(false)}
                        style={{ padding: '3px 10px', fontSize: 10, border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  关闭
                </button>
              </div>
            </div>
          )}

          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-light)', flexShrink: 0, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <button onClick={handleNewConversation} style={{ padding: '6px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }} title="新对话">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button
              onClick={() => { setShowSummonMenu(!showSummonMenu); refreshPersonaList() }}
              style={{ padding: '6px 8px', background: activeConv?.summonedPersonaId ? 'var(--accent-soft)' : 'none', border: `1px solid ${activeConv?.summonedPersonaId ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6, cursor: 'pointer', color: activeConv?.summonedPersonaId ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, fontSize: 11 }}
              title="召唤一位名家接管对话">
              🧙
            </button>
            <textarea value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder={activeConv?.summonedPersonaId ? `问 ${activeConv.summonedPersonaName}...` : '问 Hermes...'} rows={1}
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
              <button onClick={handleSend} disabled={!input.trim()} style={{ padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', background: input.trim() ? 'var(--accent)' : 'var(--border)', color: '#fff', flexShrink: 0 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              </button>
            )}
          </div>
        </>
      )}

      {/* ===== Tab: Apprentice (weekly observation log) ===== */}
      {tab === 'apprentice' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Action bar */}
          <div style={{
            padding: '10px 12px', borderBottom: '1px solid var(--border-light)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={() => generateApprentice()}
                disabled={generatingApprentice}
                style={{
                  padding: '6px 14px', fontSize: 11, fontWeight: 500,
                  border: 'none', borderRadius: 6, cursor: generatingApprentice ? 'wait' : 'pointer',
                  background: generatingApprentice ? 'var(--border)' : 'var(--accent)',
                  color: generatingApprentice ? 'var(--text-muted)' : '#fff',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {generatingApprentice && <span className="loading-spinner" style={{ width: 10, height: 10 }} />}
                {generatingApprentice ? '学徒正在翻你的痕迹…' : '让学徒写最近 7 天观察'}
              </button>
              <button
                onClick={() => setShowCustomRange(!showCustomRange)}
                disabled={generatingApprentice}
                style={{
                  padding: '5px 10px', fontSize: 10, fontWeight: 500,
                  border: '1px solid var(--border)', borderRadius: 6,
                  cursor: generatingApprentice ? 'wait' : 'pointer',
                  background: showCustomRange ? 'var(--accent-soft)' : 'transparent',
                  color: showCustomRange ? 'var(--accent-hover)' : 'var(--text-muted)',
                }}
              >
                {showCustomRange ? '收起' : '自定义日期…'}
              </button>
              {apprenticeEntries.length > 0 && !showCustomRange && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  上次: {apprenticeEntries[0].weekCode} · {formatTimeAgo(apprenticeEntries[0].mtime)}
                </span>
              )}
            </div>

            {/* Custom range picker */}
            {showCustomRange && !generatingApprentice && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                fontSize: 11, color: 'var(--text-secondary)',
                padding: '6px 10px', background: 'var(--bg-warm)',
                border: '1px solid var(--border-light)', borderRadius: 6,
              }}>
                <span>从</span>
                <input
                  type="date"
                  value={customStart}
                  max={customEnd}
                  onChange={e => { setCustomStart(e.target.value); setCustomRangeError(null) }}
                  style={{ padding: '3px 6px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }}
                />
                <span>到</span>
                <input
                  type="date"
                  value={customEnd}
                  min={customStart}
                  max={todayIso}
                  onChange={e => { setCustomEnd(e.target.value); setCustomRangeError(null) }}
                  style={{ padding: '3px 6px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }}
                />
                <button
                  onClick={() => {
                    const s = new Date(customStart + 'T00:00:00')
                    const e = new Date(customEnd + 'T23:59:59')
                    if (s >= e) { setCustomRangeError('起止日期无效'); return }
                    const days = Math.round((e.getTime() - s.getTime()) / 86400000)
                    if (days > 56) { setCustomRangeError(`跨度最长 56 天（当前 ${days} 天）`); return }
                    setCustomRangeError(null)
                    generateApprentice({ startIso: s.toISOString(), endIso: e.toISOString() })
                  }}
                  style={{
                    padding: '4px 10px', fontSize: 11, border: 'none', borderRadius: 4,
                    background: 'var(--accent)', color: '#fff', cursor: 'pointer',
                  }}
                >
                  生成观察
                </button>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>最长 56 天</span>
                {customRangeError && (
                  <span style={{ fontSize: 10, color: 'var(--danger)', flexBasis: '100%' }}>
                    {customRangeError}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Intro (shown only when no logs exist) */}
          {apprenticeEntries.length === 0 && !generatingApprentice && (
            <div style={{
              padding: '28px 22px', fontSize: 12.5, color: 'var(--text-secondary)',
              lineHeight: 1.85, textAlign: 'left',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>
                关于学徒
              </div>
              <p style={{ marginBottom: 14 }}>
                学徒不是帮你答题的助手，是跟你并肩读书的同伴。
              </p>
              <p style={{ marginBottom: 14 }}>
                每周一次，它会把你这周的痕迹翻一遍——打开了哪些文献、停在哪一页、哪些立场和之前相反、
                哪本书连着几天打开却没写东西——然后写一份观察交给你。
              </p>
              <p style={{ marginBottom: 14 }}>
                它说的是<strong style={{ color: 'var(--text)' }}>你自己没注意到的模式</strong>，不是流水账。
                读完可以追问它为什么这么看。
              </p>
              <div style={{
                marginTop: 22, padding: '10px 14px',
                fontSize: 11, color: 'var(--text-muted)',
                background: 'var(--bg-warm)', borderRadius: 6,
                borderLeft: '2px solid var(--border)',
                fontStyle: 'italic', lineHeight: 1.7,
              }}>
                一周结束后点一次最合适。数据越多，观察越有意思。
              </div>
            </div>
          )}

          {/* Streaming preview */}
          {generatingApprentice && apprenticeStreamText && (
            <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px', background: 'var(--bg-warm)' }}>
              <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.8 }}>
                <ReactMarkdown
                  rehypePlugins={[rehypeKatex]}
                  remarkPlugins={[remarkMath]}
                >
                  {apprenticeStreamText}
                </ReactMarkdown>
              </div>
            </div>
          )}

          {/* Current log + follow-up dialogue */}
          {!generatingApprentice && currentApprenticeContent && (
            <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
              <div className="annotation-markdown" style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text)' }}>
                <ReactMarkdown
                  rehypePlugins={[rehypeKatex]}
                  remarkPlugins={[remarkMath]}
                >
                  {currentApprenticeContent}
                </ReactMarkdown>
              </div>

              {/* Follow-up dialogue — conversation on top of the weekly report. */}
              <div style={{
                marginTop: 22,
                paddingTop: 16,
                borderTop: '1px dashed var(--border)',
              }}>
                <div style={{
                  fontSize: 10, color: 'var(--text-muted)',
                  letterSpacing: '0.05em', marginBottom: 10,
                  textTransform: 'uppercase',
                }}>
                  追问学徒
                </div>

                {/* Dialogue bubbles */}
                {dialogueHistory.map((m, i) => (
                  <div key={i} style={{
                    marginBottom: 12,
                    display: 'flex',
                    flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
                  }}>
                    <div style={{
                      maxWidth: '85%',
                      padding: '8px 12px',
                      borderRadius: 10,
                      fontSize: 12.5,
                      lineHeight: 1.7,
                      background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--bg-warm)',
                      color: m.role === 'user' ? 'var(--accent-hover)' : 'var(--text)',
                      border: '1px solid var(--border-light)',
                    }}>
                      {m.role === 'assistant' ? (
                        <div className="annotation-markdown" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                          <ReactMarkdown rehypePlugins={[rehypeKatex]} remarkPlugins={[remarkMath]}>
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Streaming preview for the in-flight response */}
                {dialogueStreaming && dialogueStreamText && (
                  <div style={{ marginBottom: 12, display: 'flex' }}>
                    <div style={{
                      maxWidth: '85%', padding: '8px 12px', borderRadius: 10,
                      fontSize: 12.5, lineHeight: 1.7,
                      background: 'var(--bg-warm)', color: 'var(--text)',
                      border: '1px solid var(--border-light)',
                    }}>
                      <div className="annotation-markdown" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                        <ReactMarkdown rehypePlugins={[rehypeKatex]} remarkPlugins={[remarkMath]}>
                          {dialogueStreamText}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}

                {/* Input */}
                <div style={{
                  display: 'flex', gap: 6, marginTop: 8,
                  alignItems: 'flex-end',
                }}>
                  <textarea
                    value={dialogueInput}
                    onChange={e => setDialogueInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        sendDialogueQuestion()
                      }
                    }}
                    placeholder={dialogueHistory.length === 0
                      ? '追问：「立场摇摆指哪两条？」/「为什么觉得我卡住了？」'
                      : '继续追问…'}
                    disabled={dialogueStreaming}
                    rows={2}
                    style={{
                      flex: 1, padding: '7px 10px',
                      border: '1px solid var(--border)', borderRadius: 6,
                      fontSize: 12, outline: 'none', resize: 'none',
                      background: 'var(--bg)', color: 'var(--text)',
                      fontFamily: 'inherit', lineHeight: 1.5,
                    }}
                  />
                  <button
                    onClick={sendDialogueQuestion}
                    disabled={!dialogueInput.trim() || dialogueStreaming}
                    style={{
                      padding: '7px 14px', fontSize: 11, fontWeight: 500,
                      border: 'none', borderRadius: 6,
                      cursor: (!dialogueInput.trim() || dialogueStreaming) ? 'not-allowed' : 'pointer',
                      background: (!dialogueInput.trim() || dialogueStreaming) ? 'var(--border)' : 'var(--accent)',
                      color: (!dialogueInput.trim() || dialogueStreaming) ? 'var(--text-muted)' : '#fff',
                    }}
                  >
                    {dialogueStreaming ? '…' : '追问'}
                  </button>
                </div>
                <div style={{
                  fontSize: 10, color: 'var(--text-muted)', marginTop: 6,
                  lineHeight: 1.5,
                }}>
                  追问会和这周的报告一起保存，下次打开还在。
                </div>
              </div>
            </div>
          )}

          {/* History list at bottom. Collapsible when 3+ reports exist — only
              the newest is shown by default with a "展开全部 (N)" toggle. Keeps
              bottom strip compact so the current report gets more vertical space. */}
          {apprenticeEntries.length > 0 && !generatingApprentice && (
            <div style={{
              borderTop: '1px solid var(--border-light)', background: 'var(--bg-warm)',
              padding: '6px 10px',
              maxHeight: historyExpanded ? 320 : 90,
              overflow: 'auto', flexShrink: 0,
              transition: 'max-height 0.2s ease',
            }}>
              <div style={{
                fontSize: 10, color: 'var(--text-muted)', marginBottom: 4,
                fontWeight: 500, display: 'flex', alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span>历史观察 ({apprenticeEntries.length})</span>
                {apprenticeEntries.length >= 3 && (
                  <button
                    onClick={() => setHistoryExpanded(!historyExpanded)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--accent)', fontSize: 10, padding: 0,
                    }}
                  >
                    {historyExpanded ? '收起' : `展开全部 (${apprenticeEntries.length})`}
                  </button>
                )}
              </div>
              {(historyExpanded ? apprenticeEntries : apprenticeEntries.slice(0, 2)).map(e => (
                <div key={e.weekCode}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 6px', borderRadius: 3, cursor: 'pointer',
                    background: currentApprenticeWeek === e.weekCode ? 'var(--accent-soft)' : 'transparent',
                    color: currentApprenticeWeek === e.weekCode ? 'var(--accent-hover)' : 'var(--text-secondary)',
                    fontSize: 11,
                  }}
                  onMouseEnter={evt => { if (currentApprenticeWeek !== e.weekCode) evt.currentTarget.style.background = 'var(--bg-hover)' }}
                  onMouseLeave={evt => { if (currentApprenticeWeek !== e.weekCode) evt.currentTarget.style.background = 'transparent' }}
                  onClick={() => loadApprenticeWeek(e.weekCode)}
                >
                  <span style={{ flex: 1 }}>{e.weekCode}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{formatTimeAgo(e.mtime)}</span>
                  <button
                    onClick={evt => { evt.stopPropagation(); deleteApprenticeWeek(e.weekCode) }}
                    title="删除"
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--text-muted)', fontSize: 11, padding: '0 3px',
                    }}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== Tab: 召唤 (Personas — WIP batch 29) =====
          Progressive persona generation:
          user types a name → multi-source web search (Wikipedia + Baidu Baike
          + DuckDuckGo) → AI disambig from combined candidates → AI generates
          initial archive → user can refine / feed material / rename.
          Each revision carries a rigorous 5-dimension fitness score. */}
      {tab === 'personas' && (
        // Locked placeholder for the 召唤 tab — replaces full PersonasTab while the
        // feature is in 打磨 mode. Keeps the import (PersonasTab) so re-enabling is
        // a one-line revert: drop this block, re-add <PersonasTab />.
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '40px 24px', gap: 14, color: 'var(--text-muted)',
          background: 'var(--bg)',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'var(--bg-warm)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--accent)',
          }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>召唤 · 敬请期待</div>
          <div style={{ fontSize: 11, lineHeight: 1.7, textAlign: 'center', maxWidth: 280 }}>
            召唤功能正在打磨中：资料检索覆盖率、速率限制、人物档案蒸馏流程<br />
            还需要再迭代一轮，先锁着避免体验落差。<br />
            <span style={{ opacity: 0.7 }}>下个版本上线，旧档案数据保留不丢。</span>
          </div>
          <button
            onClick={() => setTab('chat')}
            style={{
              marginTop: 6, padding: '5px 14px', fontSize: 11,
              border: '1px solid var(--border)', borderRadius: 4,
              background: 'transparent', color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-warm)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            返回对话
          </button>
        </div>
      )}

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
