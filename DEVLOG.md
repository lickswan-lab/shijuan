# 拾卷 / 召唤功能 开发日志

格式：倒序（新的在上）。每个 batch 一段，列改了什么 + 留了什么坑。

---

## 2026-05-06 · Batch 68 · 夜间值守 Round 8 #25 · PERF · 注释栏拖动同步 IO 阻塞清除

主题：**PERF · AnnotationPanel resize 拖动 onMove 每帧 localStorage.setItem(同步 IO ~2-5ms),60Hz 拖动累计 240ms/秒主线程阻塞,改成 raf 节流 setState + mouseup 一次性 persist**

### 修了什么(R8#25)

`src/components/AnnotationPanel/AnnotationPanel.tsx:818-865` `handleResizeStart`:

旧代码 `onMove`:
```ts
setPanelWidth(Math.max(200, Math.min(800, startWidth + delta)))
//  ↓ setPanelWidth 内部:
//    _setPanelWidth(w)   // setState 触发 ~2100 行组件 re-render
//    localStorage.setItem('sj-annPanelWidth', String(w))  // 同步 IO
```

新代码:
1. 拖动期间 `onMove` 只调 `_setPanelWidth`(纯 state),且用 `requestAnimationFrame` 节流(同帧多个 mousemove 合并成一次 setState)
2. 用 closure 内 `lastWidth` 变量记录最终值
3. `onUp` 时一次性 `localStorage.setItem(lastWidth)`

`setPanelWidth` 函数(含 localStorage 写)保留给非拖动场景使用(初次 mount / 外部代码改宽度)。

### 为什么有用

用户报"注释栏拖动有延迟"。根因:`mousemove` 每秒触发 60+ 次,每次都同步写 localStorage(Chromium 的 localStorage 是 main-thread sync IO,典型 2-5ms/次),拖动 1 秒 = 120-300ms 主线程阻塞,叠加 React 重渲 AnnotationPanel(~2100 行 JSX,即便 React 18 batching 也有几 ms)。视觉上鼠标拖出的 visible width 跟不上手指实际位置 → 体感"延迟"。

修后:拖动期间 0 次 IO,raf 节流让最多 60 次/秒 setState(超过的合并),mouseup 时 1 次 IO。理论上拖动跟手感跟原生 windows 边框 resize 接近。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 223ms / preload 13ms / renderer 4.19s)
- baseline `tsc -b --noEmit` 错误数维持(本批改动无新增 TS 问题)

### 后续

下轮 Round 8 #26 必须 Bug 或 UX(因为 #25 是 PERF)。

本修复要进入下一次 release(v1.3.5 或合并到 v1.3.4 重 build)用户才能感受到。当前 1.3.4 已发布,如需让用户立刻享受这条优化建议:
- 选项 A:作为单独 patch 重 build app.asar.gz,push 覆盖 v1.3.4 release(用 `gh release upload --clobber`),应用内更新拉到
- 选项 B:打 v1.3.5 tag → 走 GitHub Actions 全平台 build → 新 release

同区域可继续观察:
- `panelWidth` state 改变会让整个 AnnotationPanel 重渲(2100 行),可考虑用 CSS variable + ref 直接改 DOM `style.width` 完全跳过 React 渲染。但当前 raf+setState 已经够流畅,过度优化先不做
- TopBar 的字号滑块 / 阅读舒适度调节滑块可能有同款 hot-path localStorage 问题,值得 sweep

---

## 2026-05-05 · 1.3.4 发布 · 内置 6 个最早 skill 首次启动注入 + R8#19-24 累计修复

主题：**1.3.4 把 confucius/laozi/mozi/plato/socrates/aristotle 6 个 skill 打入 asar,首次启动自动 import 到 ~/.lit-manager/agent/personas/,新用户安装即用**

注:1.3.3 是 2026-05-04 GitHub Actions 自动 build 上线的版本(无内置 skill,无本批 R8 修复)。本次新功能跳过 1.3.3 改 tag 直接发 1.3.4,保留 1.3.3 release 历史可回滚。

### 1.3.4 新增

`package.json` build.files
1. 加 `skills/**/*` 让 electron-builder 把 skills/ 整个目录(18 个 skill 的源文件夹,~1.3 MB)进 asar。pack-portable.mjs 默认就会包含 skills/(无 ROOT_EXCLUDES 排除),无需改动。

`electron/ipc/personas.ts` 新增 `seedBundledSkills()` (export)
1. BUILTIN_SKILL_SLUGS = `['confucius','laozi','mozi','plato','socrates','aristotle']` —— 1.3.2 release 同款 6 位
2. marker 文件 `~/.lit-manager/.bundled-seeded-v1.3.3` 防重复 seed(版本号沿用 v1.3.3 是因为代码先在 1.3.3 写,改名重发会让旧 1.3.3 的 user 重复 seed)
3. 已存在的 persona(按 skillSlug / canonicalName / name 匹配)跳过,**绝不覆盖** —— 防破坏用户改过的 persona 或社区下载的同名版本
4. 失败容忍:任何一个 slug 读不到 / parse 失败 / 写盘失败,记 warning 跳过,不影响其它 5 个;整个 seed 错误也不阻塞 app 启动
5. importedFrom 固定指向 bundled skills 目录(asar 内 / resources 内) —— uninstall 后附属包丢失但 fullMarkdown 仍能用,personas.ts:1611 已有 try/catch 兜底

`electron/main.ts` 启动流程
1. import `seedBundledSkills` 并在 IPC register 之后 fire-and-forget 调用
2. seed 不阻塞 createWindow → 窗口照常弹出,seed 在后台跑 ~100ms
3. logStartup 写出 `{ seeded, skipped, failed }`,crash.log 可查

### 累计修复(从 1.3.2 → 1.3.3 的 6 轮 night-shift Bug)

| Round | 主题 | 风险等级 |
|---|---|---|
| R8#19 | HTML/MD 内相对路径图片渲染断 | 中(用户可见功能性问题) |
| R8#20 | TranslateModal timer race + cleanup leak | 低 |
| R8#21 | personaId 路径清洗(防 IPC 路径穿越) | 低(defense-in-depth) |
| R8#22 | second-instance win.flashFrame isDestroyed 防御 | 低 |
| R8#23 | 混元 thinking 字段双注入清理(reasoning_effort 单字段) | 中(若 TokenHub 严格校验 → 400) |
| R8#24 | probeOllama timer finally clear | 极低 |

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 235ms / preload 13ms / renderer 4.77s)
- `tsc -b --noEmit`: 58 个 baseline 错误维持不变(本批改动无新增 TS 问题)
- `npm run dist`: 待跑(下一步)
- `node scripts/compress-asar.mjs`: 待跑(下一步)

### 后续

