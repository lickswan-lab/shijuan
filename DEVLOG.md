# 拾卷 / 召唤功能 开发日志

格式：倒序（新的在上）。每个 batch 一段，列改了什么 + 留了什么坑。

---

## 2026-04-19 · Batch 38 · 文社科用户视角痛点修复（5 个）

### 出发点

用户问："以一个文社科的本科生/研究生的视角审视目前的应用现状"。我做了一份 6 痛点清单，用户拍板"解决 6 个痛点"，后改为"痛点 6 不着急"——保留 P1~P5 实现：

| P  | 痛点 | 解决方式 |
|----|------|---------|
| P1 | README 太"开发者"，新人看完直接劝退 | 整段重写顶部，去掉 Electron / Vite / IPC / Zustand / chokepoint 等术语 |
| P2 | 7 家 Provider 平铺，新用户不知道选哪个 | GLM 加「推荐起步」红色 badge + 首启 Onboarding 弹窗 |
| P3 | 文献库导出只有"全库导出"，单条无快捷动作 | 文件树右键菜单加「复制引用（纯文本）」+「复制 BibTeX」 |
| ~~P4~~ | "召唤""学徒"用奇幻 / 师徒比喻，文社科用户隔阂 | 一度改成「作者问答」/「阅读小结」，**用户复审后撤回**——名字保留 |
| P5 | 沉浸阅读 + 听课模式都在代码里写好了，但被 `{false &&}` 锁着 | 翻开 guard，两个完整功能立刻可用 |
| ~~P6~~ | 隐私 / 数据存储不可见 | 用户判断"不着急"，跳过 |

### 做了什么

#### P5 · 解锁两个已实现功能（最高 ROI）

- `src/components/PdfViewer/PdfViewer.tsx:2557`：把 `{false && <button>` 改为 `<button>`，沉浸阅读切换按钮直接出现在阅读栏，点击隐藏侧栏 + TopBar
- `src/components/TopBar/TopBar.tsx:547`：同样翻开听课模式入口，点击进入 LectureMode（webspeech / 讯飞 / 阿里云 三种 STT 可选）

两个功能后端 + UI + 状态管理 + 快捷键全是齐的（`useUiStore.immersiveMode` / `setImmersiveMode` / `activeLectureId` / `setActiveLecture` 早就 wired），只是 hide guard 没翻。两行改动，两个功能上线。

#### P4 · UI 名词改名 → 用户拍板撤回

第一遍按"去奇幻化"思路，把 UI 文案的「召唤 / 学徒 / Hermes」全改成了「作者问答 / 阅读小结 / 研究助手」（涉及 AgentPanel / PersonasTab / AnnotationPanel / PdfViewer / TopBar / personaDistillPrompts 共 6 文件、约 30 处字符串）。

跑完 tsc + build 后给用户看，用户回："**召唤 → 作者问答，学徒 → 阅读小结，Hermes → 研究助手（仅 UI 字符串）这个名字不要改**"。

→ 全量回滚，所有改动恢复。决策原因（猜测）：这三个名字是产品的<strong>身份标识</strong>而不是描述符——「召唤」一个名家比「作者问答」更有仪式感，「学徒」每周翻你的痕迹比「阅读小结」更有人格感，「Hermes」是研究助手的代号也是品牌锚点。换成中性词等于把产品的灵魂磨平。

教训：用户提的"文社科用户隔阂"是对<strong>解释成本</strong>的担忧，不是对<strong>名字本身</strong>的不满——下一轮如果还要做这件事，应该是<strong>给名字加一行小字注释</strong>（例如 `召唤 ⓘ 召唤一位人物的思想方式对话`），而不是改名字本身。

### P1 · README 顶部重写

把 100 行开发者口吻的"主进程级 chokepoint"/「五步验证管道」/「Persona Distillation」全部撤下，换成：

