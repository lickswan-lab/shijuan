// BUG-FIX R8#8 · localStorage 数字读 NaN 防御
//
// 之前散在 4 个文件 5 处的写法都是裸 `Number(localStorage.getItem(KEY))`,
// 用户手动改坏 localStorage(或浏览器旧版本写过非法值)就会得 NaN,下游
// 计算/比较全 false,行为静默失常(更新检查不再触发 / panel 宽度变 0 / 滚动
// 位置不恢复 ...)。
//
// uiStore.ts 已经在 R5#3 修了 aiContextWindow 这一处,这次把模式抽出来
// 让整个 app 走同一份兜底逻辑。
//
// 用法:
//   const last = readNumber('sj-lastUpdateCheck', 0)         // 整数,允许 0
//   const w    = readNumber('sj-annPanelWidth', 380, 80)     // 必须 > 80
//   const s    = readNumber('sj-scroll-xxx', 0)
//
// 入参:
//   key: localStorage key
//   defaultValue: 解析失败 / NaN / 不存在时返回这个
//   minValue: 可选下限(严格大于)。一些 width / 字号场景有意义。

export function readNumber(key: string, defaultValue: number, minValue?: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return defaultValue
    const n = Number(raw)
    if (!Number.isFinite(n)) return defaultValue
    if (typeof minValue === 'number' && n <= minValue) return defaultValue
    return n
  } catch {
    return defaultValue
  }
}
