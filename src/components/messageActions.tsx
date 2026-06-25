import figures from 'figures';
import type { RefObject } from 'react';
import React, { useCallback, useMemo, useRef } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { logEvent } from '../services/analytics/index.js';
import type { NormalizedUserMessage, RenderableMessage } from '../types/message.js';
import { isEmptyMessageText, SYNTHETIC_MESSAGES } from '../utils/messages.js';

// 辅助类型：把 MessageContent 的第一个元素收窄为具有已知结构的 block。
// MessageContent = string | ContentBlockParam[] | ContentBlock[]，所以索引
// 得到的是 string | ContentBlockParam | ContentBlock，无法直接暴露 .type/.text。
type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  content?: unknown;
  [key: string]: unknown;
};
const firstBlock = (content: unknown): ContentBlock | undefined => {
  if (!Array.isArray(content)) return undefined;
  const b = content[0];
  if (b == null || typeof b === 'string') return undefined;
  return b as ContentBlock;
};

const NAVIGABLE_TYPES = [
  'user',
  'assistant',
  'grouped_tool_use',
  'collapsed_read_search',
  'system',
  'attachment',
] as const;
export type NavigableType = (typeof NAVIGABLE_TYPES)[number];

export type NavigableOf<T extends NavigableType> = Extract<RenderableMessage, { type: T }>;
export type NavigableMessage = RenderableMessage;

// Tier-2 黑名单（tier-1 是 height > 0）—— 这些会渲染但不可操作。
export function isNavigableMessage(msg: NavigableMessage): boolean {
  switch (msg.type) {
    case 'assistant': {
      const b = firstBlock(msg.message.content);
      // 文本响应（扣除 AssistantTextMessage 返回 null 的情况 —— tier-1
      // 会漏掉未测量的虚拟项），或带有可提取输入的工具调用。
      return (
        (b?.type === 'text' && !isEmptyMessageText(b.text!) && !SYNTHETIC_MESSAGES.has(b.text!)) ||
        (b?.type === 'tool_use' && b.name! in PRIMARY_INPUT)
      );
    }
    case 'user': {
      if (msg.isMeta || msg.isCompactSummary) return false;
      const b = firstBlock(msg.message.content);
      if (b?.type !== 'text') return false;
      // Interrupt 等 —— 合成内容，并非用户编写。
      if (SYNTHETIC_MESSAGES.has(b.text!)) return false;
      // 与 VirtualMessageList sticky-prompt 相同的过滤：XML 包裹的（命令
      // 展开、bash-stdout 等）不是真正的 prompt。
      return !stripSystemReminders(b.text!).startsWith('<');
    }
    case 'system':
      switch (msg.subtype) {
        case 'api_metrics':
        case 'stop_hook_summary':
        case 'turn_duration':
        case 'memory_saved':
        case 'agents_killed':
        case 'away_summary':
        case 'thinking':
          return false;
      }
      return true;
    case 'grouped_tool_use':
    case 'collapsed_read_search':
      return true;
    case 'attachment':
      switch (msg.attachment.type) {
        case 'queued_command':
        case 'diagnostics':
        case 'hook_blocking_error':
        case 'hook_error_during_execution':
          return true;
      }
      return false;
  }
  return false;
}

type PrimaryInput = {
  label: string;
  extract: (input: Record<string, unknown>) => string | undefined;
};
const str = (k: string) => (i: Record<string, unknown>) => (typeof i[k] === 'string' ? i[k] : undefined);
const PRIMARY_INPUT: Record<string, PrimaryInput> = {
  Read: { label: 'path', extract: str('file_path') },
  Edit: { label: 'path', extract: str('file_path') },
  Write: { label: 'path', extract: str('file_path') },
  NotebookEdit: { label: 'path', extract: str('notebook_path') },
  Bash: { label: 'command', extract: str('command') },
  Grep: { label: 'pattern', extract: str('pattern') },
  Glob: { label: 'pattern', extract: str('pattern') },
  WebFetch: { label: 'url', extract: str('url') },
  WebSearch: { label: 'query', extract: str('query') },
  Task: { label: 'prompt', extract: str('prompt') },
  Agent: { label: 'prompt', extract: str('prompt') },
  Tmux: {
    label: 'command',
    extract: i => (Array.isArray(i.args) ? `tmux ${i.args.join(' ')}` : undefined),
  },
};

// 只有 AgentTool 拥有 renderGroupedToolUse —— Edit/Bash 等仍保持为 assistant tool_use block。
export function toolCallOf(msg: NavigableMessage): { name: string; input: Record<string, unknown> } | undefined {
  if (msg.type === 'assistant') {
    const b = firstBlock(msg.message.content);
    if (b?.type === 'tool_use') return { name: b.name!, input: b.input as Record<string, unknown> };
  }
  if (msg.type === 'grouped_tool_use') {
    const b = firstBlock(msg.messages[0]?.message.content);
    if (b?.type === 'tool_use') return { name: msg.toolName, input: b.input as Record<string, unknown> };
  }
  return undefined;
}

