import { ipcMain } from 'electron'
import fs from 'fs/promises'

export function registerPdfOperationsIpc(): void {
  // Get PDF page count (via reading the PDF and counting pages using a simple heuristic)
  // In production we'd use pdf-lib, but for now the renderer does this via pdf.js

  // Extract a page as a PNG image (base64) for OCR
  // This is handled in the renderer process using pdf.js canvas rendering
  // and then sent to the main process for GLM API call
  ipcMain.handle('extract-page-image', async (_event, pdfPath: string, _pageNum: number) => {
    // Verify the PDF exists
    try {
      await fs.access(pdfPath)
      return { success: true }
    } catch {
      return { success: false, error: 'PDF file not found' }
    }
  })
}
