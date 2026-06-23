import { feature } from 'bun:bundle';
import figures from 'figures';
import * as React from 'react';
import type { z } from 'zod/v4';
import { ProgressBar } from '@anthropic/ink';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { linkifyUrlsInText, OutputLine } from 'src/components/shell/OutputLine.js';
import { Ansi, Box, Text, stringWidth } from '@anthropic/ink';
import { createHyperlink } from 'src/utils/hyperlink.js';
import type { ToolProgressData } from 'src/Tool.js';
import type { ProgressMessage } from 'src/types/message.js';
import type { MCPProgress } from 'src/types/tools.js';
import { formatNumber } from 'src/utils/format.js';

import { getContentSizeEstimate, type MCPToolResult } from 'src/utils/mcpValidation.js';
import { jsonParse, jsonStringify } from 'src/utils/slowOperations.js';
import type { inputSchema } from './MCPTool.js';

// 显示大型 MCP 响应警告的阈值
const MCP_OUTPUT_WARNING_THRESHOLD_TOKENS = 10_000;

// 非 verbose 模式下截断单个输入值以保持头部紧凑。
// 与 BashTool 的理念一致：显示足够识别调用的信息，
// 而不内联转储整个 payload。
const MAX_INPUT_VALUE_CHARS = 80;

// 回退到原始 JSON 显示前的最大顶层键数。
// 超过此数量，扁平 k:v 列表会弊大于利。
const MAX_FLAT_JSON_KEYS = 12;

// 不对大型 blob 尝试扁平对象解析。
const MAX_FLAT_JSON_CHARS = 5_000;

// 不尝试解析超过此大小的 JSON blob（性能安全）。
const MAX_JSON_PARSE_CHARS = 200_000;

// 字符串值被视为"主要文本 payload"的条件：含换行或足够长，
// 使得内联显示不如解包展示。
const UNWRAP_MIN_STRING_LEN = 200;

export function renderToolUseMessage(
  input: z.infer<ReturnType<typeof inputSchema>>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (Object.keys(input).length === 0) {
    return '';
  }
  return Object.entries(input)
    .map(([key, value]) => {
      let rendered = jsonStringify(value);
      if (feature('MCP_RICH_OUTPUT') && !verbose && rendered.length > MAX_INPUT_VALUE_CHARS) {
        rendered = rendered.slice(0, MAX_INPUT_VALUE_CHARS).trimEnd() + '…';
      }
      return `${key}: ${rendered}`;
    })
    .join(', ');
}

export function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<MCPProgress>[],
): React.ReactNode {
  const lastProgress = progressMessagesForMessage.at(-1);

  if (!lastProgress?.data) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>运行中…</Text>
      </MessageResponse>
    );
  }

  const { progress, total, progressMessage } = lastProgress.data;

  if (progress === undefined) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>运行中…</Text>
      </MessageResponse>
    );
  }

  if (total !== undefined && total > 0) {
    const ratio = Math.min(1, Math.max(0, progress / total));
    const percentage = Math.round(ratio * 100);
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {progressMessage && <Text dimColor>{progressMessage}</Text>}
          <Box flexDirection="row" gap={1}>
            <ProgressBar ratio={ratio} width={20} />
            <Text dimColor>{percentage}%</Text>
          </Box>
        </Box>
      </MessageResponse>
    );
  }

  return (
    <MessageResponse height={1}>
      <Text dimColor>{progressMessage ?? `处理中… ${progress}`}</Text>
    </MessageResponse>
  );
}

