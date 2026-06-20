import { useState, useEffect, useRef } from 'react';
import { X, Save, StickyNote, Pencil, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownNote } from '@/components/notes/MarkdownNote';
import { cn } from '@/lib/cn';

interface SymbolNoteEditorProps {
  symbolName: string;
  note: string;
  onSave: (note: string) => void;
  onClose: () => void;
}

/**
 * Inline note editor for a symbol.
 * Renders as a popover / inline textarea below the symbol row.
 */
export function SymbolNoteEditor({ symbolName, note, onSave, onClose }: SymbolNoteEditorProps) {
  const [value, setValue] = useState(note);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode === 'edit') textareaRef.current?.focus();
  }, [mode]);

  // Ctrl/Cmd+S to save, Ctrl/Cmd+P to toggle preview
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave(value);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setMode(m => (m === 'edit' ? 'preview' : 'edit'));
      }
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [value, onSave, onClose]);

  return (
    <div className="mt-1 mb-1.5 ml-6 rounded-lg border bg-surface-1/50 overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b bg-surface-2/50">
        <StickyNote className="size-3 text-brand" />
        <span className="text-[10px] font-medium text-foreground truncate">{symbolName}</span>
        <div className="ml-auto flex items-center gap-0.5 rounded bg-surface-2 p-0.5">
          <button
            onClick={() => setMode('edit')}
            className={cn(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
              mode === 'edit'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title="编辑 (Ctrl+P 切换)"
          >
            <Pencil className="size-2.5" />
            编辑
          </button>
          <button
            onClick={() => setMode('preview')}
            className={cn(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors',
              mode === 'preview'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title="预览 (Ctrl+P 切换)"
            disabled={!value.trim()}
          >
            <Eye className="size-2.5" />
            预览
          </button>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-3" />
        </button>
      </div>

      {/* Body */}
      {mode === 'edit' ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="记录你对这个符号的理解、疑问或笔记…（支持 Markdown：**粗体** *斜体* `code` ```块``` - 列表）"
          className="w-full min-h-[80px] max-h-[300px] px-2.5 py-2 text-xs bg-transparent text-foreground placeholder:text-muted-foreground/50 resize-y focus:outline-none font-mono leading-relaxed"
        />
      ) : (
        <div className="px-2.5 py-2 min-h-[80px] max-h-[300px] overflow-y-auto">
          {value.trim() ? (
            <MarkdownNote content={value} compact className="text-xs" />
          ) : (
            <p className="text-xs text-muted-foreground/50 italic">（无内容可预览）</p>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-t bg-surface-2/30">
        <span className="text-[10px] text-muted-foreground">Ctrl+S 保存 · Ctrl+P 切换预览 · Esc 关闭</span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-6 px-2.5 text-[10px] gap-1"
            onClick={() => onSave(value)}
            disabled={value === note}
          >
            <Save className="size-2.5" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
