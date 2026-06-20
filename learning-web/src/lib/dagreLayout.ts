import dagre from '@dagrejs/dagre'
import type { Node as FlowNode, Edge as FlowEdge } from 'reactflow'

export interface DagreLayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  rankSep?: number
  nodeSep?: number
  edgeSep?: number
  rankDir?: 'TB' | 'LR' | 'BT' | 'RL'
}

/**
 * 使用 dagre 层次布局算法为 ReactFlow 节点计算位置。
 * 需要边信息来确定节点间的拓扑关系和层次。
 */
export function applyDagreLayout(
  nodes: FlowNode[],
  edges: FlowEdge[],
  opts: DagreLayoutOptions = {},
): FlowNode[] {
  const nw = opts.nodeWidth ?? 220
  const nh = opts.nodeHeight ?? 36

  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: opts.rankDir ?? 'LR',
    nodesep: opts.nodeSep ?? 40,
    ranksep: opts.rankSep ?? 80,
    edgesep: opts.edgeSep ?? 10,
    marginx: 40,
    marginy: 40,
  })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    g.setNode(node.id, { width: nw, height: nh })
  }

  for (const edge of edges) {
    // 只添加两端节点都存在的边（避免 dagre 报错）
    if (
      nodes.some(n => n.id === edge.source) &&
      nodes.some(n => n.id === edge.target)
    ) {
      g.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(g)

  return nodes.map(node => {
    const pos = g.node(node.id)
    if (!pos) return node
    return {
      ...node,
      position: { x: pos.x - nw / 2, y: pos.y - nh / 2 },
    }
  })
}
