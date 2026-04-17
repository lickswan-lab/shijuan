// Bundle a portable (green/no-install) Windows build using electron-packager.
// Why not electron-builder for this artifact? electron-builder rewrites the exe's
// PE header (asar integrity + signtool, even when we pass no cert), which triggers
// Windows CodeIntegrity (SAC) blocking on Win11 machines without reputation.
// electron-packager leaves the exe untouched → identical bytes to a known-good
// Electron release → not blocked.
//
// But electron-packager, by default, includes *everything* in the project root
// (except devDependencies). That drags in:
//   - dist/ and dist-packager/ from previous builds (up to 1+ GB)
//   - canvas, @napi-rs (pdfjs optional deps — not used in Electron renderer)
//   - src/, electron/ source (already compiled into out/)
//   - dev tool transitive: core-js, lodash, underscore, es5-ext, @babel, …
//
// This script whitelists only what the runtime needs.

import packager from 'electron-packager'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// Clean previous output so we don't accidentally repack it
const OUT = path.join(ROOT, 'dist-packager')
await fs.rm(OUT, { recursive: true, force: true }).catch(() => {})
// Also clean dist/ (electron-builder leftovers) so packager doesn't sweep it in
await fs.rm(path.join(ROOT, 'dist'), { recursive: true, force: true }).catch(() => {})

// Project-root paths we never want in the app bundle
const ROOT_EXCLUDES = [
  'dist',
  'dist-packager',
  'src',
  'electron',
  'scripts',
  '_shelved_features',
  '.github',
  '.vscode',
  '.git',
  'index.html',
  'electron.vite.config.ts',
  'tsconfig.node.json',
  'tsconfig.json',
  'tsconfig.web.json',
  '.gitignore',
  '.gitattributes',
  'README.md',
  'LICENSE',
]

// node_modules that are dev-only, optional-unused, or renderer-only (already
// bundled into out/renderer/ by Vite) — wasted disk if packed.
//
// Rule of thumb: the Electron main process's out/main/index.js only requires
// these node modules: electron, fs, path, http(s), os, child_process, uuid.
// pdf-lib is dynamic-imported (OCR chunking). Everything else in our deps
// (react, react-pdf, pdfjs-dist, epubjs, mammoth, katex, react-markdown,
// remark-*, rehype-*, zustand) is only used from the renderer, which is
// already a self-contained bundle after `vite build`.
const NM_EXCLUDES = [
  // --- build/dev tooling ---
  'core-js', 'lodash', 'underscore', 'es5-ext',
  '@babel', '@types', 'typescript', '7zip-bin',
  '@electron', 'electron-builder', 'electron-packager', 'electron-vite',
  'app-builder-bin', 'app-builder-lib',
  '@esbuild', 'esbuild', 'vite', '@vitejs', '@rollup',
  'dmg-builder', 'dmg-license', 'builder-util', 'builder-util-runtime',

  // --- optional native deps not used by our Electron renderer ---
  'canvas',        // pdfjs optional; renderer uses browser canvas
  '@napi-rs',      // same story, napi-rs canvas variant

  // --- renderer-only, bundled by Vite (still listed as dependencies so that
  //     `npm install` puts them on disk for dev/build; at runtime the
  //     packaged app loads out/renderer/assets/*.js instead) ---
  'react', 'react-dom', 'scheduler',
  'react-pdf', 'pdfjs-dist',
  'react-markdown', 'remark-math', 'rehype-katex', 'rehype-raw',
  'epubjs', 'mammoth', 'katex', 'zustand',
  // big renderer-only transitive deps pulled in by the above — all get rolled
  // into the Vite output. Keep conservative: only block obvious ones, let
  // a few small transitive scraps stay rather than break main import.
  'jszip', 'pako', 'parse5', 'localforage',
  'micromark', 'micromark-core-commonmark',
  'mdast-util-to-markdown', 'mdast-util-to-hast', 'mdast-util-from-markdown',
]

function shouldIgnore(filePath) {
  // electron-packager on Windows passes paths with backslashes — split on either separator
  const parts = filePath.split(/[/\\]/).filter(Boolean)
  if (parts.length === 0) return false

  // Top-level filter (not inside node_modules)
  if (parts[0] !== 'node_modules' && ROOT_EXCLUDES.includes(parts[0])) return true

  // node_modules filter
  if (parts[0] === 'node_modules' && parts.length >= 2) {
    // .bin is nothing but CLI shims for devDependencies — always drop
    if (parts[1] === '.bin') return true
    // Scoped packages: parts[1]=@scope, parts[2]=pkgname
    const first = parts[1]
    const scoped = parts[1].startsWith('@') ? parts[1] : null
    for (const ex of NM_EXCLUDES) {
      if (first === ex) return true
      if (scoped && scoped === ex) return true  // entire @scope excluded
    }
  }

  return false
}

console.log('[pack-portable] starting electron-packager…')
const t0 = Date.now()

const appPaths = await packager({
  dir: ROOT,
  name: '拾卷',
  platform: 'win32',
  arch: 'x64',
  out: OUT,
  icon: path.join(ROOT, 'build/icon.ico'),
  asar: true,
  overwrite: true,
  prune: true,  // default, but be explicit — removes devDependencies
  ignore: shouldIgnore,
})

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`[pack-portable] done in ${elapsed}s → ${appPaths[0]}`)

// Report sizes
async function du(p) {
  let total = 0
  const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    const sub = path.join(p, e.name)
    if (e.isDirectory()) total += await du(sub)
    else {
      try { const s = await fs.stat(sub); total += s.size } catch {}
    }
  }
  return total
}
const totalBytes = await du(appPaths[0])
console.log(`[pack-portable] total size: ${(totalBytes / 1024 / 1024).toFixed(0)} MB`)
