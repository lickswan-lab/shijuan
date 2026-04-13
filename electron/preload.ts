import { contextBridge, ipcRenderer } from 'electron'
import type { Library, PdfMeta, HistoryEntry } from '../src/types/library'

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
  checkFileExists: (absPath: string): Promise<boolean> =>
    ipcRenderer.invoke('check-file-exists', absPath),

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
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
export type ElectronAPI = typeof electronAPI
