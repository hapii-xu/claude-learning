import { feature } from 'bun:bundle';
import React from 'react';
import { AgentTool } from '@claude-code-best/builtin-tools/tools/AgentTool/AgentTool.js';
import { isInForkChild } from '@claude-code-best/builtin-tools/tools/AgentTool/forkSubagent.js';
import { logForDebugging } from '../../utils/debug.js';
import type { LocalJSXCommandOnDone, LocalJSXCommandContext } from '../../types/command.js';

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  // 检查 feature flag
  if (!feature('FORK_SUBAGENT')) {
    onDone('Fork subagent feature is not enabled. Set FEATURE_FORK_SUBAGENT=1 to enable.', { display: 'system' });
    return null;
  }

  // 递归 fork 守卫
  if (isInForkChild(context.messages)) {
    onDone('Fork is not available inside a forked worker. Complete your task directly using your tools.', {
      display: 'system',
    });
    return null;
  }

  const directive = args.trim();
  if (!directive) {
    onDone('Usage: /fork <directive>\nExample: /fork Fix the null check in validate.ts', { display: 'system' });
    return null;
  }

  // 查找最后一条 assistant 消息以从中 fork
  const lastAssistantMessage = [...context.messages].reverse().find(m => m.type === 'assistant') as any; // 类型断言以避免复杂的类型导入

  if (!lastAssistantMessage) {
    onDone('Cannot fork: no assistant response in conversation history.', { display: 'system' });
    return null;
  }

  try {
    // 复用 AgentTool 的 fork 逻辑。
    // 省略 subagent_type 会触发隐式 fork。
    const input = {
      prompt: directive,
      fork: true, // 触发 AgentTool 的 fork 路径：继承父会话上下文 + system prompt + 模型
      run_in_background: true, // fork 总是异步运行
      // description 只显示在底部 selector / BackgroundTasksDialog，保持简短标签
      // 即可；用户输入的 prompt 会作为第一条用户消息呈现在主视图里，这里不要
      // 重复显示。
      description: 'forked from main',
    };

    // 使用正确的参数调用 AgentTool：
    // - input：agent 参数（无 subagent_type => fork 路径）
    // - toolUseContext：当前上下文（ToolUseContext）
    // - canUseTool：来自 context 的权限检查函数
    // - assistantMessage：要从中 fork 的最后一条 assistant 消息
    AgentTool.call(input, context, context.canUseTool!, lastAssistantMessage).catch(error => {
      logForDebugging(`Fork subagent async error: ${error}`, { level: 'error' });
    });

    // 通知用户 fork 已启动
    onDone(`Forked subagent started with directive: "${directive}"`, { display: 'system' });
    return null;
  } catch (error) {
    // 仅捕获同步 setup 错误
    logForDebugging(`Fork command setup error: ${error}`, { level: 'error' });
    onDone(`Fork failed: ${error instanceof Error ? error.message : String(error)}`, { display: 'system' });
    return null;
  }
}
