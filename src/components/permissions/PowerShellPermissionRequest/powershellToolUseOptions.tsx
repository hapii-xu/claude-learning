import { POWERSHELL_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/PowerShellTool/toolName.js';
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { generateShellSuggestionsLabel } from '../shellPermissionHelpers.js';

export type PowerShellToolUseOption = 'yes' | 'yes-apply-suggestions' | 'yes-prefix-edited' | 'no';

export function powershellToolUseOptions({
  suggestions = [],
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
  editablePrefix,
  onEditablePrefixChange,
}: {
  suggestions?: PermissionUpdate[];
  onRejectFeedbackChange: (value: string) => void;
  onAcceptFeedbackChange: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
  editablePrefix?: string;
  onEditablePrefixChange?: (value: string) => void;
}): OptionWithDescription<PowerShellToolUseOption>[] {
  const options: OptionWithDescription<PowerShellToolUseOption>[] = [];

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

  // Note: No sandbox toggle for PowerShell - sandbox is not supported on Windows
  // Note: No classifier-reviewed option for PowerShell (ANT-ONLY feature for Bash)

  // Only show "always allow" options when not restricted by allowManagedPermissionRulesOnly.
  // Prefer the editable prefix input (static extractor + user edits) over the
  // non-editable suggestions label. The editable input can't represent
  // directory permissions or Read-tool rules, so fall back to the label when
  // those are present.
  if (shouldShowAlwaysAllowOptions() && suggestions.length > 0) {
    const hasNonPowerShellSuggestions = suggestions.some(
      s =>
        s.type === 'addDirectories' ||
        (s.type === 'addRules' && s.rules?.some(r => r.toolName !== POWERSHELL_TOOL_NAME)),
    );
    if (editablePrefix !== undefined && onEditablePrefixChange && !hasNonPowerShellSuggestions) {
      options.push({
        type: 'input',
        label: '\u662f\uff0c\u4ee5\u540e\u4e0d\u518d\u8be2\u95ee',
        value: 'yes-prefix-edited',
        placeholder: '\u547d\u4ee4\u524d\u7f00\uff08\u4f8b\u5982 Get-Process:*\uff09',
        initialValue: editablePrefix,
        onChange: onEditablePrefixChange,
        allowEmptySubmitToCancel: true,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
        resetCursorOnUpdate: true,
      });
    } else {
      const label = generateShellSuggestionsLabel(suggestions, POWERSHELL_TOOL_NAME);
      if (label) {
        options.push({
          label,
          value: 'yes-apply-suggestions',
        });
      }
    }
  }

  if (noInputMode) {
    options.push({
      type: 'input',
      label: '否',
      value: 'no',
      placeholder: '并告诉 Claude 要做什么改变',
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
