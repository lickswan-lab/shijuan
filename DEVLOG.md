# 拾卷 / 召唤功能 开发日志

格式：倒序（新的在上）。每个 batch 一段，列改了什么 + 留了什么坑。

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