- 一句话定位："一个安静的桌面读书工具：导入文献、做注释、和书里的作者聊聊"
- 「这是什么」段：本地、文社科、不上传云端
- 「适合谁 / 不适合谁」对照
- 「主要能做什么」4 个真实使用场景：安静读书 / 学徒周报 / 召唤 / 跨文献关联
- 「上手三步」：导入 → 选中文字写想法 → 周一看学徒

API key 指南、Dev 章节、版本历史保留不动（那些是给已经上路的人看的）。

#### P2 · GLM 推荐 + 首启 Onboarding

- `TopBar.tsx`：GLM 卡片名旁加红底白字「推荐起步」徽章，比原本「OCR 必需」绿字更醒目
- 新建 `src/components/Onboarding/OnboardingModal.tsx`：
  - boot 后 1.2s 检查 `aiGetProviders()`，**任何 provider 已配置 → 不显示**
  - localStorage 标志位 `sj-onboarding-shown` —— 关一次就再不弹（无论是否真去配置）
  - 内容三段：定位（拾卷不接 AI 也能用）→ 推荐（GLM：国内、免费、5 分钟）→ 备选（OpenAI / Claude / Kimi 等）
  - CTA 一个："去配置 GLM →" 按钮，点击关弹窗 + 打开 Settings
  - 退出按钮「稍后再说」，没有压力推销
- `App.tsx` 用 `lazy()` + `<Suspense>` 挂在最底部，不影响首屏

#### P3 · 单条文献 BibTeX / 引用复制

`src/components/Sidebar/FileTree.tsx`：
- `EntryItem` 右键菜单分两组：[查看文件位置] / [复制引用、复制 BibTeX] / [移除、删除原文件]
- 「复制引用（纯文本）」：自动判 CJK 用「、」分隔多作者（中文），否则 " and "（英文），格式 `作者. 《标题》. 年份.` —— 直接粘到论文/邮件/微信
- 「复制 BibTeX」：复用 `utils/citations.ts:generateBibTeX()` 单条调用，剥掉 `% 拾卷导出 ...` 注释头，clipboard 里只剩 `@misc{...}` 块
- 全部走 `navigator.clipboard.writeText()`，零 IPC，零网络

### 测试通过

- `tsc --noEmit`：EXIT=0，0 错
- `electron-vite build`：4.30s 构建成功，`OnboardingModal-D0BhHV6a.js` 5.81 kB 已 split

### 已知问题 / 下一步

- 听课模式 + 沉浸阅读重新放出来后还没做端到端跑通；上次端到端测试是 Batch 36 在两个功能 hide 状态下做的。下个 batch 要补一次 LectureMode 实测（讯飞 key 注入流程 / webspeech 兜底）
- Onboarding 弹窗没做 i18n（中文硬编码）—— 拾卷整体只支持中文，先不展开
- P4 撤回后，"给名字加一行小字注释"的方案还没做——下个 batch 可考虑在 TopBar 这三个 tab 上 hover 显示一句解释，让陌生用户知道点进去会发生什么

---

## 2026-04-19 · Batch 37 · 启动黑洞修复（隐窗 + 静默失败兜底）

### 现象（Batch 36 端到端测试发现）

冷启动 v1.3.0-beta 安装版 `拾卷.exe` 时：
- 4 个 electron 进程都成功 spawn（main + utility + 2 renderer）
- `MainWindowHandle = 0`，主窗口从未显示
- `Preferences` 文件被写入 → 说明 main 进程跑到了 IPC 注册之后
- stderr 全空 → `loadFile()` 的 promise 被 `.catch(console.error)` 吃掉了，但启动从 Start 菜单时 console 不可见
- 用户角度：点了图标 → 任务管理器里有进程 → 没窗口 → 不知道发生了什么

根因：`createWindow` 用 `show:false` + `ready-to-show` 触发显示，一旦 renderer 在首次 paint 之前崩溃 / preload 抛错 / loadFile 路径错，`ready-to-show` 永远不会 fire，窗口永远不显示。**这是隐窗黑洞 bug**。

