import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  FileCode,
  ArrowRight,
  ArrowLeft,
  MessageSquare,
  FolderTree,
  ChevronRight,
  ExternalLink,
  Eye,
  Copy,
  Check,
} from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { ParsedMessage, ParsedParticipant } from '@/lib/mermaidParser';
import { getIncomingMessages, getOutgoingMessages, getSubsequentChain, getUpstreamChain } from '@/lib/mermaidParser';
import type { Selection } from '@/hooks/useMermaidInteractivity';
import { useFileContent } from '@/hooks/useFileContent';
import { CodeViewer } from '@/components/code/CodeViewer';

function getLangFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'bash',
    py: 'python',
    rs: 'rust',
    go: 'go',
  };
  return map[ext] || 'text';
}

interface CallChainPanelProps {
  selection: Selection;
  participants: ParsedParticipant[];
  messages: ParsedMessage[];
  participantMap: Map<string, string>;
  fileMap: Map<string, string | null>;
  onClose: () => void;
  onSelectMessage?: (index: number) => void;
  /** When true, panel expands to accommodate inline source preview */
  onPreviewToggle?: (expanded: boolean) => void;
}

export function CallChainPanel({
  selection,
  participants,
  messages,
  participantMap,
  fileMap,
  onClose,
  onSelectMessage,
  onPreviewToggle,
}: CallChainPanelProps) {
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const handlePreview = useCallback(
    (path: string | null) => {
      setPreviewPath(prev => {
        const next = prev === path ? null : path;
        onPreviewToggle?.(next !== null);
        return next;
      });
    },
    [onPreviewToggle],
  );

  return (
    <div className={cn('flex flex-col h-full transition-[width] duration-200', previewPath ? 'w-[640px]' : 'w-96')}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-xs font-medium text-muted-foreground">调用链详情</span>
        <button
          onClick={onClose}
          className="size-5 rounded flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Main panel */}
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-3">
            {selection.type === 'participant' ? (
              <ParticipantView
                participantId={selection.id}
                participants={participants}
                messages={messages}
                participantMap={participantMap}
                fileMap={fileMap}
                onSelectMessage={onSelectMessage}
                previewPath={previewPath}
                onPreview={handlePreview}
              />
            ) : (
              <MessageView
                messageIndex={selection.index}
                messages={messages}
                participantMap={participantMap}
                fileMap={fileMap}
                onSelectMessage={onSelectMessage}
                previewPath={previewPath}
                onPreview={handlePreview}
              />
            )}
          </div>
        </ScrollArea>

        {/* Inline source preview pane */}
        {previewPath && <SourcePreviewPane path={previewPath} onClose={() => handlePreview(null)} />}
      </div>
    </div>
  );
}

// ─── Participant View ───────────────────────────────────────────────

