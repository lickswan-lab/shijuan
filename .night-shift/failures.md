# 夜间值守失败记录

**分支**: `night-shift-2026-04-28`

## 状态: 零失败

17 个编号 round + 1 个文档 commit,全程零回归。

每一轮都跑了:
- `npx tsc --noEmit` → EXIT=0
- `npx electron-vite build` → 成功(31~36 秒)

无任何一轮触发 git reset --hard 回退路径。

## 协议触发情况

夜间值守协议规定:验证任一项失败 → `git reset --hard HEAD` → 写失败原因到此文件 → 本轮结束。

本次值守期间从未触发该路径,所以本文件是一份"零失败"声明。

## 遇到的小问题(不算失败,自我修正)

- **Round 8 #1 regex 替换**:Edit 工具因为 char class 里 `,，` 是混合半/全角逗号,exact match 失败两次。改用 Python 脚本 + 二次 Edit 完成。完成后 tsc + build 全绿。
- **Round 8 #4 后续大型 commit 显示行数夸大**:`3 files changed, 1786 insertions(+), 3190 deletions(-)` 这种巨大 diff 是 git 的 EOL 自动转换在新 commit 里把整个文件重写一遍(LF ↔ CRLF)。实际逻辑改动小,build 验证通过没影响。

## 未尝试 / 未触发的领域

下面这些目录到现在还没扫,本批不触碰但留作下批:

- `src/components/Lecture/`(已经是 R2#α 修过 stream leak,本批未深入)
- `electron/ipc/aiApi.ts`(1885 行的 streaming / DSML / web search 主路径,未审计 callWithManualSearchLoop / parseSSEStream / callClaudeStream / fetchUrlAsText 这些核心函数)
- `electron/ipc/personas.ts`(1657 行,只扫了 path.join 形态没改)
- `electron/ipc/personaEmbeddingApi.ts`(R5#1 修过 abort signal,深扫未做)
- `electron/ipc/readingLog.ts`(R2#ζ + R4#4 修过,深扫未做)

后续 round 可以从这里继续。
