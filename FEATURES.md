# 拾卷 ShiJuan · 功能使用报告

> 版本：v1.3.0-beta · 2026-04-19
> 范围：当前实际可用 / 部分可用 / 已锁定的全部功能盘点

图例：`[✅ 可用]` 已稳定可用 · `[⚠️ 部分]` 已实装但有限制 · `[🔒 锁定]` 后端就绪、前端按钮锁 · `[🚧 未实装]` 仅有占位

---

## 1. 文献库管理

### 导入

| 格式 | 状态 | 说明 |
|------|------|------|
| PDF | ✅ 可用 | 主要格式，全功能阅读 + 注释 |
| EPUB | ✅ 可用 | 通过 epubjs 转换章节导航 |
| DOCX | ✅ 可用 | 通过 mammoth 转 HTML，公式走 KaTeX |
| Markdown / TXT | ✅ 可用 | 内联 react-markdown + KaTeX |
| HTML | ✅ 可用 | 直接渲染 |

- **入库方式**：`+` 文件 / `+` 文件夹 / 拖拽
- **文件大小**：无硬限制；OCR 时单 chunk 上限 40MB / 80 页（自动二分切片）
- **数据位置**：本地 app-data 目录，零云端上传

### 组织

- [✅ 可用] 虚拟文件夹（任意分组，与磁盘路径解耦）
- [✅ 可用] 标签系统（全局标签池，每条目可绑多个）
- [✅ 可用] 元数据：标题、作者、年份、备注
- [✅ 可用] 拖动排序（sortIndex 持久化）
- [✅ 可用] 右键菜单：打开 / 重命名 / 改标签 / 移文件夹 / 在文件夹中显示 / 删除

### 搜索

- [✅ 可用] 全文搜索（覆盖文件名 + 注释 + OCR 文本）
- [✅ 可用] **Ctrl+P** 快速打开（模糊匹配文献 + 笔记，距离评分）

---

## 2. 阅读

### PDF

- [✅ 可用] 基于 react-pdf + pdfjs-dist 4.10
- [✅ 可用] 页码导航 / PDF 大纲跳转 / 上次阅读位置记忆
- [✅ 可用] 文字选择 → 右键菜单（注释 / 问 AI / 复制）
- [✅ 可用] 字号、行距、阅读区背景色温调节
- [✅ 可用] 暗色模式（顶栏一键切换 + 跟随系统）

### 其他格式

- EPUB / DOCX / MD / HTML 都有专门 viewer，不是 fallback 渲染

---

## 3. OCR

- [✅ 可用] 提供商：智谱 GLM（独家）
- [✅ 可用] 触发方式：文献右键「OCR 识别」 / 批量队列
- [✅ 可用] 自动切片：>40MB 或 >80 页自动二分（`electron/ipc/aiApi.ts:22-54`）
- [✅ 可用] 输出：可编辑 `.ocr.txt`（每页 + 全文）
- [✅ 可用] 公式：LaTeX 解析后走 KaTeX 渲染
- [✅ 可用] 多栏 / 表格识别
- [✅ 可用] 进度回调（每片完成发事件给 UI）
- [✅ 可用] 状态字段：`entry.ocrStatus = 'none' | 'partial' | 'complete'`

**速率注意**：GLM 免费 tier 4 RPM，主进程节流自动排队，撞墙后退避 ×2

---

## 4. 注释

### 高亮 / 标记

- [✅ 可用] 6 色高亮（黄 / 红 / 绿 / 蓝 / 紫 / 橙）
- [✅ 可用] 划线（不需要颜色）

### 历史链（核心特色）

每段选中文字背后挂一条 **历史链**（`Annotation.historyChain`），同段文字的所有交互按时间序保留：

| 类型 | 含义 |
|------|------|
| `note` | 用户笔记 |
| `question` | 用户提问 |
| `stance` | 立场标注 |
| `link` | 跨文献链接 |
| `ai_interpretation` | AI 自动解释 |
| `ai_qa` | AI 一问一答 |
| `ai_feedback` | AI 反馈 |
| `ai_persona` | 角色化回复 |

