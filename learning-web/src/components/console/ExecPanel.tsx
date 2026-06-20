import { useState, useEffect, useRef } from 'react';
import { useSse } from '@/hooks/useSse';
import { runExec, cancelExec, fetchCommands } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ExecCommand } from '@/data/types';
import {
  Play,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  FileCheck,
  TestTube,
  TestTube2,
  Heart,
  Trash2,
} from 'lucide-react';

const iconMap: Record<string, typeof Play> = {
  TestTube,
  TestTube2,
  ShieldCheck,
  FileCheck,
  CheckCircle: CheckCircle2,
  Heart,
};

export function ExecPanel() {
  const [commands, setCommands] = useState<ExecCommand[]>([]);
  const { lines, connected, connect, disconnect, clear, exitCode } = useSse();
  const [running, setRunning] = useState(false);
  const [execId, setExecId] = useState<string | null>(null);
  const [currentCmd, setCurrentCmd] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCommands()
      .then(setCommands)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    if (exitCode !== null) setRunning(false);
  }, [exitCode]);

  const handleRun = async (cmd: ExecCommand) => {
    if (running) {
      if (execId) await cancelExec(execId);
      disconnect();
      setRunning(false);
      return;
    }

    try {
      const result = await runExec({ cmd: cmd.id });
      setExecId(result.execId);
      setCurrentCmd(cmd.label);
      setRunning(true);
      clear();
      connect(`/api/exec/stream?execId=${result.execId}`);
    } catch {
      // Error in UI
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Command buttons */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b bg-surface-1/50 flex-wrap">
        {commands.map(cmd => {
          const Icon = iconMap[cmd.icon] || Play;
          const isCurrent = currentCmd === cmd.label && running;
          return (
            <Button
              key={cmd.id}
              size="sm"
              variant={isCurrent ? 'destructive' : 'outline'}
              className="h-7 px-2.5 text-xs"
              onClick={() => handleRun(cmd)}
            >
              {isCurrent ? (
                <>
                  <Square className="size-3 mr-1" />
                  停止
                </>
              ) : (
                <>
                  <Icon className="size-3 mr-1" />
                  {cmd.label}
                </>
              )}
            </Button>
          );
        })}

        <button
          onClick={clear}
          className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="清空"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      {/* Output */}
      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="p-3 font-mono text-xs leading-relaxed">
          {lines.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">
              {running ? (
                <div className="flex items-center gap-2 justify-center">
                  <Loader2 className="size-4 animate-spin" />
                  <span>正在执行 {currentCmd}...</span>
                </div>
              ) : (
                <p>选择一个命令执行</p>
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
                )}
              >
                {line.data}
              </div>
            ))
          )}

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
                  <span className="text-xs font-medium">{currentCmd} 完成</span>
                </>
              ) : (
                <>
                  <XCircle className="size-4" />
                  <span className="text-xs font-medium">
                    {currentCmd} 失败 (exit: {exitCode})
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
