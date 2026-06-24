import { basename, sep } from 'path';
import { type ReactNode } from 'react';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { Text } from '@anthropic/ink';
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js';
import { permissionRuleExtractPrefix } from '../../utils/permissions/shellRuleMatching.js';

function commandListDisplay(commands: string[]): ReactNode {
  switch (commands.length) {
    case 0:
      return '';
    case 1:
      return <Text bold>{commands[0]}</Text>;
    case 2:
      return (
        <Text>
          <Text bold>{commands[0]}</Text> 和 <Text bold>{commands[1]}</Text>
        </Text>
      );
    default:
      return (
        <Text>
          <Text bold>{commands.slice(0, -1).join('、')}</Text>、以及 <Text bold>{commands.slice(-1)[0]}</Text>
        </Text>
      );
  }
}

function commandListDisplayTruncated(commands: string[]): ReactNode {
  // 检查纯文本表示是否过长
  const plainText = commands.join(', ');
  if (plainText.length > 50) {
    return '类似命令';
  }
  return commandListDisplay(commands);
}

function formatPathList(paths: string[]): ReactNode {
  if (paths.length === 0) return '';

  // 从路径中提取目录名
  const names = paths.map(p => basename(p) || p);

  if (names.length === 1) {
    return (
      <Text>
        <Text bold>{names[0]}</Text>
        {sep}
      </Text>
    );
  }
  if (names.length === 2) {
    return (
      <Text>
        <Text bold>{names[0]}</Text>
        {sep} 和 <Text bold>{names[1]}</Text>
        {sep}
      </Text>
    );
  }

  // 3 个及以上，显示前两个并附加 "and N more"
  return (
    <Text>
      <Text bold>{names[0]}</Text>
      {sep}、<Text bold>{names[1]}</Text>
      {sep} 及其余 {paths.length - 2} 项
    </Text>
  );
}

/**
 * 为 shell 权限对话框（Bash、PowerShell）中的 "Yes, and apply suggestions"
 * 选项生成标签。通过 shell 工具名和可选的命令转换函数进行参数化
 * （例如，Bash 会去除输出重定向，使文件名不会显示为命令）。
 */
export function generateShellSuggestionsLabel(
  suggestions: PermissionUpdate[],
  shellToolName: string,
  commandTransform?: (command: string) => string,
): ReactNode | null {
  // 收集所有用于展示的规则
  const allRules = suggestions.filter(s => s.type === 'addRules').flatMap(s => s.rules || []);

  // 分离 Read 规则与 shell 规则
  const readRules = allRules.filter(r => r.toolName === 'Read');
  const shellRules = allRules.filter(r => r.toolName === shellToolName);

  // 获取目录信息
  const directories = suggestions.filter(s => s.type === 'addDirectories').flatMap(s => s.directories || []);

  // 从 Read 规则中提取路径（与目录分开保持）
  const readPaths = readRules.map(r => r.ruleContent?.replace('/**', '') || '').filter(p => p);

  // 提取 shell 命令前缀，可选地转换以便展示
  const shellCommands = [
    ...new Set(
      shellRules.flatMap(rule => {
        if (!rule.ruleContent) return [];
        const command = permissionRuleExtractPrefix(rule.ruleContent) ?? rule.ruleContent;
        return commandTransform ? commandTransform(command) : command;
      }),
    ),
  ];

  // 检查我们有哪些内容
  const hasDirectories = directories.length > 0;
  const hasReadPaths = readPaths.length > 0;
  const hasCommands = shellCommands.length > 0;

  // 处理单一类型的情况
  if (hasReadPaths && !hasDirectories && !hasCommands) {
    // 仅 Read 规则 - 使用 "reading from" 措辞
    if (readPaths.length === 1) {
      const firstPath = readPaths[0]!;
      const dirName = basename(firstPath) || firstPath;
      return (
        <Text>
          是，允许从此项目的 <Text bold>{dirName}</Text>
          {sep} 读取
        </Text>
      );
    }

    // 多个读取路径
    return <Text>是，允许从此项目读取 {formatPathList(readPaths)}</Text>;
  }

  if (hasDirectories && !hasReadPaths && !hasCommands) {
    // 仅目录权限 - 使用 "access to" 措辞
    if (directories.length === 1) {
      const firstDir = directories[0]!;
      const dirName = basename(firstDir) || firstDir;
      return (
        <Text>
          是，始终允许访问此项目的 <Text bold>{dirName}</Text>
          {sep}
        </Text>
      );
    }

    // 多个目录
    return <Text>是，始终允许访问此项目的 {formatPathList(directories)}</Text>;
  }

  if (hasCommands && !hasDirectories && !hasReadPaths) {
    // 仅 shell 命令权限
    return (
      <Text>
        {'是，且不再询问 '}
        {commandListDisplayTruncated(shellCommands)} 命令（在 <Text bold>{getOriginalCwd()}</Text> 中）
      </Text>
    );
  }

  // 处理混合情况
  if ((hasDirectories || hasReadPaths) && !hasCommands) {
    // 合并目录和读取路径，因为两者都是路径访问
    const allPaths = [...directories, ...readPaths];
    if (hasDirectories && hasReadPaths) {
      // 混合 - 使用通用的 "access to" 措辞
      return <Text>是，始终允许访问此项目的 {formatPathList(allPaths)}</Text>;
    }
  }

  if ((hasDirectories || hasReadPaths) && hasCommands) {
    // 为两种类型构建描述性消息
    const allPaths = [...directories, ...readPaths];

    // 保持简洁但信息完整
    if (allPaths.length === 1 && shellCommands.length === 1) {
      return (
        <Text>
          是，允许访问 {formatPathList(allPaths)} 以及 {commandListDisplayTruncated(shellCommands)} 命令
        </Text>
      );
    }

    return (
      <Text>
        是，允许 {formatPathList(allPaths)} 访问及 {commandListDisplayTruncated(shellCommands)} 命令
      </Text>
    );
  }

  return null;
}
