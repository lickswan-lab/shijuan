# 拾卷 ShiJuan

> 智能文献管理与阅读笔记工具 · 把"读完一本书"变成"和这本书的作者对话"

桌面端 Electron 应用，把 PDF / EPUB / TXT 文献接入 AI 工作流：边读边批注、自动生成读书笔记、把作者「召唤」成可追问的 AI 角色（每句话能溯源到原文段落）。

**当前版本**：v1.3.0-beta · 2026-04-19

---

## 这个工具解决什么问题

读社科 / 哲学 / 思想史的人都会遇到的尴尬：
- 通用 AI（ChatGPT / Claude）回答「黑格尔会怎么看 X」全是训练印象拼接，不知道是真引述还是幻觉
- 自己读一本《精神现象学》要两个月，每次看完还得回头查上下文
- 笔记散在 OneNote / Notion / 纸本里，下次想找某个论点要翻半天

拾卷的思路：**让 AI 始终基于你导入的真实原文回答**。不是"模拟黑格尔的语气"，而是"调出黑格尔实际写过的段落 + 标注哪句话来自哪本书的哪一页"。

---

## 核心功能

### 一、文献管理 + AI 阅读

- **多格式导入**：PDF（含 OCR 切片，绕过 GLM 50MB / 100 页限制）、EPUB、TXT、DOCX
- **AI 注释面板**（Hermes Agent）：选段 → 自动给术语解释 / 上下文 / 思想史背景
- **学徒日记**：AI 作为每周观察者，整理你最近读了什么 + 提出未解决的问题
- **关注 PDF 大纲 / 全文搜索 / 注释跳转**：阅读流的基础工具齐全

### 二、召唤（Persona Distillation）

把一个历史人物 / 学者「炼」成一个可对话的 AI 角色：

1. **资料池建设**：7 源并行搜索（中英维基、百度百科、Archive.org、Project Gutenberg、DuckDuckGo、智谱 web-search-pro），自动抓全文
2. **AI 深度搜索**（v1.3.0-beta 新）：参考 dzhng/deep-research 的递归减半 + STORM 的 Question→Query 两层模板，AI 自己决定要查什么、查几轮、何时收敛
3. **多维度蒸馏**：核心思想 / 时代背景 / 世界观 / 语言风格 / 重要决断 等 6+ 维度并行炼制，每维独立失败重试
4. **拟合度评分**：AI 自评 6 项指标 ×100 分，发现"语言风格"分数低就提示用户加更多原文

### 三、引用核验（v1.3.0-beta 新）

召唤角色每次回答都要带 `[资料 N]` 标注。前端做了 5 步验证管道：

1. 主进程检索时给每个 chunk 编号（保留 sourceId / sourceTitle / chunkIdx / trust 等元数据）
2. 系统提示明确告知"只能用 [资料 1] ~ [资料 N]，超出范围的会被前端识别为伪造"
3. 正则匹配 AI 输出的脏变体：`[资料1]` / `【资料 1】` / `[资料 1, 2]` / `[资料 1-3]` 都能识别
4. 反向解析：每个引用编号对回原 chunk，超出范围的标记为伪造（红框警告）
5. 渲染时只显示真正被引用的 chunk 卡片，没引用的不污染界面

如果资料池里压根没有匹配的 chunk（用户问了 persona 不知道的事），系统会注入 STORM 风格的硬约束："禁止给具体年份 / 地名 / 原话引用，只能讲方法论 + 提示用户加资料"。

### 四、节流（v1.3.0-beta 新）

主进程级 per-provider chokepoint（`electron/ipc/aiThrottle.ts`）：
- GLM 默认 16s / 请求（按整分钟边界 4 RPM 算的安全值）
- 撞墙后自适应 ×2，上限 8×
- 所有 GLM 出口（chat / embedding / web-search-pro）共享同一份 `lastScheduled`

之前只在前端节流时，三条独立 GLM 路径并发跑会把免费 tier 配额炸穿。搬到主进程后实测稳定。

---

## 安装与使用

### Windows

