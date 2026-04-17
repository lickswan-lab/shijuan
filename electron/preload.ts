import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Library, PdfMeta, HistoryEntry, ReadingLogEvent, ReadingLog } from '../src/types/library'

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
  agentLoadInsight: (): Promise<{ success: boolean; insight: any | null }> =>
    ipcRenderer.invoke('agent-load-insight'),
  agentSaveInsight: (insight: any): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-insight', insight),
  agentLoadSkills: (): Promise<{ success: boolean; skills: any[] }> =>
    ipcRenderer.invoke('agent-load-skills'),
  agentSaveSkills: (skills: any[]): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('agent-save-skills', skills),

  // === Apprentice (weekly observation log) ===
  apprenticeCollectContext: (targetDateIso?: string): Promise<{ success: boolean; context?: any; error?: string }> =>
    ipcRenderer.invoke('apprentice-collect-context', targetDateIso),
  apprenticeList: (): Promise<{ success: boolean; entries: Array<{ weekCode: string; size: number; mtime: string }>; error?: string }> =>
    ipcRenderer.invoke('apprentice-list'),
  apprenticeLoad: (weekCode: string): Promise<{ success: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('apprentice-load', weekCode),
  apprenticeSave: (weekCode: string, content: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('apprentice-save', weekCode, content),
  apprenticeDelete: (weekCode: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('apprentice-delete', weekCode),

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
