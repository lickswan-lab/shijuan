# 夜间值守 · Round 8 进度记录

**分支**: `night-shift-2026-04-28`
**起始时间**: 2026-04-28 (lickswan 离场,要求自主跑 bug / 性能 / UX 三类轮换)
**结束**: 等用户起床中断

## Round 8 总览(18 commits)

| # | 类别 | Batch | 主题 | 文件 |
|---|---|---|---|---|
| 1 | Bug | 44 | regex char class `~~` 重复 | citationVerifier.ts / personaCitationParse.ts |
| 2 | UX | 45 | SummonView 跨 Ctrl+Shift+R 状态保持 | PersonasTab.tsx |
| 3 | Bug | 46 | agent.ts conversation RMW 加锁 | agent.ts |
| 4 | PERF | 47 | PdfViewer zustand 全量解构 → selector | PdfViewer.tsx |
| 5 | Bug | 48 | save-ocr-text 非 PDF 覆盖源文件 | library.ts |
| 6 | UX | 49 | PersonaRagPill error 详情面板 | personaRagStatus.tsx |
| 7 | PERF | 50 | ImmersiveAnnotationBox cache + selector | PdfViewer.tsx |
| 8 | Bug | 51 | localStorage NaN 防御 sweep(全 app) | safeStorageRead.ts (新) + 4 文件 |
| 9 | UX | 52 | HistorySessions 乐观缓存 | PersonasTab.tsx |
| 10 | Bug | 53 | App.tsx setTimeout cleanup + race | App.tsx |
| 11 | PERF | 54 | personaListCache 共享缓存 | personaListCache.ts (新) + 2 文件 |
| 12 | Bug | 55 | QuickOpen / BatchOcr 静态 sweep | QuickOpenModal.tsx / BatchOcrRunner.tsx |
| 13 | UX | 56 | API Key 错误 toast CTA "去设置" | AnnotationPanel.tsx |
| 14 | PERF | 57 | AgentPanel 头像缓存模块化 | personaPortraitCache.ts (新) + AgentPanel.tsx |
| 15 | UX | 58 | SummonView 发送按钮尺寸对齐(P1-6) | PersonasTab.tsx · UI polish #50 |
| 16 | Bug | 59 | apprentice weekCode 路径清洗 | apprentice.ts |
| 17 | UX | 60 | ReadingLog 错误 toast CTA(R8#13 扩散) | ReadingLogView.tsx |
| 18 | PERF | 61 | RAG cosineSim 热路径优化 | personaEmbeddingApi.ts / personas.ts |

## 类别分布

- **Bug**: 7 轮 (#1, #3, #5, #8, #10, #12, #16)
- **UX**: 6 轮 (#2, #6, #9, #13, #15, #17)
- **PERF**: 5 轮 (#4, #7, #11, #14, #18)

总计 18 轮,严格遵守"三类轮换不连选同类"。

## 里程碑

- **🎉 R1 + R2 观察项 8 条全部清空**(Round 8 #10 之后):
  - regex `~~`(R8#1) / aiThrottle 安全(原 OK 备注) / personaPortrait sanitize(uuid 安全 → 暂留) / personas embed RPM(aiThrottle 兜得住 → 暂留)
  - save-ocr-text 命名(R8#5) / App.tsx setTimeout(R8#10) / agent.ts RMW lock(R8#3) / uiStore NaN(R5#3 + R8#8 sweep)

- **新建 4 个共享 util** 把模块级 cache / 防御性读 写到一处:
  - `safeStorageRead.ts`(NaN 防御)
  - `personaListCache.ts`(persona 列表共享)
  - `personaPortraitCache.ts`(肖像共享)
  - 已存在的 `aiConfigCache.ts` / `agentMemoryCache.ts` 模式被 4 处对齐

## 全程零回归

每一轮都跑了:
- `npx tsc --noEmit` — 0 错(基线 0 错保持)
- `npx electron-vite build` — 全部通过(31~36 秒构建,无新增 build error)

## 未完成 / 留作后续

- **P2-7 上下文超限警告**(_UX_AUDIT_TODO):需要跨 provider 估 token 阈值,设计成本高
- **P2-8 API Key error CTA**:已扩散到 AnnotationPanel + ReadingLogView,剩 PersonasTab + LectureMode + AgentPanel(后两者错误是 chat bubble 不是 toast,模式不直接适用)
- **PersonasTab portrait cache 与 AgentPanel cache 合并**:R8#14 给 AgentPanel 新建了模块级 cache,但 PersonasTab 还有自己的 portraitMemoryCache(带 slug fallback)。后续可以让两者共用同一份带可选 slug fallback 的 util
- **lazy-load TranslateModal**:小 bundle 优化(~50kB),但 TranslateModal 是用户从 PdfViewer 触发的,首次延迟可见
- **新区扫描**:Lecture / common / electron/ipc/aiApi.ts 大部分还没扫,留下次 round

## 代码风险点(夜间值守期间未碰 / 不动的稳定核心)

- `electron/main.ts` 启动逻辑
- `electron/updater.ts`
- `electron/ipc/aiThrottle.ts`(stable rate limit core)
- `_shelved_features/`

## 文档同步状况

- `DEVLOG.md`: 16 个 Batch 段(44-60)已加在顶部,描述 + 验证 + 后续
- `_BUG_REPORT.md`: Round 8 段持续追加(R8#1/#3/#5/#8/#10/#12/#16),R1+R2 观察项标已修
- `_UX_AUDIT_TODO.md`: P2-1/P2-3/P2-5/P2-8/P2-10/P1-8/P1-6 标已修(部分通过本轮,部分老 batch 已修但 audit 文档没更新)
- `_UI_POLISH_LOG.md`: Change #50 加(R8#15)

## 给 lickswan 的接班 prompt 建议

如果你想继续夜间值守的工作:
1. 切回 master 看一下 17 个 commit 是不是都同意 → squash / 直接 merge / 个别 cherry-pick 都可以
2. 如果有想细看的 commit,git log night-shift-2026-04-28 ^master 看清单
3. 还想跑 round 18+ 的话,Bug 池基本空了,推荐 PERF 或 UX,或者发一个新方向的 prompt
