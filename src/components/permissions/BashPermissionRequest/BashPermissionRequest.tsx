import { feature } from 'bun:bundle';
import figures from 'figures';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useTheme } from '@anthropic/ink';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js';
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js';
import { useAppState } from '../../../state/AppState.js';
import { BashTool } from '@claude-code-best/builtin-tools/tools/BashTool/BashTool.js';
import {
  getFirstWordPrefix,
  getSimpleCommandPrefix,
} from '@claude-code-best/builtin-tools/tools/BashTool/bashPermissions.js';
import { getDestructiveCommandWarning } from '@claude-code-best/builtin-tools/tools/BashTool/destructiveCommandWarning.js';
import { parseSedEditCommand } from '@claude-code-best/builtin-tools/tools/BashTool/sedEditParser.js';
import { shouldUseSandbox } from '@claude-code-best/builtin-tools/tools/BashTool/shouldUseSandbox.js';
import { getCompoundCommandPrefixesStatic } from '../../../utils/bash/prefix.js';
import {
  createPromptRuleContent,
  generateGenericDescription,
  getBashPromptAllowDescriptions,
  isClassifierPermissionsEnabled,
} from '../../../utils/permissions/bashClassifier.js';
import { extractRules } from '../../../utils/permissions/PermissionUpdate.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { SandboxManager } from '../../../utils/sandbox/sandbox-adapter.js';
import { Select } from '../../CustomSelect/select.js';
import { ShimmerChar } from '../../Spinner/ShimmerChar.js';
import { useShimmerAnimation } from '../../Spinner/useShimmerAnimation.js';
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js';
import { PermissionDecisionDebugInfo } from '../PermissionDecisionDebugInfo.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionExplainerContent, usePermissionExplainerUI } from '../PermissionExplanation.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { SedEditPermissionRequest } from '../SedEditPermissionRequest/SedEditPermissionRequest.js';
import { useShellPermissionFeedback } from '../useShellPermissionFeedback.js';
import { logUnaryPermissionEvent } from '../utils.js';
import { bashToolUseOptions } from './bashToolUseOptions.js';

const CHECKING_TEXT = 'Attempting to auto-approve\u2026';

// 将 20fps 的闪烁时钟与 BashPermissionRequestInner 隔离开。在此之前
// 提取，useShimmerAnimation 位于 535 行的 Inner 函数体内部，因此
// 分类器通常花费的约 1-3 秒内，每 50ms 的时钟 tick 都会重新渲染
// 整个对话框（PermissionDialog + Select + 所有子组件）。Inner 还有
// Compiler 跳过（见下文），所以没有自动 memo 化——整个 JSX 树在
// 每次分类器检查期间被重建 20-60 次。
function ClassifierCheckingSubtitle(): React.ReactNode {
  const [ref, glimmerIndex] = useShimmerAnimation('requesting', CHECKING_TEXT, false);
  return (
    <Box ref={ref}>
      <Text>
        {[...CHECKING_TEXT].map((char, i) => (
          <ShimmerChar
            key={i}
            char={char}
            index={i}
            glimmerIndex={glimmerIndex}
            messageColor="inactive"
            shimmerColor="subtle"
          />
        ))}
      </Text>
    </Box>
  );
}

export function BashPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, verbose, workerBadge } = props;

  const { command, description } = BashTool.inputSchema.parse(toolUseConfirm.input);

  // 检测 sed 原地编辑命令并委托给 SedEditPermissionRequest
  // 这样将 sed 编辑以文件编辑 + diff 视图的方式渲染
  const sedInfo = parseSedEditCommand(command);

  if (sedInfo) {
    return (
      <SedEditPermissionRequest
        toolUseConfirm={toolUseConfirm}
        toolUseContext={toolUseContext}
        onDone={onDone}
        onReject={onReject}
        verbose={verbose}
        workerBadge={workerBadge}
        sedInfo={sedInfo}
      />
    );
  }

  // 普通 bash 命令 - 使用 hooks 渲染
  return (
    <BashPermissionRequestInner
      toolUseConfirm={toolUseConfirm}
      toolUseContext={toolUseContext}
      onDone={onDone}
      onReject={onReject}
      verbose={verbose}
      workerBadge={workerBadge}
      command={command}
      description={description}
    />
  );
}

