"use strict";
const electron = require("electron");
const electronAPI = {
  // Library (central storage)
  loadLibrary: () => electron.ipcRenderer.invoke("load-library"),
  saveLibrary: (data) => electron.ipcRenderer.invoke("save-library", data),
  // Import
  importFiles: () => electron.ipcRenderer.invoke("import-files"),
  importFolder: () => electron.ipcRenderer.invoke("import-folder"),
  checkFileExists: (absPath) => electron.ipcRenderer.invoke("check-file-exists", absPath),
  // PDF meta (stored centrally by entry ID)
  loadPdfMeta: (entryId) => electron.ipcRenderer.invoke("load-pdf-meta", entryId),
  savePdfMeta: (entryId, data) => electron.ipcRenderer.invoke("save-pdf-meta", entryId, data),
  // File operations
  readFileBuffer: (filePath) => electron.ipcRenderer.invoke("read-file-buffer", filePath),
  deleteFile: (absPath) => electron.ipcRenderer.invoke("delete-file", absPath),
  // Export
  exportFile: (defaultName, filters, content) => electron.ipcRenderer.invoke("export-file", defaultName, filters, content),
  // OCR files
  saveOcrText: (pdfAbsPath, text) => electron.ipcRenderer.invoke("save-ocr-text", pdfAbsPath, text),
  readOcrText: (pdfAbsPath) => electron.ipcRenderer.invoke("read-ocr-text", pdfAbsPath),
  // === AI API (multi-provider) ===
  aiGetProviders: () => electron.ipcRenderer.invoke("ai-get-providers"),
  aiSetKey: (providerId, key) => electron.ipcRenderer.invoke("ai-set-key", providerId, key),
  aiRemoveKey: (providerId) => electron.ipcRenderer.invoke("ai-remove-key", providerId),
  aiGetConfigured: () => electron.ipcRenderer.invoke("ai-get-configured"),
  // === Legacy GLM compat (still used by OCR, instant feedback) ===
  setGlmApiKey: (key) => electron.ipcRenderer.invoke("set-glm-api-key", key),
  getGlmApiKeyStatus: () => electron.ipcRenderer.invoke("get-glm-api-key-status"),
  glmOcr: (imageBase64) => electron.ipcRenderer.invoke("glm-ocr", imageBase64),
  glmOcrPdf: (pdfAbsPath) => electron.ipcRenderer.invoke("glm-ocr-pdf", pdfAbsPath),
  glmInterpret: (text, context) => electron.ipcRenderer.invoke("glm-interpret", text, context),
  glmInstantFeedback: (userNote, selectedText, ocrContext, otherAnnotations) => electron.ipcRenderer.invoke("glm-instant-feedback", userNote, selectedText, ocrContext, otherAnnotations),
  glmAsk: (question, selectedText, history, model) => electron.ipcRenderer.invoke("glm-ask", question, selectedText, history, model)
};
electron.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
