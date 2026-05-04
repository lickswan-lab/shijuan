import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useLibraryStore } from '../../store/libraryStore'
import { useUiStore } from '../../store/uiStore'
import { openEntryById } from '../../utils/openEntryById'
import type {
  ActivityStats,
  BlockRef,
  LibraryEntry,
  Memo,
  ReadingGraph,
  ReadingGraphEdge,
  ReadingGraphNodeRef,
  ReadingGraphNodeType,
} from '../../types/library'

type GraphNode = ReadingGraphNodeRef & {
  key: string
  title: string
  subtitle: string
  excerpt: string
  x: number
  y: number
  totalMs: number
  lastSessionMs: number
  lastAt?: string
  sessionCount: number
  addedAt?: string
  position?: { x: number; y: number }
}

type ImportListItem = {
  type: ReadingGraphNodeType
  id: string
  key: string
  title: string
  meta: string
  searchText: string
}

type GraphCamera = { x: number; y: number }

function screenToWorld(clientX: number, clientY: number, rect: DOMRect, camera: GraphCamera, zoom: number) {
  return {
    x: (clientX - rect.left - camera.x) / zoom,
    y: (clientY - rect.top - camera.y) / zoom,
  }
}

function nodeKey(node: ReadingGraphNodeRef) {
  return `${node.type}:${node.id}`
}

function sameNode(a: ReadingGraphNodeRef, b: ReadingGraphNodeRef) {
  return a.type === b.type && a.id === b.id
}

function edgeConnects(edge: ReadingGraphEdge, a: ReadingGraphNodeRef, b: ReadingGraphNodeRef) {
  return (sameNode(edge.a, a) && sameNode(edge.b, b)) || (sameNode(edge.a, b) && sameNode(edge.b, a))
}