### 做了什么

1. **`electron/ipc/diagnostic.ts`**：把 `appendCrashLog` 从 module-private 改成 `export`，让 main.ts 在 IPC 注册之前就能写崩溃日志（原来只有 renderer ErrorBoundary 能调）

2. **`electron/main.ts`** — 三层兜底：

   **a. force-show 定时器**（核心修复）
   ```ts
   const forceShowTimer = setTimeout(() => {
     if (mainWindow.isDestroyed() || readyToShowFired) return
     logStartup('ready-to-show did not fire within 8s, forcing window.show()', { url, isLoading })
     mainWindow.show()
   }, 8000)
   ```
   `ready-to-show` fire 时清掉 timer。8s 后即使 ready-to-show 没触发也强制 show，用户至少能看到一个窗口（哪怕是空白的）+ 在 crash.log 里留下原因，而不是进程死在后台。

   **b. webContents 失败事件全量监听**
   - `did-fail-load` (main frame only) → log + force show + `dialog.showErrorBox`
   - `render-process-gone` → log + force show + 弹窗显示 reason / exitCode
   - `preload-error` → log（preload 挂了一般 window 还会出来，只记录就够）

   **c. 进程级 uncaughtException / unhandledRejection trap**
   - 模块顶层注册（在 single-instance lock 之前）
   - 任何逃出 try/catch 的异步错误都进 crash.log

3. **IPC 注册全部 wrap 进 `safeRegister`**
   - 原来 8 个 `registerXxxIpc()` 串行裸调，任何一个抛错就把整个 boot 拖崩
   - 现在每个独立 try/catch，挂掉的模块进 crash.log，其他模块继续注册
   - （用 `const safeRegister = (...) => {}` 而不是 `function`，避开 tsconfig.node.json 的 ES5 strict 不允许 nested function decl）

4. **顶层启动 banner**
   `logStartup('boot v?.?.? pid=N platform=win32 arch=x64')` —— crash.log 头两行就能看出哪个版本启的、什么时候启的，直接对比时间戳找问题

### 为什么不直接换 `show: true`

考虑过最简方案：把 `show: false` 改成 `show: true`，反正出问题至少看得见。否决理由：
- 拾卷会有一闪即逝的白底窗口（背景没刷上 backgroundColor 之前），UX 倒退
- 治标不治本：如果 preload 挂了，渲染进程就是瞎的，光显示空窗口用户也只能看着白屏
- force-show 定时器同时解决「显示窗口」+「记录原因」两件事，更对路

### 已知问题 / 下一步

- ⚠️ Batch 36 测试时观察到的隐窗 root cause 还没定位 —— 这次只加了诊断 + 兜底。下次冷启动如果还隐窗，crash.log 应该能直接告诉我们是 did-fail-load / preload-error / 还是别的。**修复有效性需要等下一次重打包 + 用户复现来验证**
- IPC `safeRegister` 容错的副作用：如果 `library` 挂了，App 现在会"半残"启动（窗口出来但读不到文献库），而不是直接退出。这是有意的取舍——半残比黑洞强，用户能看到错误并去 Settings → 数据目录 排查
- crash.log 路径是 `~/.lit-manager/crash.log`，已经在 FEATURES.md §13 提到过，但首次启动失败的用户可能不知道去哪找。下一个 batch 考虑在 `dialog.showErrorBox` 里把这个路径直接告诉用户

### 测试通过

- `tsc --noEmit -p tsconfig.node.json`：main.ts / diagnostic.ts 我改的部分 0 错（agent.ts / aiThrottle.ts / apprentice.ts / glmApi.ts / library.ts 那 7 个错误是 pre-existing，不是这次引入的，且 electron-vite 实际构建链路不走这套 tsconfig）
- `electron-vite build`：构建成功（4.49s），新代码（forceShowTimer / did-fail-load / render-process-gone / uncaughtException）已确认进 main bundle

