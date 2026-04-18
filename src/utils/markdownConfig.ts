// Shared ReactMarkdown configuration for the whole app. Two jobs:
//
// 1. `sanitizeMath` — pre-process the text so LaTeX written with nested `$`
//    delimiters (common in OCR output / pasted Obsidian notes) doesn't break
//    KaTeX parsing. See src/utils/sanitizeMath.ts for the exact heuristic.
//
// 2. `KATEX_FORGIVING` — pass to rehype-katex so that when KaTeX still can't
//    parse an expression, it renders fallback plain text in the current color
//    instead of a scary red error inside the page. This is important because
//    the app mixes user-authored markdown, AI-generated markdown, and OCR'd
//    text — all with varying LaTeX quality, and we don't want a single bad
//    expression to look like the whole note is broken.
//
// Usage:
//   import { sanitizeMath, KATEX_FORGIVING } from '../../utils/markdownConfig'
//   import remarkMath from 'remark-math'
//   ...
//   <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[KATEX_FORGIVING]}>
//     {sanitizeMath(content)}
//   </ReactMarkdown>

import rehypeKatex from 'rehype-katex'
export { sanitizeMath } from './sanitizeMath'

// rehype plugin tuple with forgiving options. `strict: 'ignore'` and
// `throwOnError: false` together mean KaTeX stays silent about its failures
// and renders broken expressions as plain colored text rather than big red
// error blocks.
export const KATEX_FORGIVING: [typeof rehypeKatex, any] = [
  rehypeKatex,
  {
    throwOnError: false,
    strict: 'ignore',
    errorColor: 'currentColor',
  },
]