function formatDuration(ms = 0) {
  if (ms <= 0) return '0 分钟'
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return '不足 1 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours <= 0) return `${minutes} 分钟`
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

function formatDate(iso?: string) {
  if (!iso) return '暂无记录'
  return new Date(iso).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function statsOf(stats?: ActivityStats) {
  return {
    totalMs: stats?.totalMs || 0,
    lastSessionMs: stats?.lastSessionMs || 0,
    lastAt: stats?.lastAt,
    sessionCount: stats?.sessionCount || 0,
  }
}

function hashString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function defaultGraphPosition(
  type: ReadingGraphNodeType,
  key: string,
  index: number,
  count: number,
  width: number,
  height: number,
  hasBothSides: boolean,
) {
  const seed = hashString(key)
  const laneX = hasBothSides
    ? (type === 'entry' ? width * 0.29 : width * 0.71)
    : width * (0.35 + ((seed % 30) / 100))
  const usableHeight = Math.max(280, height - 160)
  const denominator = Math.max(1, count - 1)
  const progress = count <= 1 ? 0.5 : index / denominator
  const wave = Math.sin((index + 1) * 1.37 + (seed % 17)) * 44
  const xJitter = ((seed % 100) - 50) * 0.9
  const yJitter = (((seed >> 3) % 100) - 50) * 0.42
  return {
    x: Math.round(laneX + xJitter),
    y: Math.round(82 + progress * usableHeight + wave + yJitter),
  }
}

function shiftedPoint(from: GraphNode, to: GraphNode, distance: number) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.max(1, Math.hypot(dx, dy))
  return {
    x: from.x + (dx / length) * distance,
    y: from.y + (dy / length) * distance,
  }
}

function edgeRecordCount(edge: ReadingGraphEdge) {
  return edgeProgressEvents(edge).length
}

function edgeProgressEvents(edge: ReadingGraphEdge) {
  const events = edge.events || []
  return events
    .filter(event => event.kind === 'record')
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
}

function nodeOrderTime(node: GraphNode) {
  const addedAt = Date.parse(node.addedAt || '')
  if (Number.isFinite(addedAt)) return addedAt
  const lastAt = Date.parse(node.lastAt || '')
  return Number.isFinite(lastAt) ? lastAt : 0
}

function directedEdgeNodes(edge: ReadingGraphEdge, a: GraphNode, b: GraphNode) {
  const latestDirectedEvent = [...(edge.events || [])].reverse().find(event => event.from && event.to)
  if (latestDirectedEvent?.from && latestDirectedEvent?.to) {
    const fromKey = nodeKey(latestDirectedEvent.from)
    const toKey = nodeKey(latestDirectedEvent.to)
    if (a.key === fromKey && b.key === toKey) return { from: a, to: b }
    if (a.key === toKey && b.key === fromKey) return { from: b, to: a }
  }
  const isCitationPath = (edge.events || []).some(event => event.source === 'citation')
  if (isCitationPath && a.type !== b.type) {
    return a.type === 'entry' ? { from: a, to: b } : { from: b, to: a }
  }
  const aTime = nodeOrderTime(a)
  const bTime = nodeOrderTime(b)
  if (aTime === bTime) return a.key <= b.key ? { from: a, to: b } : { from: b, to: a }
  return aTime <= bTime ? { from: a, to: b } : { from: b, to: a }
}

function edgePath(a: GraphNode, b: GraphNode) {
  const start = shiftedPoint(a, b, 18)
  const end = shiftedPoint(b, a, 30)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const bend = Math.max(64, Math.min(180, Math.abs(dx) * 0.42))
  const verticalDrift = Math.max(-48, Math.min(48, dy * 0.18))
  const c1x = start.x + (dx >= 0 ? bend : -bend)
  const c2x = end.x - (dx >= 0 ? bend : -bend)
  const c1y = start.y + verticalDrift
  const c2y = end.y - verticalDrift
  return `M ${start.x} ${start.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${end.x} ${end.y}`
}

function sourceLabel(source: string) {
  switch (source) {
    case 'manual': return '手动记录'
    case 'citation': return '引用推进'
    case 'ai': return 'AI 推进'
    case 'auto': return '自动建议'
    default: return source
  }
}

function toPlainText(value?: string) {
  return (value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function excerptText(value?: string, max = 180) {
  const clean = toPlainText(value)
  if (!clean) return '暂无可展示文本，点击打开查看。'
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

function nodeTypeLabel(type: ReadingGraphNodeType) {
  return type === 'entry' ? '文献' : '笔记'
}

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, padding: '6px 0', borderBottom: '1px solid var(--border-light)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function ConfirmDialog({ title, body, confirmLabel, busy, onConfirm, onCancel }: {
  title: string
  body: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div style={{ ...modalBackdropStyle, zIndex: 140, background: 'rgba(45, 38, 29, 0.26)', backdropFilter: 'blur(3px)' }} onClick={() => { if (!busy) onCancel() }}>
      <div style={confirmDialogStyle} onClick={event => event.stopPropagation()}>
        <div style={confirmIconStyle}>!</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{title}</div>
          <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>{body}</div>
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button className="btn btn-sm" disabled={busy} onClick={onCancel}>取消</button>
          <button className="btn btn-sm btn-primary" disabled={busy} style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={onConfirm}>
            {busy ? '删除中' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ReadingGraphView() {
  const library = useLibraryStore(s => s.library)
  const createReadingGraph = useLibraryStore(s => s.createReadingGraph)
  const switchReadingGraph = useLibraryStore(s => s.switchReadingGraph)
  const renameReadingGraph = useLibraryStore(s => s.renameReadingGraph)
  const deleteReadingGraph = useLibraryStore(s => s.deleteReadingGraph)
  const addGraphNodes = useLibraryStore(s => s.addGraphNodes)
  const removeGraphNode = useLibraryStore(s => s.removeGraphNode)
  const updateGraphNodePosition = useLibraryStore(s => s.updateGraphNodePosition)
  const addGraphConnection = useLibraryStore(s => s.addGraphConnection)
  const addGraphConnectionEvent = useLibraryStore(s => s.addGraphConnectionEvent)
  const updateGraphConnectionEvent = useLibraryStore(s => s.updateGraphConnectionEvent)
  const deleteGraphConnectionEvent = useLibraryStore(s => s.deleteGraphConnectionEvent)
  const deleteGraphConnection = useLibraryStore(s => s.deleteGraphConnection)
  const setActiveMemo = useUiStore(s => s.setActiveMemo)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [activeEdgeId, setActiveEdgeId] = useState<string | null>(null)
  const [locateQuery, setLocateQuery] = useState('')
  const [locateOpen, setLocateOpen] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draftPositions, setDraftPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [linkDraft, setLinkDraft] = useState<{ fromKey: string; pointer: { x: number; y: number } } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [camera, setCamera] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const graphViewportRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    key: string
    pointerId: number
    startClientX: number
    startClientY: number
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const panRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    startCameraX: number
    startCameraY: number
  } | null>(null)

  const entries = library?.entries || []
  const memos = library?.memos || []
  const readingGraphs = library?.readingGraphs || (library?.readingGraph ? [library.readingGraph] : [])
  const activeReadingGraph = library?.readingGraph || readingGraphs.find(item => item.id === library?.activeReadingGraphId) || readingGraphs[0]
  const graphNodeRefs = activeReadingGraph?.nodes || []
  const edges = activeReadingGraph?.edges || []

  const importedKeys = useMemo(() => new Set(graphNodeRefs.map(nodeKey)), [graphNodeRefs])
  const importedEntryIds = useMemo(() => new Set(graphNodeRefs.filter(node => node.type === 'entry').map(node => node.id)), [graphNodeRefs])
  const importedMemoIds = useMemo(() => new Set(graphNodeRefs.filter(node => node.type === 'memo').map(node => node.id)), [graphNodeRefs])

  const graph = useMemo(() => {
    const entryById = new Map(entries.map(entry => [entry.id, entry]))
    const memoById = new Map(memos.map(memo => [memo.id, memo]))
    const importedNodes: GraphNode[] = graphNodeRefs
      .map(ref => {
        if (ref.type === 'entry') {
          const entry = entryById.get(ref.id)
          if (!entry) return null
          return {
            type: 'entry' as const,
            id: entry.id,
            key: `entry:${entry.id}`,
            title: entry.title || '未命名文献',
            subtitle: entry.authors.length > 0 ? entry.authors.slice(0, 2).join(' / ') : '文献',
            excerpt: excerptText(entry.notes || [entry.title, entry.authors.join(' / '), entry.tags.join('、')].filter(Boolean).join(' ')),
            addedAt: ref.addedAt,
            position: ref.position,
            ...statsOf(entry.readingStats),
          }
        }
        const memo = memoById.get(ref.id)
        if (!memo) return null
        return {
          type: 'memo' as const,
          id: memo.id,
          key: `memo:${memo.id}`,
          title: memo.title || '未命名笔记',
          subtitle: '笔记',
          excerpt: excerptText(memo.content),
          addedAt: ref.addedAt,
          position: ref.position,
          ...statsOf(memo.writingStats),
        }
      })
      .filter((node): node is Omit<GraphNode, 'x' | 'y'> => !!node)

    const entryItems = importedNodes.filter(node => node.type === 'entry')
    const memoItems = importedNodes.filter(node => node.type === 'memo')
    const baseWidth = 1800
    const baseHeight = 1200
    const rowGap = 108
    const layoutHeight = Math.max(baseHeight, 190 + Math.max(entryItems.length, memoItems.length, 1) * rowGap)
    const hasBothSides = entryItems.length > 0 && memoItems.length > 0
    const nodes: GraphNode[] = [
      ...entryItems.map((node, i) => {
        const draft = draftPositions[node.key]
        const fallback = defaultGraphPosition('entry', node.key, i, entryItems.length, baseWidth, layoutHeight, hasBothSides)
        return { ...node, x: draft?.x ?? node.position?.x ?? fallback.x, y: draft?.y ?? node.position?.y ?? fallback.y }
      }),
      ...memoItems.map((node, i) => {
        const draft = draftPositions[node.key]
        const fallback = defaultGraphPosition('memo', node.key, i, memoItems.length, baseWidth, layoutHeight, hasBothSides)
        return { ...node, x: draft?.x ?? node.position?.x ?? fallback.x, y: draft?.y ?? node.position?.y ?? fallback.y }
      }),
    ]
    const width = Math.max(baseWidth, ...nodes.map(node => node.x + 360))
    const height = Math.max(layoutHeight, ...nodes.map(node => node.y + 240))
    const nodeMap = new Map(nodes.map(node => [node.key, node]))
    const visibleEdges = edges.filter(edge => nodeMap.has(nodeKey(edge.a)) && nodeMap.has(nodeKey(edge.b)))
    return { nodes, nodeMap, visibleEdges, width, height }
  }, [entries, memos, graphNodeRefs, edges, draftPositions])

  const selectedNodes = selectedKeys.map(key => graph.nodeMap.get(key)).filter((node): node is GraphNode => !!node)
  const activeEdge = activeEdgeId ? graph.visibleEdges.find(edge => edge.id === activeEdgeId) || null : null
  const activeNode = selectedNodes.length === 1 ? selectedNodes[0] : null
  const linkSourceNode = linkDraft ? graph.nodeMap.get(linkDraft.fromKey) || null : null
  const graphEntries = entries.filter(entry => importedEntryIds.has(entry.id))
  const graphMemos = memos.filter(memo => importedMemoIds.has(memo.id))
  const totalReadingMs = graphEntries.reduce((sum, entry) => sum + (entry.readingStats?.totalMs || 0), 0)
  const totalWritingMs = graphMemos.reduce((sum, memo) => sum + (memo.writingStats?.totalMs || 0), 0)
  const topEntry = [...graphEntries].sort((a, b) => (b.readingStats?.totalMs || 0) - (a.readingStats?.totalMs || 0))[0]
  const locateMatches = useMemo(() => {
    const q = locateQuery.trim().toLowerCase()
    if (!q) return []
    return graph.nodes
      .filter(node => `${node.title} ${node.subtitle} ${node.excerpt} ${nodeTypeLabel(node.type)}`.toLowerCase().includes(q))
      .slice(0, 8)
  }, [graph.nodes, locateQuery])

  const citationCandidates = useMemo(() => {
    const out: Array<{ entryId: string; memoId: string; entryTitle: string; memoTitle: string }> = []
    const seen = new Set<string>()
    for (const memo of memos) {
      if (!importedMemoIds.has(memo.id)) continue
      for (const block of memo.blocks || []) {
        if (!block.entryId || !importedEntryIds.has(block.entryId)) continue
        const entry = entries.find(item => item.id === block.entryId)
        if (!entry) continue
        const pairKey = `entry:${entry.id}|memo:${memo.id}`
        if (seen.has(pairKey)) continue
        seen.add(pairKey)
        const exists = edges.some(edge => edgeConnects(edge, { type: 'entry', id: entry.id }, { type: 'memo', id: memo.id }))
        if (!exists) out.push({ entryId: entry.id, memoId: memo.id, entryTitle: entry.title, memoTitle: memo.title })
      }
    }
    return out
  }, [entries, memos, edges, importedEntryIds, importedMemoIds])

  const handleSelectNode = (node: GraphNode) => {
    setActiveEdgeId(null)
    setSelectedKeys(prev => {
      if (prev.includes(node.key)) return []
      return [node.key]
    })
  }

  const locateNode = (targetNode?: GraphNode) => {
    const q = locateQuery.trim().toLowerCase()
    if (!targetNode && !q) return
    const target = targetNode || locateMatches[0] || graph.nodes.find(node => (
      `${node.title} ${node.subtitle} ${node.excerpt} ${nodeTypeLabel(node.type)}`.toLowerCase().includes(q)
    ))
    if (!target) return
    setActiveEdgeId(null)
    setSelectedKeys([target.key])
    setLinkDraft(null)
    setLocateOpen(false)
    const viewport = graphViewportRef.current
    if (viewport) {
      setCamera({
        x: viewport.clientWidth / 2 - target.x * zoom,
        y: viewport.clientHeight / 2 - target.y * zoom,
      })
    }
  }

  const cancelLinkDraft = () => {
    setLinkDraft(null)
  }

  const startLinkFromNode = (node: GraphNode, event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    setActiveEdgeId(null)
    setSelectedKeys([node.key])
    setLinkDraft(prev => (
      prev?.fromKey === node.key
        ? null
        : { fromKey: node.key, pointer: { x: node.x, y: node.y } }
    ))
  }

  const completeLinkToNode = async (node: GraphNode) => {
    if (!linkDraft || busy) return
    const source = graph.nodeMap.get(linkDraft.fromKey)
    if (!source) {
      cancelLinkDraft()
      return
    }
    if (source.key === node.key) {
      cancelLinkDraft()
      setSelectedKeys([node.key])
      return
    }
    setBusy(true)
    try {
      const edge = await addGraphConnection(source, node, 'manual', `手动路径线：${source.title} → ${node.title}`)
      if (edge) {
        setActiveEdgeId(edge.id)
        setSelectedKeys([])
      }
      cancelLinkDraft()
    } finally {
      setBusy(false)
    }
  }

  const handleImportNodes = async (nodes: ReadingGraphNodeRef[]) => {
    if (nodes.length === 0) return
    setBusy(true)
    await addGraphNodes(nodes)
    setShowImportModal(false)
    setBusy(false)
  }

  const handleCreateGraph = async (name: string) => {
    setBusy(true)
    await createReadingGraph(name)
    setSelectedKeys([])
    setActiveEdgeId(null)
    setLinkDraft(null)
    setDraftPositions({})
    setBusy(false)
  }

  const handleSwitchGraph = async (id: string) => {
    setBusy(true)
    await switchReadingGraph(id)
    setSelectedKeys([])
    setActiveEdgeId(null)
    setLinkDraft(null)
    setDraftPositions({})
    setBusy(false)
  }

  const handleRenameGraph = async (id: string, name: string) => {
    setBusy(true)
    await renameReadingGraph(id, name)
    setBusy(false)
  }

  const handleDeleteGraph = async (id: string) => {
    setBusy(true)
    await deleteReadingGraph(id)
    setSelectedKeys([])
    setActiveEdgeId(null)
    setLinkDraft(null)
    setDraftPositions({})
    setBusy(false)
  }

  const handleRemoveNode = async (node: GraphNode) => {
    setBusy(true)
    await removeGraphNode(node)
    setSelectedKeys(prev => prev.filter(key => key !== node.key))
    setActiveEdgeId(null)
    setLinkDraft(prev => prev?.fromKey === node.key ? null : prev)
    setBusy(false)
  }

  const handleImportCitationLinks = async () => {
    if (citationCandidates.length === 0) return
    setBusy(true)
    for (const item of citationCandidates) {
      await addGraphConnection(
        { type: 'entry', id: item.entryId },
        { type: 'memo', id: item.memoId },
        'citation',
        '根据 Memo 引用补入路径线',
      )
    }
    setBusy(false)
  }

  const openNode = (node: GraphNode) => {
    if (node.type === 'entry') {
      void openEntryById(node.id)
    } else {
      setActiveMemo(node.id)
    }
  }

  const openBlock = async (block: BlockRef) => {
    setActiveMemo(null)
    useUiStore.getState().setSidebarTab('library')
    await openEntryById(block.entryId, { annotationId: block.annotationId })
  }

  const clampNodePosition = (x: number, y: number) => ({
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  })

  const handleNodePointerDown = (node: GraphNode, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (linkDraft) {
      event.preventDefault()
      void completeLinkToNode(node)
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      key: node.key,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node.x,
      startY: node.y,
      moved: false,
    }
    setDraggingKey(node.key)
  }

  const handleNodePointerMove = (node: GraphNode, event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.key !== node.key || drag.pointerId !== event.pointerId) return
    const dx = (event.clientX - drag.startClientX) / zoom
    const dy = (event.clientY - drag.startClientY) / zoom
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    const nextPosition = clampNodePosition(drag.startX + dx, drag.startY + dy)
    setDraftPositions(prev => ({ ...prev, [node.key]: nextPosition }))
  }

  const finishNodeDrag = async (node: GraphNode, event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.key !== node.key || drag.pointerId !== event.pointerId) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
    const dx = (event.clientX - drag.startClientX) / zoom
    const dy = (event.clientY - drag.startClientY) / zoom
    const moved = drag.moved
    const nextPosition = clampNodePosition(drag.startX + dx, drag.startY + dy)
    dragRef.current = null
    setDraggingKey(null)
    if (moved) {
      setDraftPositions(prev => ({ ...prev, [node.key]: nextPosition }))
      await updateGraphNodePosition(node, nextPosition)
      return
    }
    setDraftPositions(prev => {
      const next = { ...prev }
      delete next[node.key]
      return next
    })
    handleSelectNode(node)
  }

  const cancelNodeDrag = (node: GraphNode) => {
    const drag = dragRef.current
    if (!drag || drag.key !== node.key) return
    dragRef.current = null
    setDraggingKey(null)
    setDraftPositions(prev => {
      const next = { ...prev }
      delete next[node.key]
      return next
    })
  }

  const handleCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan && pan.pointerId === event.pointerId) {
      setCamera({
        x: pan.startCameraX + event.clientX - pan.startClientX,
        y: pan.startCameraY + event.clientY - pan.startClientY,
      })
      return
    }
    if (!linkDraft) return
    const viewport = graphViewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const pointer = screenToWorld(event.clientX, event.clientY, rect, camera, zoom)
    setLinkDraft(prev => prev ? { ...prev, pointer } : prev)
  }

  const handleCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || linkDraft) return
    const target = event.target as Element
    if (target.closest('button, input, textarea, select, [data-graph-ui], [data-graph-node], [data-graph-edge]')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCameraX: camera.x,
      startCameraY: camera.y,
    }
    setIsPanning(true)
  }

  const finishCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    panRef.current = null
    setIsPanning(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the browser.
    }
  }

  const handleWhiteboardWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const viewport = graphViewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const worldX = (pointerX - camera.x) / zoom
    const worldY = (pointerY - camera.y) / zoom
    const nextZoom = Math.max(0.35, Math.min(2.5, zoom * (event.deltaY > 0 ? 0.92 : 1.08)))
    setZoom(nextZoom)
    setCamera({
      x: pointerX - worldX * nextZoom,
      y: pointerY - worldY * nextZoom,
    })
  }

  const linkDraftTarget: GraphNode | null = linkSourceNode && linkDraft
    ? { ...linkSourceNode, key: '__draft-target__', id: '__draft-target__', title: '', x: linkDraft.pointer.x, y: linkDraft.pointer.y }
    : null

  return (
    <div style={{ flex: 1, display: 'flex', minWidth: 0, background: 'var(--bg-warm)', overflow: 'hidden' }}>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-light)', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <GraphTitleSwitcher
                graphs={readingGraphs}
                activeGraph={activeReadingGraph}
                busy={busy}
                onCreate={handleCreateGraph}
                onSwitch={handleSwitchGraph}
                onRename={handleRenameGraph}
                onDelete={handleDeleteGraph}
              />
            </div>
            <div style={graphHeaderMetaStyle}>
              <span>围绕一个问题引入证据节点，用箭头线呈现理解推进。</span>
              <span style={graphHeaderSummaryStyle}>
                <span><strong style={graphHeaderSummaryValueStyle}>{graphNodeRefs.length}</strong> 个节点</span>
                <span>阅读 <strong style={graphHeaderSummaryValueStyle}>{formatDuration(totalReadingMs)}</strong></span>
                <span>写作 <strong style={graphHeaderSummaryValueStyle}>{formatDuration(totalWritingMs)}</strong></span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={topEntry?.title || `${graph.visibleEdges.length} 条路径线`}>
                  最投入 <strong style={graphHeaderSummaryValueStyle}>{topEntry && (topEntry.readingStats?.totalMs || 0) > 0 ? topEntry.title : `${graph.visibleEdges.length} 条路径线`}</strong>
                </span>
              </span>
            </div>
          </div>
          <div style={{ position: 'relative', width: 230, flexShrink: 0 }}>
            <input
              value={locateQuery}
              onFocus={() => setLocateOpen(true)}
              onBlur={() => window.setTimeout(() => setLocateOpen(false), 120)}
              onChange={event => {
                setLocateQuery(event.target.value)
                setLocateOpen(true)
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') locateNode()
                if (event.key === 'Escape') setLocateOpen(false)
              }}
              placeholder="定位节点"
              style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-warm)', color: 'var(--text)', outline: 'none', fontSize: 12 }}
            />
            {locateOpen && locateQuery.trim() && (
              <div style={locateResultsStyle}>
                {locateMatches.length === 0 ? (
                  <div style={{ padding: '9px 10px', color: 'var(--text-muted)', fontSize: 12 }}>没有匹配节点</div>
                ) : locateMatches.map(node => (
                  <button
                    key={node.key}
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => locateNode(node)}
                    style={locateResultItemStyle}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', color: 'var(--text)', fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.title}</span>
                      <span style={{ display: 'block', marginTop: 2, color: 'var(--text-muted)', fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nodeTypeLabel(node.type)} · {formatDuration(node.totalMs)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn-sm" disabled={!locateQuery.trim()} onClick={() => locateNode()}>定位</button>
          <button className="btn btn-sm" disabled={busy} onClick={() => setShowImportModal(true)}>
            引入节点
          </button>
          <button className="btn btn-sm" disabled={citationCandidates.length === 0 || busy} onClick={handleImportCitationLinks} title="只在已引入图谱的文献和笔记之间补入引用路径线">
            补入引用路径 {citationCandidates.length > 0 ? citationCandidates.length : ''}
          </button>
        </div>

        <div
          className="reading-graph-viewport"
          ref={graphViewportRef}
          onWheel={handleWhiteboardWheel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={finishCanvasPan}
          onPointerCancel={finishCanvasPan}
          style={graphViewportStyle(isPanning, !!linkDraft)}
        >
          <div
            style={graphCanvasStyle(graph.width, graph.height, zoom, camera)}
          >
            <svg width={graph.width} height={graph.height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} data-graph-plane="true">
              <defs>
                <marker id="reading-graph-arrow" markerWidth="13" markerHeight="12" refX="11" refY="6" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M 1 1.5 L 11.5 6 L 1 10.5 Z" fill="var(--reading-graph-arrow)" stroke="var(--reading-graph-arrow-mask)" strokeWidth="1.2" strokeLinejoin="round" />
                </marker>
                <marker id="reading-graph-arrow-active" markerWidth="13" markerHeight="12" refX="11" refY="6" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M 1 1.5 L 11.5 6 L 1 10.5 Z" fill="var(--accent-hover)" stroke="var(--reading-graph-arrow-mask)" strokeWidth="1.2" strokeLinejoin="round" />
                </marker>
              </defs>
              {graph.visibleEdges.map(edge => {
                const a = graph.nodeMap.get(nodeKey(edge.a))
                const b = graph.nodeMap.get(nodeKey(edge.b))
                if (!a || !b) return null
                const { from, to } = directedEdgeNodes(edge, a, b)
                const active = edge.id === activeEdgeId
                const recordCount = edgeRecordCount(edge)
                const width = active ? 2.45 : Math.min(1.7 + Math.max(0, recordCount - 1) * 0.18, 2.25)
                const path = edgePath(from, to)
                return (
                  <g
                    key={edge.id}
                    className="reading-graph-edge-group"
                    data-graph-edge="true"
                    style={{ cursor: 'pointer' }}
                    onClick={() => { setActiveEdgeId(edge.id); setSelectedKeys([]) }}
                  >
                    <path
                      className={`reading-graph-edge${active ? ' is-active' : ''}`}
                      d={path}
                      fill="none"
                      stroke={active ? 'var(--accent-hover)' : 'var(--reading-graph-edge)'}
                      strokeWidth={width}
                      strokeOpacity={active ? 0.95 : 1}
                      strokeLinecap="round"
                      markerEnd={active ? 'url(#reading-graph-arrow-active)' : 'url(#reading-graph-arrow)'}
                      pointerEvents="none"
                    />
                    <path
                      data-graph-edge="true"
                      d={path}
                      fill="none"
                      stroke="rgba(0,0,0,0.001)"
                      strokeWidth={30}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="stroke"
                      onClick={() => { setActiveEdgeId(edge.id); setSelectedKeys([]) }}
                    />
                  </g>
                )
              })}
              {linkSourceNode && linkDraftTarget && (
                <path
                  className="reading-graph-edge is-draft"
                  d={edgePath(linkSourceNode, linkDraftTarget)}
                  fill="none"
                  stroke="var(--accent-hover)"
                  strokeWidth={1.8}
                  strokeOpacity={0.58}
                  strokeLinecap="round"
                  markerEnd="url(#reading-graph-arrow-active)"
                  pointerEvents="none"
                />
              )}
            </svg>

            {graph.nodes.map(node => (
              <GraphNodeGlyph
                key={node.key}
                node={node}
                selected={selectedKeys.includes(node.key)}
                dragging={draggingKey === node.key}
                linking={!!linkDraft}
                linkSource={linkDraft?.fromKey === node.key}
                onSelect={() => handleSelectNode(node)}
                onOpen={() => openNode(node)}
                onContextMenu={event => startLinkFromNode(node, event)}
                onPointerDown={event => handleNodePointerDown(node, event)}
                onPointerMove={event => handleNodePointerMove(node, event)}
                onPointerUp={event => { void finishNodeDrag(node, event) }}
                onPointerCancel={() => cancelNodeDrag(node)}
              />
            ))}
          </div>
          {graph.nodes.length === 0 && (
            <div
              data-graph-ui="true"
              style={emptyGraphStyle}
              onPointerDown={event => event.stopPropagation()}
            >
              <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)' }}>
                {graphNodeRefs.length === 0 ? '还没有引入节点' : '没有匹配的节点'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                {graphNodeRefs.length === 0 ? '从几篇关键文献或一组笔记开始，图谱会更像你的阅读路径，而不是完整目录。' : '换个关键词，或继续引入新的文献和笔记。'}
              </div>
              <button className="btn btn-sm btn-primary" style={{ marginTop: 14 }} onClick={() => setShowImportModal(true)}>
                引入节点
              </button>
            </div>
          )}
          <div style={mapLegendStyle}>
            <span><i style={{ ...legendDotStyle, background: '#e2a461' }} />文献</span>
            <span><i style={{ ...legendDotStyle, background: '#76b8b2' }} />笔记</span>
          </div>
          <div style={graphHintStyle}>拖拽空白平移 · 滚轮缩放 · 右键节点连线</div>
        </div>
      </main>

      <aside style={{ width: 292, flexShrink: 0, borderLeft: '1px solid var(--border-light)', background: 'var(--bg)', padding: 14, overflow: 'auto' }}>
        <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8 }}>详情</div>
        {linkSourceNode && (
          <div style={{ padding: 10, border: '1px solid var(--accent)', borderRadius: 8, background: 'var(--bg-warm)', marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--accent-hover)', fontWeight: 650, marginBottom: 5 }}>正在建立路径线</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.65 }}>
              从 <strong>{linkSourceNode.title}</strong> 出发，点击另一个节点完成箭头线。
            </div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={cancelLinkDraft}>取消</button>
          </div>
        )}
        {activeEdge && (
          <EdgeDetail
            edge={activeEdge}
            nodeMap={graph.nodeMap}
            memos={memos}
            onOpenNode={openNode}
            onOpenBlock={block => { void openBlock(block) }}
            onAddEvent={(payload) => addGraphConnectionEvent(activeEdge.id, payload)}
            onUpdateEvent={(eventId, patch) => updateGraphConnectionEvent(activeEdge.id, eventId, patch)}
            onDeleteEvent={(eventId) => deleteGraphConnectionEvent(activeEdge.id, eventId)}
            onDelete={async () => { await deleteGraphConnection(activeEdge.id); setActiveEdgeId(null) }}
          />
        )}

        {activeNode && (
          <NodeDetail
            node={activeNode}
            edges={graph.visibleEdges}
            nodeMap={graph.nodeMap}
            onOpenNode={openNode}
            onOpen={() => openNode(activeNode)}
            onRemove={() => void handleRemoveNode(activeNode)}
          />
        )}

        {!activeEdge && !activeNode && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
            点击节点查看阅读或写作反馈。点击箭头线，可以查看这段路径由哪些原文、Memo 或记录推进而来。
          </div>
        )}
      </aside>

      {showImportModal && (
        <ImportNodesModal
          entries={entries}
          memos={memos}
          importedKeys={importedKeys}
          busy={busy}
          onClose={() => setShowImportModal(false)}
          onImport={handleImportNodes}
        />
      )}

    </div>
  )
}

function GraphTitleSwitcher({ graphs, activeGraph, busy, onCreate, onSwitch, onRename, onDelete }: {
  graphs: ReadingGraph[]
  activeGraph?: ReadingGraph
  busy: boolean
  onCreate: (name: string) => Promise<void>
  onSwitch: (id: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [pendingDeleteGraph, setPendingDeleteGraph] = useState<ReadingGraph | null>(null)
  const [deletingGraphId, setDeletingGraphId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const activeGraphId = activeGraph?.id

  const createGraph = async () => {
    const name = newName.trim() || `阅读图谱 ${graphs.length + 1}`
    await onCreate(name)
    setNewName('')
    setOpen(false)
  }

  const startRename = (graph: ReadingGraph) => {
    setEditingId(graph.id)
    setEditingName(graph.name)
  }

  const commitRename = async () => {
    if (!editingId || !editingName.trim()) return
    await onRename(editingId, editingName)
    setEditingId(null)
    setEditingName('')
  }

  const confirmDeleteGraph = async () => {
    if (!pendingDeleteGraph) return
    setDeletingGraphId(pendingDeleteGraph.id)
    await onDelete(pendingDeleteGraph.id)
    setDeletingGraphId(null)
    setPendingDeleteGraph(null)
  }

  return (
    <div
      style={graphSwitcherRootStyle}
      onBlur={event => {
        const nextFocus = event.relatedTarget as Node | null
        if (!nextFocus || !event.currentTarget.contains(nextFocus)) {
          setOpen(false)
          setEditingId(null)
        }
      }}
    >
      <button
        type="button"
        className="reading-graph-switcher-button"
        style={graphSwitcherButtonStyle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(prev => !prev)}
      >
        <span style={graphSwitcherTitleStyle}>{activeGraph?.name || '阅读图谱'}</span>
        <span style={graphSwitcherMetaStyle}>{graphs.length} 张图谱</span>
        <span style={graphSwitcherChevronStyle} aria-hidden="true" />
      </button>

      {open && (
        <div style={graphSwitcherMenuStyle}>
          <div style={graphSwitcherMenuHeaderStyle}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>切换图谱</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>选择问题空间，或新建一张空白图谱。</div>
            </div>
          </div>

          <div style={graphSwitcherCreateStyle}>
            <input
              value={newName}
              onChange={event => setNewName(event.target.value)}
              placeholder="新图谱名称"
              style={smallInputStyle}
              onKeyDown={event => {
                if (event.key === 'Enter') void createGraph()
              }}
            />
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void createGraph()}>新建</button>
          </div>

          <div style={graphSwitcherListStyle}>
            {graphs.map(graph => {
              const active = graph.id === activeGraphId
              const editing = graph.id === editingId
              return (
                <div key={graph.id} className="reading-graph-list-item" style={{ ...graphListItemStyle, borderColor: active ? 'var(--accent)' : 'var(--border-light)', background: active ? 'color-mix(in srgb, var(--accent-soft) 46%, var(--bg))' : 'transparent' }}>
                  {editing ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      <input
                        value={editingName}
                        autoFocus
                        onChange={event => setEditingName(event.target.value)}
                        style={{ ...smallInputStyle, width: '100%' }}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void commitRename()
                          if (event.key === 'Escape') setEditingId(null)
                        }}
                      />
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-sm btn-primary" disabled={busy || !editingName.trim()} onClick={() => void commitRename()}>保存</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => setEditingId(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <div style={graphListRowStyle}>
                      <button
                        type="button"
                        disabled={busy || active}
                        onClick={() => {
                          void onSwitch(graph.id)
                          setOpen(false)
                        }}
                        style={graphTitleButtonStyle}
                      >
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{graph.name}</span>
                        <span style={graphInlineMetaStyle}>{graph.nodes.length} 节点 · {graph.edges.length} 路径</span>
                        {active && <span style={graphCurrentBadgeStyle}>当前</span>}
                      </button>
                      <div style={graphInlineActionsStyle}>
                        <button className="btn btn-sm" disabled={busy} style={compactGraphActionStyle} onClick={() => startRename(graph)}>重命名</button>
                        <button className="btn btn-sm" disabled={busy} style={{ ...compactGraphActionStyle, color: 'var(--danger)' }} onClick={() => setPendingDeleteGraph(graph)}>删除</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {pendingDeleteGraph && (
        <ConfirmDialog
          title="删除图谱"
          body={`删除“${pendingDeleteGraph.name}”？这只会删除这张图谱里的节点和路径线，不会删除文献或笔记。`}
          confirmLabel="删除图谱"
          busy={deletingGraphId === pendingDeleteGraph.id}
          onCancel={() => setPendingDeleteGraph(null)}
          onConfirm={() => { void confirmDeleteGraph() }}
        />
      )}
    </div>
  )
}

function GraphNodeGlyph({
  node,
  selected,
  dragging,
  linking,
  linkSource,
  onSelect,
  onOpen,
  onContextMenu,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  node: GraphNode
  selected: boolean
  dragging: boolean
  linking: boolean
  linkSource: boolean
  onSelect: () => void
  onOpen: () => void
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: () => void
}) {
  const isEntry = node.type === 'entry'
  const size = Math.min(34, Math.max(20, 20 + Math.sqrt(Math.max(node.totalMs, 0) / 60000) * 1.5))
  const labelOnRight = node.x < 460
  const labelLeft = labelOnRight ? size + 10 : -190
  const labelAlign: CSSProperties['textAlign'] = labelOnRight ? 'left' : 'right'
  return (
    <div
      className={`reading-graph-node${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${linkSource ? ' is-link-source' : ''}`}
      role="button"
      tabIndex={0}
      data-graph-node="true"
      title={linking ? (linkSource ? '点击可取消当前路径线' : '点击连接到这个节点') : '右键从这里建立路径线'}
      style={{ position: 'absolute', left: node.x - size / 2, top: node.y - size / 2, width: size, height: size, outline: 'none', cursor: dragging ? 'grabbing' : linking ? 'crosshair' : 'grab', touchAction: 'none', zIndex: dragging || selected || linkSource ? 3 : 2 }}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDoubleClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter') onSelect()
      }}
    >
      <div style={nodeOrbitStyle(node, selected || dragging || linkSource, size)}>
        <span style={nodeCoreStyle(node, selected || dragging || linkSource, size)} />
      </div>
      <div style={{ position: 'absolute', left: labelLeft, top: -4, width: 180, textAlign: labelAlign, pointerEvents: 'none', textShadow: '0 1px 2px var(--reading-graph-label-halo, rgba(247,242,228,0.9))' }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.32, fontWeight: 640, color: selected || dragging || linkSource ? 'var(--accent-hover)' : 'var(--text)', maxHeight: 34, overflow: 'hidden' }}>
          {node.title}
        </div>
        <div style={{ marginTop: 3, fontSize: 10.5, color: isEntry ? '#a66d3c' : '#557d7f', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {isEntry ? '文献' : '笔记'} · {formatDuration(node.totalMs)}
        </div>
      </div>
    </div>
  )
}

function EdgeDetail({ edge, nodeMap, memos, onOpenNode, onOpenBlock, onAddEvent, onUpdateEvent, onDeleteEvent, onDelete }: {
  edge: ReadingGraphEdge
  nodeMap: Map<string, GraphNode>
  memos: Memo[]
  onOpenNode: (node: GraphNode) => void
  onOpenBlock: (block: BlockRef) => void
  onAddEvent: (payload: { title?: string; note?: string }) => Promise<void>
  onUpdateEvent: (eventId: string, patch: { title?: string; note?: string }) => Promise<void>
  onDeleteEvent: (eventId: string) => Promise<void>
  onDelete: () => void | Promise<void>
}) {
  const a = nodeMap.get(nodeKey(edge.a))
  const b = nodeMap.get(nodeKey(edge.b))
  const entryRef = edge.a.type === 'entry' ? edge.a : edge.b.type === 'entry' ? edge.b : null
  const memoRef = edge.a.type === 'memo' ? edge.a : edge.b.type === 'memo' ? edge.b : null
  const memo = memoRef ? memos.find(item => item.id === memoRef.id) : null
  const linkedBlocks = entryRef && memo
    ? (memo.blocks || []).filter(block => block.entryId === entryRef.id)
    : []
  const fallbackNodes = [a, b].filter((node): node is GraphNode => !!node)
  const direction = a && b ? directedEdgeNodes(edge, a, b) : null
  const recordCount = edgeRecordCount(edge)
  const progressEvents = edgeProgressEvents(edge)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [showNewEvent, setShowNewEvent] = useState(false)
  const [savingEventId, setSavingEventId] = useState<string | null>(null)
  const [selectingRecords, setSelectingRecords] = useState(false)
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(() => new Set())
  const [pendingDeleteEventIds, setPendingDeleteEventIds] = useState<string[]>([])
  const [deletingEvents, setDeletingEvents] = useState(false)
  const [confirmDeletePath, setConfirmDeletePath] = useState(false)
  const [deletingPath, setDeletingPath] = useState(false)

  const startEditEvent = (event: ReadingGraphEdge['events'][number]) => {
    setShowNewEvent(false)
    setEditingEventId(event.id)
    setDraftTitle(event.title || sourceLabel(event.source))
    setDraftNote(event.note || '')
  }

  const startNewEvent = () => {
    setEditingEventId(null)
    setShowNewEvent(true)
    setSelectingRecords(false)
    setDraftTitle('')
    setDraftNote('')
  }

  const cancelEventEdit = () => {
    setEditingEventId(null)
    setShowNewEvent(false)
    setDraftTitle('')
    setDraftNote('')
    setSavingEventId(null)
  }

  const saveExistingEvent = async (eventId: string) => {
    setSavingEventId(eventId)
    await onUpdateEvent(eventId, {
      title: draftTitle.trim(),
      note: draftNote,
    })
    cancelEventEdit()
  }

  const saveNewEvent = async () => {
    setSavingEventId('__new__')
    await onAddEvent({
      title: draftTitle.trim(),
      note: draftNote,
    })
    cancelEventEdit()
  }

  const toggleRecordSelection = (eventId: string) => {
    setSelectedEventIds(prev => {
      const next = new Set(prev)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }

  const confirmDeleteEvents = async () => {
    if (pendingDeleteEventIds.length === 0) return
    setDeletingEvents(true)
    for (const eventId of pendingDeleteEventIds) {
      setSavingEventId(eventId)
      await onDeleteEvent(eventId)
    }
    if (editingEventId && pendingDeleteEventIds.includes(editingEventId)) cancelEventEdit()
    setSavingEventId(null)
    setDeletingEvents(false)
    setPendingDeleteEventIds([])
    setSelectedEventIds(new Set())
    setSelectingRecords(false)
  }

  const confirmDeleteLine = async () => {
    setDeletingPath(true)
    await onDelete()
    setDeletingPath(false)
    setConfirmDeletePath(false)
  }

  const renderEventEditor = (onSave: () => void, saving: boolean) => (
    <div style={{ padding: 9, border: '1px solid var(--accent)', borderRadius: 8, background: 'var(--bg-warm)', marginBottom: 7 }}>
      <input
        value={draftTitle}
        onChange={event => setDraftTitle(event.target.value)}
        placeholder="记录标题"
        style={{ width: '100%', padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', fontSize: 12, marginBottom: 7 }}
      />
      <textarea
        value={draftNote}
        onChange={event => setDraftNote(event.target.value)}
        placeholder="写下这条路径为什么成立、它推进了哪个问题。"
        rows={4}
        style={{ width: '100%', resize: 'vertical', minHeight: 92, padding: '8px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', fontSize: 12, lineHeight: 1.65, fontFamily: 'inherit' }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 8 }}>
        <button className="btn btn-sm" disabled={saving} onClick={cancelEventEdit}>取消</button>
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={onSave}>{saving ? '保存中' : '保存'}</button>
      </div>
    </div>
  )

  return (
    <div>
      <div style={pathCardStyle}>
        <div style={pathCardHeaderStyle}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>路径片段</div>
          <button type="button" className="reading-graph-soft-danger" style={subtleDangerButtonStyle} onClick={() => setConfirmDeletePath(true)}>删除</button>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{direction?.from.title || a?.title || nodeKey(edge.a)}</div>
        <div style={{ fontSize: 11, color: 'var(--accent)', margin: '5px 0' }}>→ 推进记录 {recordCount} 次</div>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{direction?.to.title || b?.title || nodeKey(edge.b)}</div>
      </div>
      <DetailRow label="创建" value={formatDate(edge.createdAt)} />
      <DetailRow label="最近推进" value={formatDate(edge.updatedAt)} />

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 650 }}>证据入口</div>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{linkedBlocks.length || fallbackNodes.length} 个</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
        {linkedBlocks.length > 0 ? linkedBlocks.map((block, index) => (
          <button
            key={block.historyEntryId}
            type="button"
            className="btn btn-sm"
            style={evidenceButtonStyle}
            onClick={() => onOpenBlock(block)}
            title={block.selectedText ? excerptText(block.selectedText, 72) : '打开原文批注'}
          >
            <span style={evidenceButtonTextStyle}>
              原文 {index + 1}{block.selectedText ? ` · ${excerptText(block.selectedText, 18)}` : ''}
            </span>
          </button>
        )) : fallbackNodes.map(node => (
          <button
            key={node.key}
            type="button"
            className="btn btn-sm"
            style={evidenceButtonStyle}
            onClick={() => onOpenNode(node)}
            title={`打开${nodeTypeLabel(node.type)}：${node.title}`}
          >
            <span style={evidenceButtonTextStyle}>{nodeTypeLabel(node.type)} · {node.title}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 650 }}>推进记录</div>
        <div style={recordToolbarStyle}>
          {selectingRecords && selectedEventIds.size > 0 && (
            <button
              type="button"
              className="reading-graph-soft-danger"
              style={recordDeleteSelectedStyle}
              onClick={() => setPendingDeleteEventIds(Array.from(selectedEventIds))}
            >
              删除 {selectedEventIds.size}
            </button>
          )}
          <button type="button" className="reading-graph-soft-action" title="新增推进记录" aria-label="新增推进记录" style={recordIconButtonStyle} onClick={startNewEvent}>+</button>
          {progressEvents.length > 0 && (
            <button
              type="button"
              className="reading-graph-soft-action"
              style={{
                ...recordTextButtonStyle,
                color: selectingRecords ? 'var(--accent-hover)' : 'var(--text-muted)',
                borderColor: selectingRecords ? 'var(--accent)' : 'var(--border-light)',
                background: selectingRecords ? 'var(--accent-soft)' : 'transparent',
              }}
              onClick={() => {
                setSelectingRecords(prev => !prev)
                setSelectedEventIds(new Set())
                setShowNewEvent(false)
                setEditingEventId(null)
              }}
            >
              {selectingRecords ? '完成' : '选择'}
            </button>
          )}
        </div>
      </div>
      <div style={{ marginTop: 7 }}>
        {showNewEvent && renderEventEditor(() => { void saveNewEvent() }, savingEventId === '__new__')}
        {progressEvents.map(event => {
          const editing = editingEventId === event.id
          const title = event.title || ''
          const note = event.note || ''
          return editing ? (
            <div key={event.id}>
              {renderEventEditor(() => { void saveExistingEvent(event.id) }, savingEventId === event.id)}
            </div>
          ) : selectingRecords ? (
            <label
              key={event.id}
              className="reading-graph-record-card"
              style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 8, alignItems: 'flex-start', padding: 9, border: '1px solid var(--border-light)', borderRadius: 8, background: selectedEventIds.has(event.id) ? 'var(--accent-soft)' : 'var(--bg-warm)', marginBottom: 7, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={selectedEventIds.has(event.id)}
                onChange={() => toggleRecordSelection(event.id)}
                style={{ marginTop: 2, accentColor: 'var(--accent)' }}
              />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: note ? 5 : 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: title ? 'var(--text)' : 'var(--text-muted)' }}>{title || '空白推进记录'}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>{formatDate(event.createdAt)}</span>
                </span>
                {note && (
                  <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.65 }}>
                    {excerptText(note, 110)}
                  </span>
                )}
              </span>
            </label>
          ) : (
            <div key={event.id} className="reading-graph-record-card" style={{ padding: 9, border: '1px solid var(--border-light)', borderRadius: 8, background: 'var(--bg-warm)', marginBottom: 7 }}>
              <button
                type="button"
                onClick={() => startEditEvent(event)}
                style={{ display: 'block', width: '100%', border: 0, background: 'transparent', color: 'var(--text)', textAlign: 'left', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: title ? 'var(--text)' : 'var(--text-muted)' }}>{title || '空白推进记录'}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>{formatDate(event.createdAt)}</span>
                </div>
                {note && (
                  <div style={{ color: 'var(--text-secondary)', fontSize: 11.5, lineHeight: 1.65 }}>
                    {excerptText(note, 110)}
                  </div>
                )}
              </button>
            </div>
          )
        })}
      </div>
      {pendingDeleteEventIds.length > 0 && (
        <ConfirmDialog
          title={pendingDeleteEventIds.length > 1 ? '删除推进记录' : '删除这条推进记录'}
          body={pendingDeleteEventIds.length > 1 ? `确定删除选中的 ${pendingDeleteEventIds.length} 条推进记录？` : '删除后，这条推进记录不会再出现在路径线详情中。'}
          confirmLabel={pendingDeleteEventIds.length > 1 ? `删除 ${pendingDeleteEventIds.length} 条` : '删除记录'}
          busy={deletingEvents}
          onCancel={() => setPendingDeleteEventIds([])}
          onConfirm={() => { void confirmDeleteEvents() }}
        />
      )}
      {confirmDeletePath && (
        <ConfirmDialog
          title="删除路径线"
          body="这会移除这条路径线和其中的推进记录，文献与笔记本身不会被删除。"
          confirmLabel="删除路径线"
          busy={deletingPath}
          onCancel={() => setConfirmDeletePath(false)}
          onConfirm={() => { void confirmDeleteLine() }}
        />
      )}
    </div>
  )
}

function NodeDetail({ node, edges, nodeMap, onOpenNode, onOpen, onRemove }: {
  node: GraphNode
  edges: ReadingGraphEdge[]
  nodeMap: Map<string, GraphNode>
  onOpenNode: (node: GraphNode) => void
  onOpen: () => void
  onRemove: () => void
}) {
  const related = edges.filter(edge => sameNode(edge.a, node) || sameNode(edge.b, node))
  const durationLabel = node.type === 'entry' ? '累计阅读' : '累计写作'
  const sessionLabel = node.type === 'entry' ? '阅读次数' : '写作次数'
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 650, lineHeight: 1.5, marginBottom: 8 }}>{node.title}</div>
      <DetailRow label="类型" value={node.type === 'entry' ? '文献' : '笔记'} />
      <DetailRow label={durationLabel} value={formatDuration(node.totalMs)} />
      <DetailRow label="最近一次" value={formatDuration(node.lastSessionMs)} />
      <DetailRow label={sessionLabel} value={node.sessionCount} />
      <DetailRow label="最近活动" value={formatDate(node.lastAt)} />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-sm btn-primary" onClick={onOpen}>打开</button>
        <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={onRemove}>移出图谱</button>
      </div>

      <div style={{ marginTop: 18, fontSize: 12, fontWeight: 600 }}>前后节点</div>
      {related.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>还没有路径线。</div>
      ) : related.map(edge => {
        const otherRef = sameNode(edge.a, node) ? edge.b : edge.a
        const other = nodeMap.get(nodeKey(otherRef))
        const direction = other ? directedEdgeNodes(edge, node, other) : null
        const directionLabel = direction?.from.key === node.key ? '下一步' : '上一步'
        const recordCount = edgeRecordCount(edge)
        return (
          <button
            key={edge.id}
            type="button"
            onClick={() => { if (other) onOpenNode(other) }}
            disabled={!other}
            style={{
              width: '100%', padding: '8px 0', border: 0, borderBottom: '1px solid var(--border-light)',
              background: 'transparent', textAlign: 'left', fontSize: 12, cursor: other ? 'pointer' : 'default',
              color: 'var(--text)',
            }}
          >
            <div style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{other?.title || nodeKey(otherRef)}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 2 }}>{directionLabel} · 推进记录 {recordCount} 次 · 点击打开</div>
          </button>
        )
      })}
    </div>
  )
}

function GraphManagerModal({ graphs, activeGraphId, busy, onClose, onCreate, onSwitch, onRename, onDelete }: {
  graphs: ReadingGraph[]
  activeGraphId?: string
  busy: boolean
  onClose: () => void
  onCreate: (name: string) => Promise<void>
  onSwitch: (id: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const startRename = (graph: ReadingGraph) => {
    setEditingId(graph.id)
    setEditingName(graph.name)
  }

  const commitRename = async () => {
    if (!editingId || !editingName.trim()) return
    await onRename(editingId, editingName)
    setEditingId(null)
    setEditingName('')
  }

  const createGraph = async () => {
    const name = newName.trim()
    await onCreate(name || `阅读图谱 ${graphs.length + 1}`)
    setNewName('')
  }

  const confirmDeleteGraph = async () => {
    if (!pendingDeleteGraph) return
    setDeletingGraphId(pendingDeleteGraph.id)
    await onDelete(pendingDeleteGraph.id)
    setDeletingGraphId(null)
    setPendingDeleteGraph(null)
  }

  return (
    <div style={modalBackdropStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 560 }} onClick={event => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>图谱管理</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>创建不同主题的阅读图谱，并切换当前正在编辑的那一张。</div>
          </div>
          <button className="btn btn-icon" onClick={onClose} title="关闭">×</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={newName}
            onChange={event => setNewName(event.target.value)}
            placeholder="新图谱名称"
            style={{ flex: 1, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-warm)', color: 'var(--text)', outline: 'none', fontSize: 12 }}
            onKeyDown={event => {
              if (event.key === 'Enter') void createGraph()
            }}
          />
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void createGraph()}>新建图谱</button>
        </div>

        <div style={{ border: '1px solid var(--border-light)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg)' }}>
          {graphs.map(graph => {
            const active = graph.id === activeGraphId
            const editing = graph.id === editingId
            return (
              <div key={graph.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--border-light)', background: active ? 'var(--bg-warm)' : 'var(--bg)' }}>
                <div style={{ minWidth: 0 }}>
                  {editing ? (
                    <input
                      value={editingName}
                      onChange={event => setEditingName(event.target.value)}
                      autoFocus
                      style={{ width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', fontSize: 12 }}
                      onKeyDown={event => {
                        if (event.key === 'Enter') void commitRename()
                        if (event.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {graph.name}
                        {active && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--accent-hover)' }}>当前</span>}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
                        {graph.nodes.length} 个节点 · {graph.edges.length} 条路径线 · 更新于 {formatDate(graph.updatedAt)}
                      </div>
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {editing ? (
                    <>
                      <button className="btn btn-sm btn-primary" disabled={busy || !editingName.trim()} onClick={() => void commitRename()}>保存</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => setEditingId(null)}>取消</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-sm" disabled={busy || active} onClick={() => void onSwitch(graph.id)}>打开</button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => startRename(graph)}>重命名</button>
                      <button className="btn btn-sm" disabled={busy} style={{ color: 'var(--danger)' }} onClick={() => setPendingDeleteGraph(graph)}>删除</button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {pendingDeleteGraph && (
          <ConfirmDialog
            title="删除图谱"
            body={`删除“${pendingDeleteGraph.name}”？这只会删除这张图谱里的节点和路径线，不会删除文献或笔记。`}
            confirmLabel="删除图谱"
            busy={deletingGraphId === pendingDeleteGraph.id}
            onCancel={() => setPendingDeleteGraph(null)}
            onConfirm={() => { void confirmDeleteGraph() }}
          />
        )}
      </div>
    </div>
  )
}

function ImportNodesModal({ entries, memos, importedKeys, busy, onClose, onImport }: {
  entries: LibraryEntry[]
  memos: Memo[]
  importedKeys: Set<string>
  busy: boolean
  onClose: () => void
  onImport: (nodes: ReadingGraphNodeRef[]) => Promise<void>
}) {
  const [tab, setTab] = useState<ReadingGraphNodeType>('entry')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set())

  const items = useMemo<ImportListItem[]>(() => {
    const entryItems = entries.map(entry => ({
      type: 'entry' as const,
      id: entry.id,
      key: `entry:${entry.id}`,
      title: entry.title || '未命名文献',
      meta: entry.authors.length > 0 ? entry.authors.slice(0, 3).join(' / ') : entry.tags.slice(0, 3).join(' / ') || '文献',
      searchText: `${entry.title} ${entry.authors.join(' ')} ${entry.tags.join(' ')}`.toLowerCase(),
    }))
    const memoItems = memos.map(memo => ({
      type: 'memo' as const,
      id: memo.id,
      key: `memo:${memo.id}`,
      title: memo.title || '未命名笔记',
      meta: memo.content.trim().slice(0, 42) || '笔记',
      searchText: `${memo.title} ${memo.content}`.toLowerCase(),
    }))
    return [...entryItems, ...memoItems]
  }, [entries, memos])

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(item => item.type === tab && (!q || item.searchText.includes(q)))
  }, [items, query, tab])

  const selectedRefs = useMemo<ReadingGraphNodeRef[]>(() => {
    return Array.from(picked).map(key => {
      const [type, id] = key.split(':')
      return { type: type as ReadingGraphNodeType, id }
    })
  }, [picked])

  const toggleItem = (item: ImportListItem) => {
    if (importedKeys.has(item.key)) return
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(item.key)) next.delete(item.key)
      else next.add(item.key)
      return next
    })
  }

  const selectVisible = () => {
    setPicked(prev => {
      const next = new Set(prev)
      for (const item of visibleItems) {
        if (!importedKeys.has(item.key)) next.add(item.key)
      }
      return next
    })
  }

  const clearPicked = () => setPicked(new Set())

  return (
    <div style={modalBackdropStyle} onClick={onClose}>
      <div style={modalStyle} onClick={event => event.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>引入节点</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>默认多选。只把你想经营的文献和笔记放进这张图。</div>
          </div>
          <button className="btn btn-icon" onClick={onClose} title="关闭">×</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button className={`btn btn-sm ${tab === 'entry' ? 'btn-primary' : ''}`} onClick={() => setTab('entry')}>文献</button>
          <button className={`btn btn-sm ${tab === 'memo' ? 'btn-primary' : ''}`} onClick={() => setTab('memo')}>笔记</button>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索标题、作者或内容"
            style={{ marginLeft: 'auto', width: 220, padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-warm)', color: 'var(--text)', outline: 'none', fontSize: 12 }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <button className="btn btn-sm" onClick={selectVisible}>全选当前结果</button>
          <button className="btn btn-sm" onClick={clearPicked} disabled={picked.size === 0}>清空选择</button>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>已选 {picked.size} 个</span>
        </div>

        <div style={{ maxHeight: 390, overflow: 'auto', border: '1px solid var(--border-light)', borderRadius: 8, background: 'var(--bg)' }}>
          {visibleItems.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>没有找到可引入的节点。</div>
          ) : visibleItems.map(item => {
            const alreadyImported = importedKeys.has(item.key)
            const checked = picked.has(item.key)
            return (
              <label key={item.key} style={{ display: 'grid', gridTemplateColumns: '26px 1fr auto', gap: 10, alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--border-light)', cursor: alreadyImported ? 'default' : 'pointer', opacity: alreadyImported ? 0.48 : 1 }}>
                <input type="checkbox" checked={checked || alreadyImported} disabled={alreadyImported} onChange={() => toggleItem(item)} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span>
                  <span style={{ display: 'block', marginTop: 3, fontSize: 10.5, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.meta}</span>
                </span>
                <span style={{ fontSize: 10.5, color: alreadyImported ? 'var(--success)' : 'var(--text-muted)' }}>{alreadyImported ? '已在图谱' : item.type === 'entry' ? '文献' : '笔记'}</span>
              </label>
            )
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button className="btn btn-sm btn-primary" disabled={selectedRefs.length === 0 || busy} onClick={() => void onImport(selectedRefs)}>
            引入 {selectedRefs.length} 个
          </button>
        </div>
      </div>
    </div>
  )
}

const graphSwitcherRootStyle: CSSProperties = {
  position: 'relative',
  minWidth: 0,
  maxWidth: 'min(520px, 100%)',
  zIndex: 40,
}

const graphSwitcherButtonStyle: CSSProperties = {
  minWidth: 0,
  maxWidth: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '2px 4px 2px 0',
  border: 0,
  background: 'transparent',
  color: 'var(--text)',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const graphSwitcherTitleStyle: CSSProperties = {
  minWidth: 0,
  maxWidth: 360,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  fontSize: 16,
  lineHeight: '22px',
  fontWeight: 700,
}

const graphSwitcherMetaStyle: CSSProperties = {
  flexShrink: 0,
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: '16px',
}

const graphSwitcherChevronStyle: CSSProperties = {
  width: 5,
  height: 7,
  flexShrink: 0,
  display: 'inline-block',
  borderRight: '1.5px solid var(--text-muted)',
  borderBottom: '1.5px solid var(--text-muted)',
  transform: 'rotate(45deg)',
  marginLeft: 0,
  marginTop: -4,
}

const graphSwitcherMenuStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 'calc(100% + 8px)',
  width: 360,
  maxWidth: 'calc(100vw - 40px)',
  padding: 8,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--bg) 94%, var(--bg-warm))',
  boxShadow: '0 18px 46px rgba(45,35,24,0.18)',
  backdropFilter: 'blur(12px)',
}

const graphSwitcherMenuHeaderStyle: CSSProperties = {
  padding: '8px 9px 9px',
  borderBottom: '1px solid var(--border-light)',
  marginBottom: 8,
}

const graphSwitcherCreateStyle: CSSProperties = {
  display: 'flex',
  gap: 7,
  margin: '0 2px 8px',
}

const graphSwitcherListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  maxHeight: 320,
  overflow: 'auto',
}

const smallInputStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  padding: '7px 9px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--text)',
  outline: 'none',
  fontSize: 12,
}

const graphListItemStyle: CSSProperties = {
  padding: '7px 8px',
  border: '1px solid var(--border-light)',
  borderRadius: 7,
  minWidth: 0,
}

const graphListRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const graphTitleButtonStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  padding: 0,
  background: 'transparent',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: 7,
  fontSize: 12.5,
  fontWeight: 650,
  color: 'var(--text)',
  textAlign: 'left',
  cursor: 'pointer',
}

const graphInlineMetaStyle: CSSProperties = {
  flexShrink: 0,
  color: 'var(--text-muted)',
  fontSize: 10,
  fontWeight: 500,
}

const graphCurrentBadgeStyle: CSSProperties = {
  flexShrink: 0,
  padding: '1px 5px',
  borderRadius: 999,
  background: 'var(--accent-soft)',
  color: 'var(--accent-hover)',
  fontSize: 10,
  fontWeight: 650,
}

const graphInlineActionsStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
}

const compactGraphActionStyle: CSSProperties = {
  minHeight: 24,
  padding: '2px 7px',
  fontSize: 11,
  borderRadius: 6,
}

function graphViewportStyle(isPanning: boolean, linking: boolean): CSSProperties {
  return {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
    background: 'var(--reading-graph-bg, var(--bg))',
    backgroundImage: 'radial-gradient(var(--reading-graph-grid, rgba(126,103,72,0.18)) 1px, transparent 1px)',
    backgroundSize: '28px 28px',
    cursor: isPanning ? 'grabbing' : linking ? 'crosshair' : 'grab',
    touchAction: 'none',
    isolation: 'isolate',
  }
}

function graphCanvasStyle(width: number, height: number, zoom = 1, camera: GraphCamera = { x: 0, y: 0 }): CSSProperties {
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height,
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})`,
    transformOrigin: '0 0',
    background: 'transparent',
    overflow: 'visible',
    willChange: 'transform',
    zIndex: 1,
  }
}

function nodeOrbitStyle(node: GraphNode, selected: boolean, size: number): CSSProperties {
  const isEntry = node.type === 'entry'
  const color = isEntry ? '196, 137, 76' : '100, 154, 153'
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    background: `rgba(${color}, ${selected ? 0.18 : 0.11})`,
    border: selected ? '1px solid rgba(200,149,108,0.58)' : '1px solid rgba(255,255,255,0.34)',
    boxShadow: selected
      ? `0 0 0 4px rgba(${color},0.14), 0 0 26px rgba(${color},0.34), 0 8px 18px rgba(54,42,27,0.18)`
      : `0 0 18px rgba(${color},0.20), 0 5px 14px rgba(54,42,27,0.13)`,
    cursor: 'pointer',
    transition: 'transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease',
  }
}

function nodeCoreStyle(node: GraphNode, selected: boolean, size: number): CSSProperties {
  const isEntry = node.type === 'entry'
  const color = isEntry ? '#c98f55' : '#6b9d9d'
  const darkColor = isEntry ? '#9f6837' : '#4d7e7e'
  return {
    width: Math.max(8, size * 0.48),
    height: Math.max(8, size * 0.48),
    borderRadius: '50%',
    background: color,
    border: '2px solid var(--reading-graph-node-ring, var(--bg))',
    boxShadow: selected
      ? `inset 0 0 0 1px rgba(255,255,255,0.28), 0 0 0 2px ${darkColor}`
      : 'inset 0 0 0 1px rgba(255,255,255,0.22)',
  }
}

const emptyGraphStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  width: 360,
  textAlign: 'center',
  padding: 18,
  border: '1px solid var(--border-light)',
  borderRadius: 8,
  background: 'var(--bg)',
  boxShadow: 'var(--shadow-sm)',
  zIndex: 5,
}

const mapLegendStyle: CSSProperties = {
  position: 'absolute',
  left: 18,
  top: 16,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 9px',
  border: '1px solid var(--border-light)',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--bg) 78%, transparent)',
  backdropFilter: 'blur(8px)',
  fontSize: 11,
  fontWeight: 650,
  color: 'var(--text-muted)',
  letterSpacing: 0,
  zIndex: 4,
  pointerEvents: 'none',
}

const graphHintStyle: CSSProperties = {
  position: 'absolute',
  left: 18,
  bottom: 16,
  padding: '6px 9px',
  border: '1px solid var(--border-light)',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--bg) 78%, transparent)',
  backdropFilter: 'blur(8px)',
  color: 'var(--text-muted)',
  fontSize: 11,
  pointerEvents: 'none',
  zIndex: 4,
}

const evidenceButtonStyle: CSSProperties = {
  maxWidth: 218,
  minWidth: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
}

const evidenceButtonTextStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const pathCardStyle: CSSProperties = {
  padding: '10px 12px 11px',
  border: '1px solid var(--border-light)',
  borderRadius: 8,
  background: 'color-mix(in srgb, var(--bg-warm) 76%, var(--bg))',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.28)',
}

const pathCardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 7,
}

const subtleDangerButtonStyle: CSSProperties = {
  minHeight: 26,
  padding: '0 7px',
  border: '1px solid transparent',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--text-muted)',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const recordToolbarStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  minHeight: 34,
}

const recordIconButtonStyle: CSSProperties = {
  width: 32,
  minWidth: 32,
  height: 32,
  padding: 0,
  border: '1px solid var(--border-light)',
  borderRadius: '50%',
  background: 'color-mix(in srgb, var(--bg) 68%, transparent)',
  color: 'var(--text-secondary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const recordTextButtonStyle: CSSProperties = {
  height: 32,
  padding: '0 10px',
  border: '1px solid var(--border-light)',
  borderRadius: 999,
  background: 'transparent',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const recordDeleteSelectedStyle: CSSProperties = {
  ...recordTextButtonStyle,
  color: 'var(--danger)',
  borderColor: 'rgba(201,112,112,0.28)',
  background: 'rgba(201,112,112,0.07)',
}

const iconOnlyButtonStyle: CSSProperties = {
  width: 30,
  minWidth: 30,
  height: 30,
  padding: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 18,
  lineHeight: 1,
}

const locateResultsStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  zIndex: 30,
  maxHeight: 280,
  overflow: 'auto',
  padding: 4,
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--bg)',
  boxShadow: '0 12px 32px rgba(45,35,24,0.16)',
}

const locateResultItemStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  display: 'block',
  padding: '8px 9px',
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
}

const confirmDialogStyle: CSSProperties = {
  width: 392,
  maxWidth: 'calc(100vw - 44px)',
  display: 'grid',
  gridTemplateColumns: '34px 1fr',
  gap: 12,
  padding: 16,
  borderRadius: 10,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  boxShadow: '0 18px 54px rgba(45,35,24,0.22)',
}

const confirmIconStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(201,112,112,0.12)',
  color: 'var(--danger)',
  border: '1px solid rgba(201,112,112,0.32)',
  fontWeight: 800,
}

const legendDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 7,
  height: 7,
  borderRadius: '50%',
  marginRight: 6,
}

const modalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 80,
  background: 'rgba(34, 29, 24, 0.28)',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
}

const modalStyle: CSSProperties = {
  width: 660,
  maxWidth: 'calc(100vw - 48px)',
  maxHeight: 'calc(100vh - 48px)',
  overflow: 'hidden',
  padding: 16,
  borderRadius: 8,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  boxShadow: '0 24px 80px rgba(45,35,24,0.22)',
}

const graphHeaderMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '4px 12px',
  marginTop: 3,
  minWidth: 0,
  color: 'var(--text-muted)',
  fontSize: 11,
  lineHeight: 1.55,
}

const graphHeaderSummaryStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '4px 10px',
  minWidth: 0,
  color: 'var(--text-muted)',
}

const graphHeaderSummaryValueStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontWeight: 650,
}
