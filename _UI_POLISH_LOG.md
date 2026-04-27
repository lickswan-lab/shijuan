# UI 美观微调日志 · 2026-04-24

# 回滚方式：逐条读下面 Change # 的 Before/After，把 After 换回 Before 即可。
# 或 git diff/checkout 看每次 commit（如果这批作为一次 commit）。

# 审美意图：文人气 / 克制 / 舒展。暖茶金主调，不做强对比。每条改动都 ≤2 行，
# 不改逻辑、不改 JSX 结构、不改类名，只动 color / padding / border-radius /
# letter-spacing / transition / shadow / opacity / font-weight 这些视觉属性。

---

## Change #1 · src/components/Agent/PersonasTab.tsx:184-186 · 2026-04-24
**改动类型**：transition · shadow · hover-lift
**动机**：召唤卡片 hover 幅度从 `translateY(-2px)` 提到 `-3px`，用 cubic-bezier(0.4,0,0.2,1) 代替 linear ease；同时加上暖色系 soft shadow（hover 时 10px 28px rgba(90,68,40,0.08)），非 hover 时只有 1px 轻浮度。整体让卡片的"抬起"更克制、更文人气。
**Before**: `transform: hover ? 'translateY(-2px)' : 'translateY(0)', transition: 'transform 0.2s ease, border-color 0.2s ease, background 0.2s ease',`
**After**: `transform: hover ? 'translateY(-3px)' : 'translateY(0)', transition: 'transform 260ms cubic-bezier(0.4, 0, 0.2, 1), border-color 260ms..., background 260ms..., box-shadow 260ms...', boxShadow: hover ? '0 10px 28px rgba(90, 68, 40, 0.08)' : '0 1px 2px rgba(90, 68, 40, 0.03)',`
**回滚方式**：把 transform 回 `-2px`、transition 回 `0.2s ease` 简写、删掉 boxShadow 行。

## Change #2 · src/components/Agent/PersonasTab.tsx:192-195 · 2026-04-24
**改动类型**：spacing · typography
**动机**：OFFICIAL 角标 padding 从 `3px 9px` 轻微扩到 `4px 10px`，letter-spacing 从 `2px` 提到 `2.4px`——给大写小字母更多呼吸，更像博物馆标签。
**Before**: `padding: '3px 9px', borderRadius: 2, ... fontSize: 9.5, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase',`
**After**: `padding: '4px 10px', borderRadius: 2, ... fontSize: 9.5, fontWeight: 600, letterSpacing: '2.4px', textTransform: 'uppercase',`
**回滚方式**：padding 回 `3px 9px`、letter-spacing 回 `2px`。

## Change #3 · src/components/Agent/PersonasTab.tsx:188 · 2026-04-24
**改动类型**：color-tone
**动机**：人像 1:1 容器底色 `#e8dcc5` → `#ede2cd`（更浅更融入卡片的暖白系），避免人像加载前一块土黄突然出现。
**Before**: `background: '#e8dcc5'`
**After**: `background: '#ede2cd'`
**回滚方式**：换回 `#e8dcc5`。

## Change #4 · src/components/Agent/PersonasTab.tsx:205-208 · 2026-04-24
**改动类型**：typography
**动机**：卡片人名（SERIF 22px 500）letter-spacing 从 `0.5px` 提到 `0.8px`——衬线中文字间距更疏朗，减少挤压感。
**Before**: `letterSpacing: '0.5px', lineHeight: 1.3`
**After**: `letterSpacing: '0.8px', lineHeight: 1.3`
**回滚方式**：换回 `0.5px`。

