import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// 2026-04-28 · console.warn 噪声过滤(早期 stash 走的 WIP 现在补回来)
//
// 1) KaTeX 对 OCR 文本里的 ³ ¹ ² ⁰ ' ' 等字符抛 'No character metrics for X'。
//    一篇 OCR 文档可能 100+ 条 warn,DevTools 开着时 source-map 解码这些 warn
//    极慢,主线程被卡几百毫秒 → 选区到工具栏出现"顿一下"。rehype-katex 的
//    strict:'ignore' 不能盖这条(属于不同的 logger 路径),只能在应用层拦。
// 2) PDF.js 同样 noise:切文档时旧 worker 被 terminate,在 flight 的
//    getTextContent / getAnnotations 任务会刷 'Worker task was terminated' warn。
//    这是收尾消息,不影响功能,但 DevTools 开着 + 大文献 + 频繁切换会拖慢主线程。
const _originalWarn = console.warn
const NOISE_PATTERNS = [
  'No character metrics',           // KaTeX: 上标 / 特殊字符
  'Worker task was terminated',     // PDF.js: 切文档时 in-flight 任务收尾
  'getTextContent — ignoring',      // PDF.js: 同上的另一种文本
  'getAnnotations — ignoring',      // PDF.js: annotation 任务被收尾
]
console.warn = (...args: any[]) => {
  const first = args[0]
  if (typeof first === 'string') {
    for (const p of NOISE_PATTERNS) if (first.includes(p)) return
  }
  _originalWarn(...args)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
