import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { searchSync, useCommandPalette, type SearchResult } from '@/hooks/useSearch';
import { FileCode, Layers, BookOpen, Search } from 'lucide-react';

const typeIcons: Record<string, typeof FileCode> = {
  module: Layers,
  file: FileCode,
  doc: BookOpen,
};

const typeLabels: Record<string, string> = {
  module: '模块',
  file: '文件',
  doc: '文档',
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const navigate = useNavigate();

  useCommandPalette(useCallback(() => setOpen(true), []));

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    setResults(searchSync(value));
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      navigate(path);
      setOpen(false);
      setQuery('');
      setResults([]);
    },
    [navigate],
  );

  return (
    <>
      {/* Keyboard shortcut hint */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md px-2.5 py-1.5 hover:bg-accent"
        title="搜索 (Cmd+K)"
      >
        <Search className="size-4" />
        <span className="hidden sm:inline">搜索</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          ⌘K
        </kbd>
      </button>

      {/* Command Dialog */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />

          {/* Dialog */}
          <Command
            className="relative z-10 w-full max-w-lg rounded-xl border bg-popover shadow-2xl animate-fade-up"
            shouldFilter={false}
          >
            {/* Search input */}
            <div className="flex items-center gap-3 border-b px-4">
              <Search className="size-4 text-muted-foreground shrink-0" />
              <Command.Input
                value={query}
                onValueChange={handleSearch}
                placeholder="搜索模块、文件、文档..."
                className="flex-1 h-12 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                autoFocus
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery('');
                    setResults([]);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  清除
                </button>
              )}
              <kbd className="rounded border bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                ESC
              </kbd>
            </div>

            {/* Results */}
            <Command.List className="max-h-80 overflow-y-auto p-2">
              {query && results.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">未找到匹配结果</div>
              )}

              {!query && (
                <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
                  输入关键词搜索模块、文件和文档
                </Command.Empty>
              )}

              {/* Group by type */}
              {(['module', 'file', 'doc'] as const).map(type => {
                const typeResults = results.filter(r => r.type === type);
                if (typeResults.length === 0) return null;

                const Icon = typeIcons[type];
                return (
                  <div key={type}>
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {typeLabels[type]}s
                    </div>
                    {typeResults.map(result => (
                      <Command.Item
                        key={result.path}
                        value={result.path}
                        onSelect={() => handleSelect(result.path)}
                        className="flex items-center gap-3 rounded-md px-3 py-2 text-sm cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground transition-colors"
                      >
                        <Icon className="size-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{result.title}</div>
                          {result.description && (
                            <div className="text-xs text-muted-foreground truncate">{result.description}</div>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-mono truncate max-w-32">
                          {result.subtitle}
                        </span>
                      </Command.Item>
                    ))}
                  </div>
                );
              })}
            </Command.List>
          </Command>
        </div>
      )}
    </>
  );
}
