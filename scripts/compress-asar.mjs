// Compress an app.asar into app.asar.gz for hot-update distribution.
// The updater prefers the .gz asset when both are uploaded to a GitHub release
// and gunzips it in-flight during download, so users pull 3-5x less over wire.
//
// Usage:
//   node scripts/compress-asar.mjs [src] [dst]
//
// If `src` is omitted, looks for dist/win-unpacked/resources/app.asar (NSIS
// build output). If `dst` is omitted, appends .gz to the source path.

import { createReadStream, createWriteStream, statSync, existsSync } from 'fs'
import { createGzip } from 'zlib'
import { pipeline } from 'stream/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const CANDIDATE_SOURCES = [
  'dist/win-unpacked/resources/app.asar',
  'dist/mac/拾卷.app/Contents/Resources/app.asar',
  'dist/mac-arm64/拾卷.app/Contents/Resources/app.asar',
  'dist-packager/shijuan-win32-x64/resources/app.asar',
]

function resolveSource(arg) {
  if (arg) return path.resolve(ROOT, arg)
  for (const rel of CANDIDATE_SOURCES) {
    const abs = path.join(ROOT, rel)
    if (existsSync(abs)) return abs
  }
  console.error('[compress-asar] No src given and no candidate path exists.')
  console.error('[compress-asar] Run `npm run dist` first, or pass the path explicitly.')
  console.error('[compress-asar] Candidates tried:')
  for (const p of CANDIDATE_SOURCES) console.error('  - ' + p)
  process.exit(1)
}

const src = resolveSource(process.argv[2])
const dst = process.argv[3] ? path.resolve(ROOT, process.argv[3]) : src + '.gz'

const before = statSync(src).size
const startedAt = Date.now()

console.log(`[compress-asar] src: ${path.relative(ROOT, src)}  (${(before / 1024 / 1024).toFixed(1)} MB)`)
console.log(`[compress-asar] dst: ${path.relative(ROOT, dst)}`)
console.log('[compress-asar] compressing with gzip level 9...')

await pipeline(
  createReadStream(src),
  createGzip({ level: 9 }),
  createWriteStream(dst),
)

const after = statSync(dst).size
const ratio = (after / before) * 100
const savedMB = (before - after) / 1024 / 1024
const secs = ((Date.now() - startedAt) / 1000).toFixed(1)

console.log(`[compress-asar] done in ${secs}s`)
console.log(`[compress-asar] ${(before / 1024 / 1024).toFixed(1)} MB → ${(after / 1024 / 1024).toFixed(1)} MB (${ratio.toFixed(1)}% of original, saved ${savedMB.toFixed(1)} MB)`)
console.log('[compress-asar] upload this alongside installers to the GitHub release:')
console.log('  gh release upload vX.Y.Z "' + path.relative(ROOT, dst) + '"')
