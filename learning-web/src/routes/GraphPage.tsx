import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchGraph, triggerGraphRegen } from '@/lib/api';
import type { GraphNode, GraphEdge, GraphApiResponse } from '@/data/types';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  ReactFlowProvider,
  useReactFlow,
  type Node as FlowNode,
  type Edge as FlowEdge,
  type NodeMouseHandler,
  type NodeProps,
  useNodesState,
  useEdgesState,
  MarkerType,
  Position,
  useStore,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Map as MapIcon,
  Search,
  RefreshCw,
  FileCode,
  Package,
  FolderOpen,
  Network,
  AlertCircle,
  Maximize2,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { applyDagreLayout } from '@/lib/dagreLayout';

// ─── Color Constants ───

const DIR_COLORS: Record<string, string> = {
  src: '#D77757',
  'src/entrypoints': '#E8956E',
  'src/services': '#5769F7',
  'src/tools': '#5d8a3c',
  'src/components': '#3d72a8',
  'src/state': '#7c3aed',
  'src/commands': '#b88630',
  'src/utils': '#0d9488',
  'src/workflow': '#b83b3b',
  'src/screens': '#6366f1',
  'src/context': '#a16207',
  packages: '#16a766',
};

function getDirColor(sourceFile: string): string {
  if (!sourceFile) return '#6b7280';
  const prefixes = Object.keys(DIR_COLORS).sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (sourceFile.startsWith(p + '/') || sourceFile === p) return DIR_COLORS[p];
  }
  return '#6b7280';
}

const RELATION_COLORS: Record<string, string> = {
  imports: '#5769F7',
  imports_from: '#6B7CF7',
  calls: '#D77757',
  extends: '#7c3aed',
  implements: '#0d9488',
  inherits: '#8b5cf6',
  re_exports: '#b88630',
  references: '#969088',
  rationale_for: '#5d8a3c',
};

// ─── Custom Node Component ───

function FileNodeComponent({ data, selected }: NodeProps) {
  const raw = data.raw as GraphNode | undefined;
  if (!raw) return null;
  const color = getDirColor(raw.source_file || '');
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2.5 py-1.5 rounded-lg font-mono text-[11px]',
        'border shadow-sm transition-all duration-200',
        selected
          ? 'border-brand ring-2 ring-brand/20 bg-brand/5 shadow-md'
          : 'border-border bg-card hover:shadow-md hover:border-border/80',
      )}
      style={{ width: 200 }}
    >
      <span className="size-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="truncate text-foreground">{raw.label}</span>
    </div>
  );
}

const nodeTypes = { fileNode: FileNodeComponent };

// ─── Edge Builder ───

function buildEdges(edges: GraphEdge[], showLabels: boolean): FlowEdge[] {
  return edges.map((e, i) => {
    const color = RELATION_COLORS[e.relation] || '#969088';
    const w = e.weight ?? 1;
    const opacity = 0.25 + Math.min(w / 15, 0.45);
    const strokeWidth = w > 5 ? 1.5 : 1;
    return {
      id: `e-${i}`,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      animated: false,
      style: { stroke: color, strokeWidth, opacity },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      ...(showLabels
        ? {
            label: e.relation,
            labelStyle: { fontSize: 9, fill: '#969088', fontWeight: 400 },
            labelBgStyle: { opacity: 0.85, fill: 'var(--card)' },
            labelBgPadding: [3, 1] as [number, number],
          }
        : {}),
    };
  });
}

// ─── GraphCanvas (inside ReactFlowProvider) ───

function GraphCanvas({
  rawEdges,
  nodes,
  selectedNodeId,
  onNodeClick,
  transitioning,
}: {
  rawEdges: GraphEdge[];
  nodes: FlowNode[];
  selectedNodeId: string | null;
  onNodeClick: NodeMouseHandler;
  transitioning: boolean;
}) {
  const { setCenter } = useReactFlow();
  const zoom = useStore(s => s.transform[2]);
  const showLabels = zoom > 0.7;

  // Rebuild edges when zoom changes (show/hide labels)
  const edges = useMemo(() => buildEdges(rawEdges, showLabels), [rawEdges, showLabels]);

  const [nodesState, setNodesState, onNodesChange] = useNodesState(nodes);
  const [edgesState, setEdgesState, onEdgesChange] = useEdgesState(edges);

  // Sync nodes from parent when data changes
  useEffect(() => {
    setNodesState(nodes);
  }, [nodes, setNodesState]);

  // Sync edges from parent when data changes
  useEffect(() => {
    setEdgesState(edges);
  }, [edges, setEdgesState]);

  // Zoom to selected node
  useEffect(() => {
    if (!selectedNodeId) return;
    const node = nodes.find(n => n.id === selectedNodeId);
    if (!node) return;
    setCenter(node.position.x + 100, node.position.y + 18, {
      zoom: 1.0,
      duration: 500,
    });
  }, [selectedNodeId, nodes, setCenter]);

  return (
    <>
      <ReactFlow
        nodes={nodesState}
        edges={edgesState}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.03}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        style={{ height: '100%', width: '100%' }}
      >
        <Controls className="!bg-card !border-border !rounded-lg !shadow-sm" showInteractive={false} />
        <MiniMap
          className="!bg-card !border-border !rounded-lg !shadow-sm"
          nodeColor={n => getDirColor((n.data?.raw as GraphNode | undefined)?.source_file || '')}
          nodeStrokeWidth={1}
          maskColor="rgba(0,0,0,0.06)"
          pannable
          zoomable
        />
        <Background gap={24} size={1} color="var(--border)" />
      </ReactFlow>
      {transitioning && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-[1px] z-10 pointer-events-none">
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-card px-3 py-1.5 rounded-lg border shadow-sm">
            <Loader2 className="size-3.5 animate-spin" />
            加载中...
          </div>
        </div>
      )}
    </>
  );
}