function ParticipantView({
  participantId,
  participants,
  messages,
  participantMap,
  fileMap,
  onSelectMessage,
  previewPath,
  onPreview,
}: {
  participantId: string;
  participants: ParsedParticipant[];
  messages: ParsedMessage[];
  participantMap: Map<string, string>;
  fileMap: Map<string, string | null>;
  onSelectMessage?: (index: number) => void;
  previewPath: string | null;
  onPreview: (path: string | null) => void;
}) {
  const participant = participants.find(p => p.id === participantId);
  if (!participant) return null;

  const displayName = participantMap.get(participantId) || participantId;
  const filePath = fileMap.get(participantId) ?? null;
  const incoming = getIncomingMessages(messages, participantId);
  const outgoing = getOutgoingMessages(messages, participantId);

  return (
    <>
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
            <FolderTree className="size-4 text-brand" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold truncate">{displayName}</h3>
            <p className="text-[10px] text-muted-foreground">参与者 · {incoming.length + outgoing.length} 次调用</p>
          </div>
        </div>

        {filePath && <SourceActions filePath={filePath} previewPath={previewPath} onPreview={onPreview} />}
      </div>

      <Separator />

      {/* Incoming calls */}
      {incoming.length > 0 && (
        <div className="space-y-1.5">
          <SectionHeader icon={<ArrowLeft className="size-3" />} label="入站调用" count={incoming.length} />
          <div className="space-y-0.5">
            {incoming.map(msg => (
              <MessageRow
                key={msg.index}
                msg={msg}
                participantMap={participantMap}
                direction="in"
                onClick={() => onSelectMessage?.(msg.index)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Outgoing calls */}
      {outgoing.length > 0 && (
        <div className="space-y-1.5">
          <SectionHeader icon={<ArrowRight className="size-3" />} label="出站调用" count={outgoing.length} />
          <div className="space-y-0.5">
            {outgoing.map(msg => (
              <MessageRow
                key={msg.index}
                msg={msg}
                participantMap={participantMap}
                direction="out"
                onClick={() => onSelectMessage?.(msg.index)}
              />
            ))}
          </div>
        </div>
      )}

      {incoming.length === 0 && outgoing.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4">该参与者没有调用记录</p>
      )}
    </>
  );
}

// ─── Message View ───────────────────────────────────────────────────

function MessageView({
  messageIndex,
  messages,
  participantMap,
  fileMap,
  onSelectMessage,
  previewPath,
  onPreview,
}: {
  messageIndex: number;
  messages: ParsedMessage[];
  participantMap: Map<string, string>;
  fileMap: Map<string, string | null>;
  onSelectMessage?: (index: number) => void;
  previewPath: string | null;
  onPreview: (path: string | null) => void;
}) {
  const msg = messages[messageIndex];
  if (!msg) return null;

  const fromName = participantMap.get(msg.from) || msg.from;
  const toName = participantMap.get(msg.to) || msg.to;
  const fromFile = fileMap.get(msg.from) ?? null;
  const toFile = fileMap.get(msg.to) ?? null;
  const upstream = getUpstreamChain(messages, messageIndex);
  const downstream = getSubsequentChain(messages, messageIndex);

  return (
    <>
      {/* Message header */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
            <MessageSquare className="size-4 text-brand" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold">调用 #{messageIndex + 1}</h3>
            <p className="text-[10px] text-muted-foreground">{msg.type === 'dashed' ? '返回' : '调用'}</p>
          </div>
        </div>

        {/* From → To */}
        <div className="flex items-center gap-1 text-xs">
          <ParticipantChip name={fromName} filePath={fromFile} previewPath={previewPath} onPreview={onPreview} />
          <ChevronRight className="size-3 text-muted-foreground shrink-0" />
          <ParticipantChip name={toName} filePath={toFile} previewPath={previewPath} onPreview={onPreview} />
        </div>

        {/* Method text */}
        <div className="bg-surface-2/50 rounded-md px-2.5 py-2">
          <code className="text-xs font-mono text-foreground/90 break-all">{msg.text}</code>
        </div>
      </div>

      <Separator />

      {/* Upstream call stack */}
      {upstream.length > 0 && (
        <div className="space-y-1.5">
          <SectionHeader
            icon={<ArrowLeft className="size-3 text-blue-400" />}
            label="上游调用栈"
            count={upstream.length}
            labelClass="text-blue-400"
          />
          <div className="space-y-0.5">
            {upstream.map((m, depth) => (
              <ChainItem
                key={m.index}
                msg={m}
                participantMap={participantMap}
                depth={depth}
                variant="upstream"
                onClick={() => onSelectMessage?.(m.index)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Downstream chain */}
      {downstream.length > 0 && (
        <div className="space-y-1.5">
          <SectionHeader
            icon={<ArrowRight className="size-3 text-brand" />}
            label="后续调用链"
            count={downstream.length}
            labelClass="text-brand"
          />
          <div className="space-y-0.5">
            {downstream.map((m, depth) => (
              <ChainItem
                key={m.index}
                msg={m}
                participantMap={participantMap}
                depth={depth}
                variant="downstream"
                onClick={() => onSelectMessage?.(m.index)}
              />
            ))}
          </div>
        </div>
      )}

      {upstream.length === 0 && downstream.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2">无上下游调用</p>
      )}
    </>
  );
}

// ─── Source Actions ─────────────────────────────────────────────────

function SourceActions({
  filePath,
  previewPath,
  onPreview,
}: {
  filePath: string;
  previewPath: string | null;
  onPreview: (path: string | null) => void;
}) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const isPreviewing = previewPath === filePath;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [filePath]);

  return (
    <div className="rounded-md border bg-surface-1/50 overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b">
        <FileCode className="size-3.5 text-brand shrink-0" />
        <code className="text-[11px] font-mono text-foreground/80 truncate flex-1">{filePath}</code>
      </div>
      <div className="flex divide-x">
        <ActionButton
          icon={<FileCode className="size-3" />}
          label="源码视图"
          onClick={() => navigate(`/file/${filePath}`)}
        />
        <ActionButton
          icon={<ExternalLink className="size-3" />}
          label="新标签"
          onClick={() => window.open(`/file/${filePath}`, '_blank')}
        />
        <ActionButton
          icon={<Eye className="size-3" />}
          label="预览"
          onClick={() => onPreview(filePath)}
          active={isPreviewing}
        />
        <ActionButton
          icon={copied ? <Check className="size-3 text-status-active" /> : <Copy className="size-3" />}
          label={copied ? '已复制' : '复制路径'}
          onClick={handleCopy}
        />
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 flex flex-col items-center gap-0.5 py-1.5 px-1 text-[10px] transition-colors',
        'hover:bg-accent text-muted-foreground hover:text-foreground',
        active && 'bg-brand/10 text-brand',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ─── Inline source preview ──────────────────────────────────────────

function SourcePreviewPane({ path, onClose }: { path: string; onClose: () => void }) {
  const { data, loading } = useFileContent(path);

  return (
    <div className="w-80 border-l flex flex-col min-h-0 shrink-0">
      <div className="flex items-center justify-between px-2 py-1.5 border-b shrink-0">
        <code className="text-[10px] font-mono text-muted-foreground truncate">{path}</code>
        <button
          onClick={onClose}
          className="size-4 rounded flex items-center justify-center hover:bg-accent text-muted-foreground ml-1 shrink-0"
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="flex-1 overflow-auto min-h-0 text-[11px]">
        {loading ? (
          <div className="p-3 text-muted-foreground text-xs">加载中...</div>
        ) : data ? (
          <CodeViewer code={data.content} language={getLangFromPath(path)} filePath={path} className="h-full" />
        ) : (
          <div className="p-3 text-status-error text-xs">无法加载源码</div>
        )}
      </div>
    </div>
  );
}

// ─── Shared components ──────────────────────────────────────────────

function SectionHeader({
  icon,
  label,
  count,
  labelClass,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  labelClass?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <span className={cn('text-[11px] font-medium text-muted-foreground', labelClass)}>{label}</span>
      <Badge variant="secondary" className="text-[10px] h-4 px-1">
        {count}
      </Badge>
    </div>
  );
}

function MessageRow({
  msg,
  participantMap,
  direction,
  onClick,
}: {
  msg: ParsedMessage;
  participantMap: Map<string, string>;
  direction: 'in' | 'out';
  onClick?: () => void;
}) {
  const otherName =
    direction === 'in' ? participantMap.get(msg.from) || msg.from : participantMap.get(msg.to) || msg.to;
  const Icon = direction === 'in' ? ArrowLeft : ArrowRight;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 text-[11px] px-2 py-1 rounded hover:bg-accent/50 text-left"
    >
      <Icon className="size-2.5 text-muted-foreground/50 shrink-0" />
      <span className="text-muted-foreground/70 font-mono truncate">{otherName}</span>
      <span className="text-foreground/60 truncate ml-auto">{msg.text}</span>
    </button>
  );
}

function ChainItem({
  msg,
  participantMap,
  depth,
  variant,
  onClick,
}: {
  msg: ParsedMessage;
  participantMap: Map<string, string>;
  depth: number;
  variant: 'upstream' | 'downstream';
  onClick?: () => void;
}) {
  const fromName = participantMap.get(msg.from) || msg.from;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-1.5 text-[11px] px-2 py-1 rounded hover:bg-accent/50 text-left"
    >
      <span className="text-muted-foreground/50 w-4 text-right shrink-0 font-mono">{msg.index + 1}</span>
      <span className={cn('font-mono shrink-0', variant === 'upstream' ? 'text-blue-400' : 'text-brand/70')}>
        {fromName}
      </span>
      <ChevronRight className="size-2.5 text-muted-foreground/40 shrink-0" />
      <span className="text-foreground/80 truncate">{msg.text}</span>
    </button>
  );
}

function ParticipantChip({
  name,
  filePath,
  previewPath,
  onPreview,
}: {
  name: string;
  filePath: string | null;
  previewPath: string | null;
  onPreview: (path: string | null) => void;
}) {
  if (filePath) {
    return (
      <button
        onClick={() => onPreview(filePath)}
        title="点击在面板内预览源码"
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-2/60',
          'text-brand/80 hover:text-brand hover:bg-brand/10 transition-colors',
          'max-w-[120px]',
          previewPath === filePath && 'bg-brand/10 text-brand',
        )}
      >
        <FileCode className="size-3 shrink-0" />
        <span className="truncate text-[11px] font-mono">{name}</span>
      </button>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-surface-2/60 text-[11px] font-mono text-muted-foreground max-w-[120px] truncate">
      {name}
    </span>
  );
}
