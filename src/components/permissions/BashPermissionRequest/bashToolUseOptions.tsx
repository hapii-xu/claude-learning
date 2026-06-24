import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js';
import { extractOutputRedirections } from '../../../utils/bash/commands.js';
import { isClassifierPermissionsEnabled } from '../../../utils/permissions/bashClassifier.js';
import type { PermissionDecisionReason } from '../../../utils/permissions/PermissionResult.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js';

export type BashToolUseOption =
  | 'yes'
  | 'yes-apply-suggestions'
  | 'yes-prefix-edited'
  | 'yes-classifier-reviewed'
  | 'no';

/**
 * 检查描述是否已存在于 allow 列表中。
 * 比较时使用小写并去除尾随空白。
 */
function descriptionAlreadyExists(description: string, existingDescriptions: string[]): boolean {
  const normalized = description.toLowerCase().trimEnd();
  return existingDescriptions.some(existing => existing.toLowerCase().trimEnd() === normalized);
}

/**
 * 去除输出重定向，使文件名不会在标签中显示为命令。
 */
function stripBashRedirections(command: string): string {
  const { commandWithoutRedirections, redirections } = extractOutputRedirections(command);
  // 仅当存在实际重定向时才使用去除后的版本
  return redirections.length > 0 ? commandWithoutRedirections : command;
}

export function bashToolUseOptions({
  suggestions = [],
  decisionReason,
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  onClassifierDescriptionChange,
  classifierDescription,
  initialClassifierDescriptionEmpty = false,
  existingAllowDescriptions = [],
  yesInputMode = false,
  noInputMode = false,
  editablePrefix,
  onEditablePrefixChange,
}: {
  suggestions?: PermissionUpdate[];
  decisionReason?: PermissionDecisionReason;
  onRejectFeedbackChange: (value: string) => void;
  onAcceptFeedbackChange: (value: string) => void;
  onClassifierDescriptionChange?: (value: string) => void;
  classifierDescription?: string;
  /** 初始分类器描述是否为空。为 true 时隐藏该选项。 */
  initialClassifierDescriptionEmpty?: boolean;
  existingAllowDescriptions?: string[];
  yesInputMode?: boolean;
  noInputMode?: boolean;
  /** 可编辑前缀规则内容（如 "npm run:*"）。设置后替换基于 Haiku 的建议。 */
  editablePrefix?: string;
  /** 当用户编辑前缀值时的回调。 */
  onEditablePrefixChange?: (value: string) => void;
}): OptionWithDescription<BashToolUseOption>[] {
  const options: OptionWithDescription<BashToolUseOption>[] = [];

  if (yesInputMode) {
    options.push({
      type: 'input',
      label: '是',
      value: 'yes',
      placeholder: '告诉 Claude 接下来做什么',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
    });
  } else {
    options.push({
      label: '是',
      value: 'yes',
    });
  }

  // 仅在未受 allowManagedPermissionRulesOnly 限制时显示 "always allow" 选项
  if (shouldShowAlwaysAllowOptions()) {
    // 为前缀规则显示可编辑输入，替代基于 Haiku 的建议标签——
    // 但仅当建议中不包含可编辑前缀无法表示的非 Bash 项
    // （addDirectories、Read 规则）时。
    const hasNonBashSuggestions = suggestions.some(
      s => s.type === 'addDirectories' || (s.type === 'addRules' && s.rules?.some(r => r.toolName !== BASH_TOOL_NAME)),
    );
    if (editablePrefix !== undefined && onEditablePrefixChange && !hasNonBashSuggestions && suggestions.length > 0) {
      options.push({
        type: 'input',
        label: '\u662f\uff0c\u4ee5\u540e\u4e0d\u518d\u8be2\u95ee',
        value: 'yes-prefix-edited',
        placeholder: '\u547d\u4ee4\u524d\u7f00\uff08\u4f8b\u5982 npm run:*\uff09',
        initialValue: editablePrefix,
        onChange: onEditablePrefixChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      });
    } else if (suggestions.length > 0) {
      const label = generateShellSuggestionsLabel(suggestions, BASH_TOOL_NAME, stripBashRedirections);

      if (label) {
        options.push({
          label,
          value: 'yes-apply-suggestions',
        });
      }
    }

    // 添加 classifier-reviewed 选项需满足：已启用、初始描述非空、
    // 描述不在 allow 列表中、且决策原因不是服务端分类器阻断
    // （当服务端分类器先触发时，基于 prompt 的规则无帮助）。
    // 当可编辑前缀选项已显示时跳过——两者作用相同，出现两个相同的
    // "don't ask again" 输入会令人困惑。
    const editablePrefixShown = options.some(o => o.value === 'yes-prefix-edited');
    if (
      process.env.USER_TYPE === 'ant' &&
      !editablePrefixShown &&
      isClassifierPermissionsEnabled() &&
      onClassifierDescriptionChange &&
      !initialClassifierDescriptionEmpty &&
      !descriptionAlreadyExists(classifierDescription ?? '', existingAllowDescriptions) &&
      decisionReason?.type !== 'classifier'
    ) {
      options.push({
        type: 'input',
        label: '\u662f\uff0c\u4ee5\u540e\u4e0d\u518d\u8be2\u95ee',
        value: 'yes-classifier-reviewed',
        placeholder: '\u63cf\u8ff0\u5141\u8bb8\u7684\u5185\u5bb9...',
        initialValue: classifierDescription ?? '',
        onChange: onClassifierDescriptionChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      });
    }
  }

  if (noInputMode) {
    options.push({
      type: 'input',
      label: '否',
      value: 'no',
      placeholder: '告诉 Claude 要做什么改变',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
    });
  } else {
    options.push({
      label: '否',
      value: 'no',
    });
  }

  return options;
}
