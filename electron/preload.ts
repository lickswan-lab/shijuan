import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Library, PdfMeta, HistoryEntry, ReadingLogEvent, ReadingLog, LectureSession, AgentConversation, HermesSkill, HermesInsight } from '../src/types/library'

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

  // OCR files
  saveOcrText: (pdfAbsPath: string, text: string): Promise<string> =>
    ipcRenderer.invoke('save-ocr-text', pdfAbsPath, text),
  readOcrText: (pdfAbsPath: string): Promise<{ exists: boolean; text: string | null; path: string }> =>
    ipcRenderer.invoke('read-ocr-text', pdfAbsPath),

  // === AI API (multi-provider) ===
  aiGetProviders: (): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }>; hasKey: boolean }>> =>
    ipcRenderer.invoke('ai-get-providers'),
  aiSetKey: (providerId: string, key: string): Promise<boolean> =>
    ipcRenderer.invoke('ai-set-key', providerId, key),
  aiRemoveKey: (providerId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai-remove-key', providerId),
  aiGetKey: (providerId: string): Promise<string | null> =>
    ipcRenderer.invoke('ai-get-key', providerId),
  aiGetConfigured: (): Promise<Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>> =>
    ipcRenderer.invoke('ai-get-configured'),

  // === Legacy GLM compat (still used by OCR, instant feedback) ===
  setGlmApiKey: (key: string): Promise<boolean> =>
    ipcRenderer.invoke('set-glm-api-key', key),
  getGlmApiKeyStatus: (): Promise<'set' | 'not-set'> =>
    ipcRenderer.invoke('get-glm-api-key-status'),
  glmOcr: (imageBase64: string): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('glm-ocr', imageBase64),
  glmOcrPdf: (pdfAbsPath: string): Promise<{ success: boolean; text?: string; pageTexts?: string[]; pageCount?: number; error?: string }> =>
    ipcRenderer.invoke('glm-ocr-pdf', pdfAbsPath),
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
  aiChatStream: (streamId: string, modelSpec: string, messages: Array<{ role: string; content: string }>): Promise<{ success: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('ai-chat-stream', streamId, modelSpec, '', messages),
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

  // === Lecture ===
  lectureSave: (session: LectureSession): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('lecture-save', session),
  lectureSaveAudio: (sessionId: string, buffer: ArrayBuffer): Promise<{ success: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('lecture-save-audio', sessionId, Buffer.from(buffer)),
  lectureDeleteAudio: (sessionId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('lecture-delete-audio', sessionId),
  lectureXfyunSign: (appid: string, apikey: string): Promise<{ success: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('lecture-xfyun-sign', appid, apikey),
  lectureAliyunToken: (akid: string, aksecret: string): Promise<{ success: boolean; token?: string; expireTime?: number; error?: string }> =>
    ipcRenderer.invoke('lecture-aliyun-token', akid, aksecret),

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

  // === Agent ===
  agentLoadMemory: (): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('agent-load-memory'),
  agentSaveMemory: (content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-memory', content),
  agentLoadConversations: (): Promise<{ success: boolean; conversations: AgentConversation[]; error?: string }> =>
    ipcRenderer.invoke('agent-load-conversations'),
  agentSaveConversation: (conv: AgentConversation): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-conversation', conv),
  agentExecuteTool: (toolName: string, argsJson: string): Promise<{ success: boolean; result: string }> =>
    ipcRenderer.invoke('agent-execute-tool', toolName, argsJson),
  agentLoadInsight: (): Promise<{ success: boolean; insight: HermesInsight | null }> =>
    ipcRenderer.invoke('agent-load-insight'),
  agentSaveInsight: (insight: HermesInsight): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('agent-save-insight', insight),
  agentLoadSkills: (): Promise<{ success: boolean; skills: HermesSkill[] }> =>
    ipcRenderer.invoke('agent-load-skills'),
  agentSaveSkills: (skills: HermesSkill[]): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('agent-save-skills', skills),

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
