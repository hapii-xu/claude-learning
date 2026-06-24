import React, { Suspense, use, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index.js';
import type { Message } from '../../types/message.js';
import {
  generatePermissionExplanation,
  isPermissionExplainerEnabled,
  type PermissionExplanation as PermissionExplanationType,
  type RiskLevel,
} from '../../utils/permissions/permissionExplainer.js';
import { ShimmerChar } from '../Spinner/ShimmerChar.js';
import { useShimmerAnimation } from '../Spinner/useShimmerAnimation.js';

const LOADING_MESSAGE = '正在加载解释…';

function ShimmerLoadingText(): React.ReactNode {
  const [ref, glimmerIndex] = useShimmerAnimation('responding', LOADING_MESSAGE, false);

  return (
    <Box ref={ref}>
      <Text>
        {LOADING_MESSAGE.split('').map((char, index) => (
          <ShimmerChar
            key={index}
            char={char}
            index={index}
            glimmerIndex={glimmerIndex}
            messageColor="inactive"
            shimmerColor="text"
          />
        ))}
      </Text>
    </Box>
  );
}

function getRiskColor(riskLevel: RiskLevel): 'success' | 'warning' | 'error' {
  switch (riskLevel) {
    case 'LOW':
      return 'success';
    case 'MEDIUM':
      return 'warning';
    case 'HIGH':
      return 'error';
  }
}

function getRiskLabel(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case 'LOW':
      return '低风险';
    case 'MEDIUM':
      return '中风险';
    case 'HIGH':
      return '高风险';
  }
}

type PermissionExplanationProps = {
  toolName: string;
  toolInput: unknown;
  toolDescription?: string;
  messages?: Message[];
};

type ExplainerState = {
  visible: boolean;
  enabled: boolean;
  promise: Promise<PermissionExplanationType | null> | null;
};

/**
 * 创建一个永不 reject 的解释 promise。
 * 错误会被捕获并以 null 返回。
 */
function createExplanationPromise(props: PermissionExplanationProps): Promise<PermissionExplanationType | null> {
  return generatePermissionExplanation({
    toolName: props.toolName,
    toolInput: props.toolInput,
    toolDescription: props.toolDescription,
    messages: props.messages,
    signal: new AbortController().signal, // 不会中止——请求足够快
  }).catch(() => null);
}

/**
 * 管理权限解释器状态的 Hook。
 * 惰性创建获取 promise（仅在用户按下 Ctrl+E 时），
 * 避免为用户从未查看的解释消耗 token。
 */
export function usePermissionExplainerUI(props: PermissionExplanationProps): ExplainerState {
  const enabled = isPermissionExplainerEnabled();
  const [visible, setVisible] = useState(false);
  const [promise, setPromise] = useState<Promise<PermissionExplanationType | null> | null>(null);

  // 使用快捷键进行 ctrl+e 切换（可通过 keybindings.json 配置）
  useKeybinding(
    'confirm:toggleExplanation',
    () => {
      if (!visible) {
        logEvent('tengu_permission_explainer_shortcut_used', {});
        // 仅在首次切换时创建 promise（惰性加载）
        if (!promise) {
          setPromise(createExplanationPromise(props));
        }
      }
      setVisible(v => !v);
    },
    { context: 'Confirmation', isActive: enabled },
  );

  return { visible, enabled, promise };
}

/**
 * 使用 React 19 的 use() 读取 promise 的内部组件。
 * 加载时挂起，出错时返回 null。
 */
function ExplanationResult({ promise }: { promise: Promise<PermissionExplanationType | null> }): React.ReactNode {
  const explanation = use(promise);

  if (!explanation) {
    return (
      <Box marginTop={1}>
        <Text dimColor>解释不可用</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{explanation.explanation}</Text>
      <Box marginTop={1}>
        <Text>{explanation.reasoning}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color={getRiskColor(explanation.riskLevel)}>{getRiskLabel(explanation.riskLevel)}:</Text>
          <Text> {explanation.risk}</Text>
        </Text>
      </Box>
    </Box>
  );
}

/**
 * 内容组件 - 加载时显示（通过 Suspense），可见时显示解释
 */
export function PermissionExplainerContent({
  visible,
  promise,
}: {
  visible: boolean;
  promise: Promise<PermissionExplanationType | null> | null;
}): React.ReactNode {
  if (!visible || !promise) {
    return null;
  }

  return (
    <Suspense
      fallback={
        <Box marginTop={1}>
          <ShimmerLoadingText />
        </Box>
      }
    >
      <ExplanationResult promise={promise} />
    </Suspense>
  );
}
