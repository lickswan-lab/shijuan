import { ipcMain } from 'electron'
import type { HistoryEntry } from '../../src/types/library'

const GLM_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const GLM_OCR_URL = 'https://open.bigmodel.cn/api/paas/v4/layout_parsing'

let apiKey = ''

async function callGlmChat(model: string, messages: Array<{ role: string; content: any }>): Promise<string> {
  if (!apiKey) throw new Error('GLM API Key 未设置。请在设置中填入你的智谱AI API Key。')

  const response = await fetch(GLM_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GLM API error ${response.status}: ${text}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

// GLM-OCR uses dedicated layout_parsing endpoint
async function callGlmOcr(imageBase64: string): Promise<string> {
  if (!apiKey) throw new Error('GLM API Key 未设置。请在设置中填入你的智谱AI API Key。')

  const response = await fetch(GLM_OCR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'glm-ocr',
      file: `data:image/png;base64,${imageBase64}`
    })
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GLM-OCR API error ${response.status}: ${text}`)
  }

  const data = await response.json()
  console.log('[glm-ocr] Response keys:', Object.keys(data))

  // GLM-OCR layout_parsing returns text in md_results field
  let text = data.md_results || ''

  // Fallback: extract from layout_details if md_results is empty
  if (!text && data.layout_details) {
    const blocks: string[] = []
    for (const page of data.layout_details) {
      for (const block of page) {
        if (block.content) blocks.push(block.content)
      }
    }
    text = blocks.join('\n\n')
  }

  // Minimal cleanup: only fix LaTeX circled numbers, keep all markdown formatting
  const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
  text = text
    .replace(/\$\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
    .replace(/\$\\\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
    // Normalize excessive newlines
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  // Keep ## headings, **bold**, ![images]() etc. for frontend rendering

  if (!text) {
    throw new Error('OCR 未能提取到文字')
  }

  console.log('[glm-ocr] Extracted text length:', text.length)
  return text
}

/**
 * @deprecated Superseded by `registerAiApiIpc` in `./aiApi.ts` since v1.1. All
 * channels below (`set-glm-api-key`, `get-glm-api-key-status`, `glm-ocr`,
 * `glm-ocr-pdf`, `glm-interpret`, `glm-instant-feedback`, `glm-ask`) are also
 * registered there. Calling this function AFTER `registerAiApiIpc()` would
 * attempt to double-register the same channels and Electron would throw
 * "Attempted to register a second handler for ...". This file is kept only
 * for git history / reference and is not imported by `main.ts`.
 *
 * If you're reading this because you're about to re-enable it: don't. Delete
 * this file, or merge any missing pieces into aiApi.ts first.
 */
export function registerGlmApiIpc(): void {
  throw new Error(
    'registerGlmApiIpc is deprecated — the channels it registers are already ' +
    'registered by registerAiApiIpc (electron/ipc/aiApi.ts). Do not call this. ' +
    'See the @deprecated comment on this function.'
  )
  // Set API key
  ipcMain.handle('set-glm-api-key', async (_event, key: string) => {
    apiKey = key
    return true
  })

  // Get API key status
  ipcMain.handle('get-glm-api-key-status', async () => {
    return apiKey ? 'set' : 'not-set'
  })

  // OCR a page image using GLM-OCR dedicated model
  ipcMain.handle('glm-ocr', async (_event, imageBase64: string) => {
    try {
      const text = await callGlmOcr(imageBase64)
      return { success: true, text }
    } catch (err: any) {
      console.error('[glm-ocr] Error:', err.message)
      return { success: false, error: err.message }
    }
  })

  // OCR entire PDF file — send PDF directly to GLM-OCR (supports PDF up to 50MB)
  ipcMain.handle('glm-ocr-pdf', async (_event, pdfAbsPath: string) => {
    try {
      if (!apiKey) throw new Error('GLM API Key 未设置')

      const fs = await import('fs/promises')
      const pdfBuffer = await fs.readFile(pdfAbsPath)
      const pdfBase64 = pdfBuffer.toString('base64')

      console.log('[glm-ocr-pdf] Sending PDF, size:', Math.round(pdfBuffer.length / 1024), 'KB')

      const response = await fetch(GLM_OCR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'glm-ocr',
          file: `data:application/pdf;base64,${pdfBase64}`
        })
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`GLM-OCR API error ${response.status}: ${errText}`)
      }

      const data = await response.json()
      console.log('[glm-ocr-pdf] Response keys:', Object.keys(data))

      let text = data.md_results || ''

      if (!text && data.layout_details) {
        const blocks: string[] = []
        for (const page of data.layout_details) {
          for (const block of page) {
            if (block.content) blocks.push(block.content)
          }
        }
        text = blocks.join('\n\n')
      }

      // Minimal cleanup
      const circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩']
      text = text
        .replace(/\$\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
        .replace(/\$\\\\textcircled\{(\d+)\}\$/g, (_m: string, n: string) => circled[parseInt(n)-1] || `(${n})`)
        .replace(/\n{4,}/g, '\n\n\n')
        .trim()

      if (!text) throw new Error('OCR 未能提取到文字')

      // Extract per-page text if layout_details has page info
      const pageTexts: string[] = []
      if (data.layout_details && Array.isArray(data.layout_details)) {
        for (const page of data.layout_details) {
          const pageContent = page.map((b: any) => b.content || '').join('\n\n')
          pageTexts.push(pageContent)
        }
      }

      console.log('[glm-ocr-pdf] Extracted text length:', text.length, 'pages:', pageTexts.length)
      return { success: true, text, pageTexts, pageCount: data.data_info?.num_pages || pageTexts.length }
    } catch (err: any) {
      console.error('[glm-ocr-pdf] Error:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Interpret/explain selected text
  ipcMain.handle('glm-interpret', async (_event, text: string, context: string) => {
    try {
      const result = await callGlmChat('glm-4-flash', [
        {
          role: 'system',
          content: '你是学术文献阅读助手。请用中文解释以下学术文本的含义，帮助读者理解。要求：1）解释关键概念；2）理清论证逻辑；3）指出隐含假设；4）如涉及理论家，说明其思想形成的背景。语言要通俗易懂。'
        },
        {
          role: 'user',
          content: context
            ? `请解释这段文字：\n\n「${text}」\n\n上下文：${context}`
            : `请解释这段文字：\n\n「${text}」`
        }
      ])
      return { success: true, text: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Instant feedback: lightweight AI response after user writes a note
  ipcMain.handle('glm-instant-feedback', async (_event, userNote: string, selectedText: string, ocrContext: string, otherAnnotations: Array<{ text: string; note: string; entryTitle: string }>) => {
    try {
      // Build context about user's other annotations across all literature
      let otherNotesContext = ''
      if (otherAnnotations.length > 0) {
        const items = otherAnnotations.slice(0, 15).map(a =>
          `[${a.entryTitle}]「${a.text}」→ ${a.note}`
        ).join('\n')
        otherNotesContext = `\n\n用户在其他文献中的历史注释（检查是否有相关或矛盾的观点）：\n${items}`
      }

      const result = await callGlmChat('glm-4-flash', [
        {
          role: 'system',
          content: `你是学术文献阅读助手。用户正在阅读论文并写下了一条注释。请给出简短的即时反馈（1-3句话）。

优先级：
1. 指出用户注释与其历史注释之间的矛盾或呼应
2. 补充用户可能忽略的论证前提或隐含假设
3. 提出一个延伸思考的方向

要求：
- 如果没有有价值的反馈，只回复空字符串
- 不要复述用户已经写的内容
- 不要泛泛而谈，要具体
- 用中文回复，语气简洁克制`
        },
        {
          role: 'user',
          content: `论文原文片段：「${selectedText}」\n\n${ocrContext ? `页面上下文：${ocrContext.substring(0, 800)}\n\n` : ''}用户写的注释：${userNote}${otherNotesContext}`
        }
      ])
      return { success: true, text: result.trim() || null }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Q&A with history chain
  ipcMain.handle('glm-ask', async (_event, question: string, selectedText: string, history: HistoryEntry[], model?: string) => {
    try {
      const messages: Array<{ role: string; content: string }> = [
        {
          role: 'system',
          content: `你是学术文献阅读助手。用户正在阅读一段学术文本，请基于文本内容回答用户的问题。\n\n参考文本：\n「${selectedText}」`
        }
      ]

      // Add previous history as context
      for (const entry of history) {
        if (entry.type === 'ai_qa') {
          if (entry.userQuery) {
            messages.push({ role: 'user', content: entry.userQuery })
          }
          messages.push({ role: 'assistant', content: entry.content })
        } else if (entry.type === 'annotation' || entry.type === 'note') {
          messages.push({ role: 'user', content: `[我的笔记] ${entry.content}` })
        } else if (entry.type === 'question') {
          messages.push({ role: 'user', content: `[我的质疑] ${entry.content}` })
        } else if (entry.type === 'stance') {
          messages.push({ role: 'user', content: `[我的立场] ${entry.content}` })
        } else if (entry.type === 'ai_interpretation') {
          messages.push({ role: 'assistant', content: `[AI解读] ${entry.content}` })
        } else if (entry.type === 'ai_feedback') {
          messages.push({ role: 'assistant', content: `[AI反馈] ${entry.content}` })
        }
      }

      messages.push({ role: 'user', content: question })

      const result = await callGlmChat(model || 'glm-4-flash', messages)
      return { success: true, text: result }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })
}
