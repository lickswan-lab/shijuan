# Bug 报告 · 2026-04-24

静态代码分析 + 流程推演的一次系统性 sweep。覆盖区域：召唤 redesign（PersonasTab / SummonView / 会话持久化）、RAG 自动构建广播、速率限制队列、citation 反向解析、肖像 IPC、新增的 IPC 模块。

**Round 2 (2026-04-24 · 本轮)**：清掉 Round 1 留下的 4 条中危 + 新扫 PdfViewer / Lecture / Onboarding / stores / library/readingLog/lecture/agent IPC / App / TopBar。

## 🔴 高危 · 已直接修（Round 1 · 3 条）

### BUG-FIX #1 · electron/ipc/personas.ts:1021 · persona-delete 留下孤儿文件
**症状**：用户在 gallery 点「移除」一位思想家后，档案 json 被删掉，但：
- `<DATA_DIR>/agent/personas/<id>.rag.json`（embedding 索引，可达 MB 级）
- `<DATA_DIR>/agent/personas/<id>/portrait.*`（用户覆盖的肖像目录）
- `<DATA_DIR>/agent/summons/<id>/*.json`（历史对话，可能很多文件）

都原地不动。时间一长用户 `.lit-manager/` 堆一堆用不到的 blob；更恶心的是，如果再用相同 id 创建档案（实际不会，因为 uuid，但…），历史数据会 resurface。

**根因**：`persona-delete` 只 `fs.unlink(<id>.json)`，没清后续所有关联路径。

**修复**：unlink 成功后 Promise.all 并行清理 rag 文件 / 肖像目录 / summons 目录，每个独立 catch 以免单点故障阻断其他清理。ENOENT 路径也触发一次 sweep（修补历史 partial-delete 状态）。

**注释标签**：`// BUG-FIX #1 · persona-delete leaves orphans`

---

### BUG-FIX #2 · src/components/Agent/personaRagStatus.tsx:262 · usePersonaRagAutoBuildToasts setTimeout 泄漏
**症状**：自动 RAG 构建每完成一个（或失败一个）就 `setTimeout(() => dismiss(toast.id), 6000)`，但这个 timer handle 从来没被跟踪。用户如果在 6s 内切出 PersonasTab（父组件卸载），React 会打印 "Can't perform a React state update on an unmounted component" 警告；更糟，timer 仍然在跑，6s 后调用的 `dismiss` 闭包里的 `setToasts` 推到了僵尸 state，浪费渲染并污染 React 警告日志。

批量自动构建（用户同时导入 3 个 skill）会累积 N 个泄漏 timer。

**根因**：`setTimeout(() => dismiss(...), autoDismissMs)` 没 clearTimeout，effect cleanup 只 `return cleanup` 处理了 IPC 订阅，没处理 timer。

**修复**：用 `dismissTimersRef: Set<Timeout>` 跟踪所有 pending 的 auto-dismiss timer；effect cleanup 同时清 IPC 订阅和这些 timer；timer 内部 fire 后自己 delete。

**注释标签**：`// BUG-FIX #2 · track auto-dismiss timers`

---

### BUG-FIX #3 · src/components/Agent/PersonasTab.tsx:1051 · SummonView handleSend 流式期间切页 setState on unmounted
**症状**：用户发一条消息后，在流式响应中途点「返回」或「新对话」（后者换 `key` 强制 remount），handleSend 正在 await 的 `personaGetSystemPrompt` / `aiChatStream` 还在跑；完成后 `setMessages / setStreaming / setBusy` 全部在已卸载组件上 fire，控制台刷 React 警告。`onAiStreamChunk` listener 也在 cleanup 之前的每一 chunk 都往僵尸 state 推 `setStreaming(full)`。

虽然不直接崩溃，但会掩盖真实 bug 的日志，并且在快速切换场景下拖慢一点点（无效渲染）。

**根因**：没有 `mountedRef` 守卫；原来的逻辑依赖 cleanup 移除 listener，但 listener 的 handler 里没有早退逻辑，且 aiChatStream 的 promise 完成后的分支完全没有 mounted check。

**修复**：新建 `mountedRef = useRef(true)`，在独立 useEffect([]) 里 set/unset。handleSend 里 5 个 await 点和 cleanup listener 全部加 `if (!mountedRef.current) return`。finally 的 setBusy(false) 也守卫。

**注释标签**：`// BUG-FIX #3 · mountedRef so async stream callbacks don't setState after unmount`

---

## 🔴 Round 2 已修（4 条 · 来自 Round 1 中危列表）

### BUG-FIX #A · src/components/Agent/personaRagStatus.tsx:127 · usePersonaRagStatusList buildIndex 卸载 setStatuses leak
**原问题**：手动构建 `await api.personaRagBuild(id)` 耗时 30–60s。用户这期间切 tab，setStatuses 在僵尸 hook 上 fire。refreshOne / refreshAll / progress listener 都有同样问题。

