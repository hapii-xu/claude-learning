import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Minimize2, Maximize, MousePointerClick } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  parseMermaidSource,
  buildParticipantMap,
  getUpstreamChain,
  getSubsequentChain,
  type ParsedDiagram,
} from '@/lib/mermaidParser';
import { resolveParticipantFile } from '@/lib/resolveParticipantFile';
import {
  computeSequenceLayout,
  LAYOUT,
  type MessagePos,
  type NotePos,
  type ParticipantPos,
  type RectPos,
  type AltPos,
} from '@/lib/sequenceLayout';
import { CallChainPanel } from '@/components/diagram/CallChainPanel';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Selection = { type: 'participant'; id: string } | { type: 'message'; index: number } | null;

type Role = 'selected' | 'upstream' | 'downstream' | 'related' | null;

interface SequenceCanvasProps {
  source: string;
  knownFiles: string[];
  className?: string;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const DRAG_THRESHOLD = 4; // px

export function SequenceCanvas({ source, knownFiles, className }: SequenceCanvasProps) {
  const parsed = useMemo<ParsedDiagram>(() => parseMermaidSource(source), [source]);
  const layout = useMemo(() => computeSequenceLayout(parsed), [parsed]);
  const participantMap = useMemo(() => buildParticipantMap(parsed.participants), [parsed.participants]);
  const fileMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const p of parsed.participants) {
      map.set(p.id, resolveParticipantFile(p.displayName, knownFiles));
    }
    return map;
  }, [parsed.participants, knownFiles]);

  const [selection, setSelection] = useState<Selection>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [drawerWide, setDrawerWide] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ─── Role map for highlight ───
  const { participantRoles, messageRoles } = useMemo(() => {
    const pRoles = new Map<string, Role>();
    const mRoles = new Map<number, Role>();
    if (!selection) return { participantRoles: pRoles, messageRoles: mRoles };

    if (selection.type === 'participant') {
      pRoles.set(selection.id, 'selected');
      for (const m of parsed.messages) {
        if (m.from === selection.id || m.to === selection.id) {
          mRoles.set(m.index, 'related');
          if (m.from !== selection.id) pRoles.set(m.from, 'related');
          if (m.to !== selection.id) pRoles.set(m.to, 'related');
        }
      }
    } else {
      const msg = parsed.messages[selection.index];
      if (msg) {
        mRoles.set(msg.index, 'selected');
        pRoles.set(msg.from, 'selected');
        pRoles.set(msg.to, 'selected');

        for (const u of getUpstreamChain(parsed.messages, selection.index)) {
          mRoles.set(u.index, 'upstream');
          if (!pRoles.has(u.from)) pRoles.set(u.from, 'related');
          if (!pRoles.has(u.to)) pRoles.set(u.to, 'related');
        }
        for (const d of getSubsequentChain(parsed.messages, selection.index)) {
          if (!mRoles.has(d.index)) mRoles.set(d.index, 'downstream');
          if (!pRoles.has(d.from)) pRoles.set(d.from, 'related');
          if (!pRoles.has(d.to)) pRoles.set(d.to, 'related');
        }
      }
    }
    return { participantRoles: pRoles, messageRoles: mRoles };
  }, [selection, parsed.messages]);

  // ─── Wheel zoom (native non-passive) ───
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = wrapper!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      setTransform(prev => {
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = clamp(prev.scale * factor, MIN_SCALE, MAX_SCALE);
        const ratio = newScale / prev.scale;
        return {
          scale: newScale,
          x: cx - (cx - prev.x) * ratio,
          y: cy - (cy - prev.y) * ratio,
        };
      });
    }

    wrapper.addEventListener('wheel', onWheel, { passive: false });
    return () => wrapper.removeEventListener('wheel', onWheel);
  }, []);

  // ─── Drag-to-pan ───
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let mode: 'idle' | 'maybe' | 'panning' = 'idle';
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const target = e.target as Element;
      // skip drag start when clicking on interactive nodes
      if (target.closest('[data-no-pan="true"]')) return;
      mode = 'maybe';
      startX = e.clientX;
      startY = e.clientY;
      setTransform(prev => {
        originX = prev.x;
        originY = prev.y;
        return prev;
      });
    }

    function onMove(e: MouseEvent) {
      if (mode === 'idle') return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (mode === 'maybe') {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        mode = 'panning';
        wrapper!.style.cursor = 'grabbing';
      }
      setTransform(prev => ({ ...prev, x: originX + dx, y: originY + dy }));
    }

    function onUp(e: MouseEvent) {
      const wasPanning = mode === 'panning';
      mode = 'idle';
      wrapper!.style.cursor = '';
      if (wasPanning) return;
      // True click on background → clear selection
      const target = e.target as Element;
      if (!target.closest('[data-no-pan="true"]')) {
        setSelection(null);
      }
    }

    wrapper.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      wrapper.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // ─── Keyboard shortcuts ───
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelection(null);
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        setSelection(prev => {
          if (!prev || prev.type !== 'message') return prev;
          const count = parsed.messages.length;
          if (count === 0) return prev;
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          return { type: 'message', index: (prev.index + dir + count) % count };
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parsed.messages.length]);

  // ─── Fullscreen state sync ───
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // ─── Toolbar actions ───
  const zoomIn = useCallback(() => {
    setTransform(prev => ({ ...prev, scale: clamp(prev.scale * 1.2, MIN_SCALE, MAX_SCALE) }));
  }, []);
  const zoomOut = useCallback(() => {
    setTransform(prev => ({ ...prev, scale: clamp(prev.scale / 1.2, MIN_SCALE, MAX_SCALE) }));
  }, []);
  const reset = useCallback(() => setTransform({ x: 0, y: 0, scale: 1 }), []);
  const fit = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const wW = wrapper.clientWidth;
    const wH = wrapper.clientHeight;
    if (wW === 0 || wH === 0) return;
    const sx = (wW - 32) / layout.width;
    const sy = (wH - 32) / layout.height;
    const scale = clamp(Math.min(sx, sy), MIN_SCALE, MAX_SCALE);
    setTransform({
      x: (wW - layout.width * scale) / 2,
      y: 16,
      scale,
    });
  }, [layout.width, layout.height]);

  // Auto-fit on mount + whenever wrapper size changes (ResizeObserver)
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // Initial fit after a short delay to let layout settle
    const t = setTimeout(fit, 60);
    // Re-fit when wrapper resizes (window resize, sidebar toggle, etc.)
    const ro = new ResizeObserver(() => fit());
    ro.observe(wrapper);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [fit]);

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      await rootRef.current?.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }, []);

  // ─── Click handlers ───
  const handleParticipantClick = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelection({ type: 'participant', id });
  }, []);
  const handleMessageClick = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelection({ type: 'message', index });
  }, []);

  const hovered = hoveredId
    ? { name: participantMap.get(hoveredId) || hoveredId, file: fileMap.get(hoveredId) ?? null }
    : null;

  return (
    <div ref={rootRef} className={cn('sequence-canvas-root', isFullscreen && 'sequence-canvas-fullscreen', className)}>
      {/* Toolbar */}
      <div className="sequence-toolbar">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mr-auto">
          <MousePointerClick className="size-3" />
          <span>点击节点查看链路 · 拖动平移 · 滚轮缩放</span>
          <span className="text-muted-foreground/50 ml-2 font-mono">{Math.round(transform.scale * 100)}%</span>
        </div>
        <ToolBtn onClick={zoomOut} tip="缩小">
          <ZoomOut className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={zoomIn} tip="放大">
          <ZoomIn className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={fit} tip="适配视口">
          <Maximize className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={reset} tip="重置 100%">
          <RotateCcw className="size-3.5" />
        </ToolBtn>
        <ToolBtn onClick={toggleFullscreen} tip={isFullscreen ? '退出全屏' : '全屏'}>
          {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </ToolBtn>
      </div>

      {/* Canvas */}
      <div ref={wrapperRef} className="sequence-canvas-wrapper" style={{ cursor: 'grab' }}>
        <div
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transformOrigin: '0 0',
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            className="sequence-svg"
          >
            <defs>
              <marker
                id="arrow-default"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-fill-default" />
              </marker>
              <marker
                id="arrow-selected"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-fill-selected" />
              </marker>
              <marker
                id="arrow-upstream"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-fill-upstream" />
              </marker>
              <marker
                id="arrow-downstream"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-fill-downstream" />
              </marker>
            </defs>

            {/* Rect background tints (deepest layer) */}
            {layout.rects.map((r, i) => (
              <RectBackground key={`rect-${i}`} rect={r} />
            ))}

            {/* Lifelines */}
            {layout.participants.map(p => (
              <line
                key={`life-${p.id}`}
                x1={p.x}
                x2={p.x}
                y1={layout.lifelineTop}
                y2={layout.lifelineBottom}
                className={cn('lifeline', participantRoles.get(p.id) && 'lifeline-active')}
              />
            ))}

            {/* Alt frame outlines */}
            {layout.alts.map((a, i) => (
              <AltFrame key={`alt-${i}`} alt={a} />
            ))}

            {/* Messages */}
            {layout.messages.map(m => (
              <MessageNode
                key={`msg-${m.index}`}
                m={m}
                role={messageRoles.get(m.index) ?? null}
                dimmed={!!selection && !messageRoles.get(m.index)}
                onClick={e => handleMessageClick(m.index, e)}
              />
            ))}

            {/* Participant boxes (top + bottom) */}
            {layout.participants.map(p => (
              <ParticipantNode
                key={`top-${p.id}`}
                participant={p}
                y={p.topY}
                role={participantRoles.get(p.id) ?? null}
                dimmed={!!selection && !participantRoles.get(p.id)}
                onClick={e => handleParticipantClick(p.id, e)}
                onMouseEnter={() => setHoveredId(p.id)}
                onMouseLeave={() => setHoveredId(null)}
              />
            ))}
            {layout.participants.map(p => (
              <ParticipantNode
                key={`bot-${p.id}`}
                participant={p}
                y={p.bottomY}
                role={participantRoles.get(p.id) ?? null}
                dimmed={!!selection && !participantRoles.get(p.id)}
                onClick={e => handleParticipantClick(p.id, e)}
                onMouseEnter={() => setHoveredId(p.id)}
                onMouseLeave={() => setHoveredId(null)}
              />
            ))}

            {/* Notes (rendered last so they sit on top of lifelines/messages) */}
            {layout.notes.map(n => (
              <NoteBox key={`note-${n.rowIndex}`} note={n} />
            ))}
          </svg>
        </div>

        {/* Hover tooltip (DOM overlay, not affected by zoom) */}
        {hovered && (
          <div className="sequence-hover-tip">
            <span className="font-medium">{hovered.name}</span>
            {hovered.file && <span className="text-muted-foreground ml-2 font-mono text-[10px]">{hovered.file}</span>}
          </div>
        )}
      </div>

      {/* Drawer */}
      {selection && (
        <div className={cn('callchain-drawer', drawerWide && 'callchain-drawer-wide')}>
          <CallChainPanel
            selection={selection}
            participants={parsed.participants}
            messages={parsed.messages}
            participantMap={participantMap}
            fileMap={fileMap}
            onClose={() => setSelection(null)}
            onSelectMessage={idx => setSelection({ type: 'message', index: idx })}
            onPreviewToggle={setDrawerWide}
          />
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────

function ParticipantNode({
  participant: p,
  y,
  role,
  dimmed,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  participant: ParticipantPos;
  y: number;
  role: Role;
  dimmed: boolean;
  onClick: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return (
    <g
      data-no-pan="true"
      className={cn('participant-node', role && `participant-${role}`, dimmed && 'participant-dimmed')}
      transform={`translate(${p.x - p.width / 2}, ${y})`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ cursor: 'pointer' }}
    >
      <rect width={p.width} height={p.height} rx={8} className="participant-rect" />
      <text x={p.width / 2} y={p.height / 2 + 4} textAnchor="middle" className="participant-label">
        {p.displayName}
      </text>
    </g>
  );
}

function MessageNode({
  m,
  role,
  dimmed,
  onClick,
}: {
  m: MessagePos;
  role: Role;
  dimmed: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const marker =
    role === 'selected'
      ? 'url(#arrow-selected)'
      : role === 'upstream'
        ? 'url(#arrow-upstream)'
        : role === 'downstream'
          ? 'url(#arrow-downstream)'
          : 'url(#arrow-default)';

  const dashed = m.type === 'dashed';

  return (
    <g
      data-no-pan="true"
      className={cn('message-node', role && `message-${role}`, dimmed && 'message-dimmed')}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      {/* Hit area — invisible wide line for easy clicking */}
      {m.isSelf ? (
        <path d={selfLoopPath(m.fromX, m.y)} className="message-hit" fill="none" />
      ) : (
        <line x1={m.fromX} y1={m.y} x2={m.toX} y2={m.y} className="message-hit" />
      )}

      {/* Visible arrow */}
      {m.isSelf ? (
        <path
          d={selfLoopPath(m.fromX, m.y)}
          className={cn('message-line', dashed && 'message-dashed')}
          fill="none"
          markerEnd={marker}
        />
      ) : (
        <line
          x1={m.fromX}
          y1={m.y}
          x2={m.toX}
          y2={m.y}
          className={cn('message-line', dashed && 'message-dashed')}
          markerEnd={marker}
        />
      )}

      {/* Sequence number badge */}
      <SeqBadge x={m.isSelf ? m.fromX - 12 : Math.min(m.fromX, m.toX) - 14} y={m.y} n={m.index + 1} role={role} />

      {/* Label */}
      {m.isSelf ? (
        <text
          x={m.fromX + LAYOUT.SELF_LOOP_WIDTH + 4}
          y={m.y + LAYOUT.SELF_LOOP_HEIGHT / 2 + 4}
          className="message-label"
        >
          {truncate(m.text, 60)}
        </text>
      ) : (
        <text x={(m.fromX + m.toX) / 2} y={m.y - 8} textAnchor="middle" className="message-label">
          {truncate(m.text, 60)}
        </text>
      )}
    </g>
  );
}

function RectBackground({ rect }: { rect: RectPos }) {
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.width}
      height={rect.height}
      rx={6}
      style={{ fill: rect.color }}
      className="rect-bg"
    />
  );
}

function AltFrame({ alt }: { alt: AltPos }) {
  return (
    <g className="alt-frame">
      <rect x={alt.x} y={alt.y} width={alt.width} height={alt.height} rx={4} className="alt-frame-rect" />
      {/* "alt" label tab */}
      <g transform={`translate(${alt.x + 4}, ${alt.y + 4})`}>
        <rect width={28} height={14} rx={2} className="alt-frame-tab" />
        <text x={14} y={10} textAnchor="middle" className="alt-frame-tab-text">
          alt
        </text>
      </g>
      {/* Branch labels at the top of each branch */}
      {alt.branches.map((b, i) => (
        <g key={i} transform={`translate(${alt.x + 38}, ${b.y + 4})`}>
          <text className="alt-branch-label">[{b.label}]</text>
        </g>
      ))}
      {/* Divider between branches (dashed) */}
      {alt.branches.slice(1).map((b, i) => (
        <line key={`div-${i}`} x1={alt.x} x2={alt.x + alt.width} y1={b.y} y2={b.y} className="alt-branch-divider" />
      ))}
    </g>
  );
}

function NoteBox({ note }: { note: NotePos }) {
  const x = note.centerX - note.width / 2;
  return (
    <g data-no-pan="true" className="note-box" transform={`translate(${x}, ${note.y})`}>
      <rect width={note.width} height={note.height} rx={2} className="note-rect" />
      <foreignObject
        x={LAYOUT.NOTE_PAD_X}
        y={LAYOUT.NOTE_PAD_Y}
        width={note.width - LAYOUT.NOTE_PAD_X * 2}
        height={note.height - LAYOUT.NOTE_PAD_Y * 2}
      >
        <div className="note-text">{note.text}</div>
      </foreignObject>
    </g>
  );
}

function SeqBadge({ x, y, n, role }: { x: number; y: number; n: number; role: Role }) {
  return (
    <g transform={`translate(${x}, ${y})`} className={cn('seq-badge', role && `seq-badge-${role}`)}>
      <circle r={9} className="seq-badge-bg" />
      <text textAnchor="middle" y={3} className="seq-badge-text">
        {n}
      </text>
    </g>
  );
}

function selfLoopPath(x: number, y: number): string {
  const w = LAYOUT.SELF_LOOP_WIDTH;
  const h = LAYOUT.SELF_LOOP_HEIGHT;
  return `M ${x} ${y} h ${w} a 6 6 0 0 1 6 6 v ${h - 12} a 6 6 0 0 1 -6 6 h ${-w}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function ToolBtn({ children, onClick, tip }: { children: React.ReactNode; onClick: () => void; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="size-7 rounded flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
