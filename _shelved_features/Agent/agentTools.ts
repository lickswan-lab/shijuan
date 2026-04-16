/**
 * Agent tool execution and ReAct response parser.
 * Extracts tool calls from LLM responses and executes them.
 */

// ===== ReAct parser =====

export interface ParsedToolCall {
  toolName: string
  argsJson: string
  fullMatch: string  // The full <tool>...</tool> text to replace
}

/**
 * Extract tool calls from LLM response text.
 * Format: <tool name="tool_name">{"arg": "value"}</tool>
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  const regex = /<tool\s+name="([^"]+)">([\s\S]*?)<\/tool>/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    calls.push({
      toolName: match[1],
      argsJson: match[2].trim(),
      fullMatch: match[0],
    })
  }

  return calls
}

/**
 * Check if the LLM response contains any tool calls.
 */
export function hasToolCalls(text: string): boolean {
  return /<tool\s+name="[^"]+">/i.test(text)
}

/**
 * Extract memory updates from LLM response.
 * Format: <memory_update>content</memory_update>
 */
export function extractMemoryUpdate(text: string): string | null {
  const match = text.match(/<memory_update>([\s\S]*?)<\/memory_update>/)
  return match ? match[1].trim() : null
}

/**
 * Clean the response: remove tool calls and memory updates for display.
 */
export function cleanResponse(text: string): string {
  return text
    .replace(/<tool\s+name="[^"]+">[\s\S]*?<\/tool>/g, '')
    .replace(/<memory_update>[\s\S]*?<\/memory_update>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ===== Tool execution =====

// Tools that can be executed purely in the renderer (from Zustand store)
const RENDERER_TOOLS = new Set(['create_memo', 'update_memo', 'get_current_context'])

/**
 * Execute a tool call. Some tools run in renderer (store access),
 * others delegate to main process (file system access).
 */
export async function executeTool(
  toolName: string,
  argsJson: string,
  storeHelpers: {
    getLibrary: () => any
    getCurrentEntry: () => any
    getSelectedText: () => string | null
    getCurrentPdfMeta: () => any
    createMemo: (title: string) => Promise<any>
    updateMemo: (id: string, updates: any) => Promise<void>
  }
): Promise<string> {
  // Renderer-side tools
  if (toolName === 'get_current_context') {
    const entry = storeHelpers.getCurrentEntry()
    const selectedText = storeHelpers.getSelectedText()
    const meta = storeHelpers.getCurrentPdfMeta()

    const recentAnnotations = (meta?.annotations || [])
      .slice(-5)
      .map((a: any) => ({
        selectedText: a.anchor?.selectedText?.slice(0, 80),
        lastNote: a.historyChain?.[a.historyChain.length - 1]?.content?.slice(0, 200),
      }))

    return JSON.stringify({
      currentEntry: entry ? { id: entry.id, title: entry.title, authors: entry.authors, tags: entry.tags } : null,
      selectedText: selectedText?.slice(0, 500) || null,
      recentAnnotations,
    })
  }

  if (toolName === 'create_memo') {
    try {
      const args = JSON.parse(argsJson)
      const memo = await storeHelpers.createMemo(args.title || '新笔记')
      if (args.content) {
        await storeHelpers.updateMemo(memo.id, { content: args.content })
      }
      return JSON.stringify({ success: true, memoId: memo.id, title: memo.title })
    } catch (err: any) {
      return JSON.stringify({ error: err.message })
    }
  }

  if (toolName === 'update_memo') {
    try {
      const args = JSON.parse(argsJson)
      await storeHelpers.updateMemo(args.memoId, { content: args.content })
      return JSON.stringify({ success: true })
    } catch (err: any) {
      return JSON.stringify({ error: err.message })
    }
  }

  // Main-process tools (file system access)
  const result = await window.electronAPI.agentExecuteTool(toolName, argsJson)
  return result.result
}
