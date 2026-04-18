import { useState, useRef, useEffect, useCallback } from 'react'
import { v4 as uuid } from 'uuid'
import ReactMarkdown from 'react-markdown'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import type { LectureSession, TranscriptSegment } from '../../types/library'
import { connectWebSpeech, connectXfyun, connectAliyun, type STTConnection } from './sttProviders'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

// ===== Setup dialog: choose provider + title + pre-docs =====
function LectureSetup({ onStart, onCancel }: {
  onStart: (title: string, provider: 'webspeech' | 'xfyun' | 'aliyun', preDocIds: string[]) => void
  onCancel: () => void
}) {
  const { library } = useLibraryStore()
  const [title, setTitle] = useState(`${new Date().toLocaleDateString('zh-CN')} 听课记录`)
  const [provider, setProvider] = useState<'webspeech' | 'xfyun' | 'aliyun'>('webspeech')
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set())

  const entries = library?.entries || []

  return (
    <div style={{ maxWidth: 500, margin: '60px auto', padding: '32px', background: 'var(--bg-warm)', borderRadius: 12, border: '1px solid var(--border)' }}>
      <h3 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)', marginBottom: 20 }}>开始听课</h3>

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>课程标题</label>
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          style={{ width: '100%', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, outline: 'none', background: 'var(--bg)' }}
          onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
          onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>转写服务</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {([['webspeech', '浏览器识别（免费）'], ['xfyun', '讯飞实时转写'], ['aliyun', '阿里云']] as const).map(([id, name]) => (
            <button
              key={id}
              onClick={() => setProvider(id)}
              style={{
                flex: 1, minWidth: 100, padding: '10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                border: provider === id ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: provider === id ? 'var(--accent-soft)' : 'var(--bg)',
                color: provider === id ? 'var(--accent-hover)' : 'var(--text-secondary)',
                fontWeight: provider === id ? 600 : 400,
              }}
            >{name}</button>
          ))}
        </div>
        {provider === 'webspeech' && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
            使用 Chrome 内置语音识别，无需配置，需联网
          </div>
        )}
        {provider !== 'webspeech' && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
            需在设置中配置对应 API Key
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', display: 'block', marginBottom: 8 }}>
          课前文献（可选，点击选择）
        </label>
        <div style={{ maxHeight: 150, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)' }}>
          {entries.length === 0 ? (
            <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>文献库为空</div>
          ) : entries.map(entry => {
            const selected = selectedDocs.has(entry.id)
            return (
              <div
                key={entry.id}
                onClick={() => setSelectedDocs(prev => {
                  const next = new Set(prev)
                  if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id)
                  return next
                })}
                style={{
                  padding: '6px 12px', fontSize: 12, cursor: 'pointer',
                  background: selected ? 'var(--accent-soft)' : 'transparent',
                  borderBottom: '1px solid var(--border-light)',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-hover)' }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ color: selected ? 'var(--accent)' : 'transparent', fontSize: 10 }}>✓</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title}</span>
              </div>
            )
          })}
        </div>
        {selectedDocs.size > 0 && (
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>已选 {selectedDocs.size} 篇</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel} style={{ fontSize: 13 }}>取消</button>
        <button
          className="btn btn-primary"
          onClick={() => onStart(title.trim() || '听课记录', provider, [...selectedDocs])}
          style={{ fontSize: 13, padding: '8px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          开始录音
        </button>
      </div>
    </div>
  )
}

// ===== Main Lecture Mode Component =====
export default function LectureMode() {
  const { library, saveLectureSession } = useLibraryStore()
  const { activeLectureId, setActiveLecture, isRecording, setIsRecording, selectedAiModel } = useUiStore()

  const [session, setSession] = useState<LectureSession | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([])
  const [interimText, setInterimText] = useState('')
  const [notes, setNotes] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [generatingSummary, setGeneratingSummary] = useState(false)
  const [streamingSummary, setStreamingSummary] = useState('')
  const [sttStatus, setSttStatus] = useState<'none' | 'connecting' | 'connected' | 'failed'>('none')
  const [sttError, setSttError] = useState('')

  const sttRef = useRef<STTConnection | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef(0)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  // Load existing session if activeLectureId is a real ID (not '__list__')
  useEffect(() => {
    if (activeLectureId && activeLectureId !== '__list__' && library) {
      const existing = library.lectureSessions?.find(s => s.id === activeLectureId)
      if (existing && !isRecording) {
        setSession(existing)
        setTranscript(existing.transcript)
        setNotes(existing.notes)
        setElapsed(existing.duration)
      }
    }
  }, [activeLectureId])

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript.length, interimText])

  // Timer
  useEffect(() => {
    if (isRecording && !paused) {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [isRecording, paused])

  // Ref to track paused state inside audio callback
  const pausedRef = useRef(false)
  useEffect(() => { pausedRef.current = paused }, [paused])
  const elapsedRef = useRef(0)
  useEffect(() => { elapsedRef.current = elapsed }, [elapsed])

  // Start recording + STT
  const handleStart = useCallback(async (title: string, provider: 'webspeech' | 'xfyun' | 'aliyun', preDocIds: string[]) => {
    const newSession: LectureSession = {
      id: uuid(), title, date: new Date().toISOString(), duration: 0,
      preDocIds, transcript: [], notes: '', provider, createdAt: new Date().toISOString(),
    }
    setSession(newSession)
    setShowSetup(false)
    setTranscript([])
    setNotes('')
    setElapsed(0)
    setIsRecording(true)
    setActiveLecture(newSession.id)
    startTimeRef.current = Date.now()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
      })

      // MediaRecorder for saving audio
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      audioChunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
      recorder.start(1000)
      recorderRef.current = recorder

      // Connect STT provider
      let sttConnection: STTConnection | null = null
      const sttCallbacks = {
        onInterim: (text: string) => setInterimText(text),
        onFinal: (text: string) => {
          setInterimText('')
          const seg: TranscriptSegment = {
            id: uuid(),
            startTime: elapsedRef.current,
            endTime: elapsedRef.current,
            text,
            isFinal: true,
          }
          setTranscript(prev => [...prev, seg])
        },
        onError: (err: string) => {
          console.error('[stt]', err)
          setSttError(err)
          setSttStatus('failed')
        },
        onClose: () => { console.log('[stt] closed') },
        onOpen: () => { setSttStatus('connected'); setSttError('') },
      }

      if (provider === 'webspeech') {
        // Web Speech API — free, no config needed, handles audio internally
        setSttStatus('connecting')
        try {
          sttConnection = connectWebSpeech(sttCallbacks)
        } catch (err: any) {
          console.error('[stt] Web Speech failed:', err)
          setSttError(err.message)
          setSttStatus('failed')
        }
      } else {
        // Xfyun / Aliyun — paid, need API keys + IPC auth
        const keyJson = await window.electronAPI.aiGetKey(`${provider}_stt`)
        if (keyJson) {
          setSttStatus('connecting')
          try {
            const config = JSON.parse(keyJson)
            if (provider === 'xfyun') {
              const signResult = await window.electronAPI.lectureXfyunSign(config.appid, config.apikey)
              if (!signResult.success || !signResult.url) throw new Error(signResult.error || '讯飞签名失败')
              sttConnection = connectXfyun(signResult.url, sttCallbacks)
            } else {
              const tokenResult = await window.electronAPI.lectureAliyunToken(config.akid, config.aksecret)
              if (!tokenResult.success || !tokenResult.token) throw new Error(tokenResult.error || '阿里云 Token 获取失败')
              sttConnection = connectAliyun(tokenResult.token, config.appkey, sttCallbacks)
            }
          } catch (err: any) {
            console.error('[stt] Connection failed:', err)
            setSttError(err.message || String(err))
            setSttStatus('failed')
          }
        } else {
          setSttStatus('none')
        }
      }

      // PCM audio processing — only needed for WebSocket-based providers (xfyun/aliyun)
      // Web Speech API handles audio capture internally
      if (sttConnection && provider !== 'webspeech') {
        const audioCtx = new AudioContext({ sampleRate: 16000 })
        audioCtxRef.current = audioCtx
        const source = audioCtx.createMediaStreamSource(stream)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        const conn = sttConnection

        source.connect(processor)
        processor.connect(audioCtx.destination)

        processor.onaudioprocess = (e) => {
          if (pausedRef.current) return
          const input = e.inputBuffer.getChannelData(0)
          const pcm = new Int16Array(input.length)
          for (let i = 0; i < input.length; i++) {
            pcm[i] = Math.max(-32768, Math.min(32767, Math.floor(input[i] * 32768)))
          }
          conn.send(pcm.buffer)
        }
      }

      sttRef.current = sttConnection
    } catch (err: any) {
      alert(`麦克风访问失败：${err.message}`)
      setIsRecording(false)
    }
  }, [])

  // Cleanup on unmount — stop all recording resources
  useEffect(() => {
    return () => {
      if (sttRef.current) { sttRef.current.close(); sttRef.current = null }
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
        recorderRef.current.stream.getTracks().forEach(t => t.stop())
      }
      if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null }
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  // Stop recording
  const handleStop = useCallback(async () => {
    setIsRecording(false)
    setPaused(false)
    setSttStatus('none')

    // Stop STT
    if (sttRef.current) {
      sttRef.current.close()
      sttRef.current = null
    }

    // Stop AudioContext
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }

    // Stop MediaRecorder
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
      recorderRef.current.stream.getTracks().forEach(t => t.stop())
    }

    if (timerRef.current) clearInterval(timerRef.current)

    // Save audio
    if (session && audioChunksRef.current.length > 0) {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
      const buf = await blob.arrayBuffer()
      const result = await window.electronAPI.lectureSaveAudio(session.id, buf)
      if (result.success) session.audioPath = result.path
    }

    // Save session
    if (session) {
      const updated = { ...session, duration: elapsed, transcript, notes }
      saveLectureSession(updated)
      await window.electronAPI.lectureSave(updated)
      setSession(updated)

      // Auto-create a memo in the notes system
      const transcriptText = transcript.map(s => `[${formatTime(s.startTime)}] ${s.text}`).join('\n')
      const memoContent = `# ${session.title}\n\n_${new Date(session.date).toLocaleDateString('zh-CN')} · ${formatTime(elapsed)}_\n\n## 转写记录\n\n${transcriptText || '（无转写）'}\n\n## 课堂笔记\n\n${notes || '（无笔记）'}`
      const { createMemo, updateMemo } = useLibraryStore.getState()
      const memo = await createMemo(`[听课] ${session.title}`)
      await updateMemo(memo.id, { content: memoContent })
    }
  }, [session, elapsed, transcript, notes])

  // Pause/Resume
  const handlePause = useCallback(() => {
    setPaused(!paused)
  }, [paused])

  // Generate AI summary
  const handleGenerateSummary = useCallback(async () => {
    if (!session || generatingSummary) return
    setGeneratingSummary(true)
    setStreamingSummary('')

    const transcriptText = transcript.map(s => `[${formatTime(s.startTime)}] ${s.text}`).join('\n')

    // Get pre-doc titles
    const preDocTitles = (session.preDocIds || []).map(id => {
      const entry = library?.entries.find(e => e.id === id)
      return entry?.title || ''
    }).filter(Boolean).join('、')

    const systemPrompt = `你是一位学术课程助教。请基于以下课堂录音转写、学生笔记和课前文献，生成一份结构化的课程记录。

要求：
1. 提取课程大纲（带时间戳）
2. 列出关键概念和定义
3. 标注学生笔记中的重点与课程内容的对应关系
4. 如果课前文献中有相关内容，指出对应关系
5. 生成 3-5 个复习问题
6. 用「你」称呼学生`

    const userMsg = `===== 课堂转写 =====\n${transcriptText || '（无转写记录）'}\n\n===== 学生笔记 =====\n${notes || '（无笔记）'}\n\n===== 课前文献 =====\n${preDocTitles || '（无课前文献）'}`

    const streamId = uuid()
    let fullText = ''

    const cleanup = window.electronAPI.onAiStreamChunk((sid, chunk) => {
      if (sid !== streamId) return
      fullText += chunk
      setStreamingSummary(fullText)
    })

    try {
      const result = await window.electronAPI.aiChatStream(streamId, selectedAiModel, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ])
      if (!result.success) fullText = `生成失败：${result.error}`
    } finally {
      cleanup()
    }

    setStreamingSummary('')
    if (session && fullText) {
      const updated = { ...session, aiSummary: fullText, aiModel: selectedAiModel, duration: elapsed, transcript, notes }
      setSession(updated)
      saveLectureSession(updated)
      await window.electronAPI.lectureSave(updated)
    }
    setGeneratingSummary(false)
  }, [session, transcript, notes, elapsed, selectedAiModel, library])

  // Add manual transcript (for when STT isn't connected)
  const addManualSegment = useCallback((text: string) => {
    if (!text.trim()) return
    const seg: TranscriptSegment = {
      id: uuid(),
      startTime: elapsed,
      endTime: elapsed,
      text: text.trim(),
      isFinal: true,
    }
    setTranscript(prev => [...prev, seg])
  }, [elapsed])

  // ===== No active lecture — show list or setup =====
  const showList = !activeLectureId || activeLectureId === '__list__'
  if (showList && !showSetup && !isRecording) {
    const sessions = library?.lectureSessions || []
    return (
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
        <div style={{ maxWidth: 600, margin: '0 auto', padding: '40px 32px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>听课记录</h2>
            <button
              onClick={() => setShowSetup(true)}
              style={{
                padding: '8px 16px', fontSize: 13, fontWeight: 500,
                background: 'var(--accent)', color: '#fff', border: 'none',
                borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              开始听课
            </button>
          </div>

          {sessions.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 12 }}>
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              </svg>
              <div style={{ fontSize: 13, marginBottom: 6 }}>还没有听课记录</div>
              <div style={{ fontSize: 12 }}>点击上方按钮开始你的第一次听课</div>
            </div>
          ) : sessions.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveLecture(s.id)}
              style={{
                padding: '14px 16px', marginBottom: 8, borderRadius: 8,
                background: 'var(--bg-warm)', border: '1px solid var(--border)',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
            >
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>{s.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 12 }}>
                <span>{new Date(s.date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span>{formatTime(s.duration)}</span>
                <span>{s.transcript.length} 段转写</span>
                {s.aiSummary && <span style={{ color: 'var(--success)' }}>AI 总结</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (showSetup) {
    return (
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)' }}>
        <LectureSetup onStart={handleStart} onCancel={() => { setShowSetup(false); setActiveLecture(null) }} />
      </div>
    )
  }

  // ===== Active lecture (recording or viewing) =====
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* Control bar */}
      <div style={{
        padding: '10px 20px', borderBottom: '1px solid var(--border-light)',
        display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
      }}>
        <button
          onClick={() => { if (isRecording) handleStop(); setActiveLecture(null); setShowSetup(false) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', flex: 1 }}>
          {session?.title || '听课记录'}
        </span>

        {/* Timer */}
        <span style={{
          fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: isRecording ? 'var(--danger)' : 'var(--text-muted)',
        }}>
          {isRecording && !paused && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', marginRight: 8, animation: 'cursor-blink 1s infinite' }} />}
          {formatTime(elapsed)}
        </span>

        {/* STT status indicator */}
        {isRecording && sttStatus !== 'none' && (
          <span style={{
            fontSize: 10, padding: '3px 8px', borderRadius: 10,
            display: 'flex', alignItems: 'center', gap: 4,
            ...(sttStatus === 'connecting' ? { background: '#fef3cd', color: '#856404' } :
               sttStatus === 'connected' ? { background: '#d4edda', color: '#155724' } :
               { background: '#f8d7da', color: '#721c24' }),
          }}>
            <span style={{
              display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
              background: sttStatus === 'connecting' ? '#ffc107' : sttStatus === 'connected' ? '#28a745' : '#dc3545',
              ...(sttStatus === 'connecting' ? { animation: 'cursor-blink 1s infinite' } : {}),
            }} />
            {sttStatus === 'connecting' ? '转写连接中' : sttStatus === 'connected' ? '转写中' : '转写不可用'}
          </span>
        )}
        {isRecording && sttError && (
          <span title={sttError} style={{ fontSize: 10, color: '#721c24', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sttError}
          </span>
        )}
        {isRecording && sttStatus === 'none' && (
          <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 10, background: 'var(--bg-warm)', color: 'var(--text-muted)' }}>
            未配置转写
          </span>
        )}

        {isRecording && (
          <>
            <button onClick={handlePause} style={{
              padding: '6px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
              background: 'var(--bg-warm)', border: '1px solid var(--border)', color: 'var(--text)',
            }}>
              {paused ? '继续' : '暂停'}
            </button>
            <button onClick={handleStop} style={{
              padding: '6px 12px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
              background: 'var(--danger)', border: 'none', color: '#fff',
            }}>
              停止
            </button>
          </>
        )}

        {!isRecording && session && !session.aiSummary && (
          <button onClick={handleGenerateSummary} disabled={generatingSummary} style={{
            padding: '6px 14px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
            background: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent-hover)',
          }}>
            {generatingSummary ? '生成中...' : '生成 AI 课程记录'}
          </button>
        )}
      </div>

      {/* Main content: transcript + notes */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Transcript */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-light)' }}>
          <div style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
            实时转写
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
            {transcript.map(seg => (
              <div key={seg.id} style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', marginRight: 8 }}>
                  [{formatTime(seg.startTime)}]
                </span>
                <span style={{ fontSize: 13, color: seg.isFinal ? 'var(--text)' : 'var(--text-muted)', lineHeight: 1.7 }}>
                  {seg.text}
                </span>
              </div>
            ))}
            {interimText && (
              <div style={{ marginBottom: 8, opacity: 0.5 }}>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginRight: 8 }}>[{formatTime(elapsed)}]</span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>{interimText}</span>
              </div>
            )}
            <div ref={transcriptEndRef} />

            {transcript.length === 0 && !isRecording && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 12 }}>
                {session?.aiSummary ? '查看右侧 AI 课程记录' : '暂无转写记录'}
              </div>
            )}
            {transcript.length === 0 && isRecording && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 12 }}>
                {sttStatus === 'connected' ? '正在录音中，等待语音转写...' :
                 sttStatus === 'connecting' ? '正在连接转写服务...' :
                 sttStatus === 'failed' ? '转写服务连接失败，仅录音模式' :
                 '未配置转写服务，仅录音模式'}
                <br /><br />
                <span style={{ fontSize: 11 }}>
                  {sttStatus === 'none' && '前往设置 → 语音转写 配置讯飞或阿里云 API'}
                  {sttStatus === 'failed' && (sttError || '请检查 API 配置是否正确')}
                  {(sttStatus === 'connected' || sttStatus === 'connecting') && '录音会同时保存到本地'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right: Notes + AI Summary */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-light)', flexShrink: 0 }}>
            我的笔记
          </div>
          <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {/* Notes textarea */}
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="在这里记录你的课堂笔记..."
              style={{
                flex: 1, minHeight: 200, padding: '12px 16px', border: 'none', outline: 'none',
                fontSize: 13, lineHeight: 1.8, resize: 'none', fontFamily: 'var(--font)',
                background: 'transparent', color: 'var(--text)',
              }}
            />

            {/* AI Summary */}
            {(session?.aiSummary || streamingSummary) && (
              <div style={{
                borderTop: '1px solid var(--border-light)', padding: '16px',
                background: 'var(--bg-warm)',
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-hover)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                  </svg>
                  AI 课程记录
                  {generatingSummary && <span className="loading-spinner" style={{ width: 12, height: 12 }} />}
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text)' }}>
                  <ReactMarkdown>
                    {streamingSummary || session?.aiSummary || ''}
                  </ReactMarkdown>
                  {generatingSummary && <span className="streaming-cursor" />}
                </div>
                {!isRecording && session?.aiSummary && !generatingSummary && (
                  <button onClick={handleGenerateSummary} style={{
                    marginTop: 8, padding: '4px 10px', fontSize: 10,
                    background: 'transparent', color: 'var(--text-muted)',
                    border: '1px solid var(--border-light)', borderRadius: 4, cursor: 'pointer',
                  }}>重新生成</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom: Pre-docs */}
      {session && session.preDocIds.length > 0 && (
        <div style={{
          padding: '8px 16px', borderTop: '1px solid var(--border-light)',
          display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          fontSize: 11, color: 'var(--text-muted)',
        }}>
          <span>课前文献：</span>
          {session.preDocIds.map(id => {
            const entry = library?.entries.find(e => e.id === id)
            return entry ? (
              <span key={id} style={{
                padding: '2px 8px', background: 'var(--bg-warm)', border: '1px solid var(--border)',
                borderRadius: 4, fontSize: 10, color: 'var(--text-secondary)',
              }}>
                {entry.title}
              </span>
            ) : null
          })}
        </div>
      )}
    </div>
  )
}