export function renderToolResultMessage(
  output: string | MCPToolResult,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose, input }: { verbose: boolean; input?: unknown },
): React.ReactNode {
  const mcpOutput = output as MCPToolResult;

  if (!verbose) {
    const slackSend = trySlackSendCompact(mcpOutput, input);
    if (slackSend !== null) {
      return (
        <MessageResponse height={1}>
          <Text>
            已向 <Ansi>{createHyperlink(slackSend.url, slackSend.channel)}</Ansi> 发送消息
          </Text>
        </MessageResponse>
      );
    }
  }

  const estimatedTokens = getContentSizeEstimate(mcpOutput);
  const showWarning = estimatedTokens > MCP_OUTPUT_WARNING_THRESHOLD_TOKENS;
  const warningMessage = showWarning
    ? `${figures.warning} MCP 响应过大（约 ${formatNumber(estimatedTokens)} tokens），会迅速填满上下文`
    : null;

  let contentElement: React.ReactNode;
  if (Array.isArray(mcpOutput)) {
    const contentBlocks = mcpOutput.map((item, i) => {
      if (item.type === 'image') {
        return (
          <Box key={i} justifyContent="space-between" overflowX="hidden" width="100%">
            <MessageResponse height={1}>
              <Text>[图片]</Text>
            </MessageResponse>
          </Box>
        );
      }
      // 对 text 块与任何其他块类型，提取文本（若有）
      const textContent =
        item.type === 'text' && 'text' in item && item.text !== null && item.text !== undefined
          ? String(item.text)
          : '';
      return feature('MCP_RICH_OUTPUT') ? (
        <MCPTextOutput key={i} content={textContent} verbose={verbose} />
      ) : (
        <OutputLine key={i} content={textContent} verbose={verbose} />
      );
    });

    // 将数组内容包裹在列布局中
    contentElement = (
      <Box flexDirection="column" width="100%">
        {contentBlocks}
      </Box>
    );
  } else if (!mcpOutput) {
    contentElement = (
      <Box justifyContent="space-between" overflowX="hidden" width="100%">
        <MessageResponse height={1}>
          <Text dimColor>（无内容）</Text>
        </MessageResponse>
      </Box>
    );
  } else {
    contentElement = feature('MCP_RICH_OUTPUT') ? (
      <MCPTextOutput content={mcpOutput} verbose={verbose} />
    ) : (
      <OutputLine content={mcpOutput} verbose={verbose} />
    );
  }

  if (warningMessage) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text color="warning">{warningMessage}</Text>
        </MessageResponse>
        {contentElement}
      </Box>
    );
  }

  return contentElement;
}

/**
 * 渲染 MCP 文本输出。依次尝试三种策略：
 * 1. 如果 JSON 只包裹了一个占主导地位的文本 payload（如 Slack 的
 *    {"messages":"line1\nline2..."}），解包并交给 OutputLine 截断。
 * 2. 如果 JSON 是一个小而扁平的对象，按对齐的 key: value 渲染。
 * 3. 否则回退到 OutputLine（pretty-print + 截断）。
 */
function MCPTextOutput({ content, verbose }: { content: string; verbose: boolean }): React.ReactNode {
  const unwrapped = tryUnwrapTextPayload(content);
  if (unwrapped !== null) {
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {unwrapped.extras.length > 0 && (
            <Text dimColor>{unwrapped.extras.map(([k, v]) => `${k}: ${v}`).join(' · ')}</Text>
          )}
          <OutputLine content={unwrapped.body} verbose={verbose} linkifyUrls />
        </Box>
      </MessageResponse>
    );
  }
  const flat = tryFlattenJson(content);
  if (flat !== null) {
    const maxKeyWidth = Math.max(...flat.map(([k]) => stringWidth(k)));
    return (
      <MessageResponse>
        <Box flexDirection="column">
          {flat.map(([key, value], i) => (
            <Text key={i}>
              <Text dimColor>{key.padEnd(maxKeyWidth)}: </Text>
              <Ansi>{linkifyUrlsInText(value)}</Ansi>
            </Text>
          ))}
        </Box>
      </MessageResponse>
    );
  }
  return <OutputLine content={content} verbose={verbose} linkifyUrls />;
}

/**
 * 将 content 解析为 JSON 对象并返回其 entries。若 content 不可解析、
 * 不是对象、过大、或键数为 0/过多，则返回 null。
 */
