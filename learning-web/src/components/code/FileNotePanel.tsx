import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Circle, StickyNote, ChevronDown, ChevronUp, Save, Pencil, Eye, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownNote } from '@/components/notes/MarkdownNote';
import { useFileNote } from '@/hooks/useFileNote';
import { cn } from '@/lib/cn';

interface FileNotePanelProps {
  filePath: string;
  allStudied?: boolean;
}

export function FileNotePanel({ filePath, allStudied }: FileNotePanelProps) {
  const { entry, toggleCompleted, setNote } = useFileNote(filePath);
  const [expanded, setExpanded] = useState(false);
  const [noteMode, setNoteMode] = useState<'edit' | 'preview'>('edit');
  const [noteValue, setNoteValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync note value when entry loads
  useEffect(() => {
    setNoteValue(entry?.note ?? '');
  }, [entry?.note]);

  useEffect(() => {
    if (expanded && noteMode === 'edit') textareaRef.current?.focus();
  }, [expanded, noteMode]);

  // Ctrl+S / Ctrl+P / Esc when expanded
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setNoteMode(m => (m === 'edit' ? 'preview' : 'edit'));
      }
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const handleSave = () => {
    setNote(noteValue);
  };

  const completed = entry?.completed ?? false;
  const noteLen = (entry?.note ?? '').trim().length;

  return (
    <div className="mb-3 rounded-lg border bg-surface-1/50 overflow-hidden">
      {/* Compact bar */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Manual completed toggle */}
        <button
          onClick={toggleCompleted}
          className={cn(
            'flex items-center gap-1.5 text-xs font-medium rounded-md px-2 py-1 transition-all',
            completed
              ? 'text-brand bg-brand/10 hover:bg-brand/15'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent',
          )}
          title={completed ? '已标记为整文件学习完成 — 点击取消' : '标记整个文件学习完成'}
        >
          {completed ? <CheckCircle2 className="size-3.5 fill-brand/20" /> : <Circle className="size-3.5" />}
          {completed ? '文件已完成' : '标记文件完成'}
        </button>

        {/* Auto-derived badge */}
        {allStudied && !completed && (
          <span className="text-[10px] text-status-active border border-status-active/30 bg-status-active/5 rounded-full px-2 py-0.5">
            全部符号已学
          </span>
        )}
        {allStudied && completed && (
          <span className="text-[10px] text-brand/70 rounded-full px-2 py-0.5">✓ 全部符号已学</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {/* Note toggle */}
          <button
            onClick={() => setExpanded(v => !v)}
            className={cn(
              'flex items-center gap-1 text-xs rounded-md px-2 py-1 transition-colors',
              expanded
                ? 'bg-background text-foreground shadow-sm'
                : noteLen > 0
                  ? 'text-brand/70 hover:text-brand'
                  : 'text-muted-foreground hover:text-foreground',
            )}
            title={expanded ? '收起笔记' : '展开文件笔记'}
          >
            <StickyNote className="size-3.5" />
            {noteLen > 0 ? `笔记 (${noteLen} 字)` : '添加文件笔记'}
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
        </div>
      </div>

      {/* Expanded note editor */}
      {expanded && (
        <div className="border-t">
          {/* Editor toolbar */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-2/50">
            <StickyNote className="size-3 text-brand" />
            <span className="text-[10px] font-medium text-foreground truncate">文件笔记</span>
            <div className="ml-auto flex items-center gap-0.5 rounded bg-surface-2 p-0.5">
              <button
                onClick={() => setNoteMode('edit')}
                className={cn(
                  'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
                  noteMode === 'edit'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Pencil className="size-2.5" />
                编辑
              </button>
              <button
                onClick={() => setNoteMode('preview')}
                disabled={!noteValue.trim()}
                className={cn(
                  'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
                  noteMode === 'preview'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Eye className="size-2.5" />
                预览
              </button>
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="size-3" />
            </button>
          </div>

          {/* Body */}
          {noteMode === 'edit' ? (
            <textarea
              ref={textareaRef}
              value={noteValue}
              onChange={e => setNoteValue(e.target.value)}
              placeholder="记录这个文件的整体理解、学习总结、重要模式或待跟进的问题…（支持 Markdown）"
              className="w-full min-h-[100px] max-h-[400px] px-2.5 py-2 text-xs bg-transparent text-foreground placeholder:text-muted-foreground/50 resize-y focus:outline-none font-mono leading-relaxed"
            />
          ) : (
            <div className="px-2.5 py-2 min-h-[100px] max-h-[400px] overflow-y-auto">
              {noteValue.trim() ? (
                <MarkdownNote content={noteValue} compact className="text-xs" />
              ) : (
                <p className="text-xs text-muted-foreground/50 italic">（无内容可预览）</p>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between px-2.5 py-1.5 border-t bg-surface-2/30">
            <span className="text-[10px] text-muted-foreground">Ctrl+S 保存 · Ctrl+P 切换预览 · Esc 收起</span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => setExpanded(false)}>
                收起
              </Button>
              <Button
                size="sm"
                className="h-6 px-2.5 text-[10px] gap-1"
                onClick={handleSave}
                disabled={noteValue === (entry?.note ?? '')}
              >
                <Save className="size-2.5" />
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
