import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [react()]
  }
})
