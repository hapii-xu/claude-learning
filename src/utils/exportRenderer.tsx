import React, { useRef } from 'react';
import stripAnsi from 'strip-ansi';
import { Messages } from '../components/Messages.js';
import { KeybindingProvider } from '../keybindings/KeybindingContext.js';
import { loadKeybindingsSyncWithWarnings } from '../keybindings/loadUserBindings.js';
import type { KeybindingContextName } from '../keybindings/types.js';
import { AppStateProvider } from '../state/AppState.js';
import type { Tools } from '../Tool.js';
import type { Message } from '../types/message.js';
import { renderToAnsiString } from './staticRender.js';

/**
 * 用于静态/无头渲染的最小键绑定提供器。
 * 提供键绑定上下文，不含 ChordInterceptor（后者使用 useInput，
 * 在无 stdin 的无头渲染中会挂起）。
 */
function StaticKeybindingProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const { bindings } = loadKeybindingsSyncWithWarnings();
  const pendingChordRef = useRef(null);
  const handlerRegistryRef = useRef(new Map());
  const activeContexts = useRef(new Set<KeybindingContextName>()).current;

  return (
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={null}
      setPendingChord={() => {}}
      activeContexts={activeContexts}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={handlerRegistryRef}
    >
      {children}
    </KeybindingProvider>
  );
}

// 估算一条 Message 最多能产生多少 NormalizedMessages 的上界。
// normalizeMessages 将一条含 N 个内容块的 Message 拆分为 N 条
// NormalizedMessages — 与块数 1:1 对应。字符串内容 = 1 个块。
// AttachmentMessage 等没有 .message，规范化后 ≤1。
function normalizedUpperBound(m: Message): number {
  if (!('message' in m)) return 1;
  const c = m.message!.content;
  return Array.isArray(c) ? c.length : 1;
}

/**
 * 以分块方式流式渲染消息，保留 ANSI 转义码。每个块都是一次
 * 新鲜的 renderToAnsiString — yoga 布局树 + Ink 屏幕缓冲区的大小
 * 以最高的 CHUNK 为准，而非整个会话。实测（2026 年 3 月，
 * 538 条消息会话）：与单次完整渲染相比，RSS 峰值降低 55%。sink 拥有
 * 输出所有权 — 写入 stdout 用于 `[` 转存到回滚缓冲区，appendFile 用于 `v`。
 *
 * Messages.renderRange 在 normalize→group→collapse 之后切片，因此工具调用
 * 分组在块边界处保持正确；buildMessageLookups 在完整规范化数组上运行，
 * 所以 tool_use↔tool_result 的解析不受各自落在哪个块中的影响。
 */
export async function streamRenderedMessages(
  messages: Message[],
  tools: Tools,
  sink: (ansiChunk: string) => void | Promise<void>,
  {
    columns,
    verbose = false,
    chunkSize = 40,
    onProgress,
  }: {
    columns?: number;
    verbose?: boolean;
    chunkSize?: number;
    onProgress?: (rendered: number) => void;
  } = {},
): Promise<void> {
  const renderChunk = (range: readonly [number, number]) =>
    renderToAnsiString(
      <AppStateProvider>
        <StaticKeybindingProvider>
          <Messages
            messages={messages}
            tools={tools}
            commands={[]}
            verbose={verbose}
            toolJSX={null}
            toolUseConfirmQueue={[]}
            inProgressToolUseIDs={new Set()}
            isMessageSelectorVisible={false}
            conversationId="export"
            screen="prompt"
            streamingToolUses={[]}
            showAllInTranscript={true}
            isLoading={false}
            renderRange={range}
          />
        </StaticKeybindingProvider>
      </AppStateProvider>,
      columns,
    );

  // renderRange 索引到折叠后数组，其长度在此不可见——normalize 将每条 Message
  // 按内容块数量拆分为 NormalizedMessage（每条消息数量不限），collapse 将部分合并回去。
  // 上限为精确的 normalize 输出数量 + chunkSize，使循环
  // 始终到达触发 break 的空切片（collapse 只会收缩）。
  let ceiling = chunkSize;
  for (const m of messages) ceiling += normalizedUpperBound(m);
  for (let offset = 0; offset < ceiling; offset += chunkSize) {
    const ansi = await renderChunk([offset, offset + chunkSize]);
    if (stripAnsi(ansi).trim() === '') break;
    await sink(ansi);
    onProgress?.(offset + chunkSize);
  }
}

/**
 * 将消息渲染为适合导出的纯文本字符串。
 * 使用与交互式 UI 相同的 React 渲染逻辑。
 */
export async function renderMessagesToPlainText(
  messages: Message[],
  tools: Tools = [],
  columns?: number,
): Promise<string> {
  const parts: string[] = [];
  await streamRenderedMessages(messages, tools, chunk => void parts.push(stripAnsi(chunk)), { columns });
  return parts.join('');
}
