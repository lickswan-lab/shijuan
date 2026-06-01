import { resolve } from 'path'
import { existsSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 2026-05-25 · CJK/PDF 渲染修复 — 把 pdfjs-dist 的 cmaps/ 和 standard_fonts/
//   拷到 renderer 输出 + dev server 中间件 serve,这两个目录是 PDF.js 解码
//   预定义 CMap CJK 字体(如 STSong-Light-GBK-EUC-H)和加载 14 个标准字体
//   兜底所必需的,缺失会导致中文 PDF 渲染成空白页。
function copyDirRecursive(src: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name)
    const destPath = resolve(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath)
    }
  }
}

function pdfjsAssetsPlugin() {
  // react-pdf v9 嵌套了自己的 pdfjs-dist,优先用嵌套那份(版本对齐 worker);
  // 顶层 pdfjs-dist 是兜底(如果未来 npm 把版本提升合并)。
  const candidateRoots = [
    resolve(__dirname, 'node_modules/react-pdf/node_modules/pdfjs-dist'),
    resolve(__dirname, 'node_modules/pdfjs-dist'),
  ]
  const pdfjsRoot = candidateRoots.find((p) => existsSync(p)) ?? candidateRoots[0]
  const assetMap: Record<string, string> = {
    'cmaps': resolve(pdfjsRoot, 'cmaps'),
    'standard_fonts': resolve(pdfjsRoot, 'standard_fonts'),
  }
  return {
    name: 'pdfjs-assets',
    configureServer(server: any) {
      // Dev: 拦截 /pdfjs-assets/{cmaps|standard_fonts}/<file>,从 node_modules 直接读
      server.middlewares.use('/pdfjs-assets', (req: any, res: any, next: any) => {
        const url = (req.url || '').split('?')[0]
        const m = url.match(/^\/(cmaps|standard_fonts)\/([^/].*)$/)
        if (!m) return next()
        const dir = assetMap[m[1]]
        if (!dir) return next()
        const safeName = m[2].replace(/\\/g, '/')
        if (safeName.includes('..')) return next()
        const filePath = resolve(dir, safeName)
        try {
          const st = statSync(filePath)
          if (!st.isFile()) return next()
          const data = readFileSync(filePath)
          res.setHeader('Content-Type', filePath.endsWith('.bcmap')
            ? 'application/octet-stream'
            : 'application/octet-stream')
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          res.end(data)
        } catch {
          next()
        }
      })
    },
    writeBundle() {
      // Build: 拷到 out/renderer/pdfjs-assets/{cmaps,standard_fonts}
      const dest = resolve(__dirname, 'out/renderer/pdfjs-assets')
      mkdirSync(dest, { recursive: true })
      for (const [name, src] of Object.entries(assetMap)) {
        if (!existsSync(src)) {
          console.warn(`[pdfjs-assets] source missing: ${src} — PDF CJK rendering may break`)
          continue
        }
        try {
          copyDirRecursive(src, resolve(dest, name))
        } catch (err) {
          console.warn(`[pdfjs-assets] copy failed for ${name}:`, err)
        }
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: false
    },
    build: {
      outDir: 'out/renderer',
      // Raise chunk size warning threshold (our PDF/EPUB chunks are large by nature)
      chunkSizeWarningLimit: 1500,
      // Don't eagerly preload heavy lazy deps (pdfjs/katex/markdown/mammoth/epub)
      // These should only load when actually needed — PDF viewing, DOCX, EPUB, etc.
      modulePreload: {
        resolveDependencies: (_url, deps) => {
          return deps.filter(d =>
            !/(^|\/)(pdfjs|katex|markdown|mammoth|epub)-[A-Za-z0-9_-]+\.(js|css)$/.test(d)
          )
        }
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        },
        output: {
          // Consolidate shared heavy deps into dedicated chunks so they aren't duplicated
          // across multiple lazy routes (PdfViewer / AnnotationPanel / MemoEditor / ReadingLogView)
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              // Markdown pipeline: used by PdfViewer, AnnotationPanel, MemoEditor, ReadingLogView
              if (
                /[\\/](react-markdown|remark-math|rehype-katex|rehype-raw|remark-parse|remark-rehype|mdast-util|micromark|unified|unist|hast-util|vfile|property-information|space-separated-tokens|comma-separated-tokens|html-void-elements|character-entities|decode-named-character-reference|trim-lines|bail|is-plain-obj|trough|extend|devlop|zwitch|ccount|longest-streak|markdown-table|escape-string-regexp|stringify-entities|trim-trailing-lines)[\\/]/.test(id)
              ) {
                return 'markdown'
              }
              // KaTeX: heavy math renderer
              if (/[\\/]katex[\\/]/.test(id)) return 'katex'
              // PDF libs: only loaded in PdfViewer
              if (/[\\/](pdfjs-dist|react-pdf)[\\/]/.test(id)) return 'pdfjs'
              // Mammoth (DOCX): only loaded when opening DOCX
              if (/[\\/]mammoth[\\/]/.test(id)) return 'mammoth'
              // EPUB: only loaded when opening EPUB
              if (/[\\/](epubjs|jszip)[\\/]/.test(id)) return 'epub'
              // React core + common UI vendors → group together
              if (/[\\/](react|react-dom|scheduler|use-sync-external-store|zustand)[\\/]/.test(id)) {
                return 'react-vendor'
              }
            }
            return undefined
          }
        }
      }
    },
    plugins: [react(), pdfjsAssetsPlugin()]
  }
})