// ─── Main GraphPage ───

export function GraphPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<GraphApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  const [limit, setLimit] = useState(300);
  const [search, setSearch] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [regenRunning, setRegenRunning] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  const loadData = useCallback(async () => {
    if (data) setTransitioning(true);
    setLoading(true);
    setError(null);
    try {
      const result = await fetchGraph({
        file: fileFilter || undefined,
        dir: dirFilter || undefined,
        limit,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setData(null);
    } finally {
      setLoading(false);
      setTransitioning(false);
    }
  }, [fileFilter, dirFilter, limit]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadData]);

  // Build flow edges first (dagre needs them)
  const flowEdges = useMemo(() => {
    if (!data || !Array.isArray(data.edges)) return [];
    return buildEdges(data.edges, false);
  }, [data]);

  // Raw edges for GraphCanvas (labels rebuilt by zoom level inside canvas)
  const rawEdges = useMemo(() => {
    if (!data || !Array.isArray(data.edges)) return [];
    return data.edges;
  }, [data]);

  // Layout options scale with node count
  const layoutOpts = useMemo(() => {
    const count = data?.nodes.length ?? 0;
    if (count > 500) return { rankSep: 40, nodeSep: 20 };
    if (count > 200) return { rankSep: 60, nodeSep: 30 };
    return { rankSep: 80, nodeSep: 40 };
  }, [data]);

  // Build flow nodes with dagre layout
  const flowNodes = useMemo(() => {
    if (!data || !Array.isArray(data.nodes)) return [];
    const rawNodes: FlowNode[] = data.nodes.map(n => ({
      id: n.id,
      type: 'fileNode',
      position: { x: 0, y: 0 },
      data: { raw: n },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    }));
    return applyDagreLayout(rawNodes, flowEdges, layoutOpts);
  }, [data, flowEdges, layoutOpts]);

  const onNodeClick: NodeMouseHandler = useCallback((_evt, node) => {
    const raw = node.data?.raw as GraphNode | undefined;
    if (raw) setSelectedNode(raw);
  }, []);

  const handleRegen = async () => {
    setRegenRunning(true);
    try {
      await triggerGraphRegen();
      setTimeout(() => {
        loadData();
        setRegenRunning(false);
      }, 30000);
    } catch {
      setRegenRunning(false);
    }
  };

  const handleSearch = (q: string) => {
    setSearch(q);
    if (!q) return;
    const match = flowNodes.find(n => {
      const raw = n.data?.raw as GraphNode | undefined;
      return (
        raw?.label.toLowerCase().includes(q.toLowerCase()) || raw?.source_file?.toLowerCase().includes(q.toLowerCase())
      );
    });
    if (match) {
      const raw = match.data?.raw as GraphNode;
      if (raw) setSelectedNode(raw);
    }
  };

  const searchMatches = useMemo(() => {
    if (!search || !data) return [];
    const q = search.toLowerCase();
    return data.nodes
      .filter(n => n.label.toLowerCase().includes(q) || (n.source_file || '').toLowerCase().includes(q))
      .slice(0, 20);
  }, [search, data]);

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col">
      {/* Header */}
      <div className="px-4 py-2 border-b flex items-center gap-2 shrink-0">
        <MapIcon className="size-4 text-brand" />
        <h1 className="text-sm font-semibold">知识图谱</h1>
        {data && (
          <span className="text-[11px] text-muted-foreground">
            {data.nodes.length} / {data.totalNodes} 节点 &middot; {data.edges.length} / {data.totalEdges} 边
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索节点..."
              value={search}
              onChange={e => handleSearch(e.target.value)}
              className="pl-7 w-48 h-7 text-xs"
            />
          </div>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="h-7 px-2 rounded border bg-background text-xs"
          >
            <option value={100}>100 节点</option>
            <option value={300}>300 节点</option>
            <option value={500}>500 节点</option>
            <option value={1000}>1000 节点</option>
          </select>
          <Button variant="ghost" size="icon" onClick={loadData} className="size-7" title="刷新">
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRegen}
            className="size-7"
            title="重新扫描 (graphify update)"
            disabled={regenRunning}
          >
            {regenRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Maximize2 className="size-3.5" />}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-56 border-r flex flex-col shrink-0">
          <div className="p-2 border-b text-[11px] font-medium text-muted-foreground">快速导航</div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              <NavButton
                icon={Network}
                label="文件总览"
                active={!fileFilter && !dirFilter}
                onClick={() => {
                  setFileFilter('');
                  setDirFilter('');
                }}
              />
              <div className="pt-1 text-[10px] text-muted-foreground uppercase tracking-wider px-2">主要目录</div>
              {[
                'src',
                'src/entrypoints',
                'src/services',
                'src/tools',
                'src/components',
                'src/state',
                'src/commands',
                'packages',
              ].map(dir => (
                <NavButton
                  key={dir}
                  icon={dir === 'packages' ? Package : FolderOpen}
                  label={dir}
                  active={dirFilter === dir}
                  onClick={() => {
                    setDirFilter(dir);
                    setFileFilter('');
                  }}
                  color={getDirColor(dir)}
                />
              ))}

              {searchMatches.length > 0 && (
                <>
                  <Separator className="my-2" />
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider px-2">搜索结果</div>
                  {searchMatches.map(n => (
                    <button
                      key={n.id}
                      onClick={() => setSelectedNode(n)}
                      className={cn(
                        'flex items-center gap-1.5 w-full text-left text-xs rounded px-2 py-1 transition-colors',
                        selectedNode?.id === n.id ? 'bg-brand/10 text-brand' : 'hover:bg-accent',
                      )}
                    >
                      <span
                        className="size-2 rounded-full shrink-0"
                        style={{
                          background: getDirColor(n.source_file || ''),
                        }}
                      />
                      <span className="truncate font-mono">{n.label}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </ScrollArea>

          {/* Legend */}
          <div className="p-2 border-t text-[10px] space-y-1">
            <div className="font-medium text-muted-foreground mb-1">边类型</div>
            {Object.entries(RELATION_COLORS).map(([rel, color]) => (
              <div key={rel} className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 rounded-full" style={{ background: color }} />
                <span className="text-muted-foreground">{rel}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Main graph canvas */}
        <div className="flex-1 min-w-0 relative h-full">
          {loading && !data ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : error && !data ? (
            <div className="p-8 text-center">
              <AlertCircle className="size-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <p className="text-xs text-muted-foreground mt-2">
                运行 <code className="bg-muted px-1.5 py-0.5 rounded">bun run regen-graph</code> 生成图谱
              </p>
            </div>
          ) : (
            <ReactFlowProvider>
              <GraphCanvas
                rawEdges={rawEdges}
                nodes={flowNodes}
                selectedNodeId={selectedNode?.id ?? null}
                onNodeClick={onNodeClick}
                transitioning={transitioning}
              />
            </ReactFlowProvider>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div className="w-72 border-l flex flex-col shrink-0">
            <div className="p-3 border-b flex items-center gap-2">
              <FileCode className="size-4 text-brand" />
              <h3 className="text-sm font-semibold truncate">节点详情</h3>
              <Button variant="ghost" size="icon" className="ml-auto size-6" onClick={() => setSelectedNode(null)}>
                ×
              </Button>
            </div>
            <ScrollArea className="flex-1 p-3 space-y-3">
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">Label</div>
                <div className="text-sm font-mono">{selectedNode.label}</div>
              </div>
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">ID</div>
                <div className="text-xs font-mono text-muted-foreground break-all">{selectedNode.id}</div>
              </div>
              {selectedNode.source_file && (
                <>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase">文件</div>
                    <Link
                      to={`/file/${selectedNode.source_file}${selectedNode.source_location ? `#${selectedNode.source_location}` : ''}`}
                      className="text-xs font-mono text-brand hover:underline break-all"
                    >
                      {selectedNode.source_file}
                      {selectedNode.source_location && (
                        <span className="text-muted-foreground"> @ {selectedNode.source_location}</span>
                      )}
                    </Link>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => navigate(`/file/${selectedNode.source_file}`)}
                  >
                    查看文件
                    <ChevronRight className="size-3.5 ml-1" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => {
                      setFileFilter(selectedNode.source_file!);
                      setDirFilter('');
                    }}
                  >
                    查看文件子图
                  </Button>
                </>
              )}
              {selectedNode.metadata && (
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase">元数据</div>
                  <pre className="text-[10px] font-mono bg-muted p-2 rounded overflow-auto">
                    {JSON.stringify(selectedNode.metadata, null, 2)}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase">连接边</div>
                <div className="text-xs text-muted-foreground">
                  {data?.edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id).length || 0} 条
                </div>
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NavButton ───

function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
  color,
}: {
  icon: typeof FileCode;
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 w-full text-left text-xs rounded px-2 py-1.5 transition-colors',
        active ? 'bg-brand/10 text-brand' : 'hover:bg-accent text-foreground/70',
      )}
    >
      {color ? (
        <span className="size-2 rounded-full shrink-0" style={{ background: color }} />
      ) : (
        <Icon className="size-3 shrink-0" />
      )}
      <span className="truncate font-mono">{label}</span>
    </button>
  );
}