---

## 2026-04-19 · Batch 36 · 官网大改 + 功能盘点 + 热更新机制澄清

### 做了什么

1. **官网整体调优**（`拾卷-website/index.html`）
   - 顶部导航新增「指南」入口，把原来的 #api-keys 区块重组成 ① 五步使用指南 + ② API Key 6 卡（智谱 / OpenAI / Claude / DeepSeek / 豆包 / Kimi）
   - hero badge 从「召唤历史名人」改为「学徒报告 / OCR 深度阅读 / 跨文献笔记」
     —— 因为召唤对话还锁着,放出来等于过度承诺
   - 上传桌面截图 `shot-hermes.png` 替换 Hermes 学徒区域的占位
   - 把 Hermes / 笔记 / 暗色三段合并到一个暖色背景的大区里，左右交替布局
     （Hermes reverse / 笔记 normal / 暗色 reverse + margin-bottom:0）
   - 8 个 emoji 图标全换成 Lucide 风格 stroke SVG（44px 圆角 + accent gradient + inset shadow）
   - 下载区新增「未签名安装提醒」黄底框，给 Win SmartScreen 与 macOS Gatekeeper 的绕行步骤
   - 下载按钮直接走 release asset URL，不再跳转 GitHub release 页让用户自己挑
   - 卡片布局从 5 卡 1 行改成 4 卡 2-2（max-width 700px），删了便携 exe，留 NSIS + Win zip + Mac arm64 + Mac x64
   - 卡片内部 `flex-direction: column; margin-top: auto` 解决末卡 2 行描述把按钮挤偏的问题

2. **功能盘点报告**（新文件 `FEATURES.md`，358 行 15 章）
   - `[✅ 可用]` / `[⚠️ 部分]` / `[🔒 锁定]` / `[🚧 未实装]` 四态打分
   - 覆盖：文献库管理 / 阅读 / 注释 / OCR / 笔记 / AI 对话 / Persona 召唤 / 学徒 / 设置 / 更新 / 快捷键 / 数据 / 已知坑 等
   - 配套 `package.json` / `electron/main.ts` / `electron/preload.ts` 实际 grep 出来的功能列表，不靠记忆

3. **🚑 自动更新机制澄清（之前 FEATURES.md 误判为未实装）**
   - 重新读 `electron/updater.ts` 全文(304 行)+ `main.ts:108` `registerUpdaterIpc()` 调用 + `preload.ts:271-279` 4 个 IPC 暴露 + release asset 包含 214MB `app.asar`
   - 结论:**真·热更新已完整实装**,且设计巧妙:
     - 自定义 asar-patch 流程,不依赖 `electron-updater`
     - **关键是不需要代码签名**:替换的是已安装应用内部的 `app.asar`,SmartScreen / Gatekeeper 在首次安装时已经放过行了,后续的热补丁不会再触发安装拦截
     - Win 用 `cmd` 脚本 `move /Y` + 15 次重试解决 asar mmap 文件锁
     - macOS 用 `bash` 脚本 `mv -f` + 15 次重试,detached process 接力 swap 然后重启
   - FEATURES.md §11 已修正回 [✅] 状态

4. **下载本地打包版本 portable.exe(127MB)做端到端冒烟测试**
   - 流程:`gh release download` → `cmd /c start` 启动 → 5 个 electron 进程起来 → 用 computer-use 截图验证 UI

### 已知问题

- 官网热更新提示语暂无,因为 release 历史上每个版本都得包含 `app.asar` 才能触发热更新逻辑;v1.3.0-beta 已经有了,但没在用户文档里告知机制。下个 batch 加一段「自动更新」FAQ
- FEATURES.md 的 [🔒 锁定] 一栏目前只有「召唤对话」一项,等 batch 34 三波兜底机制线上稳定后会从锁定移到 [✅]
- portable.exe 是新打的,还没在另一台干净 Win 机器上做无 dependency check 的冷启动测试

