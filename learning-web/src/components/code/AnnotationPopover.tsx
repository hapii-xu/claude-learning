import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import type { AnnotationColor, LineAnnotation } from '@/data/types';
import { Trash2, X } from 'lucide-react';
import { floatAnchorStyle } from './selectionUtils';

const COLORS: { value: AnnotationColor; bg: string; ring: string; label: string }[] = [
  { value: 'yellow', bg: 'bg-yellow-400', ring: 'ring-yellow-500', label: '黄色' },
  { value: 'red', bg: 'bg-red-400', ring: 'ring-red-500', label: '红色' },
  { value: 'blue', bg: 'bg-blue-400', ring: 'ring-blue-500', label: '蓝色' },
  { value: 'green', bg: 'bg-green-400', ring: 'ring-green-500', label: '绿色' },
];

interface AnnotationPopoverProps {
  open: boolean;
  onClose: () => void;
  line: number;
  filePath: string;
  existingAnnotation?: LineAnnotation | null;
  onSave: (data: { comment: string; color: AnnotationColor; startLine: number; endLine: number }) => Promise<void>;
  onDelete?: () => Promise<void>;
  // Range mode extras
  startCol?: number;
  endCol?: number;
  selectedText?: string;
  anchorRect?: DOMRect;
}

export function AnnotationPopover({
  open,
  onClose,
  line,
  existingAnnotation,
  onSave,
  onDelete,
  startCol,
  endCol,
  selectedText,
  anchorRect,
}: AnnotationPopoverProps) {
  const isRangeMode = startCol !== undefined && endCol !== undefined;
  const [comment, setComment] = useState(existingAnnotation?.comment ?? '');
  const [color, setColor] = useState<AnnotationColor>(existingAnnotation?.color ?? 'yellow');
  const [saving, setSaving] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Outside-click and Escape detection.
  // Armed after rAF + microtask so the click that opened this popover cannot
  // immediately close it (the opening click finishes bubbling before armed=true).
  useEffect(() => {
    if (!open) return;
    let armed = false;
    const raf = requestAnimationFrame(() => {
      queueMicrotask(() => {
        armed = true;
      });
    });

    const onDocMouseDown = (e: MouseEvent) => {
      if (!armed) return;
      const target = e.target as Node;
      // Clicks inside the card are fine.
      if (cardRef.current && cardRef.current.contains(target)) return;
      // Clicks inside any other annotation UI (e.g. the toolbar) are fine.
      if (target instanceof Element && target.closest('[data-annot-ui]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    if (!comment.trim()) return;
    setSaving(true);
    try {
      await onSave({ comment: comment.trim(), color, startLine: line, endLine: line });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setSaving(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const card = (
    <div ref={cardRef} className="bg-card border rounded-xl shadow-xl p-4 w-72 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          {isRangeMode ? `标注 L${line}:${startCol}` : `标注 L${line}`}
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
          <X className="size-3.5" />
        </button>
      </div>

      {/* Selected text preview (range mode only) */}
      {isRangeMode && selectedText && (
        <div className="font-mono text-[11px] bg-surface-1 rounded-md px-2.5 py-1.5 text-muted-foreground truncate border-l-2 border-brand/40">
          {selectedText}
        </div>
      )}

      {/* Color picker */}
      <div className="flex gap-2">
        {COLORS.map(c => (
          <button
            key={c.value}
            title={c.label}
            onClick={() => setColor(c.value)}
            className={cn(
              'size-6 rounded-full transition-all',
              c.bg,
              color === c.value && `ring-2 ring-offset-1 ${c.ring}`,
            )}
          />
        ))}
      </div>

      {/* Comment */}
      <textarea
        className="w-full text-sm rounded-md border bg-surface-1 px-2.5 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-brand/50 placeholder:text-muted-foreground/60"
        rows={3}
        placeholder="写下你的标注..."
        value={comment}
        onChange={e => setComment(e.target.value)}
        autoFocus
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
          // Escape is handled by the document listener above
        }}
      />

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={!comment.trim() || saving}
          className="flex-1 text-xs bg-brand text-white rounded-md py-1.5 font-medium disabled:opacity-40 hover:bg-brand/90 transition-colors"
        >
          {saving ? '保存中…' : '保存'}
        </button>
        {existingAnnotation && onDelete && (
          <button
            onClick={handleDelete}
            disabled={saving}
            className="text-xs text-red-500 hover:text-red-600 border border-red-200 rounded-md px-2.5 py-1.5 transition-colors"
            title="删除标注"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">Ctrl+Enter 保存，Esc 取消</p>
    </div>
  );

  if (anchorRect) {
    const style = floatAnchorStyle(anchorRect, 288, 280, 8);
    return createPortal(
      <div data-annot-ui="popover" className="fixed z-[60]" style={style}>
        {card}
      </div>,
      document.body,
    );
  }

  // Centered modal fallback (whole-line annotations from gutter "+" button).
  // Dim backdrop for visual clarity but no onClick — outside-click is handled
  // by the document-level mousedown listener above.
  return createPortal(
    <>
      <div className="fixed inset-0 z-[49] bg-black/20" />
      <div data-annot-ui="popover" className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto">{card}</div>
      </div>
    </>,
    document.body,
  );
}
