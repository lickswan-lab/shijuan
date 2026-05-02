const childProcess = require('child_process')
const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const repoRoot = path.resolve(__dirname, '..')

function jsString(value) {
  return JSON.stringify(value)
}

function runChild(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    const timeoutMs = options.timeoutMs || 60000
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`))
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function parseJsonLine(output) {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // Keep walking upward; Electron may print non-JSON diagnostics.
    }
  }
  throw new Error(`No JSON result found in output:\n${output}`)
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'shijuan-online-search-'))
  const tempHome = path.join(tempRoot, 'home')
  await fsp.mkdir(tempHome, { recursive: true })

  try {
    const onlineBundle = path.join(tempRoot, 'online-search-bundle.cjs')
    await esbuild.build({
      entryPoints: [path.join(repoRoot, 'electron', 'ipc', 'onlineSearch.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: onlineBundle,
      external: ['electron'],
      logLevel: 'silent',
    })

    const electronHarness = path.join(tempRoot, 'electron-harness.js')
    await fsp.writeFile(electronHarness, `
const { app, session } = require('electron')
const fs = require('fs/promises')
const fsSync = require('fs')
const http = require('http')
const testHome = process.env.SHIJUAN_TEST_HOME
if (testHome) app.setPath('home', testHome)
const online = require(${jsString(onlineBundle)})

const pdf = Buffer.from('%PDF-1.4\\n% fixture\\n1 0 obj\\n<<>>\\nendobj\\ntrailer\\n<<>>\\n%%EOF\\n')

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/search') {
      sendHtml(res, '<!doctype html><title>Fixture Search</title><a href="/record/fixture">Fixture Paper Landing Page</a>')
      return
    }
    if (url.pathname === '/record/fixture') {
      sendHtml(res, '<!doctype html><title>Fixture Paper</title><a href="/files/fixture-paper.pdf?download=1">Download PDF</a>')
      return
    }
    if (url.pathname === '/files/fixture-paper.pdf') {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(pdf.length),
        'content-disposition': 'attachment; filename="fixture-paper.pdf"',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(pdf)
      return
    }
    if (url.pathname === '/private-search') {
      if (!/\\bauth=1\\b/.test(req.headers.cookie || '')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Login Required</title>')
        return
      }
      sendHtml(res, '<!doctype html><title>Private Search</title><a href="/private-record/fixture">Private Paper Landing Page</a>')
      return
    }
    if (url.pathname === '/private-record/fixture') {
      if (!/\\bauth=1\\b/.test(req.headers.cookie || '')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Login Required</title>')
        return
      }
      sendHtml(res, '<!doctype html><title>Private Paper</title><a href="/private-files/private-paper.pdf?download=1">Private PDF</a>')
      return
    }
    if (url.pathname === '/private-files/private-paper.pdf') {
      if (!/\\bauth=1\\b/.test(req.headers.cookie || '')) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>Login Required</title>')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': String(pdf.length),
        'content-disposition': 'attachment; filename="private-paper.pdf"',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(pdf)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function run() {
  await app.whenReady()
  const server = await startServer()
  try {
    const port = server.address().port
    const siteUrl = 'http://127.0.0.1:' + port + '/search?q={query}'
    const search = await online.runSearch({ siteUrl, query: 'fixture', maxPages: 4 })
    if (!search.success) throw new Error(search.error || 'search failed')
    if (search.scannedPages < 2) throw new Error('expected search to scan landing page')
    if (search.results.length !== 1) throw new Error('expected one downloadable result, got ' + search.results.length)
    const result = search.results[0]
    if (result.extension !== 'pdf') throw new Error('expected pdf result, got ' + result.extension)
    const download = await online.runDownload({ url: result.url, fileName: result.fileName, title: result.title })
    if (!download.success) throw new Error(download.error || 'download failed')
    const bytes = await fs.readFile(download.absPath)
    if (!bytes.toString('utf8', 0, 5).startsWith('%PDF-')) throw new Error('downloaded file is not a PDF fixture')
    const origin = 'http://127.0.0.1:' + port + '/'
    await session.fromPartition('persist:shijuan-online-sites').cookies.set({
      url: origin,
      name: 'auth',
      value: '1',
      path: '/',
    })
    const privateSiteUrl = 'http://127.0.0.1:' + port + '/private-search?q={query}'
    const privateSearch = await online.runSearch({ siteUrl: privateSiteUrl, query: 'fixture', maxPages: 4, useSiteSession: true })
    if (!privateSearch.success) throw new Error(privateSearch.error || 'private search failed')
    if (!privateSearch.usedSiteSession) throw new Error('private search did not report site session use')
    if ((privateSearch.sessionCookieCount || 0) < 1) throw new Error('private search did not see session cookies')
    if (privateSearch.results.length !== 1) throw new Error('expected one private downloadable result, got ' + privateSearch.results.length)
    const privateResult = privateSearch.results[0]
    const privateDownload = await online.runDownload({
      url: privateResult.url,
      fileName: privateResult.fileName,
      title: privateResult.title,
      useSiteSession: true,
    })
    if (!privateDownload.success) throw new Error(privateDownload.error || 'private download failed')
    const privateBytes = await fs.readFile(privateDownload.absPath)
    if (!privateBytes.toString('utf8', 0, 5).startsWith('%PDF-')) throw new Error('private downloaded file is not a PDF fixture')
    console.log(JSON.stringify({
      ok: true,
      searchedUrl: search.searchedUrl,
      scannedPages: search.scannedPages,
      resultCount: search.results.length,
      result,
      download,
      downloadExists: fsSync.existsSync(download.absPath),
      bytes: bytes.length,
      privateSearchedUrl: privateSearch.searchedUrl,
      privateResultCount: privateSearch.results.length,
      privateSessionCookieCount: privateSearch.sessionCookieCount,
      privateDownload,
      privateBytes: privateBytes.length,
    }))
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err && (err.stack || err.message) || String(err) }))
    process.exitCode = 1
  } finally {
    server.close(() => app.quit())
    setTimeout(() => app.exit(process.exitCode || 0), 1000).unref()
  }
}