每条带：作者 / 时间戳 / 模型标签 / 用户原 query / 上下文。

### AI 即时反馈

- [✅ 可用] 选中 → 右键「问 AI」→ 流式回复直接进历史链
- [✅ 可用] 上下文自动注入：选中文 + 当页 OCR + 跨文档相关注释

---

## 5. 思考笔记

- [✅ 可用] Markdown 编辑器，内联预览
- [✅ 可用] KaTeX 公式（行内 + 块）
- [✅ 可用] 文件夹层级（MemoFolder）
- [✅ 可用] **拖拽引用**：从注释面板拖块进笔记 = 自动写入引用
- [✅ 可用] **#N 跨文献引用**：1-99 编号自动转 `block:N` 协议链接（`src/components/Memo/MemoEditor.tsx:45-52`）
- [✅ 可用] 导出 .md / .html / .txt

---

## 6. AI 对话（Hermes Agent）

### 聊天面板

- [✅ 可用] 多轮对话 + 持久化（`agentSaveConversation`）
- [✅ 可用] 上下文自动注入：当前选中 + OCR + 阅读历史
- [✅ 可用] 流式响应（`onAiStreamChunk` 事件 / 可中断）
- [✅ 可用] 工具调用循环（最多 5 轮）：AI 可调注释搜索 / 笔记创建等内建工具
- [✅ 可用] Agent memory：`memory.md` 跨会话观察累积

### 右键问 AI

- [✅ 可用] 单轮 Q&A 走选中段落
- [✅ 可用] 回复直接落入注释历史链

---

## 7. AI Provider（共 9 家，全可用）

| Provider | 端点 | 推荐模型 | 备注 |
|----------|------|---------|------|
| 智谱 GLM | open.bigmodel.cn | GLM-4-Flash（免费）/ GLM-5.1 | OCR 唯一提供商 |
| OpenAI | api.openai.com | GPT-5.4 mini | 需海外资源 |
| Claude | api.anthropic.com | Claude Sonnet 4.6 | 需海外资源 |
| Google Gemini | generativelanguage… | Gemini 3 Flash | 需海外资源 |
| Kimi | api.moonshot.cn | Moonshot V1 128K | 长上下文擅长 |
| DeepSeek | api.deepseek.com | DeepSeek V3.2 / R1 | 国内 / 极便宜 |
| 字节豆包 | ark.cn-beijing… | endpoint ID | 需控制台先建 endpoint |
| Claude Code CLI | 本地 spawn | 走本机已登录 | 零 API key |
| Ollama 本地 | localhost:11434 | 自动从 /api/tags 拉 | 完全离线 |

### 配置

- [✅ 可用] 每家 API key 加密本地存储
- [✅ 可用] 模型选择器（持久化最近用）
- [✅ 可用] Web search 开关（GLM / Claude / Kimi 原生；其他 fallback 函数调用）
- [✅ 可用] Provider 状态显示（✓ 已配 / ✗ 未配）

### 节流（v1.3.0-beta 重写）

- [✅ 可用] **主进程级 chokepoint**（`electron/ipc/aiThrottle.ts`）
- [✅ 可用] GLM base 16s / 请求（按整分钟边界 4 RPM 留 1s 安全余量）
- [✅ 可用] 撞墙自适应 ×2，上限 8×
- [✅ 可用] **同 provider 所有出口共享**（chat / embedding / web-search-pro 用一份 lastScheduled）
- [✅ 可用] 前端自动重试（2 次退避：15s / 30s）

---

## 8. Hermes 学徒日记

研究学徒每周交一份观察报告。**不是助手 / 老师，是同伴**。

### 数据来源

- 阅读事件：哪些文献被打开、停在哪些页
- 注释：本周新增的笔记 / 提问 / AI 反馈分布
- 笔记：本周新建 / 编辑的 memo

### 生成

- [✅ 可用] 「让学徒写最近 7 天观察」按钮一键触发
- [✅ 可用] 自定义日期：可拉到任意 [start, end]，最长 56 天
- [✅ 可用] AI 模型走当前默认 provider，markdown 输出

