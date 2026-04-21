import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Library, PdfMeta, HistoryEntry, ReadingLogEvent, ReadingLog, Persona, PersonaSource } from '../src/types/library'

const electronAPI = {
  // Library (central storage)
  loadLibrary: (): Promise<Library | null> =>
    ipcRenderer.invoke('load-library'),
  saveLibrary: (data: Library): Promise<boolean> =>
    ipcRenderer.invoke('save-library', data),

  // Import
  importFiles: (): Promise<string[]> =>
    ipcRenderer.invoke('import-files'),
  importFolder: (): Promise<string[]> =>
    ipcRenderer.invoke('import-folder'),
  scanDroppedPaths: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('scan-dropped-paths', paths),
  getPathForFile: (file: File): string =>
    webUtils.getPathForFile(file),
  checkFileExists: (absPath: string): Promise<boolean> =>
    ipcRenderer.invoke('check-file-exists', absPath),
  fullTextSearch: (query: string, libraryData: any): Promise<Array<{
    entryId: string; entryTitle: string; type: 'ocr' | 'annotation';
    text: string; pageNumber?: number; annotationId?: string;
  }>> => ipcRenderer.invoke('full-text-search', query, libraryData),

  // PDF meta (stored centrally by entry ID)
  loadPdfMeta: (entryId: string): Promise<PdfMeta | null> =>
    ipcRenderer.invoke('load-pdf-meta', entryId),
  savePdfMeta: (entryId: string, data: PdfMeta): Promise<boolean> =>
    ipcRenderer.invoke('save-pdf-meta', entryId, data),
  deletePdfMeta: (entryId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('delete-pdf-meta', entryId),

  // File operations
  readFileBuffer: (filePath: string): Promise<Buffer> =>
    ipcRenderer.invoke('read-file-buffer', filePath),
  deleteFile: (absPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('delete-file', absPath),
  showItemInFolder: (absPath: string): void =>
    ipcRenderer.send('show-item-in-folder', absPath),

  // Export
  exportFile: (defaultName: string, filters: Array<{ name: string; extensions: string[] }>, content: string | Buffer): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('export-file', defaultName, filters, content),
  // Save a translated text as .txt in ~/.lit-manager/translations/ — returns
  // the absolute path the renderer can attach to a new LibraryEntry.
  saveTranslationAsFile: (title: string, content: string): Promise<{ success: boolean; absPath?: string; error?: string }> =>
    ipcRenderer.invoke('save-translation-as-file', title, content),
  exportFullBackup: (): Promise<{ success: boolean; path?: string; error?: string; stats?: { entryCount: number; memoCount: number; metaCount: number; apprenticeCount: number } }> =>
    ipcRenderer.invoke('export-full-backup'),
  pickAndReadBibFile: (): Promise<{ success: boolean; content?: string; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('pick-and-read-bib-file'),

  // OCR files
  saveOcrText: (pdfAbsPath: string, text: string): Promise<string> =>
    ipcRenderer.invoke('save-ocr-text', pdfAbsPath, text),
  readOcrText: (pdfAbsPath: string): Promise<{ exists: boolean; text: string | null; path: string }> =>
    ipcRenderer.invoke('read-ocr-text', pdfAbsPath),

  // === AI API (multi-provider) ===
  aiGetProviders: (): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }>; hasKey: boolean; noKey?: boolean; apiKeyUrl?: string; freeTierHint?: string }>> =>
    ipcRenderer.invoke('ai-get-providers'),
  aiSetKey: (providerId: string, key: string): Promise<boolean> =>
    ipcRenderer.invoke('ai-set-key', providerId, key),
  aiRemoveKey: (providerId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai-remove-key', providerId),
  aiGetKey: (providerId: string): Promise<string | null> =>
    ipcRenderer.invoke('ai-get-key', providerId),
  aiGetConfigured: (): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>> =>
    ipcRenderer.invoke('ai-get-configured'),
  ollamaProbe: (): Promise<{ available: boolean; models: Array<{ id: string; name: string }> }> =>
    ipcRenderer.invoke('ollama-probe'),
  claudeCliProbe: (): Promise<{ available: boolean; version: string | null }> =>
    ipcRenderer.invoke('claude-cli-probe'),

  // === Legacy GLM compat (OCR, instant feedback) ===
  setGlmApiKey: (key: string): Promise<boolean> =>
    ipcRenderer.invoke('set-glm-api-key', key),
  getGlmApiKeyStatus: (): Promise<'set' | 'not-set'> =>
    ipcRenderer.invoke('get-glm-api-key-status'),
  glmOcr: (imageBase64: string): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('glm-ocr', imageBase64),
  glmOcrPdf: (pdfAbsPath: string, opts?: { entryId?: string }): Promise<{ success: boolean; text?: string; pageTexts?: string[]; pageCount?: number; chunks?: number; error?: string }> =>
    ipcRenderer.invoke('glm-ocr-pdf', pdfAbsPath, opts),
  onOcrProgress: (callback: (payload: { entryId?: string; chunkIndex: number; totalChunks: number; phase: 'start' | 'done' | 'error' }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('glm-ocr-progress', handler)
    return () => { ipcRenderer.removeListener('glm-ocr-progress', handler) }
  },
  glmInterpret: (text: string, context: string): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('glm-interpret', text, context),
  glmInstantFeedback: (
    userNote: string, selectedText: string, ocrContext: string,
    otherAnnotations: Array<{ text: string; note: string; entryTitle: string }>
  ): Promise<{ success: boolean; text?: string | null; error?: string }> =>
    ipcRenderer.invoke('glm-instant-feedback', userNote, selectedText, ocrContext, otherAnnotations),
  glmAsk: (question: string, selectedText: string, history: HistoryEntry[], model?: string): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('glm-ask', question, selectedText, history, model),

  // === Streaming AI ===
  aiChatStream: (streamId: string, modelSpec: string, messages: Array<{ role: string; content: string }>, opts?: { webSearch?: boolean }): Promise<{ success: boolean; text?: string; error?: string; aborted?: boolean }> =>
    ipcRenderer.invoke('ai-chat-stream', streamId, modelSpec, '', messages, opts),
  aiAbortStream: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai-abort-stream', streamId),

  // Main process tells the renderer it just updated library.json (e.g. midnight
  // scheduler wrote a reading log). The renderer should reload its in-memory
  // library so the next save doesn't stomp the backend-added fields.
  onLibraryChangedOnDisk: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('library-changed-on-disk', handler)
    return () => { ipcRenderer.removeListener('library-changed-on-disk', handler) }
  },
  onAiStreamChunk: (callback: (streamId: string, chunk: string) => void) => {
    const handler = (_event: any, streamId: string, chunk: string) => callback(streamId, chunk)
    ipcRenderer.on('ai-stream-chunk', handler)
    return () => { ipcRenderer.removeListener('ai-stream-chunk', handler) }
  },
  onAiStreamDone: (callback: (streamId: string, fullText: string) => void) => {
    const handler = (_event: any, streamId: string, fullText: string) => callback(streamId, fullText)
    ipcRenderer.on('ai-stream-done', handler)
    return () => { ipcRenderer.removeListener('ai-stream-done', handler) }
  },
  onAiStreamError: (callback: (streamId: string, error: string) => void) => {
    const handler = (_event: any, streamId: string, error: string) => callback(streamId, error)
    ipcRenderer.on('ai-stream-error', handler)
    return () => { ipcRenderer.removeListener('ai-stream-error', handler) }
  },

  // === Agent (Hermes research assistant) ===
  agentLoadMemory: (): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('agent-load-memory'),
  agentSaveMemory: (content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-memory', content),
  agentExecuteTool: (toolName: string, argsJson: string): Promise<{ success: boolean; result: string }> =>
    ipcRenderer.invoke('agent-execute-tool', toolName, argsJson),
  agentLoadConversations: (): Promise<{ success: boolean; conversations: any[]; error?: string }> =>
    ipcRenderer.invoke('agent-load-conversations'),
  agentSaveConversation: (conversation: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-conversation', conversation),
  agentDeleteConversation: (conversationId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-delete-conversation', conversationId),
  agentLoadInsight: (): Promise<{ success: boolean; insight: any | null }> =>
    ipcRenderer.invoke('agent-load-insight'),
  agentSaveInsight: (insight: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-insight', insight),
  agentLoadSkills: (): Promise<{ success: boolean; skills: any[] }> =>
    ipcRenderer.invoke('agent-load-skills'),
  agentSaveSkills: (skills: any[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-skills', skills),

  // === Apprentice (weekly observation log) ===
  apprenticeCollectContext: (params?: string | { startIso?: string; endIso?: string; targetDateIso?: string }): Promise<{ success: boolean; context?: any; error?: string }> =>
    ipcRenderer.invoke('apprentice-collect-context', params),
  apprenticeList: (): Promise<{ success: boolean; entries: Array<{ weekCode: string; size: number; mtime: string }>; error?: string }> =>
    ipcRenderer.invoke('apprentice-list'),
  apprenticeLoad: (weekCode: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('apprentice-load', weekCode),
  apprenticeSave: (weekCode: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('apprentice-save', weekCode, content),
  apprenticeDelete: (weekCode: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('apprentice-delete', weekCode),
  apprenticeLoadDialogue: (weekCode: string): Promise<{ success: boolean; history: Array<{ role: string; content: string; createdAt?: string }>; error?: string }> =>
    ipcRenderer.invoke('apprentice-load-dialogue', weekCode),
  apprenticeSaveDialogue: (weekCode: string, history: Array<{ role: string; content: string; createdAt?: string }>): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('apprentice-save-dialogue', weekCode, history),

  // === 召唤 (Personas) ===
  personaList: (): Promise<{ success: boolean; entries: Array<{ id: string; name: string; canonicalName?: string; identity?: string; updatedAt: string; currentFitnessTotal?: number }>; error?: string }> =>
    ipcRenderer.invoke('persona-list'),
  personaLoad: (id: string): Promise<{ success: boolean; persona?: Persona; error?: string }> =>
    ipcRenderer.invoke('persona-load', id),
  personaSave: (persona: Persona): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('persona-save', persona),
  personaDelete: (id: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('persona-delete', id),
  // Multi-source web search (Wikipedia zh+en + Baidu Baike + DuckDuckGo)
  nuwaSearch: (query: string): Promise<{ success: boolean; sources: PersonaSource[]; error?: string }> =>
    ipcRenderer.invoke('nuwa-search', query),
  // Fetch full body for a selected source
  nuwaFetchPage: (source: PersonaSource): Promise<{ success: boolean; fullContent?: string; error?: string }> =>
    ipcRenderer.invoke('nuwa-fetch-page', source),
  // Open a source URL in the user's default browser
  nuwaOpenUrl: (url: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('nuwa-open-url', url),
  // Export a persona's skill to a directory (defaults to ~/.claude/skills/<slug>/)
  personaExportSkill: (personaId: string, opts?: { outDir?: string; includeResearch?: boolean }): Promise<{ success: boolean; skillDir?: string; error?: string }> =>
    ipcRenderer.invoke('persona-export-skill', personaId, opts),
  // Dialog — pick a root directory to export skill under
  personaPickExportDir: (): Promise<{ success: boolean; dir?: string }> =>
    ipcRenderer.invoke('persona-pick-export-dir'),
  // Import an existing skill (SKILL.md file or its containing directory)
  personaImportSkill: (absPath: string): Promise<{ success: boolean; persona?: Persona; error?: string }> =>
    ipcRenderer.invoke('persona-import-skill', absPath),
  // Dialog — pick a SKILL.md file or skill directory to import
  personaPickSkillPath: (): Promise<{ success: boolean; path?: string }> =>
    ipcRenderer.invoke('persona-pick-skill-path'),
  // Build the system prompt used when summoning a persona for chat / annotation.
  // When userQuery is passed, the prompt is augmented with retrieved original-
  // text snippets (embedding cos sim if index built, else BM25) from
  // persona.sourcesUsed so the AI can cite real passages via [资料 N] instead
  // of reciting pretrained general knowledge.
  personaGetSystemPrompt: (personaId: string, userQuery?: string): Promise<{
    success: boolean
    systemPrompt?: string
    persona?: { id: string; name: string; canonicalName?: string; skillMode: 'legacy' | 'distilled' | 'imported' }
    retrievedCount?: number
    retrievalMode?: 'embedding' | 'bm25' | 'empty'
    // Wave-3: chunks injected into the prompt — UI uses these for citation
    // reverse-parse (find [资料 N] in AI output → look up source card).
    chunks?: Array<{
      n: number
      sourceId: string
      sourceTitle: string
      sourceType: string
      trust: string
      chunkIdx: number
      text: string
      url?: string
    }>
    totalChunks?: number
    error?: string
  }> =>
    ipcRenderer.invoke('persona-get-system-prompt', personaId, userQuery),
  // Directly retrieve top-K chunks for a persona + query (embedding if
  // indexed, BM25 fallback). persona-get-system-prompt already calls this
  // internally when userQuery is passed.
  personaRagRetrieve: (personaId: string, query: string, topK?: number): Promise<{
    success: boolean
    chunks?: Array<{ sourceId: string; sourceTitle: string; sourceType: string; trust: string; chunkIdx: number; text: string; score: number }>
    totalChunks?: number
    retrievalMode?: 'embedding' | 'bm25' | 'empty'
    error?: string
  }> => ipcRenderer.invoke('persona-rag-retrieve', personaId, query, topK),
  // Build the persona's semantic index (Phase A). Embeds every chunk via the
  // chosen provider (defaults to whichever key is configured; GLM preferred for
  // Chinese users, OpenAI fallback). Persisted to <personaId>.rag.json.
  personaRagBuild: (personaId: string, opts?: { providerId?: 'openai' | 'glm' }): Promise<{
    success: boolean
    builtAt?: string
    chunkCount?: number
    provider?: 'openai' | 'glm'
    model?: string
    dim?: number
    error?: string
  }> => ipcRenderer.invoke('persona-rag-build', personaId, opts),
  // Index status: built? stale? which provider? how many chunks?
  personaRagStatus: (personaId: string): Promise<{
    success: boolean
    built: boolean
    needsRebuild?: boolean
    builtAt?: string
    provider?: 'openai' | 'glm'
    model?: string
    dim?: number
    chunkCount?: number
    currentHydratedSources?: number
    availableProviders?: Array<{ id: 'openai' | 'glm'; hasKey: boolean; displayName: string; model: string; dim: number }>
    error?: string
  }> => ipcRenderer.invoke('persona-rag-status', personaId),
  personaRagClear: (personaId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('persona-rag-clear', personaId),
  // Progress event for persona-rag-build
  onPersonaRagBuildProgress: (callback: (payload: { personaId: string; phase: 'chunk' | 'embed' | 'save' | 'done'; done: number; total: number }) => void) => {
    const handler = (_event: any, payload: any) => callback(payload)
    ipcRenderer.on('persona-rag-build-progress', handler)
    return () => { ipcRenderer.removeListener('persona-rag-build-progress', handler) }
  },

  // === Auto Update ===
  checkUpdate: (): Promise<{
    hasUpdate: boolean; currentVersion: string; latestVersion: string;
    downloadUrl: string | null; releaseNotes: string; asarSize: number;
  }> => ipcRenderer.invoke('check-update'),
  downloadUpdate: (downloadUrl: string): Promise<{ success: boolean; tempPath?: string; error?: string }> =>
    ipcRenderer.invoke('download-update', downloadUrl),
  applyUpdate: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('apply-update'),
  onUpdateProgress: (callback: (pct: number) => void) => {
    const handler = (_event: any, pct: number) => callback(pct)
    ipcRenderer.on('update-progress', handler)
    return () => { ipcRenderer.removeListener('update-progress', handler) }
  },

  // === Theme ===
  setTitleBarTheme: (dark: boolean) => ipcRenderer.send('set-title-bar-theme', dark),

  // === Diagnostics ===
  getDiagnosticInfo: (): Promise<{
    appVersion: string
    electronVersion: string
    platform: string
    arch: string
    dataDir: string
    libraryJsonSize: number
    metaCount: number
    ocrFilesCount: number
    errorLogs: Array<{ name: string; mtime: string; content: string }>
  }> => ipcRenderer.invoke('get-diagnostic-info'),
  openDataDir: (): Promise<void> => ipcRenderer.invoke('open-data-dir'),
  logRendererCrash: (payload: { label?: string; message?: string; stack?: string; componentStack?: string }): void =>
    ipcRenderer.send('log-renderer-crash', payload),

  // === Reading Log ===
  readingLogCollectEvents: (date: string): Promise<{ success: boolean; events: ReadingLogEvent[]; error?: string }> =>
    ipcRenderer.invoke('reading-log-collect-events', date),
  readingLogGenerateSummary: (params: { events: ReadingLogEvent[]; date: string; recentLogs: ReadingLog[]; model: string }): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('reading-log-generate-summary', params),
  readingLogSave: (log: ReadingLog): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('reading-log-save', log),
  onReadingLogGenerated: (callback: (log: ReadingLog) => void) => {
    const handler = (_event: any, log: ReadingLog) => callback(log)
    ipcRenderer.on('reading-log-generated', handler)
    return () => { ipcRenderer.removeListener('reading-log-generated', handler) }
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
export type ElectronAPI = typeof electronAPI