**修复**：新增 `mountedRef = useRef(true)`（独立 effect set/unset），所有 `await fetchPersonaRagUiState` / `await api.personaRagBuild` 后的 setStatuses 前加 `if (!mountedRef.current) return`。progress listener 的 `fetchPersonaRagUiState(...).then(s => ...)`、`error`/`chunk|embed|save` 三个分支也全部守卫。

**注释标签**：`// BUG-FIX #A · mountedRef guard for async build/refresh`

---

### BUG-FIX #C · electron/ipc/summonSession.ts:119 · save 预校验 serializable
**原问题**：SummonMsg `[key: string]: unknown` 允许前端塞任意字段。未来若塞了 Buffer/File/React element/循环引用，`JSON.stringify` 深在 `atomicWriteJson` 抛错，UI 得到一个模糊 error 字符串。

**修复**：save handler 开头 `try { JSON.stringify(session) } catch (e) { return { success: false, error: 'messages 含不可序列化字段: ' + e.message } }`。失败早返回，前端可映射成明确的 warning toast。

**注释标签**：`// BUG-FIX #C · serializable precheck`

---

### BUG-FIX #D · electron/ipc/aiThrottle.ts + aiRateLimits.ts · RPM override 持久化
**原问题**：`setProviderRpmOverride` 只改内存，重启回默认。付费 tier 用户每次启动都要再次设定 3000 RPM，浪费 quota。

**修复**：
- 新增 `loadRpmOverridesFromDisk()` / `persistRpmOverrides()`，落盘到 `~/.lit-manager/rate-limit-overrides.json`
- `setProviderRpmOverride` 改了状态后 fire-and-forget 调 `persistRpmOverrides`
- `aiApi.ts::registerAiApiIpc` 在 `loadApiKeys()` 之后、`startStatusBroadcast()` 之前调 `loadRpmOverridesFromDisk()`
- 兜底：文件不存在 / JSON 损坏 / 非 object / rpm 非法都不 throw（只 console.warn），boot 永远不被挡住
- 文件格式：`{ "openai": 3000, "glm": 120 }`——只存有效 override，null 视为"不存在"，自愈

**注释标签**：`// BUG-FIX #D · persist RPM overrides` 分布在 aiThrottle.ts 和 aiApi.ts 两处

---

### BUG-FIX #E · electron/ipc/personas.ts + preload.ts + PersonasTab.tsx · persona-append-source 后端 handler
**原问题**：appendSource 在 renderer 里用 `persona` prop 做 baseline，`{ ...persona, sourcesUsed: [...] }` 再 save。若放开前端 busy 护栏（未来 drop-zone 批量），N 个并发调用都读同一 baseline，最后一个 save 赢，中间的 source 全丢。

**修复**：
- 新增 IPC `persona-append-source(personaId, source)`：load 最新 persona → append → atomicWriteJson → 返回新 persona
- 用 `withPersonaAppendLock` per-persona 串行化（Promise 尾链模式，同 persona 串行，不同 persona 并行）
- preload 加 `personaAppendSource` 方法；PersonasTab 的 `appendSource` 改调新 handler，移除前端 "prop + spread" 逻辑
- 幂等：source.id 已存在时直接返回 latest（重试不重复）
- append 完成后仍触发 `maybeTriggerAutoBuild` 保留原语义

**注释标签**：`// BUG-FIX #E · persona-append-source read-modify-write on the main process`

---

## 🟢 中危 · 已修（本轮 / 2026-04-24）

### BUG-FIX #B · src/components/Agent/PersonasTab.tsx:1007 · 历史对话恢复后 injectedChunks 和 citations 丢失
**原问题**：`toPersistable` 故意只保存 role/content/retrievalMode/totalChunks/injectedCitationIds，丢掉了 injectedChunks 和 citations。resume 会话后，老 assistant 消息的「📚 引用核验」卡片区域是空的；RetrievalPill 也少显示 top-N 标签。

**复现**：召唤 → 提问命中 RAG → 看到引用卡 → 返回 → 再进同一会话 → 卡片没了。

**修复**：加 `compactChunk()` 辅助，`text` 截断到 240 字（CitationCard 只渲染前 140 字）；`toPersistable` 里一并保存 `injectedChunks` 和 `citations`（每条 citation 的 chunk 也走 compactChunk）。SummonMsgLike 后端是 `[key: string]: unknown`，不需要 backend 类型同步。
单 session 额外约 +40KB（50 msg × 5 chunk × 240 字），换来可恢复的引用核验。

**注释标签**：`// BUG-FIX #B · persist compact chunks + citations`

---

## 🟢 Round 1 观察项（4 条 · 仍保留不修）

- ~~**personaCitationParse.ts:34 / citationVerifier.ts:26** 正则字符类里 `~~` 是重复的，第二个 `~` 没意义。清理下更干净，但 regex 行为不变。~~ → **R8#1 已修**
- **aiThrottle.ts:165** `effectiveRpm` 已经 `Math.max(1, ...)` 防 0，但 baseRpm × adaptiveMultiplier rounded 后 glm (3) × 0.1 = 0.3 → round→0 → max(1,0)=1。安全。
- **personaPortrait.ts:100** `path.join(PERSONAS_DIR, personaId)` 没做 personaId 清洗。当前 id 都是 uuid() 安全，但未来 imported skill 的 id 若来源变化要小心。
- **personas.ts:1434** `persona-get-system-prompt` 里 `retrieveChunksInternal` 的 embed call 不走主进程队列，若一分钟连发 5 次，5 embed + 5 chat 可能撞 glm 3 RPM 墙——但 aiThrottle 自动降档能兜住。

