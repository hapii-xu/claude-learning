import { useState, useEffect } from 'react';
import { X, Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Shortcut {
  keys: string[];
  description: string;
}

const shortcuts: { category: string; items: Shortcut[] }[] = [
  {
    category: '导航',
    items: [
      { keys: ['⌘', 'K'], description: '打开命令面板' },
      { keys: ['?'], description: '显示快捷键帮助' },
      { keys: ['Esc'], description: '关闭弹窗 / 返回' },
      { keys: ['g', 'h'], description: '跳转到首页' },
    ],
  },
  {
    category: '搜索',
    items: [
      { keys: ['/'], description: '聚焦搜索框' },
      { keys: ['Esc'], description: '清除搜索' },
    ],
  },
  {
    category: '模块页',
    items: [
      { keys: ['←'], description: '返回上一页' },
      { keys: ['→'], description: '前进到下一页' },
    ],
  },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore if typing in input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative z-10 w-full max-w-md rounded-xl border bg-popover shadow-2xl animate-fade-up">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Keyboard className="size-4.5 text-brand" />
            <h2 className="text-base font-semibold text-foreground">键盘快捷键</h2>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Shortcuts */}
        <div className="p-5 space-y-5">
          {shortcuts.map(group => (
            <div key={group.category}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2.5">
                {group.category}
              </h3>
              <div className="space-y-1.5">
                {group.items.map(shortcut => (
                  <div key={shortcut.description} className="flex items-center justify-between py-1">
                    <span className="text-sm text-foreground">{shortcut.description}</span>
                    <div className="flex items-center gap-0.5">
                      {shortcut.keys.map((key, i) => (
                        <kbd
                          key={i}
                          className="inline-flex items-center justify-center min-w-[1.5rem] h-6 rounded border bg-surface-2 px-1.5 text-[11px] font-mono text-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-3">
          <p className="text-xs text-muted-foreground text-center">
            按{' '}
            <kbd className="inline-flex items-center justify-center min-w-[1.25rem] h-5 rounded border bg-surface-2 px-1 text-[10px] font-mono">
              ?
            </kbd>{' '}
            切换此面板
          </p>
        </div>
      </div>
    </div>
  );
}
