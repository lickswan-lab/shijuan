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
export async function openEntryById(entryId: string, options?: OpenEntryOptions): Promise<boolean> {
  const library = useLibraryStore.getState().library
  const entry = library?.entries.find(e => e.id === entryId)
  if (!entry) return false

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
}
