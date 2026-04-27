# lit-manager UX 审查 · 待处理 TODO

> 生成于 2026-04-24，配合本次"多轮体验优化 · 第一轮"落地。
> 本文件列出**已识别但尚未修复**的问题，供后续迭代处理。本轮已修部分见各文件内 `P0-N` / `P1-N` 注释。

## 本轮已修（不再赘述，仅列编号）

- P0-1 · 召唤对话新消息不自动滚底
- P0-2 · AnnotationPanel 召唤 popover 点击外部/Esc 关闭
- P0-3 · AnnotationPanel 召唤相关 `alert()` 替换为暖金 toast
- P0-4 · PersonasTab 导出成功 `window.alert()` 替换为面板内横幅
- P1-1 · AnnotationPanel 召唤按钮图标用 `--accent-hover` 色，视觉统一
- P1-2 · SummonView 初始加载明确的 "正在召唤…" spinner
- P1-3 · ImportModal 支持 Esc/Enter 快捷键
- P1-4 · SummonView 输入框 busy 时视觉禁用（变灰 + not-allowed）
- P1-5 · UserMaterialsSection 成功绿条 5s 自消失
- P1-7 · AnnotationPanel popover 淡入动画（sj-pop-in）

## 待处理 P1 / P2

### P1-6 · 按钮尺寸微不一致（视觉）
`SummonView` 底部发送按钮 padding `10px 20px` vs `ActionBtn primary` `12px 18px`。外观接近但行高/宽度会差 1-2px。
- 位置：`src/components/Agent/PersonasTab.tsx` 的 SummonView
- 修法建议：把发送按钮改用 `ActionBtn variant="primary"` 封装，或抽一份 shared `.btn-summon-primary` 样式。

### ~~P1-8 · personaList 为空时 AnnotationPanel 召唤按钮只靠 title 提示~~ → **已修(检查时发现 line 2170-2190 已实现 P1-8/P2-9 空态引导)**

### ~~P2-1 · Ctrl+Shift+R 刷新后召唤会话状态丢~~ → **R8#2 已修**
`summonInit` 是 useState 不持久化;刷新后 stage 重置到 gallery → 现在 PersonasTab 在 mount 时读 sessionStorage 恢复 stage / current.id / summonInit.sessionId,关窗才清。

### P2-2 · 暖金色值在两套定义之间轻微漂移
- PersonasTab 硬编码 `C.accent = '#C8956C'`（与 CSS var `--accent: #C8956C` light 模式一致）
- 但暗模式下 CSS var 变为 `#d4a070`，PersonasTab inline style 不会跟随
- 位置：`PersonasTab.tsx:35-43`
- 修法建议：把 `C` palette 里的 accent/text 改成 `var(--accent)` 等 CSS 变量引用，牺牲 inline style 静态性换取暗模式支持。涉及约 80 处替换，先单独做一轮。

### ~~P2-3 · SummonView 没有 Esc 关闭对话~~ → **已修(检查时发现 line 1086-1105 已实现两段式 Esc:textarea 焦点先 blur,第二下才 onClose)**

### P2-4 · AgentPanel 的 `confirmingDelete` 模态在 PersonasTab 的删除流里没用
删 persona / 删 history session 还在用 `window.confirm()`。跟 AgentPanel 已经做过的暖金 confirm 模态不一致。
- 位置：`PersonasTab.tsx:504, 1299`
- 修法建议：抽一个 `<ConfirmDialog>` 组件，在两处都用。

### ~~P2-5 · RAG pill tooltip 信息丰富但要 hover 才见~~ → **R8#6 已修**
当前索引失败时 pill 只显示"索引失败"，详细 `message` 要 hover title 才看到。失败原因经常是 API 限流 / Key 失效这种用户需要立刻知道的事。
→ pill 改为带 ▾/▴ 的可展开按钮,error 状态点击展开 inline 面板:显示 state.message + "收起"/"重试构建"两个按钮,position: absolute 不影响外层布局。

### P2-6 · CitationBadge 的 hover tooltip 是 native `title`，信息密度低
badge 悬浮提示用浏览器 `title` 属性，多行 `\n` 在某些 OS 会被吞。
- 位置：`CitationBadge.tsx:182-207`
- 修法建议：换成一个 inline popup div，hover 时显示，可点击关闭。但这是小众场景，优先级低。

### P2-7 · 上下文窗口超限时兜底
大 SKILL.md + 长对话可能超模型 context。目前没有检测，AI 会直接 500。
- 位置：`PersonasTab.tsx` SummonView.handleSend
- 修法建议：send 前估算 prompt 字节数，超阈值时给 warning "对话较长，考虑开新对话或删历史资料"。

### P2-8 · API key 未配时点召唤的错误信息不明确
目前会拿到 IPC 返回的一串后端错误。
- 位置：多处 `aiChatStream` 失败时
- 修法建议：检测错误包含 "key" / "401" 等关键词时显示 "先去设置配置 AI Key"，并给一个跳转按钮。

### P2-9 · AnnotationPanel 召唤 popover 里没有快速 "去库里导入" 链接
personaList 为空时没有引导按钮，用户要手动切到 Agent 面板召唤 tab。
- 位置：`AnnotationPanel.tsx` 召唤按钮附近
- 修法建议：空态时在 popover 里放 "去 Agent 面板导入" 按钮，点击触发 `useUiStore().setRightPanel('agent')` + 可能还要一个 tab state 让 AgentPanel 自动打开 personas tab。

### ~~P2-10 · HistorySessionsSection 每次打开 detail 都 fetch，没有乐观缓存~~ → **R8#9 已修**
切回 detail 会看到 "加载中…" 闪烁。
→ 模块级 `historySessionsCache: Map<personaId, SummonSessionSummary[]>` SWR 风格。有 cache 立即渲染 + 后台 revalidate(loading=false 不闪);无 cache 走原来的 loading 路径。删除时清该 personaId 的 cache,下次 effect 重 fetch。

---

## 视觉一致性抽查结果（留作参考）

- ✓ 卡片 border-radius 在召唤 / 学徒 / Hermes 三 tab 基本都在 8-10px，可接受
- ⚠️ PersonasTab 用 serif 标题（书卷感），AgentPanel 用 sans-serif 标题，故意不同，OK
- ✓ 按钮 padding 在 `.btn`/`.btn-sm` 体系里统一；PersonasTab 的 ActionBtn / SummonView 发送按钮是"手写"的，p1-6 可以优化
- ⚠️ PersonasTab 用 `C.accentSoft = 'rgba(200,149,108,0.12)'`，AgentPanel 用 `var(--accent-soft) = #F5E6D3`，不完全一致但都在暖金范围
- ✓ shadows 基本都走 CSS var --shadow-sm/md/lg 或 rgba(60,40,20,...) 系

## 键盘快捷键状态

| 动作 | 当前支持 | 建议 |
|------|---------|------|
| Esc 关导入 modal | ✓ 本轮已加 | - |
| Esc 关 popover | ✓ 本轮已加 | - |
| Esc 关召唤对话 | ✗ | P2-3 |
| Ctrl+Enter 发送召唤消息 | ✓ | - |
| Enter 发送 Hermes/学徒消息 | ✓ | - |
| Enter 确认 modal | ✓ ImportModal 本轮加 | confirmingDelete 已支持 |