function parseJsonEntries(
  content: string,
  { maxChars, maxKeys }: { maxChars: number; maxKeys: number },
): [string, unknown][] | null {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars || trimmed[0] !== '{') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = jsonParse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > maxKeys) {
    return null;
  }
  return entries;
}

/**
 * 如果 content 解析为 JSON 对象，且所有值都是标量或小型嵌套对象，
 * 则将其扁平化为 [key, displayValue] 对。嵌套对象用一行 JSON 表示。
 * 如果 content 不符合条件则返回 null。
 */
export function tryFlattenJson(content: string): [string, string][] | null {
  const entries = parseJsonEntries(content, {
    maxChars: MAX_FLAT_JSON_CHARS,
    maxKeys: MAX_FLAT_JSON_KEYS,
  });
  if (entries === null) return null;
  const result: [string, string][] = [];
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      result.push([key, value]);
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      result.push([key, String(value)]);
    } else if (typeof value === 'object') {
      const compact = jsonStringify(value);
      if (compact.length > 120) return null;
      result.push([key, compact]);
    } else {
      return null;
    }
  }
  return result;
}

/**
 * 如果 content 是一个 JSON 对象，其中一个 key 持有占主导地位的字符串
 * payload（多行或很长），且所有兄弟字段都是小标量，则解包它。这处理
 * 常见的 MCP 模式 {"messages":"line1\nline2..."}：pretty-print 会保持
 * \n 转义，但我们想要真正的换行 + 截断。
 */
export function tryUnwrapTextPayload(content: string): { body: string; extras: [string, string][] } | null {
  const entries = parseJsonEntries(content, {
    maxChars: MAX_JSON_PARSE_CHARS,
    maxKeys: 4,
  });
  if (entries === null) return null;
  // 找到唯一的主要字符串 payload。先 trim：尾部 \n
  // 不应让短兄弟字段（如分页提示）变成"主要"。
  let body: string | null = null;
  const extras: [string, string][] = [];
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      const t = value.trimEnd();
      const isDominant = t.length > UNWRAP_MIN_STRING_LEN || (t.includes('\n') && t.length > 50);
      if (isDominant) {
        if (body !== null) return null; // 两个大字符串 —— 有歧义
        body = t;
        continue;
      }
      if (t.length > 150) return null;
      extras.push([key, t.replace(/\s+/g, ' ')]);
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      extras.push([key, String(value)]);
    } else {
      return null; // 嵌套对象/数组 —— 走 flat 或 pretty-print 路径
    }
  }
  if (body === null) return null;
  return { body, extras };
}

const SLACK_ARCHIVES_RE = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p\d+$/;

/**
 * 检测 Slack 发送消息的结果并返回紧凑的 {channel, url} 对。
 * 同时匹配托管（claude.ai Slack）和社区 MCP server 的数据结构 ——
 * 两者都在结果中返回 `message_link`。channel 标签优先取自工具输入
 * （可能是名称如 "#foo" 或 ID 如 "C09EVDAN1NK"），找不到时回退到
 * 从 archives URL 解析出的 ID。
 */
export function trySlackSendCompact(
  output: string | MCPToolResult,
  input: unknown,
): { channel: string; url: string } | null {
  let text: unknown = output;
  if (Array.isArray(output)) {
    const block = output.find(b => b.type === 'text');
    text = block && 'text' in block ? block.text : undefined;
  }
  if (typeof text !== 'string' || !text.includes('"message_link"')) {
    return null;
  }

  const entries = parseJsonEntries(text, { maxChars: 2000, maxKeys: 6 });
  const url = entries?.find(([k]) => k === 'message_link')?.[1];
  if (typeof url !== 'string') return null;
  const m = SLACK_ARCHIVES_RE.exec(url);
  if (!m) return null;

  const inp = input as { channel_id?: unknown; channel?: unknown } | undefined;
  const raw = inp?.channel_id ?? inp?.channel ?? m[1];
  const label = typeof raw === 'string' && raw ? raw : 'slack';
  return { channel: label.startsWith('#') ? label : `#${label}`, url };
}
