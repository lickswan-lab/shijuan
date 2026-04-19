# 拾卷 / 召唤功能 开发日志

格式：倒序（新的在上）。每个 batch 一段，列改了什么 + 留了什么坑。

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
