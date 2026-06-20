/**
 * AuthPlaneSummary —— 纯展示型 Ink 组件。
 *
 * 当用户运行不带参数的 /login 时渲染三栏 auth plane 状态表：
 *
 *   Anthropic auth status:
 *     ☑ Subscription (claude.ai)         pro plan
 *     ☐ Workspace API key                not set
 *          To enable /vault /agents-platform /memory-stores:
 *          1. Open https://console.anthropic.com/settings/keys
 *          ...
 *
 *   Third-party providers:
 *     ✓ Cerebras   (CEREBRAS_API_KEY set)
 *     ☐ Groq       (GROQ_API_KEY not set)
 *     ...
 *
 * 安全：永不渲染原始 API key 值，所有输出都使用遮蔽后的预览。
 */
import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import type { AuthStatus } from './getAuthStatus.js';

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function SubscriptionRow({ subscription }: { subscription: AuthStatus['subscription'] }): React.ReactNode {
  const icon = subscription.active ? '☑' : '☐';
  const planLabel = subscription.active && subscription.plan ? ` ${subscription.plan} plan` : '';
  const statusText = subscription.active ? `logged in${planLabel}` : 'not logged in';

  return (
    <Box>
      <Text color={subscription.active ? 'success' : undefined}>
        {icon} Subscription (claude.ai){'  '}
      </Text>
      <Text dimColor={!subscription.active}>{statusText}</Text>
    </Box>
  );
}

function WorkspaceKeyRow({ workspaceKey }: { workspaceKey: AuthStatus['workspaceKey'] }): React.ReactNode {
  if (!workspaceKey.set) {
    return (
      <Box>
        <Text>{'☐ Workspace API key                '}</Text>
        <Text dimColor>not set</Text>
      </Box>
    );
  }

  if (!workspaceKey.prefixValid) {
    return (
      <Box>
        <Text color="warning">{'⚠ Workspace API key                '}</Text>
        <Text>{workspaceKey.keyPreview}</Text>
        <Text color="warning">{'  (sk-ant-api03-* required)'}</Text>
      </Box>
    );
  }

  // 来源标签：区分 env var 和保存到 settings 中的 key
  const sourceLabel =
    workspaceKey.source === 'settings'
      ? '  (saved to settings)'
      : workspaceKey.source === 'env'
        ? '  (from ANTHROPIC_API_KEY env)'
        : '';

  return (
    <Box>
      <Text color="success">{'☑ Workspace API key                '}</Text>
      <Text>{workspaceKey.keyPreview}</Text>
      {sourceLabel ? <Text dimColor>{sourceLabel}</Text> : null}
    </Box>
  );
}

function WorkspaceKeyInstructions({
  subscription,
  workspaceKey,
}: {
  subscription: AuthStatus['subscription'];
  workspaceKey: AuthStatus['workspaceKey'];
}): React.ReactNode {
  // 当 workspace key 缺失且 subscription 处于激活状态（用户已登录）时显示设置指引
  if (!workspaceKey.set && subscription.active) {
    return (
      <Box flexDirection="column" marginLeft={5} marginTop={0}>
        <Text dimColor>To enable /vault /agents-platform /memory-stores:</Text>
        <Text dimColor>{'Press W to set now (saves to settings.json, no restart needed)'}</Text>
        <Text dimColor>{'  — or —'}</Text>
        <Text dimColor>{'1. Open https://console.anthropic.com/settings/keys'}</Text>
        <Text dimColor>{'2. Create a key (sk-ant-api03-*)'}</Text>
        <Text dimColor>{'3. Set ANTHROPIC_API_KEY=<key> and restart'}</Text>
      </Box>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 根组件
// ---------------------------------------------------------------------------
//
// 此前这里列出了第三方 provider 的状态行（Cerebras / Groq / Qwen / DeepSeek）。
// 2026-05-06 移除，因为 fork 已有的 `<Login>` "Anthropic Compatible Setup" 表单
// 已经配置了同样的 Base URL + API key，为同一目标展示两套并行的 UI 会让用户困惑。
// Subscription + Workspace key 保留 —— 它们是 fork 表单不暴露的、Anthropic 侧
// 独立的认证 plane。

export interface AuthPlaneSummaryProps {
  status: AuthStatus;
}

export function AuthPlaneSummary({ status }: AuthPlaneSummaryProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 区块：Anthropic 认证状态 */}
      <Box marginBottom={0}>
        <Text bold>Anthropic auth status:</Text>
      </Box>

      <Box marginLeft={2} flexDirection="column">
        <SubscriptionRow subscription={status.subscription} />
        <WorkspaceKeyRow workspaceKey={status.workspaceKey} />
        <WorkspaceKeyInstructions subscription={status.subscription} workspaceKey={status.workspaceKey} />
      </Box>
    </Box>
  );
}