从 [Releases](https://github.com/lickswan-lab/shijuan/releases) 下载：

- **拾卷-1.3.0-beta-便携版.exe**（350MB · 解压即用，不写注册表）
- **拾卷-Setup-1.3.0-beta.exe**（NSIS 安装版，会创建桌面 / 开始菜单快捷方式）

> 首次启动会要你选数据目录（默认 `~/AppData/Roaming/shijuan`）。如果用便携版想保留数据可以手动指定。

### macOS

```bash
# 从源码运行（暂未提供签名 .dmg）
git clone https://github.com/lickswan-lab/shijuan.git
cd shijuan
npm install
npm run dev
```

### 自己打包

```bash
npm run pack-portable    # Windows portable
npm run dist             # 完整安装包
```

---

## 快速上手

1. **接入 AI**：右上角设置 → AI Provider → 填 API Key（至少配一个，推荐 GLM 因为有免费额度，见下方 API key 指南）
2. **导入第一本书**：左侧栏「+」→ 选 PDF / EPUB / TXT
3. **边读边问**：选中一段文字 → 右键「问 AI」或 Ctrl+P 打开学徒
4. **创建第一个召唤**：Agent 面板 → 召唤 → 「+ 新建」→ 输入名字（如「黑格尔」）→ 「自动搜索资料」→ 勾选 → 「开始蒸馏」
5. **进阶：深度调研**：召唤详情页 → 「AI 深度搜索」→ AI 自己决定要查什么、查几轮

---

## API Key 获取指南

拾卷支持多家 LLM provider，至少需要配一个：

### 智谱 GLM（**推荐起步**，国内访问 + 免费额度）

1. 注册 [智谱 AI 开放平台](https://open.bigmodel.cn/)
2. 实名认证后在「API Keys」页生成 Key（`xxxx.xxxxxxxxxxxxxxxx` 格式）
3. 免费 tier 包含：
   - GLM-4-Flash 主对话模型
   - embedding-2 / embedding-3 嵌入
   - web-search-pro 联网搜索（独立 quota）
4. 拾卷设置 → AI Provider → GLM → 粘贴 Key

> ⚠️ 免费 tier 是 **4 RPM**（每分钟 4 次），拾卷已内置主进程节流自动排队，不用担心炸穿。但如果你大批量导入 100+ 资料的 persona，建议升级付费 tier。

### OpenAI

1. [platform.openai.com](https://platform.openai.com/) 注册（需要海外手机号 + 海外信用卡）
2. 创建 API Key（`sk-...` 格式）
3. 充值最少 $5
4. 拾卷设置 → AI Provider → OpenAI → 粘贴 Key
5. 模型选择：
   - 对话：`gpt-4o-mini`（性价比）/ `gpt-4o`（质量）
   - 嵌入：`text-embedding-3-small`（够用）/ `text-embedding-3-large`（更准但 2 倍 token）

### Anthropic Claude

1. [console.anthropic.com](https://console.anthropic.com/) 注册（同样需要海外资源）
2. Workbench → API Keys → Create Key（`sk-ant-...` 格式）
3. 充值后启用，拾卷支持 Claude Opus / Sonnet / Haiku
4. **本地 Claude CLI**（高级）：如果你已经有 Claude Code 安装在本机，拾卷可以直接调本地 CLI（`claude_cli` provider），无需 API Key

### DeepSeek

1. [platform.deepseek.com](https://platform.deepseek.com/) 注册（国内手机号即可）
2. API Keys 页生成（`sk-...` 格式）
3. 注册送少量额度，之后便宜（~$0.14 / 1M tokens 比 GPT-4o 便宜 100×）
4. 拾卷设置 → AI Provider → DeepSeek → 粘贴 Key
5. 模型：`deepseek-chat` 通用 / `deepseek-reasoner` 有思维链

### 字节豆包

1. [火山方舟](https://www.volcengine.com/product/ark) 控制台 → API Key
2. **注意**：豆包用「endpoint ID」而非模型名，需要先在控制台为某个模型创建一个 inference endpoint
3. 拾卷的「模型」字段填 endpoint ID（`ep-xxxxxxxxxxxx`）

### 月之暗面 Kimi

1. [platform.moonshot.cn](https://platform.moonshot.cn/) 注册
2. API Keys → 生成
3. 模型：`moonshot-v1-8k` / `moonshot-v1-128k`（长上下文）

---

## 版本更新

### v1.3.0-beta · 2026-04-19（当前）

**召唤可信度三波 + 主进程节流 + AI 深度搜索**

- 新增：`[资料 N]` 引用核验（伪造编号红框警告）
- 新增：无资料池 persona 注入「禁止编造引用」硬约束
- 新增：AI 深度搜索（递归减半 breadth 6→3，2 轮上限）
- 新增：GLM 主进程节流 chokepoint（chat / embed / web-search-pro 共享 16s 间隔）
- 新增：学徒日记 Hermes Agent 每周观察报告
- 新增：OCR 大 PDF 自动切片
- 新增：诊断面板 / 启动恢复 / 崩溃上报
- 优化：portable 包从 1.2GB 瘦身到 350MB（-71%）
- 优化：注释搜索 + #N 引用跳转 + Ctrl+P 快速切换

**已知坑**：召唤对话功能暂时锁定（按钮显示「🔒 召唤对话（敬请期待）」），等三波兜底机制线上稳定后再放开。

详见 [DEVLOG.md](./DEVLOG.md)。

### v1.2.6 / v1.2.5 / v1.2.4

数据层加固 + UX 深度优化（共 22 批 bug 修复 + IPC 重构）。详见 git history。

---

## 开发

```bash
git clone https://github.com/lickswan-lab/shijuan.git
cd shijuan
npm install
npm run dev          # 开发模式（HMR）
npx tsc --noEmit     # 类型检查
```

技术栈：Electron 34 + Vite + React 18 + TypeScript + Zustand + react-pdf / epubjs / mammoth。

主目录结构：
```
electron/
  ipc/                 # 主进程 IPC handlers
    aiApi.ts           # 6 家 LLM provider 统一 wrapper
    aiThrottle.ts      # per-provider chokepoint（v1.3.0-beta 新）
    personas.ts        # persona CRUD + 蒸馏
    personaEmbeddingApi.ts / personaRagHelper.ts  # 嵌入 + 检索
    personas-search-helper.ts                     # 7 源并行搜索
src/
  components/
    Agent/             # PersonasTab / AgentPanel / 学徒日记
    PdfViewer/         # 阅读流 + 大纲
    AnnotationPanel/   # 注释 + 搜索
```

---

## License

待定（私有项目预备开源）。如需商用请先 issue 联系。

---

## 联系

- Issues：[github.com/lickswan-lab/shijuan/issues](https://github.com/lickswan-lab/shijuan/issues)
- Email：lickswan@gmail.com