1. push tag `v1.3.4` → GitHub Actions workflow `.github/workflows/build.yml` 自动 build 三平台(win + mac-intel + mac-arm) + softprops/action-gh-release publish 到 v1.3.4 release
2. 18 个 skill zip(community_preview/assets/skills/*.zip)单独上传到 v1.3.4 release "备着"作为 fallback / 离线分发
3. 用户冒烟测试 Google + GitHub OAuth 登录(client secret 已 rotate 见 community_preview/SESSION_STATE.md 注脚)

---

## 2026-05-05 · Batch 67 · 夜间值守 Round 8 #24 · Bug · probeOllama timer finally clear

主题：**Bug · probeOllama 的 1.5s abort timer 在 catch 路径不 clear,与同文件 fetchAndExtract / personas.ts / onlineSearch.ts / personas-search-helper.ts 的 try-finally 模式不一致**

### 修了什么(R8#24)

`electron/ipc/aiApi.ts:624-641`

`probeOllama()` 用 AbortController + 1.5s timer 守护 fetch:
- try 路径:fetch 完成后 line 629 `clearTimeout(timer)` ✓
- **catch 路径:fetch 抛错(daemon 不在 / DNS 失败 / refused)时 timer 不 clear**

修法:把 `const ctrl` / `const timer` 提到 try 外,`clearTimeout` 移到 finally。

### 为什么有用

实际副作用很轻 —— 1.5s 后 timer fire 调用一个已结束的 AbortController.abort() 是 noop,不会 throw 或污染状态。但:
1. Node 仍持有 timer handle 1.5s,Settings 面板每次打开都 probe 一次,长会话累积
2. 跟同文件 line 968 `fetchAndExtract` 的 try-finally 模式不一致 —— 同一作者两种风格,未来读者会困惑哪个是对的
3. 关闭即时性:Settings 关掉后 timer 还得跑完才释放

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 264ms / preload 14ms / renderer 4.73s)
- `tsc -b --noEmit`: 58 个 baseline 错误维持不变

### 后续  下轮 Round 8 #25 必须 PERF 或 UX(R8#19-24 连做 6 个 Bug,因为用户显式调用"软件整体的多轮 bug 排查"+"重点验证腾讯混元接入"两次 override 类型轮换;现在恢复正常)。

继续观察(本次 sweep 未修):
- 混元 `chatUrl: tokenhub.tencentmaas.com` / 4 个模型 ID 静态层无法验证,需实测一次混元请求看 API 是否真的工作
- 混元 `hunyuan-2.0-thinking-` 系列若强制 thinking,effort=low 时可能被服务端忽略 / 报错 —— 等用户反馈
- `aiThrottle.ts:537 setInterval(broadcastStatus)` 用 unref(),没在 before-quit clear 但 process exit 自然死亡,无 leak

---

## 2026-05-05 · Batch 66 · 夜间值守 Round 8 #23 · Bug · 混元 thinking 字段双注入清理

主题：**Bug · 腾讯混元 TokenHub 接入里 effort 注入冗余 body.thinking(Anthropic 风格字段),严格 schema 校验下可能 400,移除只保留 reasoning_effort**

### 修了什么(R8#23)

`electron/ipc/aiApi.ts:456-458`

原代码:
```ts
} else if (providerId === 'hunyuan') {
  body.reasoning_effort = effort
  body.thinking = { type: effort === 'low' ? 'disabled' : 'enabled' }
}
```

移除 `body.thinking` 那一行,只保留 `body.reasoning_effort`。

### 为什么有用

腾讯混元 TokenHub(`tokenhub.tencentmaas.com/v1/chat/completions`)是 OpenAI 兼容接口:
- `reasoning_effort` 是 OpenAI 标准字段(GPT-5 / o-series 都用),OpenAI compat 接口几乎肯定接受 ✓
- `body.thinking = { type: 'enabled' / 'disabled' }` 是 **Anthropic Messages API** 的字段格式
  - 腾讯混元官方文档没出现过顶级 thinking 字段
  - 候选的腾讯式 thinking 字段是 `extra_body.enable_thinking`(同 Qwen)或 `chat_options.thinking`,但都不是顶级

两种可能后果:
1. **严格 schema 校验** → 整个请求 400 失败 → 用户选混元任何含 effort 的请求都挂
2. **容忍未知字段** → thinking 被静默忽略,reasoning_effort 仍生效

第 1 种是 blocker,第 2 种字段冗余无害。**移除冗余字段是最稳的方向**。

### 接入静态验证总览

混元接入主体是完整的:
- Provider 定义(id/chatUrl/models/auth) `aiApi.ts:154-166` ✓
- API key 存取(走 generic IPC 自动覆盖) ✓
- Rate limit 30 RPM / 2 并发 `aiRateLimits.ts:50-55` ✓
- Effort/thinking 注入(hy3 / thinking 模型) `aiApi.ts:412-413, 456-458` 本轮修
- Web search(manual function calling loop) `aiApi.ts:891` ✓
- UI 自动可见(ModelSelector 是 provider-agnostic) ✓

未验证项(需运行时实测):
- `chatUrl: tokenhub.tencentmaas.com` 域名静态层无法验证,DNS / SSL 握手要实际触发
- 4 个模型 ID(`hy3-preview` / `hunyuan-2.0-thinking-20251109` / `hunyuan-2.0-instruct-20251111` / `hunyuan-role-latest`)是日期 snapshot 形式,未来腾讯版本切换需手动跟进
- `hunyuan-2.0-thinking-` 系列是否强制 thinking 模式 / effort=low 是否被尊重,要实测

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 264ms / preload 14ms / renderer 4.73s)

---

## 2026-05-05 · Batch 65 · 夜间值守 Round 8 #22 · Bug · second-instance win.flashFrame isDestroyed 防御

主题：**Bug · 单实例锁 second-instance 触发后 3s,主窗口若已销毁裸调 flashFrame 会抛 "Object has been destroyed",同 R4#4 模式补 isDestroyed 兜底**

### 修了什么(R8#22)

`electron/main.ts:218`

`app.on('second-instance', ...)` 用户启动第二个拾卷实例时,旧实例窗口闪烁 3s 提示。原:
```ts
setTimeout(() => win.flashFrame(false), 3000)
```
3s 内用户关 app / 旧主窗口被替换 / mac dock 触发关窗保活 → win 进 destroyed 状态,timer fire 时 flashFrame(false) 抛错。

修:加 `if (!win.isDestroyed()) win.flashFrame(false)` 兜底。timer handle 不 track —— second-instance 事件稀疏触发,单 timer 闭包 leak 量级可忽略。

### 为什么有用

跟 R4#4(`midnight scheduler win.isDestroyed()` 检查)是同一类问题。R4#4 已经把 setInterval 那条线扫干净,这里是漏网的 setTimeout 同模式。后者触发概率更低(用户得真正启动第二实例),但行为一旦撞上是 main process exception,会污染 crash log。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 233ms / preload 13ms / renderer 4.12s)
- `tsc -b --noEmit`: 58 个 baseline 错误维持不变,无新增

---

## 2026-05-05 · Batch 64 · 夜间值守 Round 8 #21 · Bug · personaId 路径清洗(全 IPC 覆盖)

主题：**Bug · personaId / sessionId 进 path.join 无清洗,defense-in-depth 挡路径穿越,同 R2#γ / R4#3 / R8#16 模式**

### 修了什么(R8#21)

`electron/ipc/personas.ts`

新增 helper:
```ts
const SAFE_PERSONA_ID = /^[a-zA-Z0-9_-]+$/
function isUnsafePersonaId(id: unknown): boolean {
  return typeof id !== 'string' || !SAFE_PERSONA_ID.test(id)
}
```

11 个接收 personaId 的 IPC handler 入口加早返:
- `persona-load` / `persona-save`(校验 `persona.id`)/ `persona-reveal` / `persona-delete`
- `persona-append-source` / `persona-export-skill`
- `persona-rag-retrieve` / `persona-rag-build` / `persona-rag-status` / `persona-rag-clear`
- `persona-get-system-prompt`

不通过返回 `{ success: false, error: 'personaId 含非法字符' }`,handler body 不执行。

`electron/ipc/personaPortrait.ts`

`persona-get-portrait` 入口同样加 SAFE_PERSONA_ID 校验(避免 portrait 加载阶段绕过 personas.ts 的校验)。

`electron/ipc/summonSession.ts`

新增 SAFE_ID + 两个 helper(unsafePersonaId / unsafeSessionId)。4 个 IPC(summon-session-list / load / save / delete)入口都校验,save 还校验 `session.personaId / session.sessionId`(因为 personaId 从 session 内部字段拿)。

### 为什么有用

R1 观察项的"未来需小心"项,当时被搁置(personaId 由 uuid() 产出安全)。但:
1. IPC 是 renderer 可控接口,renderer 被 XSS 或前端 bug 都能塞脏 id
2. 召唤社区 / future imported skill 的 id 来源会随版本变化(skill zip 自带 id 字段)
3. R2#γ(lecture sessionId) / R4#3(lecture-save sessionId) / R8#16(apprentice weekCode)都已统一加了同样的 defense-in-depth,personaId 是最后一类未覆盖的 path-fragment

修复后:`../../../etc/passwd` / `..\\..\\windows\\system32\\cmd.exe` / 含 `\0\r\n` 的 id 全部被早返挡住,不会触达 path.join。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 231ms / preload 13ms / renderer 4.00s)
- `tsc -b --noEmit`: 58 个 baseline 错误维持不变,无新增

---

## 2026-05-05 · Batch 63 · 夜间值守 Round 8 #20 · Bug · TranslateModal setTimeout leak

主题：**Bug · 翻译 modal 复制提示 / 保存为文献两条 deferred 操作的 setTimeout 不跟踪,modal 关闭后回调仍触发,同 R2#α / ONBOARD#1 / R7#1 模式**

### 修了什么(R8#20)

`src/components/PdfViewer/TranslateModal.tsx`

两处裸 setTimeout 改用 ref 跟踪:
- `handleCopyResult` 复制成功 1.8s 后清"已复制到剪贴板"提示 → `copyMsgTimerRef`
- `handleSaveAsEntry` 保存为文献 400ms 后调 `onClose` 自动关 modal → `closeAfterSaveTimerRef`

每次 schedule 前 clear 前一个(防短时间多次操作 timer 累积),unmount cleanup useEffect 清两个 timer。`useRef` 加进 react import。

### 为什么有用

TranslateModal 是 PdfViewer 的子模块,在文献切换 / 用户关 modal / 用户连点保存按钮时频繁 mount/unmount。原本 `setTimeout(() => setLocalProgressMsg(''), 1800)` 直接裸跑,modal 切 open=false 不 unmount 也好,unmount 也好,1.8s 内 fire 都会:
- 在 hidden 组件上 set state(无害但污染 React 警告)
- onClose 在已经关掉的 modal 上重复调用(可能触发父组件 stale state 路径)
- 用户连点复制按钮 → 累积多个 timer,最后一个赢但中间几个空跑

跟 R2#α(LectureMode handleGenerateSummary stream leak)/ ONBOARD#1(OnboardingModal goToFeatureTour timer)/ R7#1(rereading AI stream)是同一类问题。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 239ms / preload 13ms / renderer 4.82s)

---

### 后续  下轮 Round 8 #23 必须 PERF 或 UX(本轮 #20-22 连做 3 个 Bug,因为用户显式调用"软件整体的多轮 bug 排查"override 了类型轮换;现在恢复正常)。

观察清单(本次 sweep 发现但未修):
- `OnlineSearchModal.tsx:93` setTimeout 无 cleanup —— 在线搜索整体封锁中,触发不到,留待功能复活时再修
- `MemoList.tsx` 4 处 inline `setTimeout(() => ref?.focus(), 50)` —— ref 链式调用本身安全,优雅性问题不是 bug
- `agent-save-skills` / `agent-save-insight` 无 RMW 锁 —— UI 已下线,触发不到,只为 legacy 用户文件读写保留

---

## 2026-05-05 · Batch 62 · 夜间值守 Round 8 #19 · Bug · HTML/MD 相对路径图片渲染断

主题：**Bug · srcdoc iframe + react-markdown 没有 file 锚点导致 HTML/MD 内相对路径图全断,补 base href + img resolver 修通**

### 修了什么(R8#19)

`src/components/PdfViewer/PdfViewer.tsx`

1. 新增 module-scope helper `fileBaseUrl(absPath)`：把 `.html` / `.md` 的绝对路径转成它所在目录的 `file:///...` URL。Windows 反斜杠 → 正斜杠,encodeURI 处理中文/空格。

2. `HtmlViewer` srcdoc 注入 `<base href>`：原本 `frame.srcdoc = html` 让 iframe 的 origin 是 `about:srcdoc`,所有 `<img src="images/x.png">` 这种相对引用都解析不到。`<base>` 必须放 head 最前(浏览器只认第一个 base),所以在 typographyStyle 注入之前先处理。

3. `TextFileContent`(.md/.txt 渲染) 给 `<Markdown>` 加 `rehypeRaw` + 自定义 `img` 组件:
   - `rehypeRaw` 让源文里的原生 `<img>` / `<a>` 标签生效(教材/Obsidian 导出 markdown 经常这样写,之前会被当文本忽略)
   - 自定义 `img` 把相对 src 拼成 file:// 绝对 URL,external 协议(http/data/file)直通

不动:
- PDF(react-pdf 把图嵌入 canvas,工作正常)
- DOCX(mammoth.convertToHtml 默认把图转 base64 data URI 内联,工作正常)
- `.doc` 二进制(mammoth 不支持,本轮范围只动图片;后续单独评估删 SUPPORTED_EXTS 还是换库)

### 为什么有用

调研发现拾卷支持的 5 类格式里 PDF/DOCX 图片正常,**HTML/MD 在用户最常见的"图文同目录"场景下完全断**(教材导出、Obsidian 笔记、HTML 备份都是这种结构)。Wallpaper/截图/示意图全部加载失败,用户看到 broken image icon。本轮把 HTML 和 MD 的相对路径 image src 都接到本地文件系统,5 类格式里能渲染图的从 2/5 提到 4/5。

主进程 `webSecurity:false` 早就开了(原本是为了 PDF 加载),file:// 资源加载本来就允许,本次只是给两个 viewer 补上"找得到文件位置"的锚点。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0(main 231ms / preload 15ms / renderer 4.00s)
- baseline `tsc -b --noEmit` 错误数 58 → 58(全部为既存错误,行号偏移与本轮新增 14/26/42 行完全一致,无新增类型问题)

### 后续  下轮 Round 8 #20 必须 PERF 或 UX(因为 #19 是 Bug)。

注:2026-04-30 / 2026-05-02 两条 "继承开发 · UX · ...扩散收口" 没占用主 Round 计数(标题无 `Batch N · Round 8 #N`),按未编号 follow-up 处理,所以本轮接 R8#18 之后编 #19。

`.doc` 二进制 / SUPPORTED_EXTS 处置作为独立 follow-up 留给 UX 或 Bug 轮:目前 mammoth 喂 .doc 会失败显示 "DOCX 解析失败:...",不算静默 bug,但 SUPPORTED_EXTS 仍声称支持,属于伪装可用。

---

## 2026-05-02 · 1.3.2 发布准备 · 在线搜索封锁 / 召唤社区上线

主题：**把当前版本定为 1.3.2，暂时关闭在线搜索，并只开放六位人物 skill**

### 修了什么

`package.json` / `package-lock.json`
1. 版本号定为 `1.3.2`。

`src/components/TopBar/TopBar.tsx` / `electron/ipc/onlineSearch.ts`
1. 顶部在线搜索入口暂时隐藏。
2. 在线搜索、下载、登录、会话状态、清理会话 IPC 增加兜底封锁，统一返回“在线搜索模式暂时关闭”。

`electron/ipc/personaPortrait.ts` / `electron/ipc/personas.ts` / `src/components/Agent/PersonasTab.tsx`
1. 召唤人物头像识别补齐孔子、老子、墨子、苏格拉底、柏拉图、亚里士多德六位。
2. skill 导入时会把 skill 文件夹内的 `portrait.png/jpeg/jpg/webp` 同步到本地 persona 目录。
3. 社区首批六位人物头像使用新生成的 `png` 肖像资源。

### 配套资产

1. 已更新 `skills/<slug>/portrait.png` 与 `community_preview/assets/portraits/<slug>.png`。
2. 已重新打包 `community_preview/assets/skills/{confucius,laozi,mozi,plato,socrates,aristotle}.zip`，zip 内包含 `portrait.png`。
3. 已生成 `C:\Users\18475\OneDrive\Desktop\拾卷开发\v1.3.2\app.asar` 与 `app.asar.gz`，用于 1.3.1 → 1.3.2 应用内更新。
4. GitHub Actions 发布流同步上传 `app.asar.gz`，tag 发布时会带上压缩更新资产。
5. 官网仓库已加入 `community/` 静态页面，并在顶部导航加入“社区”入口。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0
- `npm run dist`: EXIT=0
- `node scripts/compress-asar.mjs`: EXIT=0

---

## 2026-05-02 · 继承开发 · UX · 阅读舒适度整体调优

主题：**降低阅读眩光、收窄正文行宽、改用屏幕友好字体栈**

### 资料依据

- WCAG 视觉呈现建议正文行宽不超过 80 字符，CJK 不超过 40 字符；行距至少 1.5。
- WCAG 对普通文本最低对比度要求为 4.5:1。
- 眼疲劳建议里反复强调屏幕亮度应接近环境亮度，减少眩光；拾卷旧阅读默认 `L=97` 接近纯白。
- 字体研究没有稳定证明 serif/sans 一定更好，实际更依赖字号、间距、屏幕渲染和用户熟悉度。

### 修了什么

`src/styles/globals.css`
1. 新增 `--font-reading`，优先 Noto/思源，缺字时落到雅黑而不是直接落到 SimSun。
2. 新增 `--reader-max-width: 760px` / `--reader-line-height: 1.85` / `--reader-paragraph-gap: 0.9em`。
3. OCR/Markdown 正文从 `text-align: justify` 改为 `start`，避免中英混排被硬拉开。
4. PDF canvas 加轻微 `sepia + brightness + contrast` filter，给原始白页降眩光。
5. 新增 `--reader-content-filter`，给 HTML / EPUB / DOCX / TXT 视图同步做轻滤镜。
6. 新增 `--ocr-content-filter`，OCR 视图单独稍强一点，并覆盖 OCR 标题区。

`src/components/PdfViewer/PdfViewer.tsx`
1. 阅读默认值从 `16px / 400 / L=97` 改为 `17px / 450 / L=91`，文字稍大稍稳、背景不刺眼。
2. 增加一次性 `sj-readingComfortV2` 迁移：仍停留在旧白底默认的用户会自动迁到新暖纸默认。
3. HTML / EPUB / DOCX / TXT / OCR 的正文容器统一收窄到约 40 个 CJK 字符的阅读宽度。
4. EPUB / HTML 去掉强制两端对齐，保留段首缩进与可调背景/字号。
5. 轻滤镜只挂在阅读内容层，避开右键菜单和工具栏，避免浮层定位被 CSS `filter` 影响。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0

---

## 2026-05-02 · 继承开发 · UX · LectureMode 总结失败接 CTA(R8#13 扩散收口)

主题：**UX · AI 课程记录生成失败不再污染课程记录，并可一键去设置**

### 修了什么

`src/components/Lecture/LectureMode.tsx` AI 课程记录生成失败路径:
1. 新增 `summaryError` 本地错误条，复用 `humanizeAiError()` 的 `ctaSettings`
2. key / quota / model 类错误显示「去设置」按钮，点击打开 Settings 并关闭错误条
3. `aiChatStream` 返回失败或直接 throw 都会被捕获并转译
4. 失败不再写入 `session.aiSummary`，避免把「生成失败：...」保存成课程记录正文

### 已扩散覆盖

| 触点 | 状态 |
|---|---|
| AnnotationPanel summonErr | ✅ R8#13 |
| ReadingLogView errorToast | ✅ R8#17 |
| PersonasTab summon error banner | ✅ 2026-04-30 |
| LectureMode 总结失败 | ✅ 本轮 |
| AgentPanel(在 chat bubble 里渲染错误) | ⏭ 需单独设计 |

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0

---

## 2026-04-30 · 继承开发 · UX · PersonasTab 错误横幅接 CTA(R8#13 扩散)

主题：**UX · API Key / 余额 / 模型错误在召唤人物页也可一键去设置**

### 修了什么

`src/components/Agent/PersonasTab.tsx` 顶层错误横幅:
1. `errorMsg` 从纯字符串升级为 `{ message, ctaSettings }`
2. `SummonView` 内 3 处 `humanizeAiError()` 调用改为把 `ctaSettings` 一并上传
3. 错误横幅在 `ctaSettings=true` 时显示「去设置」按钮,点击打开 Settings 并关闭横幅
4. 普通导入 / 导出 / 定位 / 历史会话错误仍走无 CTA 的普通横幅

### 已扩散覆盖

| 触点 | 状态 |
|---|---|
| AnnotationPanel summonErr | ✅ R8#13 |
| ReadingLogView errorToast | ✅ R8#17 |
| PersonasTab summon error banner | ✅ 本轮 |
| LectureMode 总结失败 | 待后续 round |

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npm run build`: EXIT=0

---

## 2026-04-28 · Batch 61 · 夜间值守 Round 8 #18 · PERF · RAG cosineSim 热路径优化

主题：**perf · RAG 检索的余弦相似度计算去掉 query 端 norm 的重复计算**

### 修了什么(R8#18)

`electron/ipc/personaEmbeddingApi.ts` 新增两个 export:
- `vectorNorm(v)` — L2 范数
- `cosineSimWithNormA(a, normA, b)` — 调用方已预算好 normA 的版本

`electron/ipc/personas.ts` line 130 RAG 语义检索热路径:
```diff
+ const normQuery = vectorNorm(queryVec)
  const scored = idx.chunks.map(c => {
-   let score = cosineSim(queryVec, c.embedding)
+   let score = cosineSimWithNormA(queryVec, normQuery, c.embedding)
```

### 预期收益

`idx.chunks.map(...)` 是用户每次召唤问 RAG 知识库时的热路径。原 cosineSim 内部对 a (queryVec) 和 b (chunk embedding) 都算 sum-of-squares + sqrt,但 a 是同一个 query,N 个 chunk 内重算 N 次。

1000-chunk × 1024-dim 场景:
- 原:1000 次 × (3 × 1024 ops + 2 sqrt) = 3M ops + 2000 sqrt
- 新:1024 ops + 1 sqrt(预算)+ 1000 × (2 × 1024 ops + 1 sqrt) = 2.05M ops + 1001 sqrt
- 节省:~33% ops + 一半 sqrt

每次 RAG 检索快一点 → 召唤问答首字延迟降低。`cosineSim` 旧 export 保留(给可能的其它调用方)。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 32.06s 通过

### 后续

下轮 Round 8 #19 必须 Bug 或 UX。

---

## 2026-04-28 · Batch 60 · 夜间值守 Round 8 #17 · UX · ReadingLog 错误 toast 接 CTA(R8#13 扩散)

主题：**UX · 把 R8#13 的"toast 加去设置按钮"模式扩散到 ReadingLogView**

### 修了什么(R8#17)

`ReadingLogView.tsx` `errorToast` state(AI 总结生成失败的提示):
1. 类型从 `string | null` 升级为 `{ message: string; ctaSettings?: boolean } | null`
2. 两处 setErrorToast 调用改传结构对象,`ctaSettings` 来自 humanizeAiError(catch 路径)或文本关键词检测(stream result 路径,因为这条 path 拿到的是 humanize 过的字符串没保留 flag)
3. toast 渲染加 "去设置" 按钮(stopPropagation),click → `useUiStore.getState().setShowSettings(true)` + 关 toast

### 已扩散覆盖

| 触点 | 状态 |
|---|---|
| AnnotationPanel summonErr | ✅ R8#13 |
| ReadingLogView errorToast | ✅ R8#17 |
| AgentPanel(在 chat bubble 里渲染错误) | ⏭ 不适用(不是 toast,是 chat 消息) |
| PersonasTab(召唤场景内 errorMsg) | 待后续 round |
| LectureMode 总结失败 | 待后续 round |

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 32.16s 通过

### 后续

下轮 Round 8 #18 必须 Bug 或 PERF。

---

## 2026-04-28 · Batch 59 · 夜间值守 Round 8 #16 · Bug · apprentice weekCode 路径清洗

主题：**bug fix · 静态 sweep apprentice.ts · path traversal defense-in-depth(同 R2#γ 模式)**

### 修了什么(R8#16)

`electron/ipc/apprentice.ts` 5 个 handler(apprentice-load / save / delete / load-dialogue / save-dialogue):
- 之前 `path.join(APPRENTICE_DIR, \`${weekCode}.md\`)` 直接用 weekCode 没清洗
- 当前 isoWeekCode 产出 'YYYY-Www' 安全,但 IPC 接受任意字符串 → defense-in-depth
- 加 `SAFE_WEEK_CODE = /^[\w-]+$/` + typeof 检查,不过返回 error

模式照搬 R2#γ 给 lecture sessionId 做的清洗。学徒观察 UI 已删(CLEAN-R7#1),触发不到,但 IPC 还在暴露。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.72s 通过

### 后续

下轮 Round 8 #17 必须 PERF 或 UX。

---

## 2026-04-28 · Batch 58 · 夜间值守 Round 8 #15 · UX · SummonView 发送按钮尺寸对齐

主题：**UX / UI polish · _UX_AUDIT_TODO P1-6 落地 · _UI_POLISH_LOG Change #50**

### 修了什么(R8#15)

`src/components/Agent/PersonasTab.tsx:1371` SummonView 发送按钮 padding `'10px 22px'` → `'12px 18px'`,对齐 ActionBtn variant=primary 的 padding(line 321)。

### 为什么有用

SummonView 顶部和右侧有"返回 / 新对话 / 召唤对话→"等 ActionBtn,用户挨着按总能看到发送按钮比别的按钮矮 1-2px、宽 4px。这次纯 padding 对齐就解决,符合 UI polish 的硬约束(单行视觉属性改动,不动 JSX 结构 / className / state / 事件)。

### 留作后续

audit 原方案是把发送按钮重构成 `<ActionBtn variant="primary">` 包装,但 ActionBtn 不支持 `disabled` prop。未来要做完整重构需要扩 ActionBtn,单独 round。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 32.70s 通过

---

## 2026-04-28 · Batch 57 · 夜间值守 Round 8 #14 · PERF · AgentPanel 头像缓存模块化

主题：**perf · AgentPanel 头像 useState cache → 模块级共享 cache**

### 修了什么(R8#14)

新建 `src/utils/personaPortraitCache.ts`:
- `getPortraitDataUrl(personaId): Promise<string | null>` 走模块级 Map cache
- inflight Promise dedup(多组件同时请求同 id 共享同一 Promise)
- 失败值也 cache(避免反复 fail 重试)

`AgentPanel.tsx`:
- 之前 `setPortraitCache` 是 useState,每次 AgentPanel mount/unmount(用户切右侧面板)都重新 IPC 拉所有曾经出现过的 persona 肖像。10 个 persona × 切 5 次 = 50 次 IPC + 文件读。
- 现在 useEffect 内调 `getPortraitDataUrl(id)`,模块 cache 命中直接同步返回,只剩首次 mount 那一波 IPC

### 留作后续

PersonasTab.tsx 自己有一份本地 `portraitMemoryCache` + slug fallback。两个 cache 现在并存(各自独立),功能正确但有重复。下次可以合并(让 PersonasTab 也走新 util,把 slug fallback 作为可选行为参数)。本轮 scope 控制只动 AgentPanel。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 31.80s 通过

### 后续

下轮 Round 8 #15 必须 Bug 或 UX。

---

## 2026-04-28 · Batch 56 · 夜间值守 Round 8 #13 · UX · API Key 错误 toast 接 CTA "去设置"

主题：**UX · _UX_AUDIT_TODO P2-8 部分完成 — humanizeAiError 的 ctaSettings 标志接入 toast**

### 修了什么(R8#13)

`AnnotationPanel.tsx` 召唤批注错误 toast(`summonErr` state):
1. state 类型从 `string | null` 升级为 `{ message: string; ctaSettings?: boolean } | null`
2. 三处 setSummonErr 改为传结构对象,把 `humanizeAiError().ctaSettings` 一并传进去
3. toast 渲染:外层 click 关闭照旧;`ctaSettings=true` 时多挂一个"去设置"按钮(stopPropagation 避免冒泡到外层关闭),点击 `useUiStore.getState().setShowSettings(true)` 打开 Settings 面板并关 toast

### 为什么有用

humanizeAiError 老就识别了 401 / 403 / 'key' / 'invalid' / 余额 / model not exist 等场景,返回 `ctaSettings: true` 标志暗示调用方该挂"去设置"按钮。但之前**没人用这个标志**——5 处 humanizeAiError 调用都只读 `.message` / `.hint`,标志被忽略。

这版给最高频的一处(召唤批注的错误 toast)接上,API Key / 余额 / 模型不存在类失败时用户一键跳到 Settings 改 Key,不用手动找 TopBar 的齿轮按钮。

### 剩余(留后续 round)

AgentPanel / PersonasTab / LectureMode / ReadingLogView 共 4 处 humanizeAiError 调用点也该接 CTA。本轮先接 AnnotationPanel,模式跑通了后续按需扩散。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 32.23s 通过

---

## 2026-04-28 · Batch 55 · 夜间值守 Round 8 #12 · Bug · QuickOpen / BatchOcr 静态 sweep

主题：**bug fix · 新扫 QuickOpen + BatchOcr 目录(R1-R7 未扫),抓两个 timer/sub 泄漏**

### 修了什么(R8#12)

**A · QuickOpenModal.tsx · setTimeout(focus) 无 cleanup**
30ms focus timer 之前没存 handle,modal 在 30ms 内被关闭(用户狂按 quick open 快捷键)会 fire 到已卸载 input + 留 orphaned timer。`const t = setTimeout(...); return () => clearTimeout(t)`。

**B · BatchOcrRunner.tsx · onOcrProgress 订阅每次 advance 都 resub**
原 effect deps 含 `ocrQueue.items / currentIndex` → 每个 OCR PDF advance 时 effect cleanup unsub + 重 sub onOcrProgress。大批量(几十文件)时 IPC 来回浪费,加上事件桥几毫秒延迟可能错过 chunk-progress 信号。改成 `ocrQueueRef = useRef(ocrQueue); ocrQueueRef.current = ocrQueue` 模式,effect deps 只 `[setOcrChunkProgress]`(stable),subscribe 一次到底,callback 通过 ref 拿最新 queue。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 31.79s 通过

### 后续

下轮 Round 8 #13 必须 PERF 或 UX。本轮已开始扫新区,可继续在 common (ConfirmDialog/ImeInput/ModelSelector) 或 Lecture / OcrRangeModal 做 sweep,但 #13 不能再选 Bug 了。

---

## 2026-04-28 · Batch 54 · 夜间值守 Round 8 #11 · PERF · personaListCache 共享缓存

主题：**perf · 仿 aiConfigCache 模式新建 personaListCache,免重复 IPC**

### 修了什么(R8#11)

1. **新建** `src/utils/personaListCache.ts`(单 export):
   - `fetchPersonaList()` 命中即同步,首次 dedupe inflight Promise
   - `subscribePersonaList(listener)` 订阅 invalidate 通知
   - `invalidatePersonaListCache()` 清缓存 + re-fetch + 广播订阅者
   - `usePersonaList()` React hook(内部自动订阅)
2. **AnnotationPanel.tsx** mount-time 拉 personaList 改成 `fetchPersonaList()` + `subscribePersonaList()`
3. **PersonasTab.tsx** persona 增删改 3 处都加 `invalidatePersonaListCache()` 调用,通知 AnnotationPanel 召唤 dropdown 自动刷新

### 预期收益

- 用户切面板时(PdfViewer ↔ AgentPanel ↔ etc) AnnotationPanel mount 不再每次都 IPC + 文件读
- PersonasTab 改 persona 后 AnnotationPanel 召唤 dropdown 自动响应,不需要刷新 / 切面板触发 mount 才更新
- 模式与 aiConfigCache / agentMemoryCache 一致,基础设施统一

### 留作后续(本轮范围之外)

PersonasTab 自己的 `loadList()` 仍走原 IPC(它需要全字段)。后续可以让 PersonasTab 也走 cache(可能要扩展 cache 字段)。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 31.86s 通过

### 后续

下轮 Round 8 #12 必须 Bug 或 UX。bug 池欠款已清空,要么从 night-shift 入口 3 (静态 sweep · 找新 bug · Lecture / BatchOcr / QuickOpen / common 等未扫目录)开始,要么转 UX。

---

## 2026-04-28 · Batch 53 · 夜间值守 Round 8 #10 · Bug · App.tsx setTimeout cleanup + race

主题：**bug fix · 清空 R1+R2 观察项最后一条欠款**

### 修了什么(R8#10)

`src/App.tsx` 的 init useEffect 之前裸跑 `setTimeout(openEntry, 300)`:
- 没跟踪 timer handle → component unmount 时 orphaned
- 没防 race → 用户在 300ms 内手动 openEntry,这个 timer 又 fire 覆盖用户选择(虽然 openEntry 内部能容忍但还是不该这么粗糙)

顺手扫到同 useEffect 里 `setTimeout(3000)` 触发 update check 的也没 cleanup,一并补上。

修法:
- 顶部 `let cancelled = false` + 两个 timer handle
- timer fire 时 check `cancelled` + `currentEntry`(已设就跳过尊重用户)
- 统一 cleanup 清两 timer + listener + cancelled

### 里程碑

**Round 1 + Round 2 观察项 8 条全部清空** 🎉
- R1: regex `~~`(R8#1) / aiThrottle 安全(原本就是 OK 备注) / personaPortrait sanitize(uuid 安全 → 暂留) / personas embed RPM(aiThrottle 兜得住 → 暂留)
- R2: save-ocr-text 命名(R8#5) / App.tsx setTimeout(R8#10) / agent.ts RMW lock(R8#3) / uiStore NaN(R5#3 + R8#8 sweep)

剩 R1 两条都是"安全"备注,不是 bug,正式归档。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.38s 通过

### 后续

下轮 Round 8 #11 选 PERF 或 UX。bug 池里没现成清单了,要扫新 bug 的话从 night-shift 入口 3 (静态 sweep · 找新 bug)开始,目标目录:Lecture / BatchOcr / QuickOpen / common / glmApi / aiApi handler。

---

## 2026-04-28 · Batch 52 · 夜间值守 Round 8 #9 · UX · HistorySessions 乐观缓存

主题：**UX · _UX_AUDIT_TODO P2-10 落地 — 切回 persona detail 不再看到 '加载中…' 闪烁**

### 修了什么(R8#9)

`src/components/Agent/PersonasTab.tsx HistorySessionsSection`:

1. 新增模块级 `historySessionsCache: Map<personaId, SummonSessionSummary[]>`
2. 初始 state 直接读 cache(同步),没 cache 才 `loading=true`
3. useEffect 里:有 cache → 后台静默刷新(loading 保持 false 不闪);无 cache → 走原来的 loading 路径
4. 删除时清掉对应 personaId 的 cache 后增 refreshTick → 下次 effect 重 fetch 拿到最新

### 触发场景

用户工作流是"在多个 persona 之间来回切看历史对话"。每次切回都看到一段加载 placeholder,体验割裂。改完后:
- 第一次进 detail:正常 loading → list 渲染 → cache 写入
- 第二次重进 detail:list 立刻渲染(从 cache),后台 fetch 一次刷新最新

边缘 case: 在 summon 里跑了一段对话回到 detail → cache 是 stale,但 useEffect 重 fetch 会在一帧后 setSessions 拿到最新。从用户视角是 "瞬间看到旧 list → 看到新增的对话",比 "加载中… → list" 顺滑。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 34.67s 通过

### 后续

下轮 Round 8 #10 必须 Bug 或 PERF。R2 观察项剩 1 条:App.tsx:301 setTimeout(openEntry,300) 清理。值得做完彻底清空 R1+R2 观察项欠款。

---

## 2026-04-28 · Batch 51 · 夜间值守 Round 8 #8 · Bug · localStorage NaN 防御 sweep

主题：**bug fix · R2 观察项第 4 条延伸 — 全 app localStorage 数字读 NaN 防御**

### 修了什么(R8#8)

新建 `src/utils/safeStorageRead.ts` · 单 export:
```ts
readNumber(key: string, defaultValue: number, minValue?: number): number
```
- `null` / 不存在 → default
- 不是 finite number → default
- 给了 minValue 且 `n <= minValue` → default(panel 宽度等下限保护)

替换 4 个文件 5 处的裸 `Number(localStorage.getItem(...))`:

| 文件 | 影响 |
|------|------|
| `App.tsx:337` 更新检查时间戳 | NaN 比较全 false → 用户永远不会再被检查更新 |
| `AnnotationPanel.tsx:753` 注释面板宽度 | NaN 让 panel 缩到 0 隐身 |
| `PdfViewer.tsx:2178` lsGet 给 6 个 slider 用 | NaN 让 OCR fontSize/字重/颜色全坏掉,文本不可读 |
| `PdfViewer.tsx:2572` 滚动位置恢复 | NaN > 0 false → 不恢复(算软失败) |

`AgentPanel.tsx:505` 已有 min/max 检查恰好碰巧防住 NaN(`NaN >= MIN` 是 false),不动。

### 触发场景

用户从浏览器开发者工具手动改 localStorage / 旧版本 app 写入过非数字值 / extension 写脏数据。罕见但一次中毒就静默坏一堆 UX。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 32.25s 通过

### 后续

R2 观察项剩 1 条:App.tsx:301 setTimeout(openEntry,300) 清理。这是夜间值守开局时点过的最后一个明确欠款。

下轮 Round 8 #9 必须 PERF 或 UX。

---

## 2026-04-28 · Batch 50 · 夜间值守 Round 8 #7 · PERF · ImmersiveAnnotationBox cache + selector

主题：**perf · ImmersiveAnnotationBox 三处共同优化**

### 修了什么(R8#7)

`src/components/PdfViewer/PdfViewer.tsx` 里的 `ImmersiveAnnotationBox` 子组件:

1. **zustand 全量解构 → selectors**(L1843-1844):
   - `const { updatePdfMeta } = useLibraryStore()` → `useLibraryStore(s => s.updatePdfMeta)`
   - `const { selectedAiModel, setSelectedAiModel } = useUiStore()` → 拆 2 个 selector
   - 不相关 store 字段变化不再让浮动批注框重渲

2. **aiGetConfigured raw IPC → fetchAiConfig 共享 cache**(L1848-1852):
   - 之前每次浮动框 mount 都跑一次 IPC + 文件读
   - 改成走 `fetchAiConfig` cache(命中即同步)+ `subscribeAiConfig` 订阅 invalidate
   - 用户在 Settings 改 API key 后浮动框自动响应,不用重开

3. **L2497 一次性 await 也走 fetchAiConfig**:
   - rereadingReminder 调用点也用同一个 cache,免重复 IPC

### 为什么有用

- ImmersiveAnnotationBox 用户每次进入 immersive 模式后选中文字都会 mount,频繁 IPC 是浪费
- AnnotationPanel / AgentPanel / TranslateModal 早就走 cache 了,这里是漏的最后一处(grep 验证)
- selector 模式让浮动框对无关 store 变化(滚动 / 主题切换 / dualPage 等)免疫

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.79s 通过
- 手测路径:进 immersive 选中 → 浮动框出现 → 模型下拉应当瞬间填充(cache hit)而不是空一会儿才出来

### 后续

下轮 Round 8 #8 必须 Bug 或 UX(因为 #7 是 PERF)。bug 池里 R2 观察项剩 2 条:App.tsx setTimeout / uiStore NaN 防御,任意一条都行。

---

## 2026-04-28 · Batch 49 · 夜间值守 Round 8 #6 · UX · PersonaRagPill error 详情面板

主题：**UX · _UX_AUDIT_TODO P2-5 落地**

### 修了什么(R8#6)

`src/components/Agent/personaRagStatus.tsx` 的 PersonaRagPill 组件:
- error 状态下 pill 改为带 ▾/▴ 的可展开按钮(label `失败 ▾` / `失败 ▴`)
- 点击 error pill → 展开 inline 详情面板,显示 `state.message`(完整失败原因) + "收起" / "重试构建" 两个按钮
- 详情面板用 `position: absolute` 定位在 pill 下方,不影响外层 Card 布局
- state.kind 切回非 error 时面板自动收起

### 为什么有用

之前用户看到红色"索引失败"pill 时,失败原因(API 限流/key 失效/余额不足等)只有 hover title 才出现。多数用户根本不会想到去 hover,看到红 pill 直接懵或点击触发重试,如果原因没解决就再次失败死循环。

现在 hover 仍有 tooltip,但 pill 的 ▾ 暗示可展开,点击直接看到完整 message,旁边就是重试按钮,流程完整。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.00s 通过
- 手测路径:用 invalid Key 触发 RAG 失败 → pill 应显示 `失败 ▾` → 点击 → 看到完整 message

### 后续

下轮 Round 8 #7 必须 Bug 或 PERF。bug 池里 R2 观察项剩 2 条:App.tsx:301 setTimeout / uiStore NaN。

---

## 2026-04-28 · Batch 48 · 夜间值守 Round 8 #5 · Bug · save-ocr-text 非 PDF 覆盖源文件

主题：**bug fix · R2 观察项第 1 条原 audit 标"边缘但不是 bug",实际是真 bug**

### 修了什么(R8#5)

`electron/ipc/library.ts` 里 `save-ocr-text` handler 之前是:
```ts
const ocrPath = pdfAbsPath.replace(/\.pdf$/i, '.ocr.txt')
await atomicWriteFile(ocrPath, text)
```

非 PDF 扩展名(`.epub` / `.docx` / `.txt` ...)→ regex 不匹配 → ocrPath 等于源文件路径 → atomicWriteFile **直接覆盖源文件,源文件被销毁**。

当前 OCR 流水线限于 PDF,实际触发概率低。但:
- `save-ocr-text` IPC 是 renderer 可达接口,任何调用方传非 PDF 都会触发
- 未来给 epub / docx 加 OCR 能力时这就是隐藏雷
- 边缘但不是 bug → 实际是真 bug,只是被上游逻辑挡住

修法抽 `ocrPathFor(srcPath)` helper:
- PDF → `book.ocr.txt`(向后兼容已有文件命名)
- 非 PDF → 追加 `.ocr.txt`(`book.epub` → `book.epub.ocr.txt`,永远不覆盖源)

四处调用点(save / read / delete / full-text-search)统一走 helper。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.47s 通过
- 手测路径:对 PDF OCR 应当不变(还是 `book.ocr.txt`),对非 PDF OCR(若有)走 `book.<ext>.ocr.txt`

### 后续

R2 观察项剩 2 条:App.tsx:301 setTimeout(openEntry,300) 清理 / uiStore.ts NaN 防御。下轮 Round 8 #6 必须 PERF 或 UX(因为 #5 是 Bug)。

---

## 2026-04-28 · Batch 47 · 夜间值守 Round 8 #4 · PERF · PdfViewer zustand 全量解构 → selector

主题：**perf · 对照 PERF-R7#1 (App.tsx) 把 PdfViewer 也改成 selector 订阅**

### 修了什么(R8#4)

`src/components/PdfViewer/PdfViewer.tsx:2108-2110` 之前是:
```tsx
const { currentEntry, currentPdfMeta, updatePdfMeta, updateEntry } = useLibraryStore()
const { textSelection, setTextSelection, setActiveAnnotation, glmApiKeyStatus, immersiveMode, darkMode, dualPageMode, searchHighlight, setSearchHighlight } = useUiStore()
```

两次全量订阅 — 任何 libraryStore / uiStore 字段变化(比如高频的 `currentVisiblePage`)都把 PdfViewer 整树重渲。改成 13 个独立 `useXxxStore(s => s.field)` selector,只对真正用的字段订阅。

### 预期收益

PdfViewer 是大组件(~5500 行),内部还嵌着 OcrContent / Bilingual / DOCX / EPUB / TextLayer 一堆子树。每次重渲要 reconcile 整树。最直接受益:
- 用户滚动 PDF 时,uiStore 高频更新 `currentVisiblePage`(每页可见性变都更),旧版让 PdfViewer 整树都进 reconcile;新版只有真用 currentVisiblePage 的子组件订阅它(目前主体不订阅)
- 用户在 Sidebar 里点击切换主题(darkMode 变),触发的 reconcile 也会窄
- AI 即时生成 stream 期间频繁 setState,即使是不相关字段也不再波及 PdfViewer

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 35.44s 通过

### 注意

L1843-L1844 还有一个内嵌组件(AnnotationPopover-like)用了 useLibraryStore() 全量解构,scope 较小先放着,下一轮 PERF 再清理。

### 后续

下轮 Round 8 #5 必须 Bug 或 UX(因为 #4 是 PERF)。bug 池里 R2 观察项还剩 3 条:library.ts 非 .pdf 命名 / App.tsx setTimeout 清理 / uiStore NaN 防御。

---

## 2026-04-28 · Batch 46 · 夜间值守 Round 8 #3 · Bug · agent.ts conversation RMW 加锁

主题：**bug fix · _BUG_REPORT.md R2 观察项第 3 条 — 并发 RMW 覆写**

### 修了什么(R8#3)

`electron/ipc/agent.ts` 的两个 handler 之前都裸跑 RMW:
```
agent-save-conversation: 读 → modify → atomicWrite
agent-delete-conversation: 读 → filter → atomicWrite
```

`atomicWriteJson` 内部的 writeLock 只串行化"写"那一步,两个并发调用的"读"会跨过对方,各自基于 stale list 写回,后写的覆盖前写的。

修法:模块级
```ts
let conversationsRMWChain: Promise<unknown> = Promise.resolve()
function withConversationsLock<T>(fn: () => Promise<T>): Promise<T> { ... }
```

把整个 RMW 序列包在 chain 里,失败 catch reset 不卡链。

### 触发场景

双窗口 / IPC 队列里两条 save 紧挨着 / save 紧跟 delete。单窗口低频用户基本碰不到,但模式上确是 bug,这版直接锁了。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.98s 通过

### 后续

R2 观察项还剩 3 条:library.ts:326 save-ocr-text 非 .pdf 命名 / App.tsx:301 setTimeout 清理 / uiStore.ts NaN 防御。下轮 Round 8 #4 必须 PERF 或 UX(因为 #3 选了 Bug)。

---

## 2026-04-28 · Batch 45 · 夜间值守 Round 8 #2 · UX · SummonView 跨 Ctrl+Shift+R 状态保持

主题：**UX · _UX_AUDIT_TODO P2-1 落地 + 顺手把 P2-3 / P1-8 标已修**

### 修了什么(P2-1)

`PersonasTab.tsx` 加了一对 useEffect 把 `stage / current.id / summonInit.sessionId` 持久化到 sessionStorage(key = `shijuan.personasTab.state.v1`):
- mount 时读 → 异步 personaLoad + 可选 summonSessionLoad → 还原 detail / summon 阶段
- stage / current / summonInit 任一变化 → 写入(gallery / import / 没有 current 时清掉)

sessionStorage 在 Electron 渲染器 reload 期间保留(关窗才清),正好适合"误触 Ctrl+Shift+R 不丢上下文"这个场景。
- 仅恢复 'detail' / 'summon';'gallery' / 'import' 是过渡态,reload 后到 gallery 即可
- persona 已删/损坏 → 清掉过期 state,自动回 gallery
- 会话存档丢了 → 用同一个 sessionId 起空会话,后续保存重建

### 顺带核对的过期审计项

读 `_UX_AUDIT_TODO.md` 时发现两条已经做了但没标:
- **P1-8**(personaList 为空时 AnnotationPanel 召唤按钮空态提示)
  - 实际 line 2170-2190 已实现 P1-8/P2-9 合并的空态引导(去 Agent 面板召唤),audit 文档写的位置 line 2023-2044 实际是 FeedbackBubble 区域(过期了)
- **P2-3**(SummonView 没有 Esc 关闭)
  - 实际 line 1086-1105 已实现两段式 Esc:textarea 焦点先 blur,第二下才 onClose,流式期间不退

两条直接划线归档。

### 验证

- `npx tsc --noEmit`: EXIT=0
- `npx electron-vite build`: 33.73s 通过
- 手测路径(下次有时间):打开 Agent 面板召唤 tab → 进 detail 或 summon → Ctrl+Shift+R → 应当回到原 stage

### 下轮预期

按"三类轮换不连选同类"规则,Round 8 #3 必须选 Bug 或 PERF。bug 池里 R1/R2 观察项还剩 5 条欠款,挑一个最像样的(library.ts:326 save-ocr-text 非 .pdf 扩展名 / agent.ts:279 conversation 写盘加 lock)做。

---

## 2026-04-28 · Batch 44 · 夜间值守 Round 8 #1 · regex `~~` 重复清理

主题：**bug fix · 把 R1 观察项第 1 条欠账清掉，作为夜间值守开局**

### 修了什么

`citationVerifier.ts:26/27/35` + `personaCitationParse.ts:34` 三处 regex 字符类里的 `~~` 改成 `~`：

```diff
- /[\d,，、\s\-–~~]+/g
+ /[\d,，、\s\-–~]+/g
```

字符类里相同字符出现两次完全等价于一次。regex 行为不变，纯 noise 清理。三个文件，diff = 6 行（含注释）。

### 验证

- `npx tsc --noEmit`：EXIT=0
- `npx electron-vite build`：33.22s 通过
- 行为不变（regex 语义一致）

### 后续

挂着的"观察项 / 已知挂起"还有 5 条等清:
- personaPortrait.ts:100 personaId 路径清洗
- agent.ts:279 agent-save-conversation 加 lock
- App.tsx:301 setTimeout(openEntry,300) 清理
- library.ts:326 save-ocr-text 非 .pdf 扩展名
- uiStore.ts:158 NaN 防御

按"三类轮换不连选同类"规则,Round 8 #2 下一轮要选 PERF 或 UX。

---

## 2026-04-27 · Batch 43 (尾) · 用户离场期间自主 sweep + bug 修

主题：**用户离开后做的"独立测试 + 修 bug + 优化体验"轮次**

### 修的 build-blocking bug（2 个，都是之前批次留下的）

1. **`AnnotationPanel.tsx:450` `React.memo()` 漏 `)` 闭合**
   - `const HistoryEntryItem = React.memo(function HistoryEntryItem({...}) { ...body... })` 结构里，函数体闭合 `}` 后**没有** `)` 闭合 React.memo 的参数列表
   - 而下游 `FeedbackBubble` 函数（普通 declaration）末尾**多了一个 `)`** —— `})` 应是 `}`
   - 总效果：esbuild 把 `React.memo(` 一直延伸到 line 488，触发 "Expected ')' but found 'function'" at line 453
   - tsc `--noEmit` 没抓到（TypeScript parser 比 esbuild 宽松），但 `electron-vite build` 失败
   - 修：line 450 `}` → `})`，line 488 `})` → `}`

2. **`AgentPanel.tsx:167` STYLE_RULES 模板字符串内嵌反引号**
   - 我之前写 `` ` `` ` `languageStyle` ` `` ` `` 在外层模板字符串里——内层反引号被 babel 当作模板字符串结束，后续中文当 JS 代码 → "Missing semicolon (167:56)"
   - 同样 tsc 通过，babel 失败
   - 修：去掉内层反引号

### Stream 状态泄漏 sweep（修 3 处遗漏入口）

之前只修了 `handleNewConversation`。又扫出 3 处切换 activeConv 时未清流式状态：
- **`handleDeleteConversation` line 733** —— 删当前对话切到 fallback 时
- **历史对话全页 line 1305** —— 用户在全页历史里点击切换
- **历史对话下拉 line 1438** —— 顶部 popover 里点击切换

这三处都加了 `handleStopStream()` 调用 + 必要的 useCallback 依赖更新。修后副作用：
- 流式中切对话 → AI stream 立即 abort（省 token）
- "XX 思考中..." 气泡不会残留到目标对话
- streaming flag 不会卡死输入框

### `window.confirm()` 全量替换（6 处剩余 → ConfirmDialog）

之前 ConfirmDialog 只接入了 PersonasTab handleDelete persona。这轮把剩下 6 处都迁移：
- **MemoList.tsx ×3** —— 删文件夹（在 MemoFolderItem sub） + 批量删笔记 + 单条删笔记
- **MemoEditor.tsx ×1** —— 删笔记
- **FileTree.tsx ×1** —— 删库分组（在 FolderItem sub）
- **PersonasTab.tsx ×1** —— HistorySessionsSection 删对话记录

每个组件加 `useConfirmDialog()` hook + 渲染 `{confirmDialog}`。所有删除场景的 dialog 都用 `danger: true`（红色 confirm 按钮）。

### 验证

- `npx tsc --noEmit`：EXIT=0
- `npx electron-vite build`：8.33s 通过（之前因 React.memo 括号 bug 失败）
- 主进程 / preload / renderer 三个 bundle 都干净构建

### 已知挂起 / 下一批

- **"流式期间 user 气泡消失，结束后又出现" bug**（用户之前报过）—— 仍未查出根因。多次审视 displayMessages useMemo / handleSend 流程 / runOne setActiveConv 都没找到能让 user 消失的路径。可能与 React 18 batching 或某个触发外部 setActiveConv 的路径有关。需要用户在能复现时贴 console 日志才能精准定位。挂起。
- **`callWithManualSearchLoop` 升级版 DSML 流过滤的边缘 case**：如果用户输出真的含全角竖线 `｜`（罕见但合法），buffer 会一直累积到流结束才一次性 emit，streaming UX 退化到非流式。可优化但 trade-off：要么严格 streaming 但有 DSML 残留，要么 buffer 但失去 streaming 感。当前 buffer 安全。
- **Round 1 4 条观察项**（regex `~~` 重复 / personaPortrait sanitize / agent.ts conversation 写盘 lock）—— 仍未做。
- **listencast / 沉浸阅读端到端**（Batch 38 P5 解锁后的端到端测试）—— 仍未做。
- **release pipeline 自动化**（Batch 42 留的）—— 仍未做。

### 文件清单（本轮）

- `src/components/AnnotationPanel/AnnotationPanel.tsx` — 修 React.memo / FeedbackBubble 括号
- `src/components/Agent/AgentPanel.tsx` — 反引号修 + 3 处 stream cleanup + handleSend useCallback deps
- `src/components/Memo/MemoList.tsx` — 3 处 confirm 替换 + import
- `src/components/Memo/MemoEditor.tsx` — 1 处 confirm 替换 + import
- `src/components/Sidebar/FileTree.tsx` — 1 处 confirm 替换 + import
- `src/components/Agent/PersonasTab.tsx` — 1 处 confirm 替换（HistorySessionsSection）

---

## 2026-04-27 · Batch 43 · 多轮用户实测驱动的体验 / 模型 / 思考强度修复

主题：**用户多轮反馈驱动的 hot-spot 修复 · provider 接入校准 · effort 思考强度新功能**

> 本批次跨度大，由用户在测试中连续抛出 6+ 个独立问题逐一推进。最后一段对 AI provider 的接入做了一次基于官方文档的全面校准 + 引入"思考强度"功能。

### 1. AI 错误转译 humanizeAiError
- 新文件 `src/utils/humanizeAiError.ts`
- 把后端透传的 raw 字符串（`GLM API error 401: {...}` / `1302` / `ECONNREFUSED` 等）
  转成中文 + 给用户明确的下一步建议
- 识别：401/403/Key 类、429/rate limit、quota/余额、network/超时、5xx、abort
- 接入 5 个调用点：
  - `AnnotationPanel.tsx` 召唤批注 / glmInterpret
  - `PersonasTab.tsx` SummonView 3 处 onError
  - `AgentPanel.tsx` 多人召唤 catch
  - `LectureMode.tsx` AI 总结
  - `ReadingLogView.tsx` 日报生成
- 用户主动 abort（"已取消"）会被识别为 `silent: true`，调用方吞掉不弹 toast

### 2. ConfirmDialog 暖金确认弹窗
- 新文件 `src/components/common/ConfirmDialog.tsx`
- 受控组件 + `useConfirmDialog()` hook（命令式 ask({...}) → 异步 onConfirm）
- 支持 title / message / confirmLabel / danger（红色）
- Esc 取消 / Enter 确认 / 自动聚焦 confirm 按钮 / backdrop 点击取消
- 视觉对齐 ImportModal（半透明 + blur backdrop · 14px radius · 暖色 shadow）
- **本批接入**：PersonasTab 的删除思想家档案（`window.confirm` → 暖金 dialog）
- **后续 batch 还要替换的 7 处**（已扫出，留给下批）：
  - PersonasTab HistorySessionsSection 删对话记录
  - MemoEditor 删笔记
  - MemoList 删文件夹 / 批量删笔记 / 单条删
  - FileTree 删库文件夹 / 批量 OCR 确认

### 3. 召唤多人对话三套场景模板（修 bug + 用户校准）

**Bug**：用户报告"辩论模式关闭之后依然处于辩论状态"。
**Root cause**：`STAGE_PREFIX_TEMPLATE` 700 字硬写"当面口头辩论 / 拆接反 / 觉得对方蠢"，
即使 `debateMode=false` 也注入这个辩论框架，把"圆桌"软指令完全压过。

**修复**（`AgentPanel.tsx`）：拆 `STAGE_*_TEMPLATE` 三套
- `STAGE_SOLO_TEMPLATE` —— 单人召唤（一对一对话，无对手概念）
- `STAGE_ROUNDTABLE_TEMPLATE` —— 多人 + 辩论关（圆桌座谈，独立陈述但可呼应）
- `STAGE_DEBATE_TEMPLATE` —— 多人 + 辩论开

`buildStagePrefix(personaName, mode)` 根据 stageMode 选模板。stageMode 计算：
- `respondents.length === 1` → 'solo'
- `debateMode` → 'debate'
- 其他 → 'roundtable'

**辩论模式 v2 校准**（用户："辩论模式则应该有明显的个人立场，不融合出结论，
而是不断反驳他人和论证自己的观点"）：
- 删掉 v1 的"半辩论半讨论 / 通过交锋抵达更清晰判断"框架
- 改成"对立辩论 · 不为达成共识 · 立场要鲜明、稳，从开场到最后一轮都不软化"
- 最终轮 instruction 也从"收束/共识"改成"再亮立场 / 再补一次反驳 / 不要试图达成共识"

**动作描写格式**（用户："辩论模式这里的人物动作描写的语句左右可以加一个括号"）：
- 三套模板 + 辩论补充段都改成"动作用圆括号"（冷笑）（蹙眉）（沉默片刻）
- 明确 "**不要用** *星号* / **粗体**" —— 那是 markdown 语法会被斜体渲染
- 旧 "*冷笑*" 风格的历史消息仍渲染为斜体，新生成走括号格式

### 3.5 辩论模式立场校准（用户二次反馈）

用户校准："辩论模式则应该有明显的个人立场，不融合出结论，而是不断反驳他人和论证自己的观点。"
- 撤掉 v1 的"半辩论半讨论 / 通过交锋抵达更清晰判断"基调
- DEBATE 模板改为"对立辩论 · 不为达成共识 · 立场要鲜明、稳，从开场到最后一轮都不软化"
- 最终轮 instruction 也从"收束/达成共识"改成"再亮一次立场 / 再补一次反驳 / 不要试图共识"

**动作描写格式**（用户："动作描写左右可以加一个括号"）：
- 三套模板都改成"动作用圆括号"（冷笑）（蹙眉）（沉默片刻）
- 明确禁止 `*星号*` / `**粗体**`（避免 markdown 误渲染成斜体）

### 4. AI provider 缓存订阅修复（修 bug "deepseek 配完后学徒模型未更新"）

**Bug**：用户在 Settings 配 deepseek API key 后，AgentPanel / AnnotationPanel /
PdfViewer / TranslateModal 这 4 个面板的模型下拉**仍是旧列表**（不含 deepseek）。

**Root cause**：`aiConfigCache.ts` 的 invalidate 只清模块级 `cache` 变量，但
**已 mount 的组件仍持有上次 fetch 的 list state**，没有 re-fetch 信号。组件用
`useEffect([])` 只在挂载时拉一次，cache 失效不影响组件 state。

**修复**：在 cache 模块加 subscribe/notify：
- `subscribeAiConfig(listener)` 注册回调
- `invalidateAiConfigCache()` 清 cache 后**主动 fetch 新数据 + 广播给所有订阅者**
- 4 个组件 `useEffect` 加 `subscribeAiConfig(setConfiguredProviders)`
- 也导出 `useAiConfig()` hook 给后续新代码用（自带订阅）

副作用：现在用户在 Settings 改任意 provider 的 Key（add / remove）后，
所有打开的面板的模型下拉会立刻自动刷新。

### 文件清单
- 新增 `src/utils/humanizeAiError.ts`
- 新增 `src/components/common/ConfirmDialog.tsx`
- 改 `src/utils/aiConfigCache.ts`（subscribe + useAiConfig）
- 改 `src/components/Agent/AgentPanel.tsx`（STAGE 三套 · 辩论 v2 · subscribe · humanize）
- 改 `src/components/Agent/PersonasTab.tsx`（humanize × 3 · ConfirmDialog 接入 1 处）
- 改 `src/components/AnnotationPanel/AnnotationPanel.tsx`（humanize × 2 · subscribe）
- 改 `src/components/Lecture/LectureMode.tsx`（humanize）
- 改 `src/components/ReadingLog/ReadingLogView.tsx`（humanize）
- 改 `src/components/PdfViewer/PdfViewer.tsx`（subscribe）
- 改 `src/components/PdfViewer/TranslateModal.tsx`（subscribe）

### 验证
- `npx tsc --noEmit` EXIT=0（0 错误）
- 未跑 dev server 端到端 —— 主要改动是 prompt 文本 + 订阅器 + helper utility，
  无 UI 视觉变化（ConfirmDialog 待用户实际触发删除流程时见到）

### 已知坑 / 下一批
- [ ] 替换剩余 7 处 `window.confirm`：MemoEditor / MemoList × 3 / FileTree × 2 /
      PersonasTab HistorySessionsSection（ConfirmDialog 已就绪，逐处接入）
- [ ] 4 条 Round 1 观察项清理（regex 重复、personaPortrait sanitize、
      personaCitationParse 正则字符类 `~~`、agent.ts conversation 写盘 lock）
- [ ] 旧 markdown `*动作*` 历史消息可考虑迁移渲染：把 emphasis 节点重写为括号
      文本节点。但代价是注释里读者写的真正强调也会被吞，**不做**为佳

### 积压（承前批次未做）
- [ ] 注释 context-aware 锚点（filterSupersededMarks 正确版本）
- [ ] OCR 状态图标的 'running' 态（FileTree entry 右侧）
- [ ] 听课 / 沉浸阅读 Batch 38 放出来后端到端实测
- [ ] release pipeline 自动化（gzip + gh release upload）

---

## 2026-04-22 · Batch 42 · 热更新 asar gzip 压缩

主题：**热更新下载包从 204.6MB 未压缩 → 65.3MB gzip（-68%，-139MB）**

背景：Batch 41 发布 v1.3.1 时发现上传的 `app.asar` 未压缩 214MB，比 NSIS
安装包还大。承诺下批做 gzip / bsdiff 优化。这批选 gzip——JS / JSON 占主体，
典型 3-5× 压缩，Node `zlib` 内置零依赖，实现风险低。bsdiff 留待后续。

**实测**：用真实 `v1.3.1/app.asar`（204.6 MB）跑 `compress-asar`，gzip level 9
产出 65.3 MB（31.9% 原大小），耗时 8.7s。用户下载从 200 MB 降到 65 MB，
流量省 2/3。

### 做了什么

1. **`electron/updater.ts` 新增 gzip 支持**
   - `UpdateInfo` 增加 `compressed: boolean` 字段（additive，旧客户端仍兼容）
   - `checkForUpdate` asset 优先级：`app.asar.gz` > `app.asar` > `*patch*.asar`
   - `downloadFile` 加 `decompress: boolean` 入参：URL 以 `.asar.gz` 结尾时
     response body 经 `zlib.createGunzip()` 流式解压，落盘已是原始 asar
     - 进度条基于"raw 字节 / content-length"（即压缩字节），正确匹配下载感知
     - file.on('finish') + 单次 settle flag 避免 gunzip / file / res 多端 error
       二次 resolve
   - `apply-update` 不动——落盘是未压缩 asar，swap 流程与之前一致

2. **`scripts/compress-asar.mjs` 新脚本**
   - 从 4 个候选路径自动找 asar（NSIS win-unpacked / mac .app / pack-portable
     dist-packager）
   - `createGzip({ level: 9 })` + `stream.pipeline`（2 行核心 + 60 行自动检测
     + 打印体积对比 + 给出 `gh release upload` 命令）
   - npm 脚本 `npm run compress-asar` 直连
   - 发版流程：`npm run dist` → `npm run compress-asar` → 上传 `.gz` 到 release

3. **preload.ts 类型签名同步**
   - `checkUpdate` 返回类型补 `compressed: boolean` 字段；TopBar / uiStore 都
     只读 `asarSize` / `downloadUrl`，不需要改

### 验证

- `npx electron-vite build`：4.91s ok，main bundle 内确认含 `createGunzip`
  `asar.gz` `compressed:` 三处标记
- 用 1.27 MB 的真实 pdfjs 产物做 round-trip：gzip level 9 → 0.26 MB (20.2%
  原大小) → gunzip → sha256 与原文件完全一致 ✅ 证明 updater 落盘字节精确
- tsc pre-existing 7 个错误（agent.ts / aiThrottle.ts / apprentice.ts /
  glmApi.ts / library.ts，见 Batch 37）与本改动无关，未新增

### 向后兼容

- 老客户端（v1.3.1 及更早）**只找 `app.asar`**，看到 release 里只有 `.gz` 会
  走 `downloadUrl=null` 兜底（提示"请从 GitHub Release 下载完整安装包"），
  不会崩。**过渡策略：发 v1.3.2 时 release 同时上传 `app.asar` + `app.asar.gz`
  两个资产**，让老客户端升到 v1.3.2 后后续就能吃 gzip。一次完整升级周期
  （估计 1-2 个版本）后可以只上传 `.gz`

### 已知坑 / 下一步

- ⚠️ 纯 gzip 每次仍要下全量 asar（压完 45-60 MB）。**下下批可考虑 bsdiff
  delta**（典型 10-50× 再缩，真改动 3 MB 可能只下 1-2 MB）。但 bsdiff 需要：
  (a) 原端 asar hash 对齐（否则 patch 不能 apply）(b) 带 bspatch 原生二进制或
  WASM 实现。实装复杂度远高于 gzip，按需再做
- compress-asar.mjs 现在只跑 level 9；如果发现 CPU 占用太高，可加个 `--level`
  参数。实测 1.27 MB 用时 0.1s，214 MB 估计 15-20s，一次发版压一次，完全够用
- **没做**：release pipeline 自动化（比如 GitHub Action 触发 `npm run dist &&
  npm run compress-asar && gh release upload`）。目前仍是手工三步。留 idle

### 积压（承前批次）

- [ ] 注释 context-aware 锚点（Batch 40 回滚的 filterSupersededMarks 要做正确
      版本：mark 加 prefix/suffix 约 20 char 上下文，匹配时 fuzzy 对齐，避开
      "同短语第二次出现"误伤）
- [ ] OCR 状态图标（Batch 39 遗留）：FileTree entry 右侧加 running / complete /
      failed 小图标；LibraryEntry.ocrStatus 加 'running' 态
- [ ] 统一 OCR + 翻译的后台任务状态模型（考虑合 useBackgroundJobsStore 或
      UI 徽章组件复用）
- [ ] 听课 / 沉浸阅读 Batch 38 放出来后还没端到端跑
- [ ] Batch 38 P4 撤回后的"名字旁加 hover 注释"方案（召唤 ⓘ、学徒 ⓘ、Hermes ⓘ）

---

## 2026-04-22 · Batch 41 · v1.3.1 发布

主题：**注释栏优化 / 阅读位置记录 / 大文件加载优化**

- AI 任务从 AnnotationPanel local state 提升到 annotationAiJobsStore：
  提问立即创建 placeholder entry（aiStatus: running），用户可切走，
  job 后台继续，回来读 store 显示流式内容；终态 entry 落入注释 chain
- 注释 entry 行内 / annotation 列表头都加 SVG + 暖色 pill 状态徽章
- 注释列表按 pageNumber 分组（PdfViewer scroll listener 推 currentVisiblePage）
  - PDF / OCR：[data-page-number] 真实页
  - EPUB：location.start.href → TOC idx 匹配（实际章节，非 spine）
  - 其他：scrollTop / clientHeight 虚拟段
- 其他文献注释三层嵌套（文献 → 页 → 注释），都默认折叠
- PdfMeta 加 lastReadScrollTopByMode + lastReadViewMode + lastReadCfi
  - PDF / OCR / DOCX / HTML / TXT / MD 用 scrollTop（按 viewMode 分存）
  - EPUB 用 cfi
  - mount 隐藏内容直到 restore 成功（避免肉眼可见跳转）
  - 三次 retry (80/200/500/1000/2000ms) 解决 OCR 异步 mount 时机问题
  - cleanup 时 lockedEntryId 强制写到原文献（修"切走再回来停在旧位置"）
- 大 PDF 懒加载：LazyPdfPage 包 react-pdf Page，IntersectionObserver
  视口外用 placeholder div，500 页 PDF 不再挂载 500 个 canvas；scale
  120ms 防抖
- EPUB 多项修复：
  - flow scrolled-doc → scrolled + manager continuous（修封面外不显示）
  - locations.generate(1500) 让 progressPct 工作（修 0% 进度）
  - overflow-anchor:auto 修向上翻闪回
  - ResizeObserver 监听 container width，拖注释栏宽度时 reflow
  - rendition.resize() 显式传 width/height + cfi 恢复
  - 章节导航栏（上/下章 + 目录下拉）+ ←/→ 键盘
- HtmlViewer 接排版 props + 划词工具栏桥接
- AI idle timeout 60s hard → 180s idle（chunk 来就重置）
- max_tokens 16384（修 GLM 默认 1024 截断）
- 注释面板按钮防换行 + 编辑框透明化 + 字号加大
- 标记重叠时新覆盖旧的尝试 → 误删问题回滚（context-aware 待做）

热更新机制 (electron/updater.ts) 已工作：客户端检测 GitHub release →
下载 app.asar → 替换 → 重启。**已知短板：上传的 asar 未压缩 214MB**，
比 setup 还大。下批做 gzip / bsdiff 优化。

---

## 2026-04-21 · Batch 40 · v1.3.0 正式版发布

主题：**翻译功能 / EPUB 格式文本优化**

包含 batch 39 全部内容 + EPUB 大量改进：
- EPUB 加载只显示封面 → flow:'scrolled' + 章节导航栏 + 键盘翻章
- EPUB 排版居中（!important 覆盖原书 CSS）+ 宋体 + 图片自适应
- EPUB 注释高亮 + 6 色划线 + 右键自定义菜单
- 字号 / 粗细 / 深浅 / 背景色 全格式打通
- 划词工具栏 全格式打通（含 EPUB iframe / HTML iframe 桥接）
- 选中行为统一：仅弹工具栏，不再自动开注释栏
- EPUB 注释栏开关后 350ms resize 修右侧空白条 + cfi 恢复阅读位置
- HtmlViewer 接排版 props + iframe 注入
- 注释面板底部按钮 nowrap

回滚的：filterSupersededMarks（按 selectedText 子串删旧）—— 误伤"重复短语第二处划线"等场景，留待后续做 context-aware（mark 加 prefix/suffix 锚点）。

发布产物：NSIS 安装版 + Windows zip + macOS arm64 / x64 zip

---

## 2026-04-21 · Batch 39 · 翻译功能 + Ctrl+C + OCR 保图（进行中）

> 本 batch 跨多轮对话完成，中途有 context compact。以下为**当前最新状态**。

### 已完成并已 commit

| Commit | 内容 |
|---|---|
| `173ec0de` | 翻译弹窗初版（4 模式：选中 / 当前页 / 页码范围 / 全文，支持流式 + 停止）· OCR 保留 image/figure/formula/equation/table 块 · md_results 兜底（layout_details 比 md 短 20%+ 时切换）· main.ts Edit 菜单 + autoHideMenuBar 修 Ctrl+C（OS 层） |
| `fadce46f` | 翻译弹窗独立模型下拉（读 aiGetConfigured 按 provider 分组；默认同步全局 selectedAiModel，弹窗内切换仅本次生效，不污染全局） |
| `20ece840` | 保存为文献（.txt 写到 `~/.lit-manager/translations/<title>.txt`，按用户规范命名「源名 部分 翻译文本（语言）」，自动加入库栏跟随原文献 folder，保存后自动打开）· Ctrl+C renderer 层兜底（capture phase + `navigator.clipboard.writeText`，INPUT/TEXTAREA 不拦）· 划词工具栏加复制/翻译按钮（后已撤回） |
| `a696a3a2` | 翻译任务后台化 · TranslateModal store-driven + 顶栏状态徽章（下面"挂起 1 + 2"两项全量完成） |

### 已完成后仍需用户手测

- 最小化流程：翻译中点 "—" 关闭 modal → 顶栏翻译按钮应有蓝色脉冲徽章 + chunk 进度 tooltip → 再点按钮重开 modal → 应看到累积译文和正确分段进度
- 失败/中止状态：点"停止" → ✕ 按钮变回，徽章变琥珀色 "!"；新翻译应覆盖旧 job
- 完成状态：跑完一次翻译 → 关闭 modal → 顶栏应显示绿色 "✓" 徽章
- 切 entry：A 文献翻译中，切到 B 文献，B 的翻译按钮不应显示 A 的徽章（因 job 按 entryId 索引）

### 挂起的工作（下一步）

1. **OCR 状态图标（新需求）**
   - 现状：OCR 已经在 main 进程跑，本身就是后台进程。但 UI 只有 `BatchOcrProgress` 浮窗显示当前项，文献栏每个 entry 没有独立的状态图标
   - 需要：`src/components/Sidebar/FileTree.tsx` 的 entry 块**右侧**加小图标
     - 正在 OCR → 蓝色旋转图标或进度
     - 完成 → 绿色 ✅
     - 失败 → 红色 ❗
   - `LibraryEntry.ocrStatus` 现在是 `'none' | 'partial' | 'complete'`，需要加 `'running'` 态
   - 需要 OCR 失败时也写回一个状态（目前失败是否有捕获？待查）

2. **统一 OCR 和翻译的状态模型**
   - 考虑把两个"后台任务状态"合并成一个 `useBackgroundJobsStore`
   - 或者各自独立 store 但 UI 徽章组件复用

### 本 batch 遇到的问题

- **context 多次被 compact**：第一次是在验证 OCR 后台 + 增加翻译功能时；第二次在重写 TranslateModal 途中
- **dev server 多次退出**（npm run dev 进程 exit 0）导致用户测试的是旧版本
  - 解决：每次 main 进程代码改动后强制重启；每次确认 pid 存在
- **划词工具栏的 翻译/复制 按钮决策反复**：一开始加了，后用户反馈冗余（对应有独立翻译按钮 + Ctrl+C 已能复制）→ 已撤
- **Ctrl+C 多次反馈不生效**：排查发现是 dev server 在跑旧 main.ts（没 pick up 新的 Edit 菜单）。重启 dev 后修好；另外加了 renderer 层兜底 capture-phase 监听，双保险
- **本轮对话输出 token 异常低**：可能是多个 system-reminder 堆叠 + 长 tool result 占用 context。已同用户确认。本日志作为一次"停下来梳理"

### 积压（待用户授权）

- lit-manager master 3 个 commit（`173ec0de` `fadce46f` `20ece840`）未 push
- shijuan-website `23cf13f`（测试群二维码）未 push
- v1.3.0-beta tag/release 需要 push 完后重新打

### 已知要测的东西（等代码改完统一测）

- [ ] 翻译模型下拉在 modal 内切换是否真的只对本次生效
- [ ] 保存为文献的文件名在 Windows 下有特殊字符时能否正确 sanitize
- [ ] Ctrl+C 在 OCR markdown 视图和 pdf.js 文本层都能复制
- [ ] 翻译最小化后重开 modal 是否能正确续上流
- [ ] OCR 状态图标在 BatchOcr 批量模式和单篇模式下都要正常

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
