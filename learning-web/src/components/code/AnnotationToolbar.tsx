import { useEffect, useRef } from 'react';
import { Bold, Italic, MessageSquare, Strikethrough, Trash2, Underline } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import type { AnnotationColor, AnnotationStyles } from '@/data/types';
import { floatAnchorStyle } from './selectionUtils';

const COLORS: { value: AnnotationColor; bg: string; label: string }[] = [
  { value: 'yellow', bg: 'bg-yellow-400', label: '黄色' },
  { value: 'red', bg: 'bg-red-400', label: '红色' },
  { value: 'blue', bg: 'bg-blue-400', label: '蓝色' },
  { value: 'green', bg: 'bg-green-400', label: '绿色' },
];

interface AnnotationToolbarProps {
  rect: DOMRect;
  currentColor?: AnnotationColor;
  currentStyles?: AnnotationStyles;
  isExisting?: boolean;
  onApplyColor: (color: AnnotationColor) => void;
  onToggleStyle: (style: keyof AnnotationStyles) => void;
  onComment: () => void;
  onDelete?: () => void;
  onClose: () => void;
}

export function AnnotationToolbar({
  rect,
  currentColor,
  currentStyles,
  isExisting,
  onApplyColor,
  onToggleStyle,
  onComment,
  onDelete,
  onClose,
}: AnnotationToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const TOOLBAR_WIDTH = 316;
  const TOOLBAR_HEIGHT = 40;
  const style = floatAnchorStyle(rect, TOOLBAR_WIDTH, TOOLBAR_HEIGHT);

  // Outside-click and Escape detection.
  // Armed after rAF + microtask so the very click that opened this toolbar
  // (which causes React to commit this component into the DOM) cannot
  // immediately trigger an outside-click close.
  useEffect(() => {
    let armed = false;
    const raf = requestAnimationFrame(() => {
      queueMicrotask(() => {
        armed = true;
      });
    });

    const onMouseDown = (e: MouseEvent) => {
      if (!armed) return;
      const target = e.target as Node;
      // Stay open if click is inside the toolbar itself.
      if (toolbarRef.current && toolbarRef.current.contains(target)) return;
      // Stay open if click is inside any annotation UI (e.g. a popover that
      // just replaced this toolbar in the same gesture).
      if (target instanceof Element && target.closest('[data-annot-ui]')) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const btn = (active: boolean) =>
    cn(
      'size-7 flex items-center justify-center rounded transition-colors',
      active ? 'bg-brand/15 text-brand' : 'hover:bg-accent text-muted-foreground hover:text-foreground',
    );

  return createPortal(
    <div
      ref={toolbarRef}
      data-annot-ui="toolbar"
      style={style}
      className="flex items-center gap-0.5 rounded-lg border bg-popover shadow-xl px-1 h-10"
      // Prevent clearing selection when interacting with toolbar
      onMouseDown={e => e.preventDefault()}
    >
      {/* Style buttons */}
      <button className={btn(!!currentStyles?.bold)} title="加粗 (B)" onClick={() => onToggleStyle('bold')}>
        <Bold className="size-3.5" />
      </button>
      <button className={btn(!!currentStyles?.italic)} title="斜体 (I)" onClick={() => onToggleStyle('italic')}>
        <Italic className="size-3.5" />
      </button>
      <button className={btn(!!currentStyles?.underline)} title="下划线 (U)" onClick={() => onToggleStyle('underline')}>
        <Underline className="size-3.5" />
      </button>
      <button
        className={btn(!!currentStyles?.strikethrough)}
        title="删除线 (S)"
        onClick={() => onToggleStyle('strikethrough')}
      >
        <Strikethrough className="size-3.5" />
      </button>

      <div className="w-px h-5 bg-border mx-0.5" />

      {/* Color swatches */}
      {COLORS.map(c => (
        <button
          key={c.value}
          title={c.label}
          onClick={() => onApplyColor(c.value)}
          onMouseDown={e => e.preventDefault()}
          className={cn(
            'size-5 rounded-full transition-all mx-0.5',
            c.bg,
            currentColor === c.value && 'ring-2 ring-offset-1 ring-current',
          )}
        />
      ))}

      <div className="w-px h-5 bg-border mx-0.5" />

      {/* Comment */}
      <button className={btn(false)} title="写评论" onClick={onComment}>
        <MessageSquare className="size-3.5" />
        <span className="text-[10px] ml-1">评论</span>
      </button>

      {/* Delete (only for existing annotations) */}
      {isExisting && onDelete && (
        <>
          <div className="w-px h-5 bg-border mx-0.5" />
          <button
            className="size-7 flex items-center justify-center rounded transition-colors hover:bg-red-50 text-red-400 hover:text-red-600"
            title="删除标注"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
