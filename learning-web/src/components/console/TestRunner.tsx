import { useState, useEffect, useRef } from 'react';
import { useSse } from '@/hooks/useSse';
import { runExec, cancelExec } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Play, Square, RotateCw, Loader2, CheckCircle2, XCircle, Trash2 } from 'lucide-react';

interface TestRunnerProps {
  /** 外部触发：指定文件路径 */
  initialPath?: string | null;
}

/**
 * 从 src/foo/bar.ts 推断测试文件路径
 */
function guessTestPath(sourcePath: string): string | null {
  // 模式 1: src/foo/__tests__/bar.test.ts
  const parts = sourcePath.split('/');
  const fileName = parts.pop();
  if (!fileName) return null;
  const baseName = fileName.replace(/\.(tsx?|jsx?)$/, '');
  const dir = parts.join('/');
  return `${dir}/__tests__/${baseName}.test.ts`;
}

export function TestRunner({ initialPath }: TestRunnerProps) {
  const [path, setPath] = useState(initialPath || '');
  const { lines, connected, connect, disconnect, clear, exitCode } = useSse();
  const [running, setRunning] = useState(false);
  const [execId, setExecId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  // Track running state from SSE exit events
  useEffect(() => {
    if (exitCode !== null) {
      setRunning(false);
    }
  }, [exitCode]);

  const handleRun = async () => {
    if (running) {
      // Cancel
      if (execId) {
        await cancelExec(execId);
      }
      disconnect();
      setRunning(false);
      return;
    }

    const testPath = path || undefined;
    try {
      const result = await runExec({
        cmd: testPath ? 'test:file' : 'test:all',
        args: testPath ? { path: testPath } : undefined,
      });
      setExecId(result.execId);
      setRunning(true);
      clear();
      connect(`/api/exec/stream?execId=${result.execId}`);
    } catch (err) {
      // Error handled by UI
    }
  };

  const statusColor =
    exitCode === null
      ? running
        ? 'bg-status-running'
        : 'bg-muted'
      : exitCode === 0
        ? 'bg-status-active'
        : 'bg-status-error';

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-surface-1/50">
        <Input
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="留空运行全部测试，输入路径运行单文件..."
          className="h-7 text-xs font-mono flex-1"
        />
        <Button
          size="sm"
          variant={running ? 'destructive' : 'default'}
          className="h-7 px-3 text-xs"
          onClick={handleRun}
        >
          {running ? (
            <>
              <Square className="size-3 mr-1" />
              停止
            </>
          ) : (
            <>
              <Play className="size-3 mr-1" />
              运行
            </>
          )}
        </Button>
        <button
          onClick={clear}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="清空输出"
        >
          <Trash2 className="size-3.5" />
        </button>

        {/* Status indicator */}
        <div className="flex items-center gap-1.5 ml-auto">
          <div className={cn('size-2 rounded-full', statusColor)} />
          <span className="text-[10px] text-muted-foreground">
            {running ? '运行中' : exitCode === null ? '就绪' : exitCode === 0 ? '通过' : `失败 (${exitCode})`}
          </span>
        </div>
      </div>

      {/* Output */}
      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="p-3 font-mono text-xs leading-relaxed">
          {lines.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">
              {running ? (
                <div className="flex items-center gap-2 justify-center">
                  <Loader2 className="size-4 animate-spin" />
                  <span>正在执行测试...</span>
                </div>
              ) : (
                <p>点击 "运行" 开始执行测试</p>
              )}
            </div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  line.type === 'stderr' && 'text-status-error',
                  line.type === 'exit' && 'font-semibold',
                  line.data.includes('✓') || line.data.includes('pass') || line.data.includes('PASS')
                    ? 'text-status-active'
                    : undefined,
                  line.data.includes('✗') || line.data.includes('fail') || line.data.includes('FAIL')
                    ? 'text-status-error'
                    : undefined,
                )}
              >
                {line.data}
              </div>
            ))
          )}

          {/* Exit status */}
          {exitCode !== null && (
            <div
              className={cn(
                'flex items-center gap-2 mt-2 py-2 px-3 rounded-md',
                exitCode === 0 ? 'bg-status-active/10 text-status-active' : 'bg-status-error/10 text-status-error',
              )}
            >
              {exitCode === 0 ? (
                <>
                  <CheckCircle2 className="size-4" />
                  <span className="text-xs font-medium">所有测试通过</span>
                </>
              ) : (
                <>
                  <XCircle className="size-4" />
                  <span className="text-xs font-medium">测试失败 (exit code: {exitCode})</span>
                </>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
