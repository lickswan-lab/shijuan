/**
 * Speech-to-text providers for lecture mode.
 * Runs in renderer process.
 * - Web Speech API: free, browser-native, no config needed
 * - Xfyun/Aliyun: paid, WebSocket-based, auth via main process IPC
 */

// ===== Common interface =====

export interface STTCallbacks {
  onInterim: (text: string) => void    // interim/partial result
  onFinal: (text: string) => void      // final confirmed result
  onError: (error: string) => void
  onClose: () => void
  onOpen?: () => void                  // connection established
}

export interface STTConnection {
  send: (audioData: ArrayBuffer) => void
  close: () => void
}

// ===== Web Speech API (free, browser-native) =====
// Uses Chrome's built-in speech recognition — no API key needed
// Supports Chinese (zh-CN), auto-restarts on end to keep continuous recognition

export function connectWebSpeech(callbacks: STTCallbacks): STTConnection {
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SpeechRecognition) {
    callbacks.onError('浏览器不支持 Web Speech API')
    return { send: () => {}, close: () => {} }
  }

  const recognition = new SpeechRecognition()
  recognition.lang = 'zh-CN'
  recognition.continuous = true
  recognition.interimResults = true
  recognition.maxAlternatives = 1

  let stopped = false

  recognition.onstart = () => {
    console.log('[webspeech] Started')
    callbacks.onOpen?.()
  }

  recognition.onresult = (event: any) => {
    // Process results from the last resultIndex onwards
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0]?.transcript || ''
      if (!text.trim()) continue

      if (result.isFinal) {
        callbacks.onFinal(text)
      } else {
        callbacks.onInterim(text)
      }
    }
  }

  recognition.onerror = (event: any) => {
    const msg = event.error === 'no-speech' ? '' :  // silent, not a real error
                event.error === 'aborted' ? '' :
                event.error === 'network' ? '语音识别网络错误（需要联网）' :
                event.error === 'not-allowed' ? '麦克风权限被拒绝' :
                `语音识别错误: ${event.error}`
    if (msg) {
      console.error('[webspeech]', msg)
      callbacks.onError(msg)
    }
  }

  recognition.onend = () => {
    // Auto-restart to keep continuous recognition (Web Speech API stops periodically)
    if (!stopped) {
      try { recognition.start() } catch {}
    } else {
      callbacks.onClose()
    }
  }

  try {
    recognition.start()
  } catch (err: any) {
    callbacks.onError(`语音识别启动失败: ${err.message}`)
  }

  return {
    send: () => {},  // Web Speech API handles audio internally, no manual PCM needed
    close: () => {
      stopped = true
      try { recognition.stop() } catch {}
    }
  }
}

// ===== iFlytek (讯飞) Real-time STT =====
// Docs: https://www.xfyun.cn/doc/asr/rtasr/API.html
// Auth signature computed in main process via lecture-xfyun-sign IPC

export function connectXfyun(
  signedUrl: string,
  callbacks: STTCallbacks
): STTConnection {
  const ws = new WebSocket(signedUrl)
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    console.log('[xfyun-stt] Connected')
    callbacks.onOpen?.()
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string)
      if (data.action === 'error') {
        callbacks.onError(`讯飞转写错误: ${data.desc || data.code}`)
        return
      }
      if (data.action === 'result') {
        const result = JSON.parse(data.data)
        // Combine word segments: cn.st.rt[].ws[].cw[].w
        const text = (result.cn?.st?.rt || [])
          .flatMap((rt: any) => rt.ws || [])
          .flatMap((w: any) => w.cw || [])
          .map((cw: any) => cw.w || '')
          .join('')

        if (result.cn?.st?.type === '0') {
          // Final result
          if (text.trim()) callbacks.onFinal(text)
        } else {
          // Interim result
          if (text.trim()) callbacks.onInterim(text)
        }
      }
    } catch (err) {
      console.error('[xfyun-stt] Parse error:', err)
    }
  }

  ws.onerror = () => {
    callbacks.onError('讯飞 WebSocket 连接失败')
  }

  ws.onclose = () => {
    callbacks.onClose()
  }

  return {
    send: (audioData: ArrayBuffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioData)
      }
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        // Send end signal per iFlytek protocol
        ws.send(JSON.stringify({ end: true }))
        setTimeout(() => ws.close(), 500)
      }
    }
  }
}

// ===== Alibaba Cloud (阿里云) Real-time ASR =====
// Docs: https://help.aliyun.com/document_detail/324262.html
// Token fetched in main process via lecture-aliyun-token IPC

export function connectAliyun(
  token: string,
  appkey: string,
  callbacks: STTCallbacks
): STTConnection {
  const taskId = crypto.randomUUID().replace(/-/g, '')
  const url = `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=${encodeURIComponent(token)}`

  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  let started = false

  ws.onopen = () => {
    console.log('[aliyun-stt] Connected, starting recognition...')
    // Send StartTranscription command
    const startMsg = {
      header: {
        message_id: crypto.randomUUID().replace(/-/g, ''),
        task_id: taskId,
        namespace: 'SpeechTranscriber',
        name: 'StartTranscription',
        appkey,
      },
      payload: {
        format: 'pcm',
        sample_rate: 16000,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
      }
    }
    ws.send(JSON.stringify(startMsg))
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string)
      const name = data.header?.name

      if (name === 'TranscriptionStarted') {
        started = true
        console.log('[aliyun-stt] Transcription started')
        callbacks.onOpen?.()
      } else if (name === 'TranscriptionResultChanged') {
        const text = data.payload?.result || ''
        if (text.trim()) callbacks.onInterim(text)
      } else if (name === 'SentenceEnd') {
        const text = data.payload?.result || ''
        if (text.trim()) callbacks.onFinal(text)
      } else if (name === 'TaskFailed') {
        callbacks.onError(`阿里云转写错误: ${data.payload?.status_text || data.header?.status_text || '未知错误'}`)
      } else if (name === 'TranscriptionCompleted') {
        console.log('[aliyun-stt] Transcription completed')
      }
    } catch (err) {
      console.error('[aliyun-stt] Parse error:', err)
    }
  }

  ws.onerror = () => {
    callbacks.onError('阿里云 WebSocket 连接失败')
  }

  ws.onclose = () => {
    callbacks.onClose()
  }

  return {
    send: (audioData: ArrayBuffer) => {
      if (ws.readyState === WebSocket.OPEN && started) {
        ws.send(audioData)
      }
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN) {
        const stopMsg = {
          header: {
            message_id: crypto.randomUUID().replace(/-/g, ''),
            task_id: taskId,
            namespace: 'SpeechTranscriber',
            name: 'StopTranscription',
            appkey,
          }
        }
        ws.send(JSON.stringify(stopMsg))
        setTimeout(() => ws.close(), 1000)
      }
    }
  }
}