### 输出结构

学徒报告固定四块：

1. **第 N 周观察**（开篇定调）
2. **我注意到的**（≤5 条 bullet，每条带证据）
3. **可能被你自己忽略的**（盲点提示）
4. **历史观察**（往期周报列表，可跳转）

### 持久化

- [✅ 可用] 历史列表 `apprenticeList`：`[{weekCode, size, mtime}]`
- [✅ 可用] 单期 load / save / delete 走 weekCode

---

## 9. 召唤（Persona Distillation）— 部分锁定

> **状态说明**：召唤的资料池建设、身份消歧、6 维蒸馏、拟合度评分、SKILL.md 导出全部可用；**只有 in-tab 召唤对话被锁了**（按钮显示 🔒 「召唤对话（敬请期待）」），等可信度兜底机制线上稳定后再开。

### 已可用的部分

#### Phase 1 · 资料池建设 [✅]

- 7 源并行搜索：维基中 / 维基英 / 百度百科 / DuckDuckGo / Archive.org / Project Gutenberg / 智谱 web-search-pro
- 选定源 → 抓全文（`nuwa-fetch-page`）
- 用户可加 / 删 / 重排 / 预览 snippet
- 支持自传入：URL / 本地文件 / prompt 模板

#### Phase 2 · 身份消歧 [✅]

- AI 从资料里生成候选「身份卡」（含 wiki infobox）
- 用户挑一张锚定 persona

#### Phase 3 · 6 维蒸馏 [✅]

并行炼制，每维独立失败重试：

1. coreThought（核心思想）
2. biographicalAnchor（生平锚点）
3. worldviewBreadth（世界观广度）
4. languageStyle（语言风格）
5. epistemicHonesty（认知诚实度）
6. userMaterialAlignment（用户材料拟合）

#### Phase 4 · 拟合度评分 [✅]

5 项细分 × 加权，0-100% 总分。色码反馈：≥80 绿 / ≥60 黄 / <60 红。低分提示加资料。

#### Phase 5 · SKILL.md 生成 + 导出 [✅]

- AI 综合 6 维 → 完整 SKILL.md（即 persona 的 system prompt）
- 一键导出到 `~/.claude/skills/<slug>/`，可在 Claude Code 中直接调用
- 反向：从已有 `~/.claude/skills/` 导入

#### RAG 索引 [✅]

- `persona-rag-build`：把每段 source chunk 走 OpenAI / GLM 嵌入
- 持久化：`<personaId>.rag.json`
- 检索模式：嵌入余弦相似度（已索引）/ BM25（未索引兜底）
- `personaGetSystemPrompt + userQuery` → 取 top-K → 注入 `[资料 N]` 引用

### 已锁定

- [🔒] **召唤对话**：UI 按钮存在但 disabled，`敬请期待` 文案

---

## 10. 阅读日志

- [✅ 可用] 自动记录 PDF 打开、页跳转、注释新增 → events 带时间戳
- [✅ 可用] 时间线侧栏列出所有日期
- [✅ 可用] 点开某日 → AI 当日总结报告（markdown）
- [✅ 可用] 「生成今日日志」按钮
- [✅ 可用] 综合 events + 过去 7 天 logs 给 AI 合成

---

## 11. 设置面板

入口：右上角 ⚙️

### AI Provider

- [✅] 每家 API key 输入 / 存储 / 清除
- [✅] 「获取 Key」直链
- [✅] 免费 tier 提示
- [✅] 模型选择器
- [✅] Provider 状态（✓ / ✗）

### 显示

- [✅] 暗色 / 亮色 / 跟随系统
- [✅] 字体缩放 / 行距
- [✅] 阅读区宽度

### 诊断面板（可折叠）

- [✅] 应用版本 / Electron 版本 / 平台
- [✅] 数据目录路径 + 一键打开
- [✅] 统计：library.json 大小 / 元数据条数 / OCR 文件数
- [✅] 错误日志（最近崩溃报告）

