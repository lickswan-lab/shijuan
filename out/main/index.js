"use strict";
const electron = require("electron");
const path = require("path");
const fs = require("fs/promises");
const is = {
  dev: !electron.app.isPackaged
};
({
  isWindows: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux"
});
const DATA_DIR$1 = path.join(electron.app.getPath("home"), ".lit-manager");
const LIBRARY_FILE = path.join(DATA_DIR$1, "library.json");
const META_DIR = path.join(DATA_DIR$1, "meta");
async function ensureDirs() {
  await fs.mkdir(DATA_DIR$1, { recursive: true });
  await fs.mkdir(META_DIR, { recursive: true });
}
let writeLock = Promise.resolve();
async function atomicWriteJson(filePath, data) {
  writeLock = writeLock.then(async () => {
    const tmpPath = filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, filePath);
  }).catch(async () => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  });
  return writeLock;
}
function metaPath(entryId) {
  return path.join(META_DIR, `${entryId}.json`);
}
function registerLibraryIpc() {
  electron.ipcMain.handle("load-library", async () => {
    await ensureDirs();
    try {
      const content = await fs.readFile(LIBRARY_FILE, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("save-library", async (_event, data) => {
    await ensureDirs();
    await atomicWriteJson(LIBRARY_FILE, data);
    return true;
  });
  const SUPPORTED_EXTS = [".pdf", ".docx", ".doc", ".epub", ".html", ".htm", ".txt", ".md"];
  const isSupported = (name) => SUPPORTED_EXTS.some((ext) => name.toLowerCase().endsWith(ext));
  electron.ipcMain.handle("import-files", async () => {
    const result = await electron.dialog.showOpenDialog({
      properties: ["openFile", "openDirectory", "multiSelections"],
      filters: [
        { name: "文档", extensions: ["pdf", "docx", "doc", "epub", "html", "htm", "txt", "md"] },
        { name: "PDF", extensions: ["pdf"] },
        { name: "Word", extensions: ["docx", "doc"] },
        { name: "EPUB", extensions: ["epub"] },
        { name: "HTML", extensions: ["html", "htm"] },
        { name: "文本", extensions: ["txt", "md"] },
        { name: "所有文件", extensions: ["*"] }
      ],
      title: "选择文件或文件夹导入"
    });
    if (result.canceled) return [];
    const allFiles = [];
    async function scanDir(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(full);
        } else if (isSupported(entry.name)) {
          allFiles.push(full);
        }
      }
    }
    for (const p of result.filePaths) {
      try {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          await scanDir(p);
        } else if (isSupported(p)) {
          allFiles.push(p);
        }
      } catch {
      }
    }
    return allFiles;
  });
  electron.ipcMain.handle("import-folder", async () => {
    const result = await electron.dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "选择文件夹（自动扫描其中的文档）"
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    const dirPath = result.filePaths[0];
    const files = [];
    async function scan(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else if (isSupported(entry.name)) {
          files.push(full);
        }
      }
    }
    await scan(dirPath);
    return files;
  });
  electron.ipcMain.handle("check-file-exists", async (_event, absPath) => {
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle("load-pdf-meta", async (_event, entryId) => {
    try {
      const content = await fs.readFile(metaPath(entryId), "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("save-pdf-meta", async (_event, entryId, data) => {
    await ensureDirs();
    data.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    await atomicWriteJson(metaPath(entryId), data);
    return true;
  });
  electron.ipcMain.handle("read-file-buffer", async (_event, filePath) => {
    const buffer = await fs.readFile(filePath);
    return buffer;
  });
  electron.ipcMain.handle("save-ocr-text", async (_event, pdfAbsPath, text) => {
    const ocrPath = pdfAbsPath.replace(/\.pdf$/i, ".ocr.txt");
    await fs.writeFile(ocrPath, text, "utf-8");
    return ocrPath;
  });
  electron.ipcMain.handle("delete-file", async (_event, absPath) => {
    const { shell: shell2 } = require("electron");
    try {
      await shell2.trashItem(absPath);
      const ocrPath = absPath.replace(/\.pdf$/i, ".ocr.txt");
      try {
        await shell2.trashItem(ocrPath);
      } catch {
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("read-ocr-text", async (_event, pdfAbsPath) => {
    const ocrPath = pdfAbsPath.replace(/\.pdf$/i, ".ocr.txt");
    try {
      const text = await fs.readFile(ocrPath, "utf-8");
      return { exists: true, text, path: ocrPath };
    } catch {
      return { exists: false, text: null, path: ocrPath };
    }
  });
  electron.ipcMain.handle("export-file", async (_event, defaultName, filters, content) => {
    try {
      const result = await electron.dialog.showSaveDialog({
        defaultPath: defaultName,
        filters
      });
      if (result.canceled || !result.filePath) return { success: false };
      if (typeof content === "string") {
        await fs.writeFile(result.filePath, content, "utf-8");
      } else {
        await fs.writeFile(result.filePath, content);
      }
      electron.shell.showItemInFolder(result.filePath);
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}
const PROVIDERS = [
  {
    id: "glm",
    name: "智谱 GLM",
    chatUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    models: [
      { id: "glm-5.1", name: "GLM-5.1（旗舰）" },
      { id: "glm-5", name: "GLM-5" },
      { id: "glm-5-turbo", name: "GLM-5-Turbo（Agent）" },
      { id: "glm-4.7-flash", name: "GLM-4.7-Flash（免费）" },
      { id: "glm-4-flash", name: "GLM-4-Flash" }
    ],
    authHeader: (key) => ({ "Authorization": `Bearer ${key}` })
  },
  {
    id: "openai",
    name: "OpenAI",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4（旗舰）" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
      { id: "gpt-5.4-nano", name: "GPT-5.4 Nano（快速）" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex（编程）" }
    ],
    authHeader: (key) => ({ "Authorization": `Bearer ${key}` })
  },
  {
    id: "claude",
    name: "Claude",
    chatUrl: "https://api.anthropic.com/v1/messages",
    models: [
      { id: "claude-opus-4-6-20250414", name: "Claude Opus 4.6（最强）" },
      { id: "claude-sonnet-4-6-20250414", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5-20241022", name: "Claude Haiku 4.5（快速）" }
    ],
    authHeader: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" })
  },
  {
    id: "gemini",
    name: "Google Gemini",
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    models: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro（旗舰）" },
      { id: "gemini-3-flash", name: "Gemini 3 Flash" },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite（快速）" }
    ],
    authHeader: (key) => ({ "Authorization": `Bearer ${key}` })
  },
  {
    id: "kimi",
    name: "Kimi (月之暗面)",
    chatUrl: "https://api.moonshot.cn/v1/chat/completions",
    models: [
      { id: "kimi-k2.5", name: "Kimi K2.5（最新）" },
      { id: "moonshot-v1-128k", name: "Moonshot V1 128K" },
      { id: "moonshot-v1-32k", name: "Moonshot V1 32K" }
    ],
    authHeader: (key) => ({ "Authorization": `Bearer ${key}` })
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    chatUrl: "https://api.deepseek.com/chat/completions",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3.2 Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek R1（推理）" }
    ],
    authHeader: (key) => ({ "Authorization": `Bearer ${key}` })
  },
  {
    id: "doubao",
    name: "豆包 (字节)",
    chatUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    models: [
      { id: "doubao-seed-2-pro-32k", name: "豆包 2.0 Pro（旗舰）" },
      { id: "doubao-seed-2-lite-32k", name: "豆包 2.0 Lite" },
      { id: "doubao-seed-2-mini-32k", name: "豆包 2.0 Mini（快速）" }
    ],
    authHeader: (key) => ({ "Authorization": `Bearer ${key}` })
  }
];
const DATA_DIR = path.join(electron.app.getPath("home"), ".lit-manager");
const KEYS_FILE = path.join(DATA_DIR, "api-keys.json");
let apiKeys = {};
async function loadApiKeys() {
  try {
    const content = await fs.readFile(KEYS_FILE, "utf-8");
    apiKeys = JSON.parse(content);
  } catch {
    apiKeys = {};
  }
}
async function saveApiKeys() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KEYS_FILE, JSON.stringify(apiKeys, null, 2), "utf-8");
}
async function callChat(providerId, model, messages) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) throw new Error(`未知的 AI 供应商: ${providerId}`);
  const key = apiKeys[providerId];
  if (!key) throw new Error(`${provider.name} API Key 未设置。请在设置中配置。`);
  if (providerId === "claude") {
    return callClaude(key, model, messages);
  }
  const response = await fetch(provider.chatUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...provider.authHeader(key)
    },
    body: JSON.stringify({ model, messages })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${provider.name} API error ${response.status}: ${text.substring(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}
async function callClaude(key, model, messages) {
  const systemMsg = messages.find((m) => m.role === "system")?.content || "";
  const chatMessages = messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role,
    content: m.content
  }));
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemMsg,
      messages: chatMessages
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text.substring(0, 200)}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || "";
}
const GLM_OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
async function callGlmOcr(imageBase64) {
  const key = apiKeys["glm"];
  if (!key) throw new Error("GLM API Key 未设置（OCR 需要智谱 GLM）");
  const response = await fetch(GLM_OCR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model: "glm-ocr", file: `data:image/png;base64,${imageBase64}` })
  });
  if (!response.ok) {
    const text2 = await response.text();
    throw new Error(`GLM-OCR API error ${response.status}: ${text2}`);
  }
  const data = await response.json();
  let text = data.md_results || "";
  if (!text && data.layout_details) {
    const blocks = [];
    for (const page of data.layout_details) {
      for (const block of page) {
        if (block.content) blocks.push(block.content);
      }
    }
    text = blocks.join("\n\n");
  }
  const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
  text = text.replace(/\$\\textcircled\{(\d+)\}\$/g, (_m, n) => circled[parseInt(n) - 1] || `(${n})`).replace(/\$\\\\textcircled\{(\d+)\}\$/g, (_m, n) => circled[parseInt(n) - 1] || `(${n})`).replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) throw new Error("OCR 未能提取到文字");
  return text;
}
function registerAiApiIpc() {
  loadApiKeys();
  electron.ipcMain.handle("ai-get-providers", async () => {
    return PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models,
      hasKey: !!apiKeys[p.id]
    }));
  });
  electron.ipcMain.handle("ai-set-key", async (_event, providerId, key) => {
    apiKeys[providerId] = key;
    await saveApiKeys();
    return true;
  });
  electron.ipcMain.handle("ai-remove-key", async (_event, providerId) => {
    delete apiKeys[providerId];
    await saveApiKeys();
    return true;
  });
  electron.ipcMain.handle("ai-get-configured", async () => {
    return PROVIDERS.filter((p) => !!apiKeys[p.id]).map((p) => ({ id: p.id, name: p.name, models: p.models }));
  });
  electron.ipcMain.handle("set-glm-api-key", async (_event, key) => {
    apiKeys["glm"] = key;
    await saveApiKeys();
    return true;
  });
  electron.ipcMain.handle("get-glm-api-key-status", async () => {
    return apiKeys["glm"] ? "set" : "not-set";
  });
  electron.ipcMain.handle("ai-chat", async (_event, providerId, model, messages) => {
    try {
      const result = await callChat(providerId, model, messages);
      return { success: true, text: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("glm-interpret", async (_event, text, context) => {
    try {
      const result = await callChat("glm", "glm-4-flash", [
        { role: "system", content: "你是学术文献阅读助手。请用中文解释以下学术文本的含义，帮助读者理解。要求：1）解释关键概念；2）理清论证逻辑；3）指出隐含假设；4）如涉及理论家，说明其思想形成的背景。语言要通俗易懂。" },
        { role: "user", content: context ? `请解释这段文字：

「${text}」

上下文：${context}` : `请解释这段文字：

「${text}」` }
      ]);
      return { success: true, text: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("glm-instant-feedback", async (_event, userNote, selectedText, ocrContext, otherAnnotations) => {
    try {
      let otherNotesContext = "";
      if (otherAnnotations.length > 0) {
        const items = otherAnnotations.slice(0, 15).map((a) => `[${a.entryTitle}]「${a.text}」→ ${a.note}`).join("\n");
        otherNotesContext = `

用户在其他文献中的历史注释：
${items}`;
      }
      const result = await callChat("glm", "glm-4-flash", [
        { role: "system", content: `你是学术文献阅读助手。用户正在阅读论文并写下了一条注释。请给出简短的即时反馈（1-3句话）。
优先级：1.指出矛盾或呼应 2.补充隐含假设 3.延伸思考方向
要求：没有有价值的反馈就回复空字符串。不要复述。语气简洁克制。中文回复。` },
        { role: "user", content: `论文原文片段：「${selectedText}」

${ocrContext ? `页面上下文：${ocrContext.substring(0, 800)}

` : ""}用户写的注释：${userNote}${otherNotesContext}` }
      ]);
      return { success: true, text: result.trim() || null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("glm-ask", async (_event, question, selectedText, history, modelSpec) => {
    try {
      let providerId = "glm";
      let model = "glm-4-flash";
      if (modelSpec && modelSpec.includes(":")) {
        const [p, m] = modelSpec.split(":", 2);
        providerId = p;
        model = m;
      } else if (modelSpec) {
        model = modelSpec;
      }
      const messages = [
        { role: "system", content: `你是学术文献阅读助手。用户正在阅读一段学术文本，请基于文本内容回答用户的问题。

参考文本：
「${selectedText}」` }
      ];
      for (const entry of history) {
        if (entry.type === "ai_qa") {
          if (entry.userQuery) messages.push({ role: "user", content: entry.userQuery });
          messages.push({ role: "assistant", content: entry.content });
        } else if (["note", "annotation", "question", "stance"].includes(entry.type)) {
          messages.push({ role: "user", content: `[我的笔记] ${entry.content}` });
        } else if (entry.type === "ai_interpretation" || entry.type === "ai_feedback") {
          messages.push({ role: "assistant", content: entry.content });
        }
      }
      messages.push({ role: "user", content: question });
      const result = await callChat(providerId, model, messages);
      return { success: true, text: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("glm-ocr", async (_event, imageBase64) => {
    try {
      const text = await callGlmOcr(imageBase64);
      return { success: true, text };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
  electron.ipcMain.handle("glm-ocr-pdf", async (_event, pdfAbsPath) => {
    try {
      const key = apiKeys["glm"];
      if (!key) throw new Error("GLM API Key 未设置（OCR 需要智谱 GLM）");
      const pdfBuffer = await fs.readFile(pdfAbsPath);
      const pdfBase64 = pdfBuffer.toString("base64");
      const response = await fetch(GLM_OCR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({ model: "glm-ocr", file: `data:application/pdf;base64,${pdfBase64}` })
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`GLM-OCR API error ${response.status}: ${errText}`);
      }
      const data = await response.json();
      let text = data.md_results || "";
      if (!text && data.layout_details) {
        const blocks = [];
        for (const page of data.layout_details) {
          for (const block of page) {
            if (block.content) blocks.push(block.content);
          }
        }
        text = blocks.join("\n\n");
      }
      const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
      text = text.replace(/\$\\textcircled\{(\d+)\}\$/g, (_m, n) => circled[parseInt(n) - 1] || `(${n})`).replace(/\$\\\\textcircled\{(\d+)\}\$/g, (_m, n) => circled[parseInt(n) - 1] || `(${n})`).replace(/\n{4,}/g, "\n\n\n").trim();
      if (!text) throw new Error("OCR 未能提取到文字");
      const pageTexts = [];
      if (data.layout_details && Array.isArray(data.layout_details)) {
        for (const page of data.layout_details) {
          pageTexts.push(page.map((b) => b.content || "").join("\n\n"));
        }
      }
      return { success: true, text, pageTexts, pageCount: data.data_info?.num_pages || pageTexts.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}
function registerPdfOperationsIpc() {
  electron.ipcMain.handle("extract-page-image", async (_event, pdfPath, _pageNum) => {
    try {
      await fs.access(pdfPath);
      return { success: true };
    } catch {
      return { success: false, error: "PDF file not found" };
    }
  });
}
function createWindow() {
  electron.Menu.setApplicationMenu(null);
  const mainWindow = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "拾卷",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#F7F3EA",
      symbolColor: "#3D3529",
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
      // Allow loading local PDF files
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (is.dev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  const rendererUrl = process.env["ELECTRON_RENDERER_URL"];
  console.log("[main] is.dev:", is.dev, "ELECTRON_RENDERER_URL:", rendererUrl);
  if (is.dev && rendererUrl) {
    mainWindow.loadURL(rendererUrl).catch((err) => {
      console.error("[main] Failed to load renderer URL:", err);
      mainWindow.loadFile(path.join(__dirname, "../renderer/index.html")).catch(console.error);
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html")).catch(console.error);
  }
}
registerLibraryIpc();
registerAiApiIpc();
registerPdfOperationsIpc();
electron.app.whenReady().then(() => {
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
