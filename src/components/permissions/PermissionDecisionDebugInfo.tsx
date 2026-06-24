import { feature } from 'bun:bundle';
import chalk from 'chalk';
import figures from 'figures';
import React, { useMemo } from 'react';
import { Ansi, Box, color, Text, useTheme } from '@anthropic/ink';
import { useAppState } from '../../state/AppState.js';
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js';
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js';
import type { PermissionDecision, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js';
import { extractRules } from '../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js';
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js';
import { detectUnreachableRules } from '../../utils/permissions/shadowedRuleDetection.js';
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js';
import { getSettingSourceDisplayNameLowercase } from '../../utils/settings/constants.js';

type PermissionDecisionInfoItemProps = {
  title?: string;
  decisionReason: PermissionDecisionReason;
};

function decisionReasonDisplayString(
  decisionReason: PermissionDecisionReason & {
    type: Exclude<PermissionDecisionReason['type'], 'subcommandResults'>;
  },
): string {
  if ((feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) && decisionReason.type === 'classifier') {
    return `${chalk.bold(decisionReason.classifier)} 分类器：${decisionReason.reason}`;
  }
  switch (decisionReason.type) {
    case 'rule':
      return `${chalk.bold(permissionRuleValueToString(decisionReason.rule.ruleValue))} 来自 ${getSettingSourceDisplayNameLowercase(decisionReason.rule.source)} 的规则`;
    case 'mode':
      return `${permissionModeTitle(decisionReason.mode)} 模式`;
    case 'sandboxOverride':
      return '需要权限以绕过沙盒';
    case 'workingDir':
      return decisionReason.reason;
    case 'safetyCheck':
    case 'other':
      return decisionReason.reason;
    case 'permissionPromptTool':
      return `${chalk.bold(decisionReason.permissionPromptToolName)} 权限提示工具`;
    case 'hook':
      return decisionReason.reason
        ? `${chalk.bold(decisionReason.hookName)} hook: ${decisionReason.reason}`
        : `${chalk.bold(decisionReason.hookName)} hook`;
    case 'asyncAgent':
      return decisionReason.reason;
    default:
      return '';
  }
}

function PermissionDecisionInfoItem({ title, decisionReason }: PermissionDecisionInfoItemProps): React.ReactNode {
  const [theme] = useTheme();

  function formatDecisionReason(): React.ReactNode {
    switch (decisionReason.type) {
      case 'subcommandResults':
        return (
          <Box flexDirection="column">
            {Array.from(decisionReason.reasons.entries()).map(([subcommand, result]) => {
              const icon =
                result.behavior === 'allow'
                  ? color('success', theme)(figures.tick)
                  : color('error', theme)(figures.cross);
              return (
                <Box flexDirection="column" key={subcommand}>
                  <Text>
                    {icon} {subcommand}
                  </Text>
                  {result.decisionReason !== undefined && result.decisionReason.type !== 'subcommandResults' && (
                    <Text>
                      <Text dimColor>
                        {'  '}⎿{'  '}
                      </Text>
                      <Ansi>{decisionReasonDisplayString(result.decisionReason)}</Ansi>
                    </Text>
                  )}
                  {result.behavior === 'ask' && <SuggestedRules suggestions={result.suggestions} />}
                </Box>
              );
            })}
          </Box>
        );
      default:
        return (
          <Text>
            <Ansi>{decisionReasonDisplayString(decisionReason)}</Ansi>
          </Text>
        );
    }
  }

  return (
    <Box flexDirection="column">
      {title && <Text>{title}</Text>}
      {formatDecisionReason()}
    </Box>
  );
}

function SuggestedRules({ suggestions }: { suggestions: PermissionUpdate[] | undefined }): React.ReactNode {
  const rules = extractRules(suggestions);
  if (rules.length === 0) return null;
  return (
    <Text>
      <Text dimColor>
        {'  '}⎿{'  '}
      </Text>
      建议规则：<Ansi>{rules.map(rule => chalk.bold(permissionRuleValueToString(rule))).join(', ')}</Ansi>
    </Text>
  );
}

type Props = {
  permissionResult: PermissionDecision;
  toolName?: string; // 将不可达规则过滤到此工具
};

// 从权限更新中提取目录的辅助函数
function extractDirectories(updates: PermissionUpdate[] | undefined): string[] {
  if (!updates) return [];

  return updates.flatMap(update => {
    switch (update.type) {
      case 'addDirectories':
        return update.directories;
      default:
        return [];
    }
  });
}

// 从权限更新中提取模式的辅助函数
function extractMode(updates: PermissionUpdate[] | undefined): PermissionMode | undefined {
  if (!updates) return undefined;
  const update = updates.findLast(u => u.type === 'setMode');
  return update?.type === 'setMode' ? update.mode : undefined;
}

function SuggestionDisplay({
  suggestions,
  width,
}: {
  suggestions: PermissionUpdate[] | undefined;
  width: number;
}): React.ReactNode {
  if (!suggestions || suggestions.length === 0) {
    return (
      <Box flexDirection="row">
        <Box justifyContent="flex-end" minWidth={width}>
          <Text dimColor>建议 </Text>
        </Box>
        <Text>无</Text>
      </Box>
    );
  }

  const rules = extractRules(suggestions);
  const directories = extractDirectories(suggestions);
  const mode = extractMode(suggestions);

  // 若无可显示内容，显示 None
  if (rules.length === 0 && directories.length === 0 && !mode) {
    return (
      <Box flexDirection="row">
        <Box justifyContent="flex-end" minWidth={width}>
          <Text dimColor>建议 </Text>
        </Box>
        <Text>无</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box justifyContent="flex-end" minWidth={width}>
          <Text dimColor>建议 </Text>
        </Box>
        <Text> </Text>
      </Box>

      {/* 显示规则 */}
      {rules.length > 0 && (
        <Box flexDirection="row">
          <Box justifyContent="flex-end" minWidth={width}>
            <Text dimColor> 规则 </Text>
          </Box>
          <Box flexDirection="column">
            {rules.map((rule, index) => (
              <Text key={index}>
                {figures.bullet} {permissionRuleValueToString(rule)}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* 显示目录 */}
      {directories.length > 0 && (
        <Box flexDirection="row">
          <Box justifyContent="flex-end" minWidth={width}>
            <Text dimColor> 目录 </Text>
          </Box>
          <Box flexDirection="column">
            {directories.map((dir, index) => (
              <Text key={index}>
                {figures.bullet} {dir}
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {/* 显示模式变更 */}
      {mode && (
        <Box flexDirection="row">
          <Box justifyContent="flex-end" minWidth={width}>
            <Text dimColor> 模式 </Text>
          </Box>
          <Text>{permissionModeTitle(mode)}</Text>
        </Box>
      )}
    </Box>
  );
}

export function PermissionDecisionDebugInfo({ permissionResult, toolName }: Props): React.ReactNode {
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const decisionReason = permissionResult.decisionReason;
  const suggestions = 'suggestions' in permissionResult ? permissionResult.suggestions : undefined;

  const unreachableRules = useMemo(() => {
    const sandboxAutoAllowEnabled =
      SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
    const all = detectUnreachableRules(toolPermissionContext, {
      sandboxAutoAllowEnabled,
    });

    // 从权限结果中获取建议的规则
    const suggestedRules = extractRules(suggestions);

    // 过滤出匹配任一建议规则的规则
    // 当规则的 toolName 和 ruleContent 相同时视为匹配
    if (suggestedRules.length > 0) {
      return all.filter(u =>
        suggestedRules.some(
          suggested =>
            suggested.toolName === u.rule.ruleValue.toolName && suggested.ruleContent === u.rule.ruleValue.ruleContent,
        ),
      );
    }

    // 后备方案：若指定了工具名则按工具名过滤
    if (toolName) {
      return all.filter(u => u.rule.ruleValue.toolName === toolName);
    }

    return all;
  }, [toolPermissionContext, toolName, suggestions]);

  const WIDTH = 10;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box justifyContent="flex-end" minWidth={WIDTH}>
          <Text dimColor>行为 </Text>
        </Box>
        <Text>{permissionResult.behavior}</Text>
      </Box>
      {permissionResult.behavior !== 'allow' && (
        <Box flexDirection="row">
          <Box justifyContent="flex-end" minWidth={WIDTH}>
            <Text dimColor>消息 </Text>
          </Box>
          <Text>{permissionResult.message}</Text>
        </Box>
      )}
      <Box flexDirection="row">
        <Box justifyContent="flex-end" minWidth={WIDTH}>
          <Text dimColor>原因 </Text>
        </Box>
        {decisionReason === undefined ? (
          <Text>undefined</Text>
        ) : (
          <PermissionDecisionInfoItem decisionReason={decisionReason} />
        )}
      </Box>
      <SuggestionDisplay suggestions={suggestions} width={WIDTH} />
      {unreachableRules.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="warning">
            {figures.warning} 不可达规则（{unreachableRules.length}）
          </Text>
          {unreachableRules.map((u, i) => (
            <Box key={i} flexDirection="column" marginLeft={2}>
              <Text color="warning">{permissionRuleValueToString(u.rule.ruleValue)}</Text>
              <Text dimColor>
                {'  '}
                {u.reason}
              </Text>
              <Text dimColor>
                {'  '}修复：{u.fix}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
