import { homedir } from 'os';
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { setSessionTrustAccepted } from '../../bootstrap/state.js';
import type { Command } from '../../commands.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getMcpConfigsByScope } from '../../services/mcp/config.js';
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js';
import { checkHasTrustDialogAccepted, saveCurrentProjectConfig } from '../../utils/config.js';
import { getCwd } from '../../utils/cwd.js';
import { getFsImplementation } from '../../utils/fsOperations.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { Select } from '../CustomSelect/index.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
import {
  getApiKeyHelperSources,
  getAwsCommandsSources,
  getBashPermissionSources,
  getDangerousEnvVarsSources,
  getGcpCommandsSources,
  getHooksSources,
  getOtelHeadersHelperSources,
} from './utils.js';

type Props = {
  onDone(): void;
  commands?: Command[];
};

export function TrustDialog({ onDone, commands }: Props): React.ReactNode {
  const { servers: projectServers } = getMcpConfigsByScope('project');

  // 在所有情况下，我们通常只检查项目级别和项目本地级别的设置，
  // 因为相比用户级别的设置，我们假设用户不会直接配置这些。

  // 检查 MCP
  const hasMcpServers = Object.keys(projectServers).length > 0;
  // 检查 hooks
  const hooksSettingSources = getHooksSources();
  const hasHooks = hooksSettingSources.length > 0;
  // 检查权限和 slash 命令中是否允许代码执行
  const bashSettingSources = getBashPermissionSources();
  // 检查会执行任意命令的 apiKeyHelper
  const apiKeyHelperSources = getApiKeyHelperSources();
  const hasApiKeyHelper = apiKeyHelperSources.length > 0;
  // 检查会执行任意命令的 AWS 命令
  const awsCommandsSources = getAwsCommandsSources();
  const hasAwsCommands = awsCommandsSources.length > 0;
  // 检查会执行任意命令的 GCP 命令
  const gcpCommandsSources = getGcpCommandsSources();
  const hasGcpCommands = gcpCommandsSources.length > 0;
  // 检查会执行任意命令的 otelHeadersHelper
  const otelHeadersHelperSources = getOtelHeadersHelperSources();
  const hasOtelHeadersHelper = otelHeadersHelperSources.length > 0;
  // 检查危险的环境变量（不在 SAFE_ENV_VARS 中）
  const dangerousEnvVarsSources = getDangerousEnvVarsSources();
  const hasDangerousEnvVars = dangerousEnvVarsSources.length > 0;

  const hasSlashCommandBash =
    commands?.some(
      command =>
        command.type === 'prompt' &&
        command.loadedFrom === 'commands_DEPRECATED' &&
        (command.source === 'projectSettings' || command.source === 'localSettings') &&
        command.allowedTools?.some((tool: string) => tool === BASH_TOOL_NAME || tool.startsWith(BASH_TOOL_NAME + '(')),
    ) ?? false;

  const hasSkillsBash =
    commands?.some(
      command =>
        command.type === 'prompt' &&
        (command.loadedFrom === 'skills' || command.loadedFrom === 'plugin') &&
        (command.source === 'projectSettings' || command.source === 'localSettings' || command.source === 'plugin') &&
        command.allowedTools?.some((tool: string) => tool === BASH_TOOL_NAME || tool.startsWith(BASH_TOOL_NAME + '(')),
    ) ?? false;

  const hasAnyBashExecution = bashSettingSources.length > 0 || hasSlashCommandBash || hasSkillsBash;

  const hasTrustDialogAccepted = checkHasTrustDialogAccepted();
  const [pendingExitCode, setPendingExitCode] = React.useState<number | null>(null);

  // 当设置了非 null 的退出码时，先渲染 null（清空屏幕），
  // 然后在下一帧触发关闭，以便 Ink 有时间在 cleanupTerminalModes()
  // 卸载并退出 alt 屏幕之前刷新空帧。如果不做这个延迟，
  // gracefulShutdownSync 会在 React 提交后立即开始异步清理，
  // 与 reconciler 发生竞态，导致终端上残留 TrustDialog 的输出。
  React.useEffect(() => {
    if (pendingExitCode !== null) {
      const code = pendingExitCode;
      const timer = setTimeout(() => gracefulShutdownSync(code));
      return () => clearTimeout(timer);
    }
  }, [pendingExitCode]);

  React.useEffect(() => {
    const isHomeDir = homedir() === getCwd();
    logEvent('tengu_trust_dialog_shown', {
      isHomeDir,
      hasMcpServers,
      hasHooks,
      hasBashExecution: hasAnyBashExecution,
      hasApiKeyHelper,
      hasAwsCommands,
      hasGcpCommands,
      hasOtelHeadersHelper,
      hasDangerousEnvVars,
    });
  }, [
    hasMcpServers,
    hasHooks,
    hasAnyBashExecution,
    hasApiKeyHelper,
    hasAwsCommands,
    hasGcpCommands,
    hasOtelHeadersHelper,
    hasDangerousEnvVars,
  ]);

  function onChange(value: 'enable_all' | 'exit') {
    if (value === 'exit') {
      // 设置 pendingExitCode 以在触发关闭之前清空屏幕。
      // 上面的 useEffect 将 gracefulShutdownSync 延迟到下一帧执行，
      // 以便 Ink 先刷新空帧 —— 否则 cleanupTerminalModes 会与 React 的
      // 重新渲染发生竞态，导致终端上残留 TrustDialog 的内容。
      setPendingExitCode(1);
      return;
    }

    const isHomeDir = homedir() === getCwd();

    logEvent('tengu_trust_dialog_accept', {
      isHomeDir,
      hasMcpServers,
      hasHooks,
      hasBashExecution: hasAnyBashExecution,
      hasApiKeyHelper,
      hasAwsCommands,
      hasGcpCommands,
      hasOtelHeadersHelper,
      hasDangerousEnvVars,
    });

    if (isHomeDir) {
      // 对于家目录，只在会话内存中存储信任（不持久化到磁盘）
      // 这样既允许 hooks 和其他需要信任的功能在本次会话中工作，
      // 又保留了不永久信任家目录的安全意图
      setSessionTrustAccepted(true);
    } else {
      saveCurrentProjectConfig(current => ({
        ...current,
        hasTrustDialogAccepted: true,
      }));
    }

    // 不要在这里写入 MCP server 设置。interactiveHelpers.tsx 中的
    // handleMcpjsonServerApprovals 在此对话框之后立即运行，并显示逐个 server 的
    // 审批 UI。如果在此处写入 enabledMcpjsonServers/enableAllProjectMcpServers，
    // 会把每个 server 都标记为 'approved'，从而静默跳过该对话框。见 #15558。

    onDone();
  }

  // 默认的 onExit 是 useApp().exit() → Ink.unmount()，它会拆除 React 树
  // 但从不调用 onDone()。interactiveHelpers.tsx 中的 showSetupScreens()
  // 等待一个只能通过 onDone 解析的 Promise，所以默认行为会让 await 永远
  // 挂起。在启用键位自定义时，chokidar watcher（persistent: true）保持
  // 事件循环活跃，进程会冻结。这里像 "No" 一样显式退出码 1。
  const exitState = useExitOnCtrlCDWithKeybindings(() => setPendingExitCode(1));

  // 使用可配置的键位绑定将 ESC 用于取消/退出
  useKeybinding(
    'confirm:no',
    () => {
      setPendingExitCode(0);
    },
    { context: 'Confirmation' },
  );

  // 当设置了 pendingExitCode 时，不渲染任何内容，以便在关闭清理 alt 屏幕
  // 之前清空屏幕。参见上面的 useEffect。
  if (pendingExitCode !== null) {
    return null;
  }

  // 如果没有任何内容需要显示，则自动解决信任对话框。
  if (hasTrustDialogAccepted) {
    setTimeout(onDone);
    return null;
  }

  return (
    <PermissionDialog color="warning" titleColor="warning" title="Accessing workspace:">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        <Text bold>{getFsImplementation().cwd()}</Text>

        <Text>
          Is this a project you trust? (Your own code, a well-known open source project, or work from your team).
        </Text>
        <Text>Once trusted, Claude Code can read, edit, and run commands in this folder.</Text>

        <Text dimColor>
          <Link url="https://code.claude.com/docs/en/security">Security guide</Link>
        </Text>

        <Select
          options={[
            { label: 'Yes, I trust this folder', value: 'enable_all' },
            { label: 'No, exit', value: 'exit' },
          ]}
          onChange={value => onChange(value as 'enable_all' | 'exit')}
          onCancel={() => onChange('exit')}
        />

        <Text dimColor>
          {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Enter to confirm · Esc to cancel</>}
        </Text>
      </Box>
    </PermissionDialog>
  );
}
