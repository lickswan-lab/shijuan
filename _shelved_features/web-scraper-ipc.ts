  // ===== Web Resource Scraping =====
  const DOWNLOAD_EXTS = /\.(pdf|epub|docx?|txt|md|mobi|djvu|html?|zip|rar)$/i

  // Helper: fetch URL content as string, follow redirects
  function fetchUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const doReq = (u: string, depth: number) => {
        if (depth > 5) { reject(new Error('Too many redirects')); return }
        const proto = u.startsWith('https') ? https : http
        const req = proto.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            doReq(res.headers.location!, depth + 1); return
          }
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
          let data = ''
          res.setEncoding('utf-8')
          res.on('data', c => data += c)
          res.on('end', () => resolve(data))
        })
        req.on('error', reject)
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')) })
      }
      doReq(url, 0)
    })
  }

  // Scrape a URL for downloadable resources
  ipcMain.handle('scrape-resources', async (_event, url: string) => {
    try {
      const html = await fetchUrl(url)

      // Extract all links from the page
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
      const resources: Array<{ url: string; name: string; ext: string }> = []
      const seen = new Set<string>()

      let match
      while ((match = linkRegex.exec(html)) !== null) {
        let href = match[1]
        const label = match[2].replace(/<[^>]*>/g, '').trim()

        // Resolve relative URLs
        if (href.startsWith('/')) {
          const base = new URL(url)
          href = `${base.protocol}//${base.host}${href}`
        } else if (!href.startsWith('http')) {
          href = new URL(href, url).href
        }

        // Check if it looks like a downloadable file
        const extMatch = href.match(DOWNLOAD_EXTS)
        if (extMatch && !seen.has(href)) {
          seen.add(href)
          const fileName = decodeURIComponent(href.split('/').pop()?.split('?')[0] || label || 'unknown')
          resources.push({
            url: href,
            name: fileName || label,
            ext: extMatch[1].toLowerCase(),
          })
        }
      }

      // Also check for direct download links in common patterns
      const directLinks = html.match(/https?:\/\/[^\s"'<>]+\.(pdf|epub|docx?|txt|md|mobi)/gi) || []
      for (const link of directLinks) {
        if (!seen.has(link)) {
          seen.add(link)
          const fileName = decodeURIComponent(link.split('/').pop()?.split('?')[0] || 'file')
          const ext = link.match(/\.(\w+)$/)?.[1] || ''
          resources.push({ url: link, name: fileName, ext: ext.toLowerCase() })
        }
      }

      return { success: true, resources: resources.slice(0, 50), pageTitle: (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '' }
    } catch (err: any) {
      return { success: false, resources: [], error: err.message }
    }
  })

  // Download a file from URL to local downloads folder, return path
  ipcMain.handle('download-resource', async (_event, fileUrl: string, fileName: string) => {
    const downloadsDir = path.join(DATA_DIR, 'downloads')
    await fs.mkdir(downloadsDir, { recursive: true })
    const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_')
    const destPath = path.join(downloadsDir, safeName)

    return new Promise((resolve) => {
      const doReq = (u: string, depth: number) => {
        if (depth > 5) { resolve({ success: false, error: 'Too many redirects' }); return }
        const proto = u.startsWith('https') ? https : http
        const req = proto.get(u, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            doReq(res.headers.location!, depth + 1); return
          }
          if (res.statusCode !== 200) {
            resolve({ success: false, error: `HTTP ${res.statusCode}` }); return
          }
          const file = createWriteStream(destPath)
          const totalSize = parseInt(res.headers['content-length'] || '0', 10)
          let downloaded = 0
          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length
            file.write(chunk)
            // Send progress
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
            if (totalSize > 0 && win) {
              win.webContents.send('download-resource-progress', Math.round((downloaded / totalSize) * 100))
            }
          })
          res.on('end', () => {