### 版本检测 + 热更新

- [✅] 检查更新：轮询 GitHub releases API 比对 `tag_name`，有新版本提示用户
- [✅] **真·热更新**（自定义 asar-patch 实现）：见 `electron/updater.ts`
  - 流程：`check-update` → `download-update`（带进度事件 `update-progress`）→ `apply-update`（detached 脚本接力 swap + 重启）
  - 设计妙处：**不依赖 `electron-updater`，也不需要代码签名**。因为是替换已安装应用内部的 `app.asar`,SmartScreen / Gatekeeper 都已经在首次安装时通过了
  - Windows 用 `cmd` 脚本 `move /Y` + 15 次重试解决 asar 文件锁
  - macOS 用 `bash` 脚本 `mv -f` + 15 次重试
  - 触发条件:Release 里需有 `app.asar` 或 `*patch*.asar` asset(本次 v1.3.0-beta release 已包含 214MB 的 app.asar)

---

## 12. 快捷键

| 快捷键 | 行为 |
|--------|------|
| **Ctrl+P** | 快速打开（搜文献 + 笔记） |
| **Esc** | 关闭弹窗 / 折叠面板 |
| **Enter** | 快速打开里确认选中项 |
| **↑ ↓** | 快速打开里上下导航 |

> 暂无自定义快捷键 UI

---

## 13. 数据 / 备份 / 恢复

- [✅] **数据完全本地**：默认 app-data 目录（Win: AppData/Roaming/shijuan / mac: ~/Library / Linux: ~/.config）
- [✅] 数据目录可在初次启动选择，也可后期改
- [✅] 备份：`exportFullBackup` IPC 把整个 library.json + 元数据 + OCR + 学徒日志打包
- [⚠️ 部分] 完整恢复目前需手动覆盖数据目录（UI 自动恢复未实装）

---

## 14. 崩溃恢复

- [✅] 错误日志写到 `.error-logs/` 目录
- [✅] 渲染进程崩溃通过 `logRendererCrash` IPC 上报
- [⚠️ 部分] 自动恢复：library.json 启动重载；后台修改有 `onLibraryChangedOnDisk` 同步事件

---

## 15. 未实装 / 已隐藏

- [🚧] **沉浸阅读模式**：组件存在但路由未通
- [🚧] **讲座模式**（LectureMode）：`TopBar.tsx:548` 用 `{false &&}` 守卫隐藏
- [🚧] **多窗口**：当前单窗口（Electron main.ts 单 BrowserWindow），多文档靠 sidebar + Ctrl+P
- [🚧] **自定义快捷键**
- [🔒] **召唤对话**（见 §9）

---

## 总览速查

| 模块 | 状态 |
|------|------|
| 文献库（PDF/EPUB/DOCX/MD/HTML 导入） | ✅ |
| PDF 阅读 + 选段交互 | ✅ |
| GLM OCR（自动切片 / 进度回调） | ✅ |
| 6 色注释 + 历史链 + AI 反馈 | ✅ |
| Markdown 笔记 + #N 跨文献引用 | ✅ |
| Agent 多轮对话 + 工具循环 | ✅ |
| AI Provider（9 家全配） | ✅ |
| Hermes 学徒周报 | ✅ |
| Persona 创建 + 蒸馏 + RAG + SKILL.md 导出 | ✅ |
| 召唤对话 | 🔒 |
| 阅读日志 + AI 日报 | ✅ |
| 设置 + 诊断 + 版本检测 | ✅ |
| Ctrl+P 快速打开 | ✅ |
| 沉浸阅读 / 讲座模式 / 多窗口 | 🚧 |

---

## 依据

本报告来源：

- `electron/preload.ts`（IPC 表面）
- `electron/ipc/*.ts`（业务逻辑）
- `src/components/`（UI 面板）
- `src/store/`（Zustand 状态）
- `src/types/`（数据 schema）
- 关键词搜索：`敬请期待` / `🔒` / `disabled` / `TODO` / `{false &&}`
