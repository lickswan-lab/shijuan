// ===== Central library: stores references to PDFs scattered across the system =====

export interface Library {
  version: string
  createdAt: string
  lastOpenedAt: string
  globalTags: string[]
  // Virtual folders (groups, not real filesystem folders)
  folders: VirtualFolder[]
  // All imported PDF entries
  entries: LibraryEntry[]
  // Thinking memos
  memos: Memo[]
}

export interface VirtualFolder {
  id: string
  name: string
  createdAt: string
}

export interface LibraryEntry {
  id: string               // UUID
  absPath: string          // Original absolute path to the PDF (never moved)
  title: string            // User-editable, initially from filename
  authors: string[]
  year?: number
  tags: string[]
  notes: string
  folderId?: string        // Virtual folder ID (null = root level)
  sortIndex?: number       // Manual sort order (lower = higher in list)
  ocrStatus: 'none' | 'partial' | 'complete'
  ocrFilePath?: string     // Path to .ocr.txt (next to PDF)
  addedAt: string          // When imported
  lastOpenedAt?: string
}

export interface PdfMeta {
  version: string
  entryId: string          // Links to LibraryEntry.id
  pages: PageData[]
  annotations: Annotation[]
  createdAt: string
  updatedAt: string
}

export interface PageData {
  pageNumber: number
  ocrText: string | null
  ocrTimestamp: string | null
}

export interface Annotation {
  id: string
  anchor: {
    pageNumber: number
    startOffset: number
    endOffset: number
    selectedText: string
  }
  historyChain: HistoryEntry[]
  createdAt: string
  updatedAt: string
}

export interface HistoryEntry {
  id: string
  type: 'note' | 'question' | 'stance' | 'link' | 'ai_interpretation' | 'ai_qa' | 'ai_feedback'
  //     笔记    质疑         立场       关联      AI解读               AI问答      AI即时反馈
  content: string
  userQuery?: string
  contextSent?: string
  contextText?: string           // Additional text the user selected as context for this entry
  linkedRef?: {              // 'link' type: reference to another annotation
    entryId: string          // which literature
    annotationId: string     // which annotation
    selectedText?: string    // preview text from the linked annotation
  }
  author: 'user' | 'ai'
  editedAt?: string
  originalContent?: string
  createdAt: string
}

// ===== BlockRef: address for any piece of thinking =====
// Every note, AI response, Q&A in the system is a "block" that can be cited anywhere

export interface BlockRef {
  entryId: string              // Which PDF
  entryTitle: string           // Cached title
  annotationId: string         // Which annotation
  historyEntryId: string       // Which specific entry in the chain
  selectedText: string         // The anchor text of the annotation
  blockContent: string         // Cached content of the block
  blockAuthor: 'user' | 'ai'  // Who wrote it
}

// ===== Memo: independent thinking notes =====

export interface Memo {
  id: string
  title: string
  content: string              // User's writing (markdown), can contain [[block:id]] references
  blocks: BlockRef[]           // All blocks cited in this memo
  aiHistory: HistoryEntry[]    // AI conversations within memo writing
  createdAt: string
  updatedAt: string
  snapshots: MemoSnapshot[]    // Version history
}

export interface MemoSnapshot {
  content: string
  savedAt: string
}

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileTreeNode[]
  hasMeta?: boolean
}

export function createDefaultLibrary(): Library {
  return {
    version: '2.0.0',
    createdAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    globalTags: [],
    folders: [],
    entries: [],
    memos: []
  }
}

export function createDefaultPdfMeta(entryId: string): PdfMeta {
  return {
    version: '1.0.0',
    entryId,
    pages: [],
    annotations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}