---

# Round 2 · 2026-04-24

新扫描区域：`src/components/PdfViewer/*` · `src/components/Lecture/*` · `src/components/Onboarding/*` · `src/store/*` · `electron/ipc/library.ts` / `readingLog.ts` / `lecture.ts` / `agent.ts` · `src/App.tsx` · `src/components/TopBar/*`。

## 🔴 Round 2 已修（1 条）

### BUG-FIX R2#1 · src/components/PdfViewer/PdfViewer.tsx:2566+ · 切换文献时前一篇的异步加载污染当前文献
**症状**（⚠️ 最值得用户先看）：PdfViewer 在 `useEffect([currentEntry?.id])` 里并行发起一堆 `readFileBuffer` / `readOcrText` / mammoth 转 docx 的 promise。如果用户在某个 promise 还没 resolve 时快速切到另一篇：
1. 老文献 A 的 `readFileBuffer` 晚到 → 调用 `setTxtContent(A.txt)` / `setDocxHtml(A.docx)` / `setHtmlContent(A.html)`
2. 同时 `setCurrentDocText(A.text)`（uiStore 全局）覆盖了新文献 B 刚刚设置的 docText
3. 结果：PDF 画面显示 B（因为 `<Document>` 用 B 的 fileUrl），但 AnnotationPanel / AI 上下文 / 搜索全读到的是 A 的正文

**DOCX 情况最严重**：mammoth 转换是 CPU 密集（几百 ms），几乎一定会在用户连续点击文件列表时被 overtake。

**根因**：effect 里只有 "rereading greeting" 一段用了 `capturedEntryId + useLibraryStore.getState().currentEntry?.id !== capturedEntryId` 的守卫，其他 4 条 readFileBuffer/mammoth/readOcrText 都裸跑。

**修复**：在 effect 顶部捕获 `capturedEntryId` + 定义 `stillCurrent()` helper；每个 then() 回调先 check，不 match 就 drop。DOCX 分支在 mammoth 转换之前和之后各 check 一次（避免一个大文件浪费半秒 CPU 再丢弃）。

**注释标签**：`// BUG-FIX R2#1 · entry-switch race`

---

## 🟢 Round 2 本次已修（5 条 · 2026-04-24 晚）

### BUG-FIX R2#α · src/components/Lecture/LectureMode.tsx:363 · handleGenerateSummary stream leak
**原问题**：生成 AI 总结 stream 未 abort + setState on unmounted，付费 tier 烧 quota + 控制台告警。

**修复**：新增 `mountedRef = useRef(true)` + `activeSummaryStreamIdRef = useRef<string | null>(null)`。
- 组件 unmount 时自动 `aiAbortStream(activeSummaryStreamIdRef.current)`（fire-and-forget）
- onAiStreamChunk 里加 `if (!mountedRef.current) return`
- aiChatStream await 后的 setStreamingSummary / setGeneratingSummary 全部守卫
- cleanup() 后 `activeSummaryStreamIdRef.current = null`

**注释标签**：`// BUG-FIX R2#α · mount guard + active summary stream id`

---

### BUG R2#β · electron/ipc/library.ts:318 · read-file-buffer handler 无大小限制 OOM 风险
**状态**：🚫 **Won't fix（用户驳回 2026-04-24）**

**用户反馈**："read-file-buffer 不建议增加大小限制"——大 PDF 是合法使用场景（整本专著 / 大图集 / 扫描版老书经常 > 500MB），加硬上限会挡真实用户。OOM 风险交给 OS / Electron 自身的 heap 管理，拾卷不越界干预。

**症状**（原记录）：`ipcMain.handle('read-file-buffer', (_, filePath) => fs.readFile(filePath))` 一次把整个文件读进主进程 heap。500MB 的 PDF 让 electron 主进程分到 500MB+ 临时堆（实际还要乘以 IPC 序列化的开销），OS 层面容易触发 OOM kill。

**后续（可选）**：如果将来真的有用户反馈 OOM，考虑走 pdfjs 的 range-request 从 `file://` URL 直接加载，而不是加 size 上限——大文件该读还是读，只是读得更聪明。

---

### BUG-FIX R2#γ · electron/ipc/lecture.ts:122,134 · lecture sessionId path sanitization
**原问题**：`path.join(AUDIO_DIR, \`${sessionId}.webm\`)` 未清洗 sessionId，理论上可穿越写到 AUDIO_DIR 外的 .webm。当前 uuid() 安全，但 IPC 是 renderer 可控接口，属 defense-in-depth。

**修复**：在两个 handler 顶部加 `const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/`，不 match 返回 `{ success: false, error: 'sessionId 含非法字符' }`；同时检查 `typeof sessionId === 'string'`。

