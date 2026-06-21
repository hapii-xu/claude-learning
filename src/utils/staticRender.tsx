import * as React from 'react';
import { useLayoutEffect } from 'react';
import { PassThrough } from 'stream';
import stripAnsi from 'strip-ansi';
import { wrappedRender as render, useApp } from '@anthropic/ink';

// 这是 Ink 不支持在同一渲染树中使用多个 <Static> 组件的变通方法。
// 我们不使用 <Static>，而是将组件渲染为字符串然后打印到 stdout

/**
 * 渲染后退出的包装组件。
 * 使用 useLayoutEffect 确保我们在退出前等待 React 的提交阶段完成。
 * 这比 process.nextTick() 对 React 19 的异步渲染周期更健壮。
 */
function RenderOnceAndExit({ children }: { children: React.ReactNode }): React.ReactNode {
  const { exit } = useApp();

  // useLayoutEffect 在 React 提交 DOM 变更后同步运行。
  // setTimeout(0) 延迟退出以允许 Ink 将输出刷新到流。
  useLayoutEffect(() => {
    const timer = setTimeout(exit, 0);
    return () => clearTimeout(timer);
  }, [exit]);

  return <>{children}</>;
}

// 终端使用的 DEC 同步更新标记
const SYNC_START = '\x1B[?2026h';
const SYNC_END = '\x1B[?2026l';

/**
 * 从 Ink 输出中的第一个完整帧提取内容。
 * Ink 在非 TTY stdout 下输出多个帧，每个帧都包裹在 DEC 同步更新序列
 *（[?2026h ... [?2026l）中。我们只需要第一个帧的内容。
 */
function extractFirstFrame(output: string): string {
  const startIndex = output.indexOf(SYNC_START);
  if (startIndex === -1) return output;

  const contentStart = startIndex + SYNC_START.length;
  const endIndex = output.indexOf(SYNC_END, contentStart);
  if (endIndex === -1) return output;

  return output.slice(contentStart, endIndex);
}

/**
 * 将 React 节点渲染为带 ANSI 转义码的字符串（用于终端输出）。
 */
export async function renderToAnsiString(node: React.ReactNode, columns?: number): Promise<string> {
  let output = '';

  // 捕获所有写入。设置 .columns 使 Ink（ink.tsx:~165）获取选定宽度，
  // 而非 PassThrough 的 undefined → 80 回退 — 对于以终端宽度渲染
  // 应与用户在屏幕上看到的内容匹配的文件转储很有用。
  const stream = new PassThrough();
  if (columns !== undefined) {
    (stream as unknown as { columns: number }).columns = columns;
  }
  stream.on('data', chunk => {
    output += chunk.toString();
  });

  // 渲染包裹在 RenderOnceAndExit 中的组件
  // 非 TTY stdout（PassThrough）给出完整帧输出而非差异
  const instance = await render(<RenderOnceAndExit>{node}</RenderOnceAndExit>, {
    stdout: stream as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });

  // 等待组件自然退出
  await instance.waitUntilExit();

  // 仅提取第一个帧的内容以避免重复
  //（Ink 在非 TTY 模式下输出多个帧）
  return extractFirstFrame(output);
}

/**
 * 将 React 节点渲染为纯文本字符串（剥离 ANSI 码）。
 */
export async function renderToString(node: React.ReactNode, columns?: number): Promise<string> {
  const output = await renderToAnsiString(node, columns);
  return stripAnsi(output);
}