export type MessageActionCaps = {
  copy: (text: string) => void;
  edit: (msg: NormalizedUserMessage) => Promise<void>;
};

// 身份构建器 —— 保留 tuple 类型，使 `run` 的参数能收窄（不加这个的话，数组字面量会被拓宽）。
function action<const T extends NavigableType, const K extends string>(a: {
  key: K;
  label: string | ((s: MessageActionsState) => string);
  types: readonly T[];
  applies?: (s: MessageActionsState) => boolean;
  stays?: true;
  run: (m: NavigableOf<T>, caps: MessageActionCaps) => void;
}) {
  return a;
}

export const MESSAGE_ACTIONS = [
  action({
    key: 'enter',
    label: s => (s.expanded ? '折叠' : '展开'),
    types: ['grouped_tool_use', 'collapsed_read_search', 'attachment', 'system'],
    stays: true,
    // 空 —— `stays` 由 dispatch 内联处理。
    run: () => {},
  }),
  action({
    key: 'enter',
    label: '编辑',
    types: ['user'],
    run: (m, c) => void c.edit(m),
  }),
  action({
    key: 'c',
    label: '复制',
    types: NAVIGABLE_TYPES,
    run: (m, c) => c.copy(copyTextOf(m)),
  }),
  action({
    key: 'p',
    // `!` 安全：applies() 保证 toolName ∈ PRIMARY_INPUT。
    label: s => `复制 ${PRIMARY_INPUT[s.toolName!]!.label}`,
    types: ['grouped_tool_use', 'assistant'],
    applies: s => s.toolName != null && s.toolName in PRIMARY_INPUT,
    run: (m, c) => {
      const tc = toolCallOf(m);
      if (!tc) return;
      const val = PRIMARY_INPUT[tc.name]?.extract(tc.input);
      if (val) c.copy(val);
    },
  }),
] as const;

function isApplicable(a: (typeof MESSAGE_ACTIONS)[number], c: MessageActionsState): boolean {
  if (!(a.types as readonly string[]).includes(c.msgType)) return false;
  return !a.applies || a.applies(c);
}

export type MessageActionsState = {
  uuid: string;
  msgType: NavigableType;
  expanded: boolean;
  toolName?: string;
};

export type MessageActionsNav = {
  enterCursor: () => void;
  navigatePrev: () => void;
  navigateNext: () => void;
  navigatePrevUser: () => void;
  navigateNextUser: () => void;
  navigateTop: () => void;
  navigateBottom: () => void;
  getSelected: () => NavigableMessage | null;
};

export const MessageActionsSelectedContext = React.createContext(false);
export const InVirtualListContext = React.createContext(false);

// bg 必须放在拥有 marginTop 的 Box 上（margin 位于绘制区域之外）—— 即每个 consumer 的内部。
export function useSelectedMessageBg(): 'messageActionsBackground' | undefined {
  return React.useContext(MessageActionsSelectedContext) ? 'messageActionsBackground' : undefined;
}

// 不能在这里调用 useKeybindings —— hook 运行在 <KeybindingSetup> provider 之外。改为返回 handlers。
export function useMessageActions(
  cursor: MessageActionsState | null,
  setCursor: React.Dispatch<React.SetStateAction<MessageActionsState | null>>,
  navRef: RefObject<MessageActionsNav | null>,
  caps: MessageActionCaps,
): {
  enter: () => void;
  handlers: Record<string, () => void>;
} {
  // Ref 让 handlers 保持稳定 —— 不会因每条消息追加而重新注册 useKeybindings。
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const capsRef = useRef(caps);
  capsRef.current = caps;

  const handlers = useMemo(() => {
    const h: Record<string, () => void> = {
      'messageActions:prev': () => navRef.current?.navigatePrev(),
      'messageActions:next': () => navRef.current?.navigateNext(),
      'messageActions:prevUser': () => navRef.current?.navigatePrevUser(),
      'messageActions:nextUser': () => navRef.current?.navigateNextUser(),
      'messageActions:top': () => navRef.current?.navigateTop(),
      'messageActions:bottom': () => navRef.current?.navigateBottom(),
      'messageActions:escape': () => setCursor(c => (c?.expanded ? { ...c, expanded: false } : null)),
      // ctrl+c 跳过折叠步骤 —— 从"流式过程中已展开"状态出发，两段式
      // 意味着需要按 3 次才能中断（折叠→null→取消）。
      'messageActions:ctrlc': () => setCursor(null),
    };
    for (const key of new Set(MESSAGE_ACTIONS.map(a => a.key))) {
      h[`messageActions:${key}`] = () => {
        const c = cursorRef.current;
        if (!c) return;
        const a = MESSAGE_ACTIONS.find(a => a.key === key && isApplicable(a, c));
        if (!a) return;
        if (a.stays) {
          setCursor(c => (c ? { ...c, expanded: !c.expanded } : null));
          return;
        }
        const m = navRef.current?.getSelected();
        if (!m) return;
        (a.run as (m: NavigableMessage, c: MessageActionCaps) => void)(m, capsRef.current);
        setCursor(null);
      };
    }
    return h;
  }, [setCursor, navRef]);

  const enter = useCallback(() => {
    logEvent('tengu_message_actions_enter', {});
    navRef.current?.enterCursor();
  }, [navRef]);

  return { enter, handlers };
}