**注释标签**：`// BUG-FIX R2#γ · sanitize sessionId`

---

### BUG-FIX R2#δ · src/store/libraryStore.ts:165 · initLibrary setTimeout leak + stale closure
**原问题**：setTimeout handle 未跟踪、callback 闭包里的 `library` 可能过时。

**修复**：模块级 `let initPostBootTimer` 变量。每次 `initLibrary` 开头 `clearTimeout(initPostBootTimer)`，防 double-run；callback 内部用 `get().library` 重新取最新状态，避免覆写 midnight scheduler 在这 100ms 内的写入。OCR 扫描后第二次写盘也 re-read。

**注释标签**：`// BUG-FIX R2#δ · track the post-init background scan timer`

---

### BUG-FIX R2#ε · src/components/TopBar/TopBar.tsx · Settings / UpdatePanel setState after unmount
**原问题**：aiGetProviders / checkUpdate / downloadUpdate 的 async resolve 可能在子组件卸载后 fire setState，污染 React 警告日志。

**修复**：
- Settings 面板的 `aiGetProviders` 用 `let cancelled = false` + cleanup `() => { cancelled = true }` 模式
- UpdatePanel 内加 `mountedRef = useRef(true)`；handleCheck/handleDownload/onUpdateProgress 都守卫

**注释标签**：`// BUG-FIX R2#ε · cancellation flag` / `// BUG-FIX R2#ε · update check mountedRef`

---

### BUG-FIX R2#ζ · electron/ipc/readingLog.ts / agent.ts · corrupt JSON silent 吞
**原问题**：两处自写的 `loadLibrary = try { readFile + parse } catch { return null }` 不区分 ENOENT 和 corrupt，后者静默返回 null 让上层路径（midnight log / Hermes tools）无感知地跳过任务。

**修复**：拆成两个 try block——文件读取失败时 ENOENT 静默通过（首次启动合法），其它错误 `console.warn`；JSON.parse 失败时显式 `console.error` 并返回 null。

**注释标签**：`// BUG-FIX R2#ζ · distinguish file missing from corrupt`

---

## 🟢 Round 2 观察项（非 bug · 4 条）

- **electron/ipc/library.ts:326 save-ocr-text**：`absPath.replace(/\.pdf$/i, '.ocr.txt')`——非 .pdf 扩展名时没替换到，返回跟源一样的路径，`.ocr.txt` 结尾生成 `原名.ocr.txt` 最终还是正确（因为是追加）。边缘但不是 bug。
- **src/App.tsx:301** `initLibrary().then(...)` 里 `setTimeout(openEntry, 300)` 无清理。如果用户 300ms 内触发了手动 openEntry，会 double-open——但 openEntry 内部检查 currentEntry.id 即可容忍。观察。
- ~~**electron/ipc/agent.ts:279** `agent-save-conversation` read-modify-write 没走 lock。两个窗口并发写会失一条。但用户几乎不会开俩窗口同时跟 Hermes 对话。~~ → **R8#3 已修**(`withConversationsLock` 包 save + delete 两个 RMW 序列)
- **src/store/uiStore.ts:158,164,165** `localStorage.getItem` 的数字解析用 `Number(v)` 没防 NaN——如果用户手动改坏 localStorage，aiContextWindow 会变 NaN。下游使用点应该也没崩过（NaN 传给比较器都是 false），但不严谨。

---

## Round 2 修复文件清单

- `src/components/Agent/personaRagStatus.tsx`（BUG-FIX #A · usePersonaRagStatusList 加 mountedRef）
- `electron/ipc/summonSession.ts`（BUG-FIX #C · save 预校验）
- `electron/ipc/aiThrottle.ts`（BUG-FIX #D · loadRpmOverridesFromDisk + persistRpmOverrides）
- `electron/ipc/aiApi.ts`（BUG-FIX #D · registerAiApiIpc 调 loadRpmOverridesFromDisk）
- `electron/ipc/personas.ts`（BUG-FIX #E · persona-append-source handler + withPersonaAppendLock）
- `electron/preload.ts`（BUG-FIX #E · personaAppendSource 方法）
- `src/components/Agent/PersonasTab.tsx`（BUG-FIX #E · appendSource 改调后端）
- `src/components/PdfViewer/PdfViewer.tsx`（BUG-FIX R2#1 · stillCurrent 守卫）

### 本轮晚场追加（2026-04-24 晚）
- `src/components/Lecture/LectureMode.tsx`（BUG-FIX R2#α · mountedRef + aiAbortStream）
- `electron/ipc/lecture.ts`（BUG-FIX R2#γ · sessionId 清洗）
- `electron/ipc/readingLog.ts`（BUG-FIX R2#ζ · corrupt JSON 区分）
- `electron/ipc/agent.ts`（BUG-FIX R2#ζ · corrupt JSON 区分）
- `src/store/libraryStore.ts`（BUG-FIX R2#δ · initPostBootTimer + re-read state）
- `src/components/TopBar/TopBar.tsx`（BUG-FIX R2#ε · UpdatePanel mountedRef + Settings cancelled flag）
- `src/components/Agent/PersonasTab.tsx`（BUG-FIX #B · 持久化 compact injectedChunks + citations）

