import { feature } from 'bun:bundle';
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ContextVisualization } from '../../components/ContextVisualization.js';
import { microcompactMessages } from '../../services/compact/microCompact.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import type { Message } from '../../types/message.js';
import { analyzeContextUsage } from '../../utils/analyzeContext.js';
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js';
import { renderToAnsiString } from '../../utils/staticRender.js';

/**
 * 应用与 query.ts 在 API 调用前所做的相同 context 转换，以便
 * /context 展示模型实际看到的内容，而不是 REPL 的原始历史。
 * 如果不做 projectView，token 计数会多计入被折叠的部分 ——
 * 用户会看到 "180k, 3 spans collapsed"，而 API 实际看到的是 120k。
 */
function toApiView(messages: Message[]): Message[] {
  let view = getMessagesAfterCompactBoundary(messages);
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { projectView } =
      require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    view = projectView(view);
  }
  return view;
}

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const {
    messages,
    getAppState,
    options: { mainLoopModel, tools },
  } = context;

  const apiView = toApiView(messages);

  // 应用 microcompact 以获得发送到 API 的消息的准确表示
  const { messages: compactedMessages } = await microcompactMessages(apiView);

  // 获取终端宽度以实现响应式尺寸调整
  const terminalWidth = process.stdout.columns || 80;

  const appState = getAppState();

  // 用 compacted 后的消息分析上下文
  // 将原始消息作为最后一个参数传入，以便准确提取 API 用量
  const data = await analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    appState.agentDefinitions,
    terminalWidth,
    context, // 传入完整 context 以计算 system prompt
    undefined, // mainThreadAgentDefinition
    apiView, // 用于 API 用量提取的原始消息
  );

  // 渲染为 ANSI 字符串以保留颜色，并像 local 命令那样传给 onDone
  const output = await renderToAnsiString(<ContextVisualization data={data} />);
  onDone(output);
  return null;
}
