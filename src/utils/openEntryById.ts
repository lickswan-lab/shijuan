import { useLibraryStore } from '../store/libraryStore'
import { useUiStore } from '../store/uiStore'

interface OpenEntryOptions {
  annotationId?: string
  searchHighlight?: { query: string; pageNumber?: number }
}

// Central jump-to-entry helper. Callers from FileTree (search), AnnotationPanel (cross-entry),
// MemoEditor (#N reference), ReadingLogView (event click) all need the same sequence:
// optional search highlight → await openEntry (so currentPdfMeta is loaded) → optional setActiveAnnotation.
// Returns true if the entry was found and opened.
//
// BUG-FIX R4#5 · 内置 try/catch —— openEntry 若 IPC 失败（文件移位/权限/PDF 损坏），
// 异步异常原本会飘到顶层 "Unhandled promise rejection" · 3 个 onClick 调用点都没包
// catch · 用户只会看到"点了没反应"。现在统一在这里 catch，log + return false，
// 调用方按返回值决定是否 toast。
export async function openEntryById(entryId: string, options?: OpenEntryOptions): Promise<boolean> {
  const library = useLibraryStore.getState().library
  const entry = library?.entries.find(e => e.id === entryId)
  if (!entry) return false

  try {
    useUiStore.getState().setMainView('reader')

    if (options?.searchHighlight) {
      useUiStore.getState().setSearchHighlight({
        query: options.searchHighlight.query,
        pageNumber: options.searchHighlight.pageNumber,
        targetEntryId: entry.id,
      })
    }

    await useLibraryStore.getState().openEntry(entry)

    if (options?.annotationId) {
      useUiStore.getState().setActiveAnnotation(options.annotationId)
    }

    return true
  } catch (err: any) {
    console.error('[openEntryById] failed to open', entry.title, err?.message || err)
    return false
  }
}