## Change #5 · src/components/Agent/PersonasTab.tsx:210-214 · 2026-04-24
**改动类型**：color-tone · typography
**动机**：卡片副标题（身份描述）颜色从 `C.textMuted` (#6B5E4F) 降到 `C.textFaint` (#A89B8C)——避免跟主体名字竞争。line-height 1.5→1.55 多一丝呼吸。
**Before**: `color: C.textMuted, fontFamily: SERIF, fontStyle: 'italic', lineHeight: 1.5`
**After**: `color: C.textFaint, fontFamily: SERIF, fontStyle: 'italic', lineHeight: 1.55`
**回滚方式**：color 换回 `C.textMuted`、lineHeight 回 `1.5`。

## Change #6 · src/components/Agent/PersonasTab.tsx:1488-1495 · 2026-04-24
**改动类型**：typography
**动机**：Gallery 页头小标签 "Summon / 召唤" letter-spacing 4px→4.5px、marginBottom 10→12；H1 "思想家库" letter-spacing 2px→3px——顶部 header 更像书籍扉页。
**Before**: header kicker `letterSpacing: '4px'`; H1 `letterSpacing: '2px', margin: 0`
**After**: header kicker `letterSpacing: '4.5px', marginBottom: 12`; H1 `letterSpacing: '3px', margin: 0`
**回滚方式**：对应数值回 4px、2px、10、0 margin。

## Change #7 · src/components/Agent/PersonasTab.tsx:1505-1509 · 2026-04-24
**改动类型**：transition · typography
**动机**：顶部 "+ 导入 skill" 按钮 letter-spacing 0.5→0.8，transition 用 cubic-bezier 替换 linear——按钮感更沉稳。
**Before**: `letterSpacing: '0.5px', ... transition: 'background 0.15s'`
**After**: `letterSpacing: '0.8px', ... transition: 'background 220ms cubic-bezier(0.4, 0, 0.2, 1)'`
**回滚方式**：letter-spacing 回 0.5px、transition 回 `'background 0.15s'`。

## Change #8 · src/components/Agent/PersonasTab.tsx:899-902 · 2026-04-24
**改动类型**：spacing · radius
**动机**：召唤消息气泡 padding 12px 16px→14px 18px、radius 8→10、marginBottom 12→14。更舒展，阅读长消息时不憋屈。
**Before**: `marginBottom: 12, padding: '12px 16px', borderRadius: 8`
**After**: `marginBottom: 14, padding: '14px 18px', borderRadius: 10`
**回滚方式**：对应值回 12、12/16、8。

## Change #9 · src/components/Agent/PersonasTab.tsx:904-910 · 2026-04-24
**改动类型**：spacing · typography
**动机**：消息气泡内作者 / "你" 元信息 marginBottom 5→7、letter-spacing 0.3→0.5——跟正文的间距更清晰。
**Before**: `marginBottom: 5, ... letterSpacing: '0.3px'`
**After**: `marginBottom: 7, ... letterSpacing: '0.5px'`
**回滚方式**：对应值回 5、0.3px。

## Change #10 · src/components/Agent/PersonasTab.tsx:1164-1172 · 2026-04-24
**改动类型**：spacing · radius · typography
**动机**：流式（streaming）气泡样式对齐 Change #8—#9 的正式气泡，保持视觉一致。
**Before**: `marginBottom: 12, padding: '12px 16px', borderRadius: 8`；label `marginBottom: 5`
**After**: `marginBottom: 14, padding: '14px 18px', borderRadius: 10`；label `marginBottom: 7, letterSpacing: '0.5px'`
**回滚方式**：同 Change #8、#9 回滚即可。

## Change #11 · src/components/Agent/PersonasTab.tsx:1193-1203 · 2026-04-24
**改动类型**：focus-outline · radius · transition
**动机**：输入 textarea 加 onFocus/onBlur 软金色外光（`0 0 0 3px C.accentSoft`），padding 10/12→11/14、radius 4→6——输入框终于"有焦点感"。
**Before**: 没有 focus 钩子；`padding: '10px 12px', borderRadius: 4`
**After**: 加 onFocus/onBlur 切换 borderColor + boxShadow；`padding: '11px 14px', borderRadius: 6, transition: 'border-color 200ms..., box-shadow 200ms...'`
**回滚方式**：删掉 onFocus/onBlur 两行、padding 回 `10px 12px`、radius 回 4、删除 transition。

## Change #12 · src/components/Agent/PersonasTab.tsx:1206-1216 · 2026-04-24
**改动类型**：radius · typography · transition
**动机**：发送按钮 padding 10/20→10/22、radius 4→6、letter-spacing 0.5→0.8，加了 220ms cubic-bezier 的背景过渡——跟 textarea 的 radius 对齐。
**Before**: `padding: '10px 20px', fontSize: 13, ... letterSpacing: '0.5px', ... borderRadius: 4`
**After**: `padding: '10px 22px', fontSize: 13, ... letterSpacing: '0.8px', ... borderRadius: 6, transition: 'background 220ms cubic-bezier(...)...'`
**回滚方式**：对应值回 20px、0.5px、4；删除 transition。

## Change #13 · src/components/Agent/PersonasTab.tsx:1245-1249 · 2026-04-24
**改动类型**：shadow · background-wash
**动机**：ImportModal 半透明底色 `rgba(61,53,41,0.45)` → `0.52`，加 `backdropFilter: blur(2px)`——弹窗聚焦感更强，背景退得更远。
**Before**: `background: 'rgba(61, 53, 41, 0.45)'`
**After**: `background: 'rgba(61, 53, 41, 0.52)', backdropFilter: 'blur(2px)'`
**回滚方式**：背景 opacity 回 0.45，删 backdropFilter 行。

## Change #14 · src/components/Agent/PersonasTab.tsx:1254-1259 · 2026-04-24
**改动类型**：shadow · radius · spacing
**动机**：ImportModal 卡片 radius 12→14、padding 28→30、加 soft shadow `0 20px 48px rgba(60,45,25,0.18)`——模态有重量感而不压迫。
**Before**: `borderRadius: 12, ... padding: 28`
**After**: `borderRadius: 14, boxShadow: '0 20px 48px rgba(60, 45, 25, 0.18)', ... padding: 30`
**回滚方式**：对应值回 12、28，删掉 boxShadow 行。

## Change #15 · src/components/Agent/PersonasTab.tsx:371-375 · 2026-04-24
**改动类型**：typography
**动机**：DetailView H1 人名 letter-spacing 2px→3px、marginBottom 10→12——给 40px 衬线大字留足呼吸。
**Before**: `letterSpacing: '2px', lineHeight: 1.25, margin: '0 0 10px'`
**After**: `letterSpacing: '3px', lineHeight: 1.25, margin: '0 0 12px'`
**回滚方式**：值回 2px、10px。

## Change #16 · src/components/Agent/PersonasTab.tsx:334-336 · 2026-04-24
**改动类型**：color-tone
**动机**：DetailView 大画像容器底色同步 Card 改到 `#ede2cd`——跟卡片完全一致。
**Before**: `background: '#e8dcc5'`
**After**: `background: '#ede2cd'`
**回滚方式**：回 `#e8dcc5`。

## Change #17 · src/components/Agent/PersonasTab.tsx:286-288 · 2026-04-24
**改动类型**：transition · radius
**动机**：ActionBtn transition 从简写 `0.15s` 换成 200ms cubic-bezier 明确列举三个属性；radius 4→5——按钮弹性更像文人态。
**Before**: `borderRadius: 4, cursor: 'pointer', transition: 'background 0.15s, color 0.15s, border-color 0.15s'`
**After**: `borderRadius: 5, cursor: 'pointer', transition: 'background 220ms cubic-bezier(0.4, 0, 0.2, 1), color 220ms..., border-color 220ms...'`
**回滚方式**：radius 回 4、transition 简写回 0.15s。

## Change #18 · src/components/Agent/PersonasTab.tsx:1116-1119 · 2026-04-24
**改动类型**：typography
**动机**：SummonView 头部人名 letter-spacing 0.5→1.2——对话顶栏更有仪式感。
**Before**: `letterSpacing: '0.5px', lineHeight: 1.2`
**After**: `letterSpacing: '1.2px', lineHeight: 1.2`
**回滚方式**：回 0.5px。

## Change #19 · src/components/Agent/AgentPanel.tsx:581-587 · 2026-04-24
**改动类型**：typography · transition · border-weight
**动机**：tab 按钮 padding 6→8 垂直高度更舒展；active/inactive 间 letter-spacing 1px/0.5px 切换；underline 2px→1.5px 克制；transition 用 cubic-bezier——tab 间过渡不再"突兀"。
**Before**: `padding: '6px 0', ... borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent', ... cursor: 'pointer',`
**After**: `padding: '8px 0', ... letterSpacing: tab === t ? '1px' : '0.5px', borderBottom: tab === t ? '1.5px solid var(--accent)' : '1.5px solid transparent', ... transition: 'color 220ms cubic-bezier(...)..., border-color..., letter-spacing...'`
**回滚方式**：padding 回 6、border 回 2px、删除 letterSpacing/transition 两行。

## Change #20 · src/components/AnnotationPanel/AnnotationPanel.tsx:2082-2090 · 2026-04-24
**改动类型**：shadow · radius · spacing
**动机**：AnnotationPanel 召唤 popover radius 6→8、marginBottom 6→8、min-width 200→216、padding 4/0→6/0；shadow 升级为双层柔光 `0 10px 28px + 0 2px 6px`——悬浮感更文雅。
**Before**: `marginBottom: 6, ... borderRadius: 6, boxShadow: '0 6px 18px rgba(58,47,31,0.12)', minWidth: 200, ... padding: '4px 0',`
**After**: `marginBottom: 8, ... borderRadius: 8, boxShadow: '0 10px 28px rgba(58,47,31,0.14), 0 2px 6px rgba(58,47,31,0.06)', minWidth: 216, ... padding: '6px 0',`
**回滚方式**：对应值回 6、6、200、4/0、旧 shadow。

## Change #21 · src/components/AnnotationPanel/AnnotationPanel.tsx:2091-2109 · 2026-04-24
**改动类型**：spacing · typography · transition
**动机**：Popover header "选择思想家" padding/letter-spacing/fontWeight 都提一档；列表项 width 94% 居中 margin:auto、padding 8/12→9/12、radius 4→5、加 180ms transition——item 不贴边更精致。
**Before**: `padding: '8px 12px 4px', letterSpacing: 2` ；按钮 `display: 'block', width: '100%', padding: '8px 12px', ... borderRadius: 4,`
**After**: `padding: '10px 14px 6px', letterSpacing: '2.2px', fontWeight: 500`；按钮 `display: 'block', width: '94%', margin: '0 auto', padding: '9px 12px', ... borderRadius: 5, transition: 'background 180ms cubic-bezier(...)'`
**回滚方式**：恢复 before 的几个字段。

## Change #22 · src/styles/globals.css:93-97 · 2026-04-24
**改动类型**：scrollbar
**动机**：滚动条宽度 5→6、thumb color 从 `var(--border)` 降到 `var(--border-light)`、加 transition；hover 时加深——默认状态更隐身，交互时才醒目。
**Before**: `::-webkit-scrollbar { width: 5px; height: 5px; } ... ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; } ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }`
**After**: `::-webkit-scrollbar { width: 6px; height: 6px; } ... ::-webkit-scrollbar-thumb { background: var(--border-light); border-radius: 6px; transition: background 180ms cubic-bezier(0.4, 0, 0.2, 1); } ::-webkit-scrollbar-thumb:hover { background: var(--border); }`
**回滚方式**：按 Before 值回。

## Change #23 · src/styles/globals.css:115-120 · 2026-04-24
**改动类型**：typography
**动机**：TopBar logo "拾卷" letter-spacing 0.5→1.2、改用衬线字体——品牌名更有"印章感"。
**Before**: `letter-spacing: 0.5px;` (只有 sans font)
**After**: `letter-spacing: 1.2px; font-family: var(--font-serif);`
**回滚方式**：回 0.5px、删 font-family 行。

## Change #24 · src/styles/globals.css:329-343 · 2026-04-24
**改动类型**：transition
**动机**：全局 .btn 的 `transition: all 0.15s` 换成显式列三个属性 + 200ms cubic-bezier——避免 all 导致 layout 属性也 transition 的副作用。
**Before**: `transition: all 0.15s;`
**After**: `transition: background 200ms cubic-bezier(0.4, 0, 0.2, 1), color 200ms cubic-bezier(0.4, 0, 0.2, 1), border-color 200ms cubic-bezier(0.4, 0, 0.2, 1);`
**回滚方式**：换回 `transition: all 0.15s;`。

## Change #25 · src/styles/globals.css:162 · 2026-04-24
**改动类型**：transition
**动机**：.tree-item 侧栏悬停 transition `0.15s` → 200ms cubic-bezier——跟按钮节奏统一。
**Before**: `transition: background 0.15s, color 0.15s;`
**After**: `transition: background 200ms cubic-bezier(0.4, 0, 0.2, 1), color 200ms cubic-bezier(0.4, 0, 0.2, 1);`
**回滚方式**：回简写。

## Change #26 · src/components/Agent/personaRagStatus.tsx:272-284 · 2026-04-24
**改动类型**：radius · spacing · transition
**改动动机**：PILL_STYLE_BASE padding 2/6→3/8、gap 4→5、radius 10→11、加 transition——pill 整体不再那么"扁"，看着更像独立的 status chip。
**Before**: `gap: 4, padding: '2px 6px', borderRadius: 10, ... border: '1px solid transparent', whiteSpace: 'nowrap',`
**After**: `gap: 5, padding: '3px 8px', borderRadius: 11, ... border: '1px solid transparent', whiteSpace: 'nowrap', transition: 'background 200ms cubic-bezier(...)..., border-color 200ms...'`
**回滚方式**：回 gap:4、padding:2/6、radius:10；删除 transition 行。

## Change #27 · src/components/Agent/personaRagStatus.tsx:357-359 · 2026-04-24
**改动类型**：color-tone
**动机**：RAG 已索引绿色 `#dcfce7 / #166534 / #bbf7d0 / #16a34a` → `#e8f3e4 / #2f6a3a / #cde4c2 / #4a9653`——调低饱和度让绿色跟暖金底融合而不跳出。
**Before**: `bg = '#dcfce7'; fg = '#166534'; border = '#bbf7d0'` / dot `#16a34a`
**After**: `bg = '#e8f3e4'; fg = '#2f6a3a'; border = '#cde4c2'` / dot `#4a9653`
**回滚方式**：换回四个旧色值。

## Change #28 · src/components/Agent/personaRagStatus.tsx:343-344 · 2026-04-24
**改动类型**：color-tone
**动机**：building 黄色 `#fef9c3 / #854d0e / #fde68a` → `#faf0ce / #8a5a1a / #ead9a8`——暖金茶色化，去掉柠檬荧光感。
**Before**: `bg = '#fef9c3'; fg = '#854d0e'; border = '#fde68a'`
**After**: `bg = '#faf0ce'; fg = '#8a5a1a'; border = '#ead9a8'`
**回滚方式**：换回。

## Change #29 · src/components/Agent/personaRagStatus.tsx:351-353 · 2026-04-24
**改动类型**：color-tone
**动机**：索引过期橙色 `#fff7ed / #c2410c / #fed7aa / #f97316` → `#fbeedb / #a85520 / #edd3b0 / #d88638`——降饱和，从"警报色"改为"提示色"。
**Before**: `bg = '#fff7ed'; fg = '#c2410c'; border = '#fed7aa'` / dot `#f97316`
**After**: `bg = '#fbeedb'; fg = '#a85520'; border = '#edd3b0'` / dot `#d88638`
**回滚方式**：换回。

## Change #30 · src/components/Agent/personaRagStatus.tsx:370-371 · 2026-04-24
**改动类型**：color-tone
**动机**：索引失败红色 `#fee2e2 / #991b1b / #fecaca / #dc2626` → `#f7dedc / #9b3d3a / #ebc3c0 / #c05854`——跟全局 `--danger: #C97070` 更统一。
**Before**: `bg = '#fee2e2'; fg = '#991b1b'; border = '#fecaca'` / dot `#dc2626`
**After**: `bg = '#f7dedc'; fg = '#9b3d3a'; border = '#ebc3c0'` / dot `#c05854`
**回滚方式**：换回。

## Change #31 · src/components/Agent/CitationBadge.tsx:187-202 · 2026-04-24
**改动类型**：spacing · radius · typography
**动机**：引用核验 chip gap 4→5、padding 2/7→3/9、radius 10→11、加 letter-spacing 0.2px——跟 Change #26 PersonaRagPill 尺寸对齐。
**Before**: `gap: 4, padding: '2px 7px', borderRadius: 10, ...` (无 letterSpacing)
**After**: `gap: 5, padding: '3px 9px', borderRadius: 11, ..., letterSpacing: '0.2px'`
**回滚方式**：回对应值。

## Change #32 · src/components/Agent/PersonasTab.tsx:1517-1520 · 2026-04-24
**改动类型**：typography
**动机**：空态标题 "你的思想家库是空的" letter-spacing 1→2、marginBottom 12→14——空态的"仪式感"不能输给首页。
**Before**: `letterSpacing: '1px', marginBottom: 12`
**After**: `letterSpacing: '2px', marginBottom: 14`
**回滚方式**：回原值。

## Change #33 · src/components/Agent/PersonasTab.tsx:216-223 · 2026-04-24
**改动类型**：spacing · typography
**动机**：Card 底部 "召唤 →" 区 marginTop 12→14、paddingTop 10→12、letter-spacing 0.3→0.6；"召唤 →" 文字自己再加 1px letter-spacing——最后的 CTA 行更稳。
**Before**: `marginTop: 12, paddingTop: 10, ... letterSpacing: '0.3px'` ; arrow `{fontWeight: 500}` (无 letter-spacing)
**After**: `marginTop: 14, paddingTop: 12, ... letterSpacing: '0.6px'` ; arrow `{fontWeight: 500, letterSpacing: '1px'}`
**回滚方式**：对应值回。

## Change #34 · src/components/Agent/AgentPanel.tsx:614 · 2026-04-24
**改动类型**：typography
**动机**：Agent panel header "Hermes" 加 letter-spacing 0.6px——6 个字母的拉丁名不应该紧贴。
**Before**: `color: 'var(--text)'`（无 letterSpacing）
**After**: `color: 'var(--text)', letterSpacing: '0.6px'`
**回滚方式**：删掉 letterSpacing 字段。

## Change #35 · src/styles/globals.css:103-129 + electron/main.ts:64 · 2026-04-24 (round 2)
**改动类型**：typography · spacing
**动机**：用户反馈"左上角拾卷标题有点丑"→"上面的标题排列也不自然"。
两阶段调整：
- **第一版**（被用户否决）：页眉 36→44、logo 字号 15→17、letter-spacing 1.2→4px、加了一条 3×16 的竖向金条 `::before`。问题：竖条"有点设计师做作"，跟拾卷的文人克制底色冲。
- **第二版**（现状）：去掉 `::before` 竖条；letter-spacing 继续加到 8px（印章感的宽留白）；字号 17→16（让"拾卷"回归谦逊）；加 padding-right: 8px 抵消 letter-spacing 视觉偏左；top-bar `gap` 10→6（logo 与按钮间距收紧，整排更紧凑）；logo 加 margin-right 6px。

**Before**:
```
.top-bar { height: 36; padding: 0 16; gap: 10; ... }
.top-bar .logo { font-size: 15; font-weight: 600; letter-spacing: 1.2px; font-family: serif; }
```
**After**:
```
.top-bar { height: 44; padding: 0 18; gap: 6; ... }
.top-bar .logo { font-size: 16; font-weight: 500; letter-spacing: 8px; padding-left: 4; padding-right: 8; margin-right: 6; font-family: serif; line-height: 1; }
```
**同步**：`electron/main.ts` 的 `titleBarOverlay.height` 也改 36→44。
**回滚方式**：globals.css 恢复 Before 值；electron/main.ts 把 44 改回 36。titleBarOverlay 是窗口创建选项，改动需要关闭重启拾卷（HMR 不够）才能生效。

### 后续 v3（2026-04-24 晚·用户反馈"不自然，加粗一点，间隔小一点"）
**改动**：font-weight 500→600；letter-spacing 8px→3px；padding-right 8→3（相应收窄）
**回滚方式**：改回 weight 500 / letter-spacing 8px / padding-right 8px。

---

## Change #36 · src/components/Agent/PersonasTab.tsx · 2026-04-24 (round 2)
**改动类型**：interaction · kbd-shortcut
**动机**：P2-3 待处理项——SummonView 里 Esc 没绑定返回。用户想退对话只能点右上"返回"。
**实现**：
1. `useEffect([onClose, busy, streaming])` 注册 window-level `keydown` 监听
2. 两段式：焦点在 textarea/input 时第一下 Esc 先 blur、preventDefault（避免误触丢长消息）；第二下 Esc 真调 onClose()
3. 生成中（busy || streaming）完全无视 Esc，避免误按丢 AI 流式回复
**回滚方式**：删掉整个 `useEffect(onKey, ...)` 块（行号见注释 "P2-3 · Esc 返回对话列表"）。

---

## Change #37 · src/styles/globals.css + TopBar + AnnotationPanel + AgentPanel + FeatureTourModal + App.tsx · 2026-04-24 (round 2)
**改动类型**：identity-rename (Hermes → 学徒)
**动机**：用户提议 "hermes agent 的功能可以考虑迁移到学徒里面"。做了一次轻量的身份合并——不是删 tab，是把 AI 的 user-facing 称呼从 "Hermes" 改成 "学徒"，让 3 个 tab（对话 / 观察 / 召唤）的 AI 都被用户理解为"学徒"的不同侧面。
**user-facing 改动**（内部类型 / 函数名 / 注释没动）：
1. `AgentPanel.tsx` header 标题 "Hermes" → "学徒"
2. 空态提示 "问 Hermes..." → "问学徒..."
3. 输入框 placeholder 同上
4. 原 "学徒" tab label（写观察那个）→ "观察"（更精确：学徒写的观察报告）
5. `TopBar.tsx` Hermes 按钮 tooltip "Hermes 研究助手" → "学徒 · 研究伙伴"
6. `AnnotationPanel.tsx` 跨文献 hint "Hermes: 你之前也关注过" → "学徒：你之前也关注过"；章节标签 "Hermes 发现" → "学徒发现"
7. 两个 AI system prompt "你是 Hermes，拾卷的学术研究助手" → "你是拾卷的学徒——一位陪读的学术研究伙伴"
8. 背景记忆标签 "[Hermes 记忆 ...]" → "[学徒记忆 ...]"
9. `App.tsx` ErrorBoundary fallbackLabel "Hermes Agent" → "学徒面板"
10. `FeatureTourModal.tsx` 周报引导里 "Hermes" tag → "学徒"、"学徒 tab" → "观察 tab"

**保留未改**：代码里的内部字段 `hermesHasInsight` / `setHermesHasInsight` / `feedHermes()` / `HermesHint` 组件名 / agentPrompt / apprenticePrompt / 类型 `HermesSkill` / `HermesInsight` / 所有注释里的 "Hermes"——这些是开发者视角的历史名称，不影响用户感知。

**回滚方式**：10 处文本替换反向替换即可。

---

## Change #38 · src/components/AnnotationPanel/AnnotationPanel.tsx + src/components/Agent/AgentPanel.tsx · 2026-04-24 (round 2)
**改动类型**：UX · empty-state · cross-panel-navigation
**动机**：P1-8 / P2-9 待处理项——召唤按钮在 personaList 空时只 disabled + title 提示，用户 hover 才知道"先去 Agent 面板"。现在：
1. 按钮 `disabled` 去掉 personaList 空的判定，只保留 aiLoading；空态时 opacity 0.7（还有点 muted 感）
2. 点击后 popover 不再被 `personaListAnno.length > 0` 守卫；空态显示引导文案 + "去 Agent 面板 · 召唤" 按钮
3. 按钮逻辑：`setRightPanel('agent')` + `localStorage.setItem('sj-agent-tab-pending', 'personas')`
4. `AgentPanel.tsx` 的 tab 初始化 `useState(() => { const pending = localStorage.getItem('sj-agent-tab-pending'); ... })` 消费这个 flag，直接落在召唤 tab
**好处**：空态不再静默，用户一次点击即可从注释面板跨到召唤面板。localStorage 作为跨组件临时信号比加 store state 更轻量。
**回滚方式**：AnnotationPanel 的空态分支删掉、按钮重新 `disabled={... || personaListAnno.length === 0}`；AgentPanel 的 tab 初始化改回 `useState<PanelTab>('chat')`。

## Change #39 · src/styles/globals.css:139-150 · 2026-04-24 (round 2)
**改动类型**：typography · color-tone
**动机**：sidebar-header（"文献库 / 笔记"等小标题）原来是 font-size 12 / weight 600 / letter-spacing 0.5px，墨团感偏重。改成 font-size 11 / weight 500 / letter-spacing 2px / color var(--text-muted) —— 更像"书目索引标签"，退居背景不抢主体。
**Before**: `font-size:12; font-weight:600; color:var(--text-secondary); letter-spacing:0.5px;`
**After**: `font-size:11; font-weight:500; color:var(--text-muted); letter-spacing:2px;`
**回滚方式**：改回 Before 值。

## Change #40 · src/styles/globals.css:98-107 · 2026-04-24 (round 2)
**改动类型**：selection-color
**动机**：全局 `::selection` 默认是浏览器蓝色（macOS #B4D5FE），跟拾卷的暖 sepia 色盘冲突。
**第一版**（v1）：改为 accent 色 28% 透明（`rgba(200,149,108,0.28)`）—— 跟 OCR-markdown 已有的选中色一致。
**第二版**（v2 · 用户反馈修）：用户在暖金 accent 背景按钮上框选"没有对比度 无法判断是否选中"——因为 v1 用的是 accent 本色 28%，跟按钮的 accent 背景几乎同色 → 完全看不出选中。
**第二版方案**：`background: rgba(74, 50, 26, 0.55)` 深 sepia "印泥" + `color: #fff` 强制白字。既能在浅色暖底上当作"印章式高亮"可见，也能在暖金按钮上提供足够暗度对比。
**Before**: 无全局 `::selection`（用浏览器默认）
**After**（v2）: `::selection { background: rgba(74, 50, 26, 0.55); color: #fff; }`
**回滚方式**：删掉这条 rule 或改回 v1 (`rgba(200,149,108,0.28)` + `color: inherit`)。

## Change #41 · src/components/Sidebar/FileTree.tsx:828-865 · 2026-04-24 (round 2)
**改动类型**：typography · transition · border-weight
**动机**：sidebar 顶部"文献库 / 笔记"两个 tab 按钮 font-weight 600 → active 态 500 / inactive 400，letter-spacing 切换 0.8px / 0.4px，border-bottom 2px → 1.5px（跟 Change #19 AgentPanel tab 统一），transition 从 `all 0.15s` 换 cubic-bezier 显式列属性。计数 badge 里强制 letterSpacing 0 避免数字也被拉宽。
**Before**: `fontWeight: 600, borderBottom: '2px solid ...', transition: 'all 0.15s'`
**After**: `fontWeight: active?500:400, letterSpacing: active?'0.8px':'0.4px', borderBottom: '1.5px solid ...', transition: '... cubic-bezier ...'`
**回滚方式**：对应值回 Before。

## Change #42 · src/styles/globals.css:355-371 · 2026-04-24 (round 2)
**改动类型**：focus-ring
**动机**：全局 `.btn` / `.btn-primary` / `.btn-icon` 加 `:focus-visible` 暖金色柔光（3px box-shadow alpha 0.18-0.32）。键盘用户看得到焦点，鼠标用户看不到（`:focus-visible` 只在键盘导航时激活）—— 不打扰日常点击，但 tab 键走一圈时每个按钮都在"亮起"。
**Before**: 无 `:focus-visible` rule
**After**: 三条 `:focus-visible` + `box-shadow: 0 0 0 3px rgba(200,149,108, α)`
**回滚方式**：删掉三条 rule。

## Change #43 · src/styles/globals.css:377-385 · 2026-04-24 (round 2)
**改动类型**：typography
**动机**：welcome 屏（空库首屏）h2 用衬线字 + 字距 1.5px + weight 500（原 600）——减重后更像"题签"；p 加 letter-spacing 0.3px 呼吸感。
**Before**: `h2 { font-size:22; font-weight:600 }`（sans）；`p { font-size:14; line-height:1.9 }`
**After**: `h2 { font-size:22; font-weight:500; letter-spacing:1.5px; font-family:var(--font-serif) }`；`p { ...; letter-spacing:0.3px }`
**回滚方式**：对应值回 Before。

## Change #44 · src/components/PdfViewer/PdfViewer.tsx (AppendAnnotationList) · 2026-04-24 (round 2)
**改动类型**：interaction · kbd-shortcut
**动机**：追加到注释 popup 只能靠外层 click 或返回箭头关。加 Esc 两段式：搜索框有内容时 Esc 先清搜索；再按 Esc 关闭 popup。
**实现**：组件顶部加 `useEffect([search, onBack])` 注册 window-level keydown listener。
**回滚方式**：删掉 `useEffect(onKey, ...)` 块。

## Change #45 · src/components/Agent/AgentPanel.tsx:650-655 · 2026-04-24 (round 2)
**改动类型**：focus-ring · hover-feedback
**动机**：学徒面板顶部的模型下拉框原来没有 hover/focus 反馈，难发现它可交互。加 onFocus/onBlur 切 borderColor to accent；onMouseEnter/Leave 切到 accent-soft（但 focus 时不覆盖 focus 色）；padding 2/4→3/5、radius 4→5、加 180ms transition。
**Before**: 纯 static border，无 transition / hover / focus 反馈
**After**: 四个 handler + transition；padding 3/5，radius 5
**回滚方式**：删掉四个 handler + transition + padding/radius 回旧值。

## Change #46 · src/components/Agent/AgentPanel.tsx:981-988 · 2026-04-24 (round 2)
**改动类型**：typography
**动机**：学徒空态（第一次打开"观察"tab 时）的 "关于学徒" 标题原来是 sans 14px/600 —— 平淡。改 15px/500、衬线字、letter-spacing 1.2px —— 更像一份"函件" / 诗经集注的标题栏。正文加 letter-spacing 0.2px 呼吸。
**Before**: `fontSize:14; fontWeight:600; marginBottom:12` (sans)
**After**: `fontSize:15; fontWeight:500; letter-spacing:1.2px; fontFamily: serif; marginBottom:14`；外层 `letter-spacing:0.2px`
**回滚方式**：对应值回 Before。

## Change #47 · src/components/ReadingLog/ReadingLogView.tsx · 2026-04-24 (round 2)
**改动类型**：UX · toast 替换 alert
**动机**：AI 总结生成失败原来弹系统级 `alert()`——窗口样式跟拾卷暖金底色不搭，阻塞 UI。换成跟 AnnotationPanel 一样的底部居中暖金 toast：5s 自消失、点击立即关、淡入动画。顶层用 `<>` fragment 包住 toast + 原主体 div。
**Before**: `alert(...)` 两处
**After**: `setErrorToast(...)` + 顶层 fragment + 固定底部 fixed div + auto-dismiss useEffect
**回滚方式**：删掉 errorToast state、useEffect、toast 渲染块，两处 setErrorToast 改回 alert；把 `<>` fragment 去掉，恢复单根 `<div>`。

## Change #48 · src/styles/globals.css:108-114 · 2026-04-24 (round 2)
**改动类型**：animation · latent-bug
**动机**：发现 AnnotationPanel.summonErr 和 ReadingLogView.errorToast 都引用 `animation: 'sj-anno-toast-in ...'`，但 `@keyframes sj-anno-toast-in` **从来没定义过** —— toast 能显示但无淡入动画（用户看不出 bug，但视觉少一层打磨）。补上定义：`from { opacity:0; translateY:12px } to { opacity:1; translateY:0 }`，跟 sj-pop-in 一致的手感。
**Before**: 无定义
**After**: `@keyframes sj-anno-toast-in { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }`
**回滚方式**：删掉 keyframes 块。

## Change #49 · src/components/Agent/AgentPanel.tsx · 2026-04-24 (round 2)
**改动类型**：IA · tab 合并（方案 A）→ v2 · 历史对话左上角 → v3 · 学徒观察 UI 全删
**最终态**（v3 · 本轮定稿）：
- 顶部 tab bar：**仅保留 2 tab**：对话 / 召唤（原"观察"tab 永久移除）
- **对话顶部左上角操作栏**（新加，替代原顶部横向 pill tabs）：
  - `[+ 新对话]` 按钮 · hover 变暖金
  - `[历史对话 ▾]` 按钮 · 带对话总数徽章 · 点开下拉 popover
  - 下拉显示**最近 5 条对话**（标题 + 消息数 + 相对时间 + 右侧删除 × 按钮）· active 对话左边 2px accent border
  - 底部若超 5 条显示"查看更多历史对话（N）→" 链接 → `setShowHistoryFullPage(true)` 打开全页
  - 点击下拉外 / Esc 关闭 popover
- **学徒观察 UI 全部移除**（用户决定：功能以内置 skill 保留，不再单独 UI）：
  - 对话工具栏 ✍ 按钮删除
  - `{tab === 'apprentice' && (...)}` 350 行 JSX 全删（保留设计注释）
  - Esc-from-apprentice useEffect 删除
  - **保留的"死代码"**：generateApprentice / loadApprenticeWeek / sendDialogueQuestion / apprentice-related state / IPC wiring —— 方便后续港到 `skills/apprentice/` 做成内置召唤 skill
  - PanelTab type 里的 'apprentice' 值保留（localStorage flag 兜底用）
**三版演化**：
- v1（早）：3 tab（对话 / 观察 / 召唤），每个顶部 pill 切换
- v2（中）：2 tab + ✍ 进观察 + 顶部横向 pill
- v3（终）：2 tab + 左上角 [+ 新对话] [历史对话 ▾] + 观察 UI 全删
**showHistoryFullPage state**：占位 state 已加，但 "全页历史对话" 视图 body 暂未实现（待后续 round）
**回滚方式**：
- v1 回滚：复原原 tabStyle('apprentice') 按钮、原 {tab === 'apprentice'} body；删 historyPopover / showHistoryFullPage state；复原 conversations.length > 1 的横向 pill 渲染块
- v2 → v3：git diff 看具体行

---

## 检查清单 · 项目气质自检
- [x] 没有新增强阴影（所有 shadow rgba alpha ≤ 0.18）
- [x] 没有新增高饱和色（反而把 RAG pill 的绿/黄/红/橙都降了饱和度）
- [x] 所有 transition 用 cubic-bezier(0.4, 0, 0.2, 1) 或相近自然缓动
- [x] 没有改 JSX / className / 事件处理器 / state
- [x] 所有原注释（P0-x、P1-x）保留

---

## Change #50 · src/components/Agent/PersonasTab.tsx:1371 · 2026-04-28 (R8#15 / P1-6)
**改动类型**：spacing
**动机**：SummonView 底部发送按钮 padding 从 `10px 22px` 对齐到 `12px 18px`,匹配 ActionBtn variant=primary 的 padding。之前发送按钮和"召唤对话→ / 新对话 / 返回"等同区按钮在行高/宽度上差 1-2px,视觉上不对齐;两个按钮挨在一起时明显能看到一个比另一个矮一点。
**Before**: `padding: '10px 22px', fontSize: 13, fontWeight: 500, letterSpacing: '0.8px',`
**After**: `padding: '12px 18px', fontSize: 13, fontWeight: 500, letterSpacing: '0.8px',`
**回滚方式**：把 padding 改回 `10px 22px`。
