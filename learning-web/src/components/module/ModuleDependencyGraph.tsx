import { useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useProgress } from '@/hooks/useProgress';
import { useTheme } from '@/lib/theme';
import { computeDependencyGraph, type DependencyNode, type DependencyEdge } from '@/lib/learningPath';
import { modules } from '@/data/modules';
import { cn } from '@/lib/cn';

const groupColors: Record<string, string> = {
  foundation: '#D77757',
  core: '#E8956E',
  api: '#5769F7',
  tools: '#5d8a3c',
  ui: '#3d72a8',
  state: '#7c3aed',
  extensibility: '#b88630',
  safety: '#b83b31',
  advanced: '#0d9488',
  infra: '#6366f1',
};

export function ModuleDependencyGraph() {
  const { isCompleted } = useProgress();
  const { theme } = useTheme();
  const svgRef = useRef<SVGSVGElement>(null);
  const { nodes, edges } = useMemo(() => computeDependencyGraph(), []);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const nodeBg = isDark ? '#2C2A28' : 'white';
  const nodeText = isDark ? '#EFEEE9' : '#1A1917';
  const edgeStroke = isDark ? '#5E5A54' : '#969088';

  // 按分组和顺序计算节点位置
  const positionedNodes = useMemo(() => {
    const groupOrder = [
      'foundation',
      'core',
      'api',
      'tools',
      'ui',
      'state',
      'extensibility',
      'safety',
      'advanced',
      'infra',
    ];
    const groupCounts: Record<string, number> = {};
    const groupIndices: Record<string, number> = {};

    for (const node of nodes) {
      groupCounts[node.group] = (groupCounts[node.group] || 0) + 1;
    }

    const result: (DependencyNode & { x: number; y: number; col: number })[] = [];

    for (const node of nodes) {
      const groupIdx = groupOrder.indexOf(node.group);
      groupIndices[node.group] = groupIndices[node.group] || 0;

      const totalInGroup = groupCounts[node.group];
      const col = groupIndices[node.group];
      groupIndices[node.group]++;

      // Layout: groups in columns, modules within each group in rows
      const x = 100 + groupIdx * 180;
      const y = 80 + col * 80;

      result.push({ ...node, x, y, col });
    }

    return result;
  }, [nodes]);

  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <div className="p-4 border-b">
        <h3 className="font-semibold text-foreground">模块依赖图</h3>
        <p className="text-xs text-muted-foreground mt-1">箭头表示前置依赖关系，点击模块可跳转</p>
      </div>

      <svg
        ref={svgRef}
        width={Math.max(100 + positionedNodes.length * 30, 800)}
        height={Math.max(400, ...positionedNodes.map(n => n.y + 100))}
        className="w-full min-w-[800px]"
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={edgeStroke} />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge, i) => {
          const from = positionedNodes.find(n => n.id === edge.from);
          const to = positionedNodes.find(n => n.id === edge.to);
          if (!from || !to) return null;

          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const cx1 = from.x + dx * 0.4;
          const cy1 = from.y;
          const cx2 = to.x - dx * 0.4;
          const cy2 = to.y;

          return (
            <path
              key={i}
              d={`M ${from.x} ${from.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${to.x} ${to.y}`}
              fill="none"
              stroke={edgeStroke}
              strokeWidth="1.5"
              strokeOpacity="0.4"
              markerEnd="url(#arrowhead)"
            />
          );
        })}

        {/* Nodes */}
        {positionedNodes.map(node => {
          const color = groupColors[node.group] || edgeStroke;
          const completed = isCompleted(node.id);

          return (
            <g key={node.id}>
              <Link to={`/module/${node.id}`}>
                <rect
                  x={node.x - 60}
                  y={node.y - 18}
                  width="120"
                  height="36"
                  rx="8"
                  fill={completed ? color : nodeBg}
                  fillOpacity={completed ? 0.15 : 0.9}
                  stroke={color}
                  strokeWidth={completed ? 2 : 1}
                  strokeOpacity={completed ? 1 : 0.5}
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                />
                <text
                  x={node.x}
                  y={node.y + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-[11px] font-medium pointer-events-none select-none"
                  fill={completed ? color : nodeText}
                >
                  {node.title.length > 10 ? node.title.slice(0, 10) + '…' : node.title}
                </text>
              </Link>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="p-3 border-t flex gap-3 flex-wrap">
        {Object.entries(groupColors).map(([group, color]) => {
          const groupModules = modules.filter(m => m.group.id === group);
          if (groupModules.length === 0) return null;
          return (
            <div key={group} className="flex items-center gap-1.5">
              <div className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-[10px] text-muted-foreground">{groupModules[0].group.title}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