// 必须挂载在 <KeybindingSetup> 内部。
export function MessageActionsKeybindings({
  handlers,
  isActive,
}: {
  handlers: Record<string, () => void>;
  isActive: boolean;
}): null {
  useKeybindings(handlers, { context: 'MessageActions', isActive });
  return null;
}

// 仅 borderTop 的 Box 与 PromptInput 的 ─── 线条匹配，保证底部高度稳定。
export function MessageActionsBar({ cursor }: { cursor: MessageActionsState }): React.ReactNode {
  const applicable = MESSAGE_ACTIONS.filter(a => isApplicable(a, cursor));
  return (
    <Box flexDirection="column" flexShrink={0} paddingY={1}>
      <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderDimColor />
      <Box paddingX={2} paddingY={1}>
        {applicable.map((a, i) => {
          const label = typeof a.label === 'function' ? a.label(cursor) : a.label;
          return (
            <React.Fragment key={a.key}>
              {i > 0 && <Text dimColor> · </Text>}
              {/* dimColor={false} 强制 SGR 22 —— borderDimColor 兄弟节点会把 dim 效果渗到第一个 cell */}
              <Text bold dimColor={false}>
                {a.key}
              </Text>
              <Text dimColor> {label}</Text>
            </React.Fragment>
          );
        })}
        <Text dimColor> · </Text>
        <Text bold dimColor={false}>
          {figures.arrowUp}
          {figures.arrowDown}
        </Text>
        <Text dimColor> 导航 · </Text>
        <Text bold dimColor={false}>
          esc
        </Text>
        <Text dimColor> 返回</Text>
      </Box>
    </Box>
  );
}

export function stripSystemReminders(text: string): string {
  const CLOSE = '</system-reminder>';
  let t = text.trimStart();
  while (t.startsWith('<system-reminder>')) {
    const end = t.indexOf(CLOSE);
    if (end < 0) break;
    t = t.slice(end + CLOSE.length).trimStart();
  }
  return t;
}

export function copyTextOf(msg: NavigableMessage): string {
  switch (msg.type) {
    case 'user': {
      const b = firstBlock(msg.message.content);
      return b?.type === 'text' ? stripSystemReminders(b.text!) : '';
    }
    case 'assistant': {
      const b = firstBlock(msg.message.content);
      if (b?.type === 'text') return b.text!;
      const tc = toolCallOf(msg);
      return tc ? (PRIMARY_INPUT[tc.name]?.extract(tc.input) ?? '') : '';
    }
    case 'grouped_tool_use':
      return msg.results.map(toolResultText).filter(Boolean).join('\n\n');
    case 'collapsed_read_search':
      return msg.messages
        .flatMap(m =>
          m.type === 'user' ? [toolResultText(m)] : m.type === 'grouped_tool_use' ? m.results.map(toolResultText) : [],
        )
        .filter(Boolean)
        .join('\n\n');
    case 'system':
      if ('content' in msg) return String(msg.content);
      if ('error' in msg) return String(msg.error);
      return String(msg.subtype ?? '');
    case 'attachment': {
      const a = msg.attachment;
      if (a.type === 'queued_command') {
        const p = (a as { prompt?: unknown }).prompt;
        return typeof p === 'string'
          ? p
          : (p as Array<{ type: string; text?: string }>)
              .flatMap(b => (b.type === 'text' ? [b.text ?? ''] : []))
              .join('\n');
      }
      return `[${a.type}]`;
    }
  }
  return '';
}

function toolResultText(r: NormalizedUserMessage): string {
  const b = firstBlock(r.message.content);
  if (b?.type !== 'tool_result') return '';
  const c = b.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  return (c as Array<{ type: string; text?: string }>)
    .flatMap(x => (x.type === 'text' ? [x.text ?? ''] : []))
    .join('\n');
}
