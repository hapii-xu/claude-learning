import { homedir } from 'os';
import { basename, join, sep } from 'path';
import { type ReactNode } from 'react';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { Text } from '@anthropic/ink';
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { expandPath, getDirectoryForPath } from '../../../utils/path.js';
import { normalizeCaseForComparison, pathInAllowedWorkingPath } from '../../../utils/permissions/filesystem.js';
import type { OptionWithDescription } from '../../CustomSelect/select.js';
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js';
/**
 * 检查路径是否位于项目的 .hclaude/ 文件夹内。
 * 用于决定是否显示特殊的 ".hclaude folder" 权限选项。
 */
export function isInClaudeFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath);
  const claudeFolderPath = expandPath(`${getOriginalCwd()}/.hclaude`);

  // 检查路径是否位于项目的 .hclaude 文件夹内
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedClaudeFolderPath = normalizeCaseForComparison(claudeFolderPath);

  // 路径必须以 .hclaude 文件夹路径开头（且位于其中，而不仅是文件夹本身）
  return (
    normalizedAbsolutePath.startsWith(normalizedClaudeFolderPath + sep.toLowerCase()) ||
    // 同时匹配 posix 系统上 sep 为 / 的情况
    normalizedAbsolutePath.startsWith(normalizedClaudeFolderPath + '/')
  );
}

/**
 * 检查路径是否位于全局 ~/.hclaude/ 文件夹内。
 * 用于决定是否对用户主目录下的文件显示特殊的 ".hclaude folder" 权限选项。
 */
export function isInGlobalClaudeFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath);
  const globalClaudeFolderPath = join(homedir(), CLAUDE_DIR_NAME);

  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath);
  const normalizedGlobalClaudeFolderPath = normalizeCaseForComparison(globalClaudeFolderPath);

  return (
    normalizedAbsolutePath.startsWith(normalizedGlobalClaudeFolderPath + sep.toLowerCase()) ||
    normalizedAbsolutePath.startsWith(normalizedGlobalClaudeFolderPath + '/')
  );
}

export type PermissionOption =
  | { type: 'accept-once' }
  | { type: 'accept-session'; scope?: 'claude-folder' | 'global-claude-folder' }
  | { type: 'reject' };

export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption;
};

export type FileOperationType = 'read' | 'write' | 'create';

export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
}: {
  filePath: string;
  toolPermissionContext: ToolPermissionContext;
  operationType?: FileOperationType;
  onRejectFeedbackChange?: (value: string) => void;
  onAcceptFeedbackChange?: (value: string) => void;
  yesInputMode?: boolean;
  noInputMode?: boolean;
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = [];
  const modeCycleShortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab');

  // 处于输入模式时，显示输入框
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: '是',
      value: 'yes',
      placeholder: '并告诉 Claude 接下来做什么',
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'accept-once' },
    });
  } else {
    options.push({
      label: '是',
      value: 'yes',
      option: { type: 'accept-once' },
    });
  }

  const inAllowedPath = pathInAllowedWorkingPath(filePath, toolPermissionContext);

  // 检查是否为 .hclaude/ 文件夹路径（项目或全局）
  const inClaudeFolder = isInClaudeFolder(filePath);
  const inGlobalClaudeFolder = isInGlobalClaudeFolder(filePath);

  // 选项 2：对于 .hclaude/ 文件夹，显示特殊选项而非通用 session 选项
  // 注意：session 级别的选项始终显示，因为它们只影响内存中的状态，
  // 不持久化到设置。allowManagedPermissionRulesOnly 设置仅限制
  // 持久化的权限规则。
  if ((inClaudeFolder || inGlobalClaudeFolder) && operationType !== 'read') {
    options.push({
      label: '是，本次会话允许编辑 .hclaude/ 配置',
      value: 'yes-claude-folder',
      option: {
        type: 'accept-session',
        scope: inGlobalClaudeFolder ? 'global-claude-folder' : 'claude-folder',
      },
    });
  } else {
    // 选项 2：允许 session 期间所有更改/读取
    let sessionLabel: ReactNode;

    if (inAllowedPath) {
      // 工作目录内
      if (operationType === 'read') {
        sessionLabel = '是，本次会话期间';
      } else {
        sessionLabel = (
          <Text>
            是，本次会话允许所有编辑 <Text bold>({modeCycleShortcut})</Text>
          </Text>
        );
      }
    } else {
      // 工作目录外 - 包含目录名
      const dirPath = getDirectoryForPath(filePath);
      const dirName = basename(dirPath) || 'this directory';

      if (operationType === 'read') {
        sessionLabel = (
          <Text>
            是，本次会话允许读取 <Text bold>{dirName}/</Text>
          </Text>
        );
      } else {
        sessionLabel = (
          <Text>
            是，本次会话允许编辑 <Text bold>{dirName}/</Text> 中的所有内容 <Text bold>({modeCycleShortcut})</Text>
          </Text>
        );
      }
    }

    options.push({
      label: sessionLabel,
      value: 'yes-session',
      option: { type: 'accept-session' },
    });
  }

  // 处于输入模式时，为拒绝显示输入框
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: '否',
      value: 'no',
      placeholder: '并告诉 Claude 要做什么改变',
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: { type: 'reject' },
    });
  } else {
    // 非输入模式 - 普通选项
    options.push({
      label: '否',
      value: 'no',
      option: { type: 'reject' },
    });
  }

  return options;
}