---

## 🟡 Round 3 · Memo/Search 扫描（2026-04-24 深夜）

### BUG-FIX MEMO#1 · src/components/Memo/MemoEditor.tsx:706+ · MemoAiSection 在 AI 返回时 setState on unmounted + 覆盖其它 memo 的并发编辑
**原问题**：
1. `handleAsk` 里 `await window.electronAPI.glmAsk(...)` 后的 setInput/setLoading 没 mountedRef 守卫。用户发 AI 问题然后切 memo → AI 回来后 setState 在僵尸组件上 fire。
2. 更严重：`library` 是 closure 捕获的。AI 思考期间用户在别处修改了其它 memo（auto-save 或别的入口），AI 回来时 `saveLibrary(library)` 写入的是**旧 library**，覆盖掉其它 memo 的新改动。

**修复**：
- 新增 `mountedRef = useRef(true)` + unmount 清理
- `handleAsk` 内先 `const libAtStart = useLibraryStore.getState().library` 读取新鲜 library
- `await glmAsk` 后 `if (!mountedRef.current) return`
- 保存时再 `const currentLib = useLibraryStore.getState().library`，写 currentLib（不写 closure 版）
- 从依赖里去掉 `library`（不再用 closure 版）

**注释标签**：`// BUG-FIX MEMO#1 · mountedRef + fresh-library read`

---

### BUG-FIX MEMO#2 · src/components/Memo/MemoEditor.tsx:836+ · handleContentChange setState 用闭包 library 会吞掉并发加 memo
**原问题**：用户在 memo A 里打字触发 auto-save debounce。`setState({ library: library ? { ...library } : null })` 里的 `library` 是 closure 版；若 AI auto-memo / apprentice 观察写入新增了一条 memo，这个浅拷贝会把它"还原"掉。

**修复**：`const latestLib = useLibraryStore.getState().library; setState({ library: latestLib ? { ...latestLib } : null })`。依赖里去掉 `library`。

**注释标签**：`// BUG-FIX MEMO#2 · use getState for library spread`

---

### BUG-FIX SEARCH#1 · src/components/Sidebar/FileTree.tsx:481+ · 全文搜索 race + setState on unmounted
**原问题**：
1. 400ms debounce 里 `await fullTextSearch(...)` 完成时，用户可能已经改了搜索词；旧关键词的慢搜索结果会覆盖新关键词的快搜索结果（false 命中感）。
2. 用户导航出 sidebar / 卸载组件，resolved 的 `setFullTextResults` / `setSearching` fire 在僵尸 hook 上，React 警告。

**修复**：generation counter `searchGenRef`。每次 debounce 触发 `++searchGenRef.current`，记录本次 gen；setTimeout 回调 + await 前后都 `if (gen !== searchGenRef.current) return`；unmount cleanup 也 `searchGenRef.current++` 让 in-flight 看到 mismatch 自动退出。比 mountedRef 多一层好处：搜词更替时自动抛弃旧结果。

**注释标签**：`// BUG-FIX SEARCH#1 · generation counter`

---

### 修复文件清单（Round 3）
- `src/components/Memo/MemoEditor.tsx`（MEMO#1 + MEMO#2）
- `src/components/Sidebar/FileTree.tsx`（SEARCH#1）

---

## 🟡 Round 3 · ReadingLog/Onboarding 扫描（2026-04-24 深夜）

### BUG-FIX READLOG#1 · src/components/ReadingLog/ReadingLogView.tsx:189+ · handleGenerateSummary stream leak
**原问题**：同 R2#α 模式。点"生成 AI 总结"后切走 reading-log 标签：
1. stream 未 abort，继续消耗 API quota
2. setStreamingText / setGeneratingSummary / saveReadingLog 在卸载组件上 fire
3. 错误 alert() 也可能在 unmount 后弹（扰民）

**修复**：`mountedRef = useRef(true)` + `activeStreamIdRef = useRef<string | null>(null)`。unmount effect 自动 aiAbortStream。所有 setState 前 `if (!mountedRef.current) return`。onAiStreamChunk 也守卫。

**注释标签**：`// BUG-FIX READLOG#1 · mount guard + active stream id`

---

### BUG-FIX ONBOARD#1 · src/components/Onboarding/OnboardingModal.tsx:82 · goToFeatureTour setTimeout 泄漏
**原问题**：`goToFeatureTour` 里 `setTimeout(() => setForceFeatureTour(true), 60)` 的 handle 没跟踪。用户如果在 60ms 内卸载 modal（rare 但可能），setForceFeatureTour 在僵尸组件上 fire，意外打开功能引导。

**修复**：`goToFeatureTourTimerRef = useRef<Timeout|null>(null)`；goToFeatureTour 里 clearTimeout 前一个 + 存新的；unmount effect cleanup。

**注释标签**：`// BUG-FIX ONBOARD#1 · track hand-off timer`

---

### 修复文件清单（Round 3 续）
- `src/components/ReadingLog/ReadingLogView.tsx`（READLOG#1）
- `src/components/Onboarding/OnboardingModal.tsx`（ONBOARD#1）

