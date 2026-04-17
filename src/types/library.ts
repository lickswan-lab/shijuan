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
  // Memo folders
  memoFolders: MemoFolder[]
  // Reading logs
  readingLogs: ReadingLog[]
  // Lecture sessions
  lectureSessions: LectureSession[]
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
  marks?: TextMark[]       // 划线/加重标记（无历史链）
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
  style?: {
    color?: string  // yellow/red/green/blue/purple/orange
  }
  createdAt: string
  updatedAt: string
}

export interface TextMark {
  id: string
  type: 'underline' | 'bold'
  color?: string              // 预设色名（划线用），加重无颜色
  pageNumber: number
  selectedText: string
  createdAt: string
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
  modelLabel?: string             // e.g. "GLM-5.1", "Claude Opus 4.6"
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
  filePath?: string            // Future: relative path for .md file storage
  folderId?: string            // Memo folder ID
  blocks: BlockRef[]           // All blocks cited in this memo
  aiHistory: HistoryEntry[]    // AI conversations within memo writing
  createdAt: string
  updatedAt: string
  snapshots: MemoSnapshot[]    // Version history
}

export interface MemoFolder {
  id: string
  name: string
  createdAt: string
}

export interface MemoSnapshot {
  content: string
  savedAt: string
}

// ===== Reading Log =====

export interface ReadingLogEvent {
  id: string
  timestamp: string                // ISO
  type: 'open_doc' | 'annotate' | 'note' | 'question' | 'stance' | 'ai_interaction' | 'memo_create' | 'memo_edit' | 'mark_text'
  entryId?: string
  entryTitle?: string
  memoId?: string
  memoTitle?: string
  annotationId?: string            // For annotate/note/question/stance/ai_interaction — jump target (v1.2.7+)
  detail: string                   // e.g. "在《论法的精神》第3页添加了注释"
  selectedText?: string            // excerpt (≤80 chars)
}

export interface ReadingLog {
  id: string
  date: string                     // YYYY-MM-DD
  events: ReadingLogEvent[]
  aiSummary?: string               // Markdown
  aiModel?: string
  generatedAt: string
}

// ===== Lecture Session =====

export interface TranscriptSegment {
  id: string
  startTime: number               // seconds from recording start
  endTime: number
  text: string
  isFinal: boolean                // final vs interim result
}

export interface LectureSession {
  id: string
  title: string
  date: string                    // ISO
  duration: number                // seconds
  preDocIds: string[]             // associated pre-lecture entry IDs
  transcript: TranscriptSegment[]
  notes: string                   // user notes (Markdown)
  aiSummary?: string              // AI-generated course record
  aiModel?: string
  audioPath?: string              // path to audio file
  provider: 'webspeech' | 'xfyun' | 'aliyun'
  createdAt: string
}

// ===== Hermes Agent =====

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  content: string
  toolName?: string
  toolArgs?: string
  timestamp: string
}

export interface AgentConversation {
  id: string
  title: string
  messages: AgentMessage[]
  createdAt: string
  updatedAt: string
}

export interface HermesSkill {
  id: string
  name: string
  description: string
  type: 'builtin' | 'learned' | 'custom'
  prompt?: string          // Prompt template (custom/learned)
  trigger?: string         // When to activate (e.g. "阅读法学文献时")
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface HermesInsight {
  id: string
  content: string          // AI-generated insight markdown
  basedOn: number          // Number of behavior events analyzed
  generatedAt: string
  model: string            // Which AI model generated it
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
    memos: [],
    memoFolders: [],
    readingLogs: [],
    lectureSessions: []
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
