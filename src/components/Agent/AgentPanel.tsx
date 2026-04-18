import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import { KATEX_FORGIVING as rehypeKatex } from '../../utils/markdownConfig'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { AgentMessage, AgentConversation, HermesInsight } from '../../types/library'
import { buildAgentSystemPrompt, type AgentContext } from './agentPrompt'
import { parseToolCalls, hasToolCalls, extractMemoryUpdate, cleanResponse, executeTool } from './agentTools'
import { buildApprenticePrompt } from './apprenticePrompt'
import { APPRENTICE_DIALOGUE_SYSTEM_PROMPT, buildApprenticeDialogueUserMessage } from './apprenticeDialoguePrompt'

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

type PanelTab = 'chat' | 'insights' | 'apprentice'

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

  // Insights
  const [insight, setInsight] = useState<HermesInsight | null>(null)
  const [generatingInsight, setGeneratingInsight] = useState(false)

  // Apprentice — weekly observation logs written by Hermes-as-companion
  const [apprenticeEntries, setApprenticeEntries] = useState<Array<{ weekCode: string; size: number; mtime: string }>>([])
  const [currentApprenticeWeek, setCurrentApprenticeWeek] = useState<string | null>(null)
  const [currentApprenticeContent, setCurrentApprenticeContent] = useState<string>('')
  const [generatingApprentice, setGeneratingApprentice] = useState(false)
  const [apprenticeStreamText, setApprenticeStreamText] = useState('')

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

  useEffect(() => {
    loadMemory()
    window.electronAPI.aiGetConfigured?.().then(setConfiguredProviders).catch(() => {})
    window.electronAPI.agentLoadConversations().then(r => {
      if (r.success) {
        setConversations(r.conversations)
        if (r.conversations.length > 0) setActiveConv(r.conversations[0])
      }
    })
    window.electronAPI.agentLoadInsight().then(r => { if (r.success && r.insight?.content) setInsight(r.insight) })
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

  // ===== Insight generation =====
  const generateInsight = useCallback(async () => {
    if (generatingInsight || !memory.trim()) return
    setGeneratingInsight(true)

    const streamId = uuid()
    currentStreamIdRef.current = streamId
    let fullText = ''

    const prompt = `你是 Hermes 研究助手的分析模块。基于以下用户行为记录，生成一份简短的研究洞察报告（3-5 个要点）。

分析方向：
1. 用户近期的研究主题和关注方向
2. 阅读习惯模式（时间、频率、深度）
3. 跨文献的潜在关联
4. 值得深入的研究线索
5. 对用户的个性化建议

用中文，每个要点一句话，用 emoji 开头。

===== 用户行为记录 =====
${memory.slice(-3000)}`

    const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
      if (sid === streamId) { fullText += chunk; setStreamingText(fullText) }
    })

    try {
      await window.electronAPI.aiChatStream(streamId, agentModel, [
        { role: 'system', content: '你是一个专注于学术研究行为分析的AI助手。' },
        { role: 'user', content: prompt },
      ])
    } finally { cleanup(); currentStreamIdRef.current = null }

    setStreamingText('')
    if (fullText) {
      const newInsight: HermesInsight = {
        id: uuid(), content: fullText,
        basedOn: (memory.match(/^- \[/gm) || []).length,
        generatedAt: new Date().toISOString(), model: agentModel,
      }
      setInsight(newInsight)
      await window.electronAPI.agentSaveInsight(newInsight)
      // Only now show the red dot — real insight generated
      useUiStore.getState().setHermesHasInsight(true)
    }
    setGeneratingInsight(false)
  }, [memory, agentModel, generatingInsight])

  // ===== Apprentice: generate this week's observation =====
  const generateApprentice = useCallback(async (targetDateIso?: string) => {
    if (generatingApprentice) return
    setGeneratingApprentice(true)
    setApprenticeStreamText('')

    try {
      // 1. Collect context from the backend
      const ctxResult = await window.electronAPI.apprenticeCollectContext(targetDateIso)
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
      // Switching weeks resets the follow-up dialogue — questions are tied
      // to a specific report, not portable across weeks.
      setDialogueHistory([])
      setDialogueInput('')
      setDialogueStreamText('')
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

    setDialogueHistory([...historyBefore, { role: 'user', content: q }, { role: 'assistant', content: fullText.trim() }])
    setDialogueStreaming(false)
    setDialogueStreamText('')
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
  const behaviorCount = (memory.match(/^- \[/gm) || []).length

  const tabStyle = (t: PanelTab) => ({
    flex: 1, padding: '6px 0', fontSize: 11, fontWeight: tab === t ? 600 : 400,
    border: 'none', borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none', color: tab === t ? 'var(--accent-hover)' : 'var(--text-muted)',
    cursor: 'pointer',
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
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
        <button style={tabStyle('insights')} onClick={() => setTab('insights')}>
          洞察{behaviorCount > 0 && <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>({behaviorCount})</span>}
        </button>
      </div>

      {/* ===== Tab: Chat ===== */}
      {tab === 'chat' && (
        <>
          {conversations.length > 1 && (
            <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border-light)', display: 'flex', gap: 4, overflow: 'auto', flexShrink: 0 }}>
              {conversations.slice(0, 8).map(c => (
                <button key={c.id} onClick={() => setActiveConv(c)} style={{
                  padding: '2px 8px', fontSize: 10, borderRadius: 10, cursor: 'pointer',
                  border: c.id === activeConv?.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: c.id === activeConv?.id ? 'var(--accent-soft)' : 'transparent',
                  color: c.id === activeConv?.id ? 'var(--accent-hover)' : 'var(--text-muted)',
                  whiteSpace: 'nowrap', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{c.title}</button>
              ))}
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

          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border-light)', flexShrink: 0, display: 'flex', gap: 6, alignItems: 'flex-end' }}>
            <button onClick={handleNewConversation} style={{ padding: '6px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }} title="新对话">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <textarea value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder="问 Hermes..." rows={1}
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
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
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
              {generatingApprentice ? '学徒正在翻你这周的痕迹…' : '让学徒写本周观察'}
            </button>
            {apprenticeEntries.length > 0 && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                上次: {apprenticeEntries[0].weekCode} · {formatTimeAgo(apprenticeEntries[0].mtime)}
              </span>
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
                  对话是临时的，不保存。切换周报会重置。
                </div>
              </div>
            </div>
          )}

          {/* History list at bottom */}
          {apprenticeEntries.length > 0 && !generatingApprentice && (
            <div style={{
              borderTop: '1px solid var(--border-light)', background: 'var(--bg-warm)',
              padding: '6px 10px', maxHeight: 140, overflow: 'auto', flexShrink: 0,
            }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}>
                历史观察
              </div>
              {apprenticeEntries.map(e => (
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

      {/* ===== Tab: Insights ===== */}
      {tab === 'insights' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          {/* AI Insight card */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>AI 研究洞察</span>
              <button onClick={generateInsight} disabled={generatingInsight || !memory.trim()} style={{
                padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent-hover)',
              }}>
                {generatingInsight ? '分析中...' : insight ? '重新分析' : '生成洞察'}
              </button>
            </div>

            {generatingInsight && streamingText && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-warm)', border: '1px solid var(--border-light)', fontSize: 12, lineHeight: 1.8 }}>
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{streamingText}</ReactMarkdown>
                <span className="streaming-cursor" />
              </div>
            )}

            {!generatingInsight && insight && (
              <div style={{ padding: '10px 12px', borderRadius: 8, background: 'linear-gradient(135deg, var(--accent-soft), var(--bg-warm))', border: '1px solid var(--border-light)' }}>
                <div style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--text)' }}>
                  <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{insight.content}</ReactMarkdown>
                </div>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 6 }}>
                  基于 {insight.basedOn} 条行为记录 · {new Date(insight.generatedAt).toLocaleString('zh-CN')}
                </div>
              </div>
            )}

            {!generatingInsight && !insight && (
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11 }}>
                {memory.trim() ? '点击「生成洞察」让 AI 分析你的阅读行为' : '暂无行为记录。使用拾卷阅读、注释后，Hermes 会自动学习'}
              </div>
            )}
          </div>

          {/* Raw behavior log */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>行为记录</div>
            {behaviorCount === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>暂无记录</div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7, maxHeight: 300, overflow: 'auto' }}>
                {memory.split('\n').filter(l => l.startsWith('- [')).slice(-15).map((line, i) => (
                  <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid var(--border-light)' }}>{line.replace(/^- /, '')}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Skills tab removed in batch 28 — see note at top of file. */}
    </div>
  )
}