---

### BUG-FIX AGENT#1 · src/components/Agent/AgentPanel.tsx:202+ · mount 载入一批 IPC 的 setState on unmounted
**原问题**：AgentPanel 挂载时 useEffect([]) 里并行发 5 条 IPC（loadMemory / aiGetConfigured / agentLoadConversations / personaList / apprenticeList → apprenticeLoad），setTimeout 4s 再调一次 loadMemory。AgentPanel 随 `rightPanel` 切换频繁 mount/unmount；任一 IPC 慢到 unmount 后 resolve，就会 setState 在僵尸组件。

**修复**：`let cancelled = false` + 每个 `.then` 回调前 `if (cancelled) return` + cleanup `cancelled = true`；4s timer 也用 clearTimeout；timer callback 里二次检查 cancelled。

**注释标签**：`// BUG-FIX AGENT#1 · cancellation flag`

---

### 修复文件清单（Round 3 AGENT）
- `src/components/Agent/AgentPanel.tsx`（AGENT#1）

---

### BUG-FIX SEARCH#2 · electron/ipc/library.ts:358 · full-text-search 无外层 try/catch 可能 crash 主进程
**原问题**：`ipcMain.handle('full-text-search', async ...)` 整个 handler body 只有局部的 `.catch(() => null)` 和 `try { JSON.parse } catch {}`；如果 `libraryData.entries` 形状异常 / fs 权限错误 / 批量 promise 意外 throw，错误冒到 ipc 层 → Electron 主进程 reject → renderer 拿到失败，但更糟是**如果 promise 拒绝未处理，Electron 某些版本会 crash 主进程**。

**修复**：整个 body 包一层 try/catch。catch 里 `console.error` + `return []`——搜索返回空结果在 UX 上完全可接受（界面显示"无匹配"），主进程崩溃不行。

**注释标签**：`// BUG-FIX SEARCH#2 · wrap whole handler body`

---

### 修复文件清单（Round 3 SEARCH#2）
- `electron/ipc/library.ts`（SEARCH#2）

---

## 🟡 Round 4 · 2026-04-24 深夜批

### BUG-FIX R4#1 · annotationAiJobsStore.ts:107+ · flush updater rejection 只 warn 不改终态
**原问题**：`flushToEntry()` 里 `updater(...).catch(err => console.warn(...))` —— 磁盘写失败只打日志，job.status 永远停在 'running'，下次启动 UI 显示假"正在生成"幽灵状态。

**修复**：catch 里 `set()` 把 job 改成 `status: 'failed', error: err.message`；只在 running 时覆盖（避免覆盖 abort/completed 的正确终态）。

**注释标签**：`// BUG-FIX R4#1 · updater rejection`

### BUG-FIX R4#2 · annotationAiJobsStore.ts:130+ · stream listener 不拒绝已终态 job 的 chunk
**原问题**：onAiStreamChunk 回调不检查当前 job 是否 running。abort 或 idleTimer 触发 Promise.race 后，后端仍在流式发送的 chunk 还会被追加到 fullText，污染错误态消息（幻影追加）。

**修复**：回调顶部 `if (get().jobs[key]?.status !== 'running') return`。set() 内部也二次判断。

**注释标签**：`// BUG-FIX R4#2 · reject chunks for terminated jobs`

### BUG-FIX R4#3 · electron/ipc/lecture.ts:101+ · lecture-save 漏掉 sessionId 清洗
**原问题**：R2#γ 只给 save-audio / delete-audio 加了 SAFE_SESSION_ID 校验，lecture-save 是 oversight。脏 sessionId 可入 library.json 污染后续读取。

**修复**：handler 顶部加 `if (!SAFE_SESSION_ID.test(session.id)) return { success: false, error: 'sessionId 含非法字符' }`。常量提到 handler 前面（lecture-save 也能用）。

**注释标签**：`// BUG-FIX R4#3 · lecture-save sessionId 清洗`

### BUG-FIX R4#4 · readingLog.ts:395+ · midnight scheduler interval 无回收 + 窗口销毁未检查
**原问题**：setInterval 在 app 生命期永不 clear；开发模式 restart 会堆积；macOS dock 保活时主窗口关闭，win.isDestroyed() 未检查直接 `webContents.send` 会抛。

**修复**：
- 新导出 `stopMidnightScheduler()` 清 interval + 重置 window ref
- setInterval callback 内 `if (!win || win.isDestroyed()) return`
- `electron/main.ts` 的 `app.on('before-quit')` hook 调 stopMidnightScheduler()

**注释标签**：`// BUG-FIX R4#4 · scheduler cleanup`

### BUG-FIX R4#5 · src/utils/openEntryById.ts · 核心 await 缺 try/catch
**原问题**：`await useLibraryStore.getState().openEntry(entry)` 若失败（文件被移、权限、PDF 损坏），异常飘到 onClick 顶层成 "Unhandled promise rejection"；FileTree 搜索 / MemoEditor 跳转 / ReadingLogView 事件 3 个调用点都没 try/catch。用户只看到"点了没反应"。

