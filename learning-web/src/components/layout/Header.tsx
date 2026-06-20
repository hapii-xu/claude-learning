import { NavLink } from 'react-router-dom';
import { useTheme } from '@/lib/theme';
import { useConsole } from '@/hooks/useConsole';
import { Moon, Sun, Monitor, Menu, Terminal, Bookmark } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CommandPalette } from './CommandPalette';
import { useState, useEffect } from 'react';

export function Header({ onToggleSidebar }: { onToggleSidebar?: () => void }) {
  const { theme, setTheme } = useTheme();
  const { toggle: toggleConsole, open: consoleOpen } = useConsole();
  const [bookmarkCount, setBookmarkCount] = useState(0);

  useEffect(() => {
    fetch('/api/bookmarks')
      .then(r => r.json())
      .then((data: { bookmarks: Array<unknown> }) => setBookmarkCount(data.bookmarks?.length ?? 0))
      .catch(() => {});
  }, []);

  return (
    <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-40">
      <div className="flex h-14 items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onToggleSidebar}>
            <Menu className="size-4" />
          </Button>
          <NavLink to="/" className="flex items-center gap-2.5 group">
            <div className="size-8 rounded-lg bg-brand flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className="size-5">
                <path d="M6 8h12M6 12h8M6 16h5" stroke="white" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-foreground leading-tight group-hover:text-brand transition-colors">
                Claude Code 学习中心
              </h1>
              <p className="text-[11px] text-muted-foreground leading-tight hidden sm:block">系统性学习代码库架构</p>
            </div>
          </NavLink>
        </div>

        <div className="flex items-center gap-1">
          <CommandPalette />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleConsole}
            title={consoleOpen ? '关闭控制台' : '打开控制台'}
            className={consoleOpen ? 'text-brand' : ''}
          >
            <Terminal className="size-4" />
          </Button>
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
      </div>
    </header>
  );
}

function ThemeToggle({ theme, setTheme }: { theme: string; setTheme: (t: 'light' | 'dark' | 'system') => void }) {
  const nextTheme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(nextTheme as 'light' | 'dark' | 'system')}
      title={`当前: ${theme === 'light' ? '亮色' : theme === 'dark' ? '暗色' : '跟随系统'}`}
    >
      <Icon className="size-4" />
    </Button>
  );
}
