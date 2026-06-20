import { useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';
import type { ChatSession } from '@/data/types';
import { Trash2, Plus, MessageSquare } from 'lucide-react';

interface ChatSessionListProps {
  open: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function getLastMessagePreview(session: ChatSession): string {
  const messages = session.messages;
  if (messages.length === 0) return '暂无消息';
  const last = messages[messages.length - 1];
  const text = last.content.replace(/\n/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function ChatSessionList({
  open,
  onClose,
  sessions,
  activeId,
  onSelect,
  onDelete,
  onCreate,
}: ChatSessionListProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full mt-1 z-50 w-72 rounded-xl border bg-card shadow-lg overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-xs font-semibold text-foreground">对话列表</span>
        <button
          onClick={() => {
            onCreate();
            onClose();
          }}
          className="flex items-center gap-1 text-xs text-brand hover:text-brand/80 transition-colors"
        >
          <Plus className="size-3.5" />
          新建
        </button>
      </div>

      {/* Session list */}
      <div className="max-h-72 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">还没有对话</div>
        ) : (
          sessions.map(session => (
            <div
              key={session.id}
              className={cn(
                'group flex items-start gap-2 px-3 py-2.5 cursor-pointer hover:bg-accent transition-colors',
                activeId === session.id && 'bg-brand/5 border-l-2 border-brand',
              )}
              onClick={() => {
                onSelect(session.id);
                onClose();
              }}
            >
              <MessageSquare
                className={cn(
                  'size-3.5 mt-0.5 shrink-0',
                  activeId === session.id ? 'text-brand' : 'text-muted-foreground',
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span
                    className={cn(
                      'text-xs font-medium truncate',
                      activeId === session.id ? 'text-brand' : 'text-foreground',
                    )}
                  >
                    {session.title}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{getLastMessagePreview(session)}</p>
              </div>
              <button
                onClick={e => {
                  e.stopPropagation();
                  if (window.confirm(`确定删除对话「${session.title}」吗？`)) {
                    onDelete(session.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-status-error hover:bg-status-error/10 transition-all shrink-0"
                title="删除"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