// 使用 hooks 的内部组件 - 仅对非 MCP CLI 命令调用
function BashPermissionRequestInner({
  toolUseConfirm,
  toolUseContext,
  onDone,
  onReject,
  verbose: _verbose,
  workerBadge,
  command,
  description,
}: PermissionRequestProps & {
  command: string;
  description?: string;
}): React.ReactNode {
  const [theme] = useTheme();
  const toolPermissionContext = useAppState(s => s.toolPermissionContext);
  const explainerState = usePermissionExplainerUI({
    toolName: toolUseConfirm.tool.name,
    toolInput: toolUseConfirm.input,
    toolDescription: toolUseConfirm.description,
    messages: toolUseContext.messages,
  });
  const {
    yesInputMode,
    noInputMode,
    yesFeedbackModeEntered,
    noFeedbackModeEntered,
    acceptFeedback,
    rejectFeedback,
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,
    handleInputModeToggle,
    handleReject,
    handleFocus,
  } = useShellPermissionFeedback({
    toolUseConfirm,
    onDone,
    onReject,
    explainerVisible: explainerState.visible,
  });
  const [showPermissionDebug, setShowPermissionDebug] = useState(false);
  const [classifierDescription, setClassifierDescription] = useState(description || '');
  // 追踪初始描述（来自 prop 或异步生成）是否为空。
  // 一旦收到非空描述，该状态就保持 false。
  const [initialClassifierDescriptionEmpty, setInitialClassifierDescriptionEmpty] = useState(!description?.trim());

  // 异步为分类器生成通用描述
  useEffect(() => {
    if (!isClassifierPermissionsEnabled()) return;

    const abortController = new AbortController();
    generateGenericDescription(command, description, abortController.signal)
      .then(generic => {
        if (generic && !abortController.signal.aborted) {
          setClassifierDescription(generic);
          setInitialClassifierDescriptionEmpty(false);
        }
      })
      .catch(() => {}); // 出错时保留原值
    return () => abortController.abort();
  }, [command, description]);

  // GH#11380: 对于复合命令（cd src && git status && npm test），后端已通过
  // tree-sitter 拆分 + 每个子命令的权限检查，计算出了正确的每子命令建议。
  // decisionReason.type === 'subcommandResults' 标识了此路径。下方的同步
  // 前缀启发式（getSimpleCommandPrefix/getFirstWordPrefix）作用于整个复合
  // 字符串并取前两个单词——会产生永不匹配的死规则，如
  // `Bash(cd src:*)` 或 `Bash(./script.sh && npm test)`。
  // 用户在 settings.local.json 中累积了 150+ 条此类规则。
  //
  // 当复合命令只有一条 Bash 规则时（例如 `cd src && npm test`，cd 只读 →
  // 仅 npm test 需要批准），从后端规则初始化可编辑 input。当有 2 条及以上
  // 规则时，editablePrefix 保持 undefined，这样 bashToolUseOptions 会进入
  // yes-apply-suggestions 分支，原子化保存所有子命令规则。
  const isCompound = toolUseConfirm.permissionResult.decisionReason?.type === 'subcommandResults';

  // 可编辑前缀——同步初始化为无需 tree-sitter 即可提取的最佳前缀，
  // 然后对复合命令通过 tree-sitter 精细化。同步路径重要，因为
  // TREE_SITTER_BASH 仅对 ant 启用：在外部构建中，下方的异步精细化
  // 总是解析为 []，用户看到的就是这个初始值。
  //
  // 惰性初始化器：若放在渲染体中，每次渲染都会运行 regex + split；
  // 只有初始状态需要它。
  const [editablePrefix, setEditablePrefix] = useState<string | undefined>(() => {
    if (isCompound) {
      // 后端建议是复合命令的真相来源。
      // 单条规则 → 初始化可编辑 input 以便用户精细化。
      // 多条/零条规则 → undefined → 由 yes-apply-suggestions 处理。
      const backendBashRules = extractRules(
        'suggestions' in toolUseConfirm.permissionResult ? toolUseConfirm.permissionResult.suggestions : undefined,
      ).filter(r => r.toolName === BashTool.name && r.ruleContent);
      return backendBashRules.length === 1 ? backendBashRules[0]!.ruleContent : undefined;
    }
    const two = getSimpleCommandPrefix(command);
    if (two) return `${two}:*`;
    const one = getFirstWordPrefix(command);
    if (one) return `${one}:*`;
    return command;
  });
  const hasUserEditedPrefix = useRef(false);
  const onEditablePrefixChange = useCallback((value: string) => {
    hasUserEditedPrefix.current = true;
    setEditablePrefix(value);
  }, []);
  useEffect(() => {
    // 跳过复合命令的异步精细化——后端已运行完整的子命令分析，
    // 其建议是正确的。
    if (isCompound) return;
    let cancelled = false;
    getCompoundCommandPrefixesStatic(command, subcmd => BashTool.isReadOnly({ command: subcmd }))
      .then(prefixes => {
        if (cancelled || hasUserEditedPrefix.current) return;
        if (prefixes.length > 0) {
          setEditablePrefix(`${prefixes[0]}:*`);
        }
      })
      .catch(() => {}); // tree-sitter 失败时保留同步前缀
    return () => {
      cancelled = true;
    };
  }, [command, isCompound]);

  // 追踪分类器检查是否曾经在进行中（完成后仍保留状态）。
  // classifierCheckInProgress 在入队时（interactiveHandler）一次性设置，
  // 且只会从 true→false 转换，所以捕获挂载时的值就足够——不需要
  // latch/ref。feature() 三元表达式将属性读取排除在外部构建之外
  // （forbidden-string 检查）。
  const [classifierWasChecking] = useState(
    feature('BASH_CLASSIFIER') ? !!toolUseConfirm.classifierCheckInProgress : false,
  );

  // 这些值仅从工具 input 推导（对话框生命周期内固定）。
  // 闪烁时钟曾位于此组件中，在分类器运行时以 20fps 重新渲染它
  // （见上方 ClassifierCheckingSubtitle 的提取说明）。React Compiler
  // 无法自动 memo 化导入的函数（无法证明无副作用），因此此 useMemo
  // 仍需防范任何重新渲染源（例如 Inner 状态更新）。与 PR#20730 同模式。
  const { destructiveWarning, sandboxingEnabled, isSandboxed } = useMemo(() => {
    const destructiveWarning = getFeatureValue_CACHED_MAY_BE_STALE('tengu_destructive_command_warning', false)
      ? getDestructiveCommandWarning(command)
      : null;

    const sandboxingEnabled = SandboxManager.isSandboxingEnabled();
    const isSandboxed = sandboxingEnabled && shouldUseSandbox(toolUseConfirm.input);

    return { destructiveWarning, sandboxingEnabled, isSandboxed };
  }, [command, toolUseConfirm.input]);

  const unaryEvent = useMemo<UnaryEvent>(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []);

  usePermissionRequestLogging(toolUseConfirm, unaryEvent);

  const existingAllowDescriptions = useMemo(
    () => getBashPromptAllowDescriptions(toolPermissionContext),
    [toolPermissionContext],
  );

  const options = useMemo(
    () =>
      bashToolUseOptions({
        suggestions:
          toolUseConfirm.permissionResult.behavior === 'ask' ? toolUseConfirm.permissionResult.suggestions : undefined,
        decisionReason: toolUseConfirm.permissionResult.decisionReason,
        onRejectFeedbackChange: setRejectFeedback,
        onAcceptFeedbackChange: setAcceptFeedback,
        onClassifierDescriptionChange: setClassifierDescription,
        classifierDescription,
        initialClassifierDescriptionEmpty,
        existingAllowDescriptions,
        yesInputMode,
        noInputMode,
        editablePrefix,
        onEditablePrefixChange,
      }),
    [
      toolUseConfirm,
      classifierDescription,
      initialClassifierDescriptionEmpty,
      existingAllowDescriptions,
      yesInputMode,
      noInputMode,
      editablePrefix,
      onEditablePrefixChange,
    ],
  );

  // 使用快捷键切换权限调试信息
  const handleToggleDebug = useCallback(() => {
    setShowPermissionDebug(prev => !prev);
  }, []);
  useKeybinding('permission:toggleDebug', handleToggleDebug, {
    context: 'Confirmation',
  });

  // 允许 Esc 在自动批准后关闭对勾
  const handleDismissCheckmark = useCallback(() => {
    toolUseConfirm.onDismissCheckmark?.();
  }, [toolUseConfirm]);
  useKeybinding('confirm:no', handleDismissCheckmark, {
    context: 'Confirmation',
    isActive: feature('BASH_CLASSIFIER') ? !!toolUseConfirm.classifierAutoApproved : false,
  });

  function onSelect(value: string) {
    // 将选项映射为数字值供 analytics 使用（logEvent 不允许字符串）
    let optionIndex: Record<string, number> = {
      yes: 1,
      'yes-apply-suggestions': 2,
      'yes-prefix-edited': 2,
      no: 3,
    };
    if (feature('BASH_CLASSIFIER')) {
      optionIndex = {
        yes: 1,
        'yes-apply-suggestions': 2,
        'yes-prefix-edited': 2,
        'yes-classifier-reviewed': 3,
        no: 4,
      };
    }
    logEvent('tengu_permission_request_option_selected', {
      option_index: optionIndex[value],
      explainer_visible: explainerState.visible,
    });

    const toolNameForAnalytics = sanitizeToolNameForAnalytics(
      toolUseConfirm.tool.name,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS;

    if (value === 'yes-prefix-edited') {
      const trimmedPrefix = (editablePrefix ?? '').trim();
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
      if (!trimmedPrefix) {
        toolUseConfirm.onAllow(toolUseConfirm.input, []);
      } else {
        const prefixUpdates: PermissionUpdate[] = [
          {
            type: 'addRules',
            rules: [
              {
                toolName: BashTool.name,
                ruleContent: trimmedPrefix,
              },
            ],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ];
        toolUseConfirm.onAllow(toolUseConfirm.input, prefixUpdates);
      }
      onDone();
      return;
    }

    if (feature('BASH_CLASSIFIER') && value === 'yes-classifier-reviewed') {
      const trimmedDescription = classifierDescription.trim();
      logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
      if (!trimmedDescription) {
        toolUseConfirm.onAllow(toolUseConfirm.input, []);
      } else {
        const permissionUpdates: PermissionUpdate[] = [
          {
            type: 'addRules',
            rules: [
              {
                toolName: BashTool.name,
                ruleContent: createPromptRuleContent(trimmedDescription),
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ];
        toolUseConfirm.onAllow(toolUseConfirm.input, permissionUpdates);
      }
      onDone();
      return;
    }

    switch (value) {
      case 'yes': {
        const trimmedFeedback = acceptFeedback.trim();
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
        // 记录 accept 提交及反馈上下文
        logEvent('tengu_accept_submitted', {
          toolName: toolNameForAnalytics,
          isMcp: toolUseConfirm.tool.isMcp ?? false,
          has_instructions: !!trimmedFeedback,
          instructions_length: trimmedFeedback.length,
          entered_feedback_mode: yesFeedbackModeEntered,
        });
        toolUseConfirm.onAllow(toolUseConfirm.input, [], trimmedFeedback || undefined);
        onDone();
        break;
      }
      case 'yes-apply-suggestions': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept');
        // 若存在则提取建议（同时适用于 'ask' 和 'passthrough' 行为）
        const permissionUpdates =
          'suggestions' in toolUseConfirm.permissionResult ? toolUseConfirm.permissionResult.suggestions || [] : [];
        toolUseConfirm.onAllow(toolUseConfirm.input, permissionUpdates);
        onDone();
        break;
      }
      case 'no': {
        const trimmedFeedback = rejectFeedback.trim();

        // 记录 reject 提交及反馈上下文
        logEvent('tengu_reject_submitted', {
          toolName: toolNameForAnalytics,
          isMcp: toolUseConfirm.tool.isMcp ?? false,
          has_instructions: !!trimmedFeedback,
          instructions_length: trimmedFeedback.length,
          entered_feedback_mode: noFeedbackModeEntered,
        });

        // 处理拒绝（带或不带反馈）
        handleReject(trimmedFeedback || undefined);
        break;
      }
    }
  }

  const classifierSubtitle = feature('BASH_CLASSIFIER') ? (
    toolUseConfirm.classifierAutoApproved ? (
      <Text>
        <Text color="success">{figures.tick} Auto-approved</Text>
        {toolUseConfirm.classifierMatchedRule && (
          <Text dimColor>
            {' \u00b7 matched "'}
            {toolUseConfirm.classifierMatchedRule}
            {'"'}
          </Text>
        )}
      </Text>
    ) : toolUseConfirm.classifierCheckInProgress ? (
      <ClassifierCheckingSubtitle />
    ) : classifierWasChecking ? (
      <Text dimColor>Requires manual approval</Text>
    ) : undefined
  ) : undefined;

  return (
    <PermissionDialog
      workerBadge={workerBadge}
      title={sandboxingEnabled && !isSandboxed ? 'Bash command (unsandboxed)' : 'Bash command'}
      subtitle={classifierSubtitle}
    >
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text dimColor={explainerState.visible}>
          {BashTool.renderToolUseMessage(
            { command, description },
            { theme, verbose: true }, // 始终显示完整命令
          )}
        </Text>
        {!explainerState.visible && <Text dimColor>{toolUseConfirm.description}</Text>}
        <PermissionExplainerContent visible={explainerState.visible} promise={explainerState.promise} />
      </Box>
      {showPermissionDebug ? (
        <>
          <PermissionDecisionDebugInfo permissionResult={toolUseConfirm.permissionResult} toolName="Bash" />
          {toolUseContext.options.debug && (
            <Box justifyContent="flex-end" marginTop={1}>
              <Text dimColor>Ctrl-D to hide debug info</Text>
            </Box>
          )}
        </>
      ) : (
        <>
          <Box flexDirection="column">
            <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="command" />
            {destructiveWarning && (
              <Box marginBottom={1}>
                <Text
                  color="warning"
                  dimColor={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved : false}
                >
                  {destructiveWarning}
                </Text>
              </Box>
            )}
            <Text dimColor={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved : false}>
              Do you want to proceed?
            </Text>
            <Select
              options={
                feature('BASH_CLASSIFIER')
                  ? toolUseConfirm.classifierAutoApproved
                    ? options.map(o => ({ ...o, disabled: true }))
                    : options
                  : options
              }
              isDisabled={feature('BASH_CLASSIFIER') ? toolUseConfirm.classifierAutoApproved : false}
              inlineDescriptions
              onChange={onSelect}
              onCancel={() => handleReject()}
              onFocus={handleFocus}
              onInputModeToggle={handleInputModeToggle}
            />
          </Box>
          <Box justifyContent="space-between" marginTop={1}>
            <Text dimColor>
              Esc to reject
              {((focusedOption === 'yes' && !yesInputMode) || (focusedOption === 'no' && !noInputMode)) &&
                ' · Tab to add feedback'}
              {explainerState.enabled && ` · ctrl+e to ${explainerState.visible ? 'hide' : 'explain'}`}
            </Text>
            {toolUseContext.options.debug && <Text dimColor>Ctrl+d to show debug info</Text>}
          </Box>
        </>
      )}
    </PermissionDialog>
  );
}
