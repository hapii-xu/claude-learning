import type { LocalJSXCommandOnDone, LocalJSXCommandContext } from '../../types/command.js';

/**
 * /daemon 斜杠命令 — 在 REPL 中管理 daemon 和后台会话。
 *
 * 子命令：status | start | stop | bg | attach | logs | kill
 * 默认（无参数）：status
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const parts = args ? args.trim().split(/\s+/) : [];
  const sub = parts[0] || 'status';

  // attach 是交互式/阻塞的 — REPL 内不可用
  if (sub === 'attach') {
    onDone('Use `claude daemon attach` from the CLI. Attach is not available inside the REPL.', { display: 'system' });
    return null;
  }

  // 对于所有其他子命令，捕获 console 输出并通过 onDone 返回
  const lines = await captureConsole(async () => {
    if (sub === 'bg') {
      const bg = await import('../../cli/bg.js');
      await bg.handleBgStart(parts.slice(1));
    } else {
      const { daemonMain } = await import('../../daemon/main.js');
      await daemonMain([sub, ...parts.slice(1)]);
    }
  });

  onDone(lines.join('\n') || 'Done.', { display: 'system' });
  return null;
}

async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return lines;
}