**修复**：包 try/catch；catch 时 console.error + return false，调用方按 false 决定是否 toast。统一在 util 中处理 —— 3 个 call site 不需要每个都改。

**注释标签**：`// BUG-FIX R4#5 · centralized error handling`

### 修复文件清单（Round 4）
- `src/store/annotationAiJobsStore.ts`（R4#1 + R4#2）
- `electron/ipc/lecture.ts`（R4#3）
- `electron/ipc/readingLog.ts`（R4#4 · stopMidnightScheduler + isDestroyed）
- `electron/main.ts`（R4#4 · before-quit hook）
- `src/utils/openEntryById.ts`（R4#5 · try/catch 包核心路径）

---

## 🟡 Round 5 · 2026-04-24 凌晨

### BUG-FIX R5#1 · electron/ipc/personaEmbeddingApi.ts:120 · 429 重试 sleep 无视 AbortSignal
**原问题**：RAG 构建期间用户点"取消"，`abortSignal` 到了 fetch 但 retry 分支里 `await setTimeout(2000)` 是裸 Promise，不理 signal。每个 batch 撞 429 重试一次就延迟 2s，多 batch 累加 10s+ "幽灵延迟"。

**修复**：sleep 改成 Promise.race(sleep | abort 事件) · signal.aborted 检查在前 · abort 时 clearTimeout + reject(AbortError)。

**注释标签**：`// BUG-FIX R5#1 · abortable sleep`

### BUG-FIX R5#2 · electron/ipc/apprentice.ts:17 · loadLibrary / loadMeta 吞 corrupt JSON
**原问题**：同 R2#ζ 模式。两个辅助函数 `try { parse(readFile) } catch { return null }` —— 不区分 ENOENT（正常首启）和 JSON 损坏。损坏时观察周报生成静默失败，用户只看到 "库未初始化" 的误导性错误。

**修复**：拆成两段 —— 文件读失败 ENOENT 静默过 / 其它 warn；JSON parse 失败 `console.error` 详细信息 + return null。

**注释标签**：`// BUG-FIX R5#2 · distinguish missing vs corrupt`

### BUG-FIX R5#3 · src/store/uiStore.ts:158 · aiContextWindow NaN 防御
**原问题**：Round 2 观察项。`Number(v)` 在 v 被手动改成非数字字符串时得 NaN。NaN 传给下游比较 `ctx > 1000` 都 false，AI 请求永远用不上上下文窗口。

**修复**：读完后 `Number.isFinite(n) && n > 0 ? n : 2000` 兜底回默认值。

**注释标签**：`// BUG-FIX R5#3 · NaN 防御`

### 修复文件清单（Round 5）
- `electron/ipc/personaEmbeddingApi.ts`（R5#1）
- `electron/ipc/apprentice.ts`（R5#2）
- `src/store/uiStore.ts`（R5#3）

---

## 🟡 Round 6 · 2026-04-24 · UX + 小 bug

### BUG-FIX R6#1 · src/components/PdfViewer/PdfViewer.tsx:3436 · "OCR 文本"按钮 disabled + alert() 冗余
**原问题**：`onClick={() => { if (ocrFullText) setViewMode('ocr'); else alert('请先进行 OCR') }}` 加 `disabled={!ocrFullText}` —— disabled 按钮还同时挂 alert 回调，用户体验不清。

**修复**：onClick 只 setViewMode，用 `title={!ocrFullText ? '请先对本文献进行 OCR 识别' : ''}` 做 tooltip 提示，删除 alert。

---

## 🟡 Round 7 · 2026-04-24 · 交互异常边界

### BUG-FIX R7#1 · src/components/PdfViewer/PdfViewer.tsx:2462+ · rereadingReminder AI 流未 abort
**原问题**：用户打开文献 A（≥3 天未读），rereading AI 开始生成问候语。用户中途切到文献 B：AI stream 仍跑到完成，浪费 quota + 带宽。

**修复**：新增 `activeRereadingStreamIdRef`。设 streamId 前存 ref；完成 / 失败路径清 null。主 useEffect return cleanup 函数，entry 切换时 aiAbortStream(sid)。

**注释标签**：`// BUG-FIX R7#1 · abort rereading AI stream on entry switch`

### BUG-FIX R7#2 · src/components/PdfViewer/PdfViewer.tsx:2464+ · 快切 entry 时旧 rereading chain 覆盖新横幅
**原问题**：A → B → A 快速切换，旧 effect 的 AI chain 和新 effect 的 chain 并行，旧的在 `aiGetConfigured` / `import prompt` await 中，等它回来时新横幅已显示，旧的覆盖了新的。

**修复**：generation counter `rereadingGenRef`。effect 顶部 `const myGen = ++rereadingGenRef.current; const stillValid = () => myGen === rereadingGenRef.current && currentEntry?.id === capturedEntryId`；3 个 await 后用 stillValid() 检查，非法则 return。

**注释标签**：`// BUG-FIX R7#2 · generation counter`

