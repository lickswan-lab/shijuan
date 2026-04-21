# 拾卷 ShiJuan

> 一个安静的桌面读书工具：导入文献、做注释、召唤书里的人物聊聊。

**当前版本**：v1.3.0 · 2026-04-21

---

## 这是什么

一个本地的桌面应用，给读人文社科书的人用。打开 PDF / EPUB / DOCX，选中段落写想法，让 AI 帮你梳理脉络。每周让"学徒"给你写一份观察——你这周读了什么、停在哪里、留下什么问题。

也能"召唤一位人物"——比如黑格尔、福柯、霍布斯——拾卷会去找他的原文资料，整理出他的思想方式，然后你可以问他："你怎么看这件事？"他的回答会标注出处，告诉你这句话来自他实际写过的哪一段。

不上传云端。书、笔记、对话记录都存在你电脑上的 `~/.lit-manager/` 文件夹里。

---

## 适合谁

- 读社科 / 哲学 / 思想史的本科生、研究生、老师
- 做田野笔记 / 论文综述 / 课程备课的人
- 不想让 AI 凭印象瞎答、希望它"基于真实原文"回答的人

不适合谁：
- 想要花哨 AI 写作功能的人（这不是 ChatGPT 替身）
- 想云端同步多设备的人（拾卷是本地的）

---

## 主要能做什么

### 1. 安静地读书 + 写注释

- 支持 PDF / EPUB / DOCX / HTML / TXT / Markdown
- 选中文字 → 写笔记、问 AI、标记立场和质疑
- 沉浸阅读模式：一键隐藏所有边栏
- 听课模式：边听讲座边自动转写文字（可选讯飞 / 阿里云语音引擎）
- 全文搜索 + #N 引用跳转 + Ctrl+P 快速切换文档

### 2. 学徒周报：每周观察

每周一次，"学徒"会翻一遍你这周的痕迹，写一份观察交给你：
- 这周打开了哪些书、停在哪一页
- 哪些立场和你之前的想法相反了
- 哪本书连着几天打开却没写东西——你在等什么吗
- 这些观察不是流水账，是你自己可能没注意到的模式

读完可以追问学徒为什么这么看。

### 3. 召唤：和书里的人物对话

输入一个名字（如"福柯"），拾卷会：
1. 自动搜索他的原文资料（中英维基、Archive.org、Project Gutenberg 等多个来源）
2. 提炼出他的思想方式（核心观点、时代背景、世界观、语言风格等 6 个维度）
3. 你可以召唤他对话——他每句话都会标注 `[资料 N]`，告诉你引用的是哪一段原文
4. 如果你问的问题他没资料覆盖，他会承认"这个不知道"，而不是瞎编

也可以选中文献中的一段文字，召唤某位人物从他的视角批注这段内容。

### 4. 跨文献关联

写新注释时，AI 会发现你以前在别的书里写过的相似想法，提示"你之前也关注过——"，帮你串起散落在不同书里的思考。

---

## 安装

### Windows

从 [Releases](https://github.com/lickswan-lab/shijuan/releases) 下载：

- **便携版**（350MB · 解压即用，不写注册表，适合 U 盘 / 不想动系统的人）
- **安装版**（会创建桌面 / 开始菜单快捷方式）

### macOS / Linux

暂未提供打包版本，需要从源码运行（见底部"开发"小节）。

---

## 上手三步

1. **导入一本书**：左侧栏「+」→ 选 PDF / EPUB / TXT
2. **选中文字写想法**：直接框选段落 → 写笔记 / 问 AI / 标记立场
3. **周一回来看学徒**：右上角 Hermes（研究助手）→ 学徒 → 生成最近 7 天观察

第一次用会提示你接入一个 AI 服务商。最简单的是智谱 GLM（国内能用、有免费额度），见下方 API Key 指南。如果只是想读书、写注释，不接 AI 也能用。

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

### v1.3.0 · 2026-04-21（当前）

**翻译功能 / EPUB 格式文本优化**

- 翻译任务后台化：modal 改 store-driven，关闭弹窗不中止翻译；顶栏翻译按钮加状态徽章（运行/完成/失败/已停止），查看后自动消失
- TranslateModal mode 记忆：重开 modal 自动恢复上次未查看的 job 模式
- BatchOcr 浮窗成功完成后 3 秒自动消失，提示精简
- FileTree 每文献右侧加 OCR 状态图标（旋转/绿/红/琥珀）
- EPUB 阅读全面修复：
  - 加载只显示封面 → 改 flow:'scrolled' + 章节导航栏（上/下章 + 目录 + 进度 + 当前章）+ ←/→ 键盘翻章
  - 排版居中 + 宋体 + 图片自适应；本书 CSS 无法覆盖时用 !important 兜底
  - 注释高亮 + 6 色划线全部接入（含右键自定义菜单）
  - 字号 / 粗细 / 深浅 / 背景色 控件全格式打通（OCR / DOCX / TXT / MD / HTML / EPUB）
  - 划词工具栏 全格式适配（PDF / OCR / DOCX / EPUB / HTML / TXT / MD）
  - 选中行为统一：仅弹工具栏，注释栏由按钮触发，不再自动展开
  - 注释栏开关后 350ms resize 修右侧空白条，并恢复 cfi 阅读位置
- HTML 文件查看器：iframe 内注入排版 CSS + 选中桥接到父文档工具栏
- 注释面板底部"发送 AI / 召唤 / 保存笔记"三按钮 nowrap，不再换行
- 划词工具栏加复制 / 翻译按钮（后撤回），保留 Ctrl+C 复制兜底

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
