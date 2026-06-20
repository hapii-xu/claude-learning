import type { LocalJSXCommandOnDone, LocalJSXCommandContext } from '../../types/command.js';

/**
 * /job slash 命令 — 在 REPL 内管理模板任务。
 *
 * 子命令：list | new <template> [args] | reply <id> <text> | status <id>
 * 默认（无参数）：list
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const parts = args ? args.trim().split(/\s+/) : [];
  const sub = parts[0] || 'list';

  // 捕获 console 输出，以便作为 onDone 文本返回
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(' '));

  try {
    const { templatesMain } = await import('../../cli/handlers/templateJobs.js');
    await templatesMain([sub, ...parts.slice(1)]);
  } finally {
    console.log = origLog;
    console.error = origError;
  }

  onDone(lines.join('\n') || 'Done.', { display: 'system' });
  return null;
}