run()
`, 'utf8')

    const electronExe = require('electron')
    const env = {
      ...process.env,
      SHIJUAN_FORCE_SINGLE_INSTANCE: '0',
      SHIJUAN_TEST_HOME: tempHome,
    }
    delete env.ELECTRON_RUN_AS_NODE
    const electronRun = await runChild(electronExe, [electronHarness], { env, timeoutMs: 60000 })
    const electronOutput = `${electronRun.stdout}\n${electronRun.stderr}`
    const electronResult = parseJsonLine(electronOutput)
    if (electronRun.code !== 0 || !electronResult.ok) {
      throw new Error(`Electron online search verification failed:\n${electronOutput}`)
    }

    const libraryEntry = path.join(tempRoot, 'library-probe-entry.ts')
    const libraryBundle = path.join(tempRoot, 'library-probe.cjs')
    await fsp.writeFile(libraryEntry, `
import { useLibraryStore } from ${jsString(path.join(repoRoot, 'src', 'store', 'libraryStore'))}
import { createDefaultLibrary } from ${jsString(path.join(repoRoot, 'src', 'types', 'library'))}

;(globalThis as any).window = {
  electronAPI: {
    saveLibrary: async (library: unknown) => {
      ;(globalThis as any).__savedLibrary = library
      return true
    },
    readFileBuffer: async () => Buffer.alloc(0),
  },
}

async function run() {
  const absPath = process.argv[2]
  const library = createDefaultLibrary()
  useLibraryStore.setState({ library })
  const entry = await useLibraryStore.getState().addEntryFromPath(absPath, 'Fixture Paper PDF')
  const saved = (globalThis as any).__savedLibrary
  const current = useLibraryStore.getState().library
  console.log(JSON.stringify({
    ok: Boolean(entry),
    entry,
    currentEntryCount: current?.entries?.length || 0,
    savedEntryCount: saved?.entries?.length || 0,
    savedAbsPath: saved?.entries?.[0]?.absPath || '',
    savedTitle: saved?.entries?.[0]?.title || '',
  }))
}

run().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err && (err.stack || err.message) || String(err) }))
  process.exitCode = 1
})
`, 'utf8')

    await esbuild.build({
      entryPoints: [libraryEntry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: libraryBundle,
      logLevel: 'silent',
    })

    const libraryRun = await runChild(process.execPath, [libraryBundle, electronResult.download.absPath], { timeoutMs: 30000 })
    const libraryOutput = `${libraryRun.stdout}\n${libraryRun.stderr}`
    const libraryResult = parseJsonLine(libraryOutput)
    if (libraryRun.code !== 0 || !libraryResult.ok) {
      throw new Error(`Library import verification failed:\n${libraryOutput}`)
    }
    if (libraryResult.currentEntryCount !== 1 || libraryResult.savedEntryCount !== 1) {
      throw new Error(`Library import did not save one entry:\n${libraryOutput}`)
    }
    if (libraryResult.savedAbsPath !== electronResult.download.absPath) {
      throw new Error(`Imported path mismatch:\n${libraryOutput}`)
    }

    console.log(JSON.stringify({
      ok: true,
      tempHome,
      searchedUrl: electronResult.searchedUrl,
      scannedPages: electronResult.scannedPages,
      resultCount: electronResult.resultCount,
      downloadedPath: electronResult.download.absPath,
      downloadedBytes: electronResult.bytes,
      privateSearchedUrl: electronResult.privateSearchedUrl,
      privateResultCount: electronResult.privateResultCount,
      privateSessionCookieCount: electronResult.privateSessionCookieCount,
      privateDownloadedPath: electronResult.privateDownload.absPath,
      privateDownloadedBytes: electronResult.privateBytes,
      importedTitle: libraryResult.savedTitle,
      importedPath: libraryResult.savedAbsPath,
    }, null, 2))
  } finally {
    if (process.env.KEEP_VERIFY_TEMP !== '1') {
      await fsp.rm(tempRoot, { recursive: true, force: true })
    }
  }
}

main().catch(err => {
  console.error(err && (err.stack || err.message) || String(err))
  process.exitCode = 1
})