### 测试通过

- `tsc --noEmit` 干净
- 官网 GitHub Pages 部署成功,导航 / 截图 / 下载按钮 / 安装提醒框都渲染正常
- portable.exe 启动成功(5 个 electron 进程 spawn,用 tasklist 确认)

---

## 2026-04-19 · Batch 35 · 节流搬到主进程（chokepoint 单点）+ 召唤暂锁

### 做了什么

1. **🚑🚑 GLM 速率限制根治：节流模块迁主进程**
   新文件 `electron/ipc/aiThrottle.ts`
   - 原因：Batch 34 的前端节流只覆盖 `callPersonaAi`（chat），但 GLM 在主进程
     被 3 条独立路径调（chat / embedding / web-search-pro），三家共用 4 RPM
     配额却没共用 throttle 状态 → 并发依旧炸穿
   - 主进程模块级 `lastScheduledByProvider` + `adaptiveMultByProvider`，HMR 不重置
   - GLM base 间隔从 13s → **16s**（按整分钟边界 60/4=15s 算，留 1s 安全边）
   - 撞墙后 `bumpProviderInterval(provider)` ×2 自适应（上限 8×），所有路径共享
   - 三个出口全接入：
     - `aiApi.ts` callChat / callChatStream（chat completions）
     - `personaEmbeddingApi.ts` embedTexts（Phase A 索引 + Phase B 检索）
     - `personas-search-helper.ts` searchGlmWebSearchPro（web-search-pro tools 接口）
   - 每个出口非 OK 响应都 `isRateLimitError` 判 429/1302，命中即 bump

2. **前端节流删除**
   `src/components/Agent/PersonasTab.tsx`
   - 删 `PROVIDER_BASE_INTERVAL_MS` / `lastScheduledByProvider` / `throttleProvider` /
     `bumpProviderInterval`（约 50 行）
   - `callPersonaAi` 不再 await frontend throttle，直接进 IPC（主进程会节流）
   - 保留 retry 作为保险（15s/30s 退避 ×2，因为重试要走同一个 onChunk 流推进度）

3. **召唤功能暂锁（功能敬请期待）**
   `src/components/Agent/PersonasTab.tsx`
   - 「召唤对话」按钮改为 disabled + 虚线边 + 🔒 图标
   - 文案：「🔒 召唤对话（敬请期待）」
   - 等 Batch 34 三波（无资料兜底 + citation reverse-parse + 节流）线上稳定后再开

### 已知问题

- ⚠️ 主进程节流是 single-process scope。如果用户多开 Electron 实例（罕见但可能），
  各实例仍各跑各的 lastScheduled — 但 Electron 默认是 single-instance，正常情况下
  不会出现这个 case
- 嵌入 / 搜索路径没有 callPersonaAi 那种 retry-with-backoff，撞墙后调用方拿到
  `[]` 或抛出。这是有意的：embedding 撞墙 caller (PersonaIndex) 已有自己的
  recovery，搜索撞墙静默返回 [] 不影响其他 6 源并行

### 测试通过

- `tsc --noEmit` 干净
- 待人工验证：清掉 `~/.config/lit-manager` 的索引缓存，重跑 Hegel persona 一次
  全流程（chat + embed 重建 + GLM 搜索），观察是否还会出 1302

---

## 2026-04-19 · Batch 34 · 召唤可信度三波 + 主动节流

### 做了什么

1. **🚑 429 速率限制 — 主动节流（per-provider）**
   `src/components/Agent/PersonasTab.tsx:90-150`
   - 全局 per-provider min-interval 队列（GLM 13s · 其他 1.1s）
   - 撞墙 → `bumpProviderInterval` 自动 ×2，上限 8×
   - 队列用「原子预约 slot」模式：`lastScheduled = max(now, last+minMs)`，并发 `Promise.all` 自动按序通过
   - retry 仍保留作为保险（15s/30s 退避 ×2）