### BUG-FIX R7#3 · src/components/PdfViewer/PdfViewer.tsx · "你上次..."横幅关闭后异步回调复活
**原问题**：用户点"查看注释"或 × 关闭横幅，setRereadingReminder(null) 清掉。但 loadPdfMeta.then 的异步链还在跑，完成时 setRereadingReminder({...}) 重新显示。

**修复**：`rereadingDismissedForRef: useRef<string | null>(null)`，3 个关闭点写入此 ref；entry 切换时重置；loadPdfMeta.then 回调顶部检查 ref 命中当前 entry 则直接 return。

---

## 🟢 Round PERF · 2026-04-24 · 性能 + 冗余代码

### PERF-R7#1 · src/App.tsx:97 · 全量解构 useUiStore 导致 App-wide 广泛重渲
**原问题**：`const { setGlmApiKeyStatus, annotationPanelCollapsed, toggleAnnotationPanel, ...11 values } = useUiStore()` —— zustand 返回整个 store 对象，任何一个字段变化都让 App 重渲（整个 react 树 reconcile）。

**修复**：改成 11 个独立 `useUiStore(s => s.xxx)` selector，每个字段独立订阅，无关改动不再触发顶层重渲。library 同理改 3 个 selector。

### CLEAN-R7#1 · src/components/Agent/AgentPanel.tsx · 学徒观察 dead code ~200 行清理
**清理**：学徒观察 UI 之前全删，但代码里还留着：
- 10 个 useState（apprenticeEntries / currentApprenticeWeek / currentApprenticeContent / generatingApprentice / apprenticeStreamText / historyExpanded / showCustomRange / customStart / customEnd / customRangeError / dialogueHistory / dialogueInput / dialogueStreaming / dialogueStreamText）
- 4 个 useCallback（generateApprentice / loadApprenticeWeek / sendDialogueQuestion / deleteApprenticeWeek）共 ~160 行
- 2 个顶层 import（apprenticePrompt / apprenticeDialoguePrompt）
- mount useEffect 里的 apprenticeList / apprenticeLoad IPC 加载

全删。TS 全绿，文件从 ~1300 行降到 1076 行。

### CLEAN-R7#2 · src/components/PdfViewer/PdfViewer.tsx · 回顾按钮 dead code 清理
**清理**：`reviewing` state + `reviewStreamIdRef` + 其 `useEffect` cleanup（abort review stream on entry switch）共 ~15 行。

### 修复文件清单（Round 6 + 7 + PERF）
- `src/components/PdfViewer/PdfViewer.tsx`（R6#1 · R7#1-3 · CLEAN-R7#2）
- `src/App.tsx`（PERF-R7#1）
- `src/components/Agent/AgentPanel.tsx`（CLEAN-R7#1）

---

## Round 1 修复文件清单（保留参考）

- `electron/ipc/personas.ts`（persona-delete 连带清理 rag/portrait/summons）
- `src/components/Agent/personaRagStatus.tsx`（auto-dismiss timer 跟踪）
- `src/components/Agent/PersonasTab.tsx`（SummonView mountedRef）

---

## 🟡 Round 8 · 2026-04-28 夜间值守

### BUG-FIX R8#1 · electron/ipc/citationVerifier.ts:26,35 + src/components/Agent/personaCitationParse.ts:34 · 正则 char class 里 `~~` 重复
**原问题**：R1 观察项第 1 条留下的 cleanup。`/[\d,，、\s\-–~~]+/` 字符类里两个 `~` 完全等价于一个；同样在 `[\-–~~]` 里也是。regex 行为不变，但留着是 noise，理解成"`~` 范围"会误导未来读者。

**修复**：3 处 `~~` → `~`。tsc / build 全绿，无行为变化。

**注释标签**：`// BUG-FIX R8#1 · char class 里 ~~ 是重复(R1 观察项),清成 ~`

### BUG-FIX R8#3 · electron/ipc/agent.ts:289,312 · agent-save-conversation / agent-delete-conversation 加 RMW 锁
**原问题**：R2 观察项第 3 条。两个 handler 都做 read-modify-write,但读和写之间没加锁:
- A 读 [a, b, c] → B 读 [a, b, c] → A 写 [a', b, c] → B 写 [a, b', c] (B 用的是 stale read,覆盖 A)

`atomicWriteJson` 自身的 `writeLock` 只保证写原子,不阻止 read 跨过。

**修复**：模块级 `conversationsRMWChain: Promise<unknown>` + `withConversationsLock(fn)` helper(promise chain 串行化)。两个 handler 整个 RMW 序列都包在锁里。失败时 catch reset,后续调用不被卡死。

**触发场景**：双窗口、IPC 队列里两个 save 紧挨着、save 紧跟 delete。普通单窗口低 ux 频率确实罕见,但模式上是真 bug。

**注释标签**：`// BUG-FIX R8#3 · agent.ts · withConversationsLock 防并发覆写`

### 修复文件清单（Round 8 进行中）
- `electron/ipc/citationVerifier.ts`（R8#1）
- `src/components/Agent/personaCitationParse.ts`（R8#1）
- `electron/ipc/agent.ts`（R8#3）