2. **第二波 · 无资料硬兜底**（抄 STORM `no-info` fallback）
   `electron/ipc/personas.ts:1051-1080` + `electron/preload.ts:200-220`
   - `persona-get-system-prompt` 现在区分三态：chunks>0 / totalChunks>0 但 0 匹配 / totalChunks=0
   - 第三态注入「⛔ 极重要：禁止给具体年份/地名/原话，只能讲方法论 + 立场」硬约束
   - IPC 多返回 `chunks` + `totalChunks`，给前端做反向解析

3. **第三波 · citation reverse-parse**
   新文件 `src/components/Agent/personaCitationParse.ts`
   - 正则匹配 `[资料1]` / `【资料 1】` / `[资料 1, 2]` / `[资料 1-3]` 各种脏变体
   - `parseCitations` 反向映射 N → injected chunk；超出范围的标记为伪造
   - `normalizeCitations` 渲染前规范化，markdown 看着干净
   - UI：召唤对话每条 user msg 加「🔎 BM25 top-K / ⛔ 无可检索」badge；assistant msg 下方加「📚 引用核验」卡片，伪造引用红框

4. **AI 自主迭代调研**（之前 batch 33 落地）
   - `personaResearchPrompt.ts` — dzhng 递归减半 + STORM Q→Q 两层
   - `handleDeepResearch` callback + 「🤖 AI 深度搜索」按钮 + 进度条 + 中止
   - 2 轮上限，breadth 6→3，URL 去重，零增长提前退出

### 已知问题（下一步要查）

- ⚠️ **节流后 GLM 仍会触发速率限制**（用户报告 2026-04-19）
  - 当前节流配置：13s base · 撞墙后 ×2 自适应
  - 可能原因待排查：
    1. 节流只覆盖 `callPersonaAi`，但其他路径（embeddings 调 GLM、深度搜索的 `nuwaSearch` 调 GLM web-search-pro）也在并发请求 → 共用 GLM 配额却没共用 throttle
    2. GLM 不是按"60s 滑动窗口"算 RPM 而是按整分钟边界 → 13s × 5 在某分钟内挤 5+ 个就炸
    3. GLM 实际 RPM 比 5 更严（比如付费/免费 tier 区别，或者被官方降级）
    4. 多个 React 组件实例共用模块级 `lastScheduledByProvider` 但 HMR 后 reset
  - 排查动作：
    - [ ] 把 `lastScheduledByProvider` / `adaptiveMultByProvider` 提到一个独立模块（如 `aiThrottle.ts`），让所有 GLM 调用入口（`callPersonaAi` / `nuwaSearch` / embeddings）都走这一层
    - [ ] 在主进程 `aiApi.ts` 也加一道节流（前端节流不可信，渲染进程多 tab 时共用 main 是真正的 chokepoint）
    - [ ] 把 GLM base 间隔从 13s 提到 16~20s（按整分钟边界算的话 60/3 = 20s 才完全安全）
    - [ ] 加日志：每次 GLM 调用记 timestamp + 来源（哪个 caller），看实际 burst 模式

- 一键蒸馏维度 `decisions` 偶发失败：是上面 GLM 429 的下游表现，节流修了应该一并好

### 测试通过

- `tsc --noEmit` 干净（0 错误）
- 手动：Hegel 资料池 → 「🤖 AI 深度搜索」→ 第 1 轮 +N 资料、第 2 轮收敛 OK
- 手动：召唤问具体问题 → assistant msg 下方出现「📚 引用核验」+ 真实引用卡片

---

## 2026-04-19 · Batch 33（之前）· GLM web-search-pro 入资料池 + 「🤖 GLM 搜索」badge

详见 batch 34 第 4 项 + git history。
