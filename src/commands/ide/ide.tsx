import chalk from 'chalk';
import * as path from 'path';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import type { CommandResultDisplay, LocalJSXCommandContext } from '../../commands.js';
import { Select } from '../../components/CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';
import {
  IdeAutoConnectDialog,
  IdeDisableAutoConnectDialog,
  shouldShowAutoConnectDialog,
  shouldShowDisableAutoConnectDialog,
} from '../../components/IdeAutoConnectDialog.js';
import { Box, Text } from '@anthropic/ink';
import { clearServerCache } from '../../services/mcp/client.js';
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import { getCwd } from '../../utils/cwd.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import {
  type DetectedIDEInfo,
  detectIDEs,
  detectRunningIDEs,
  type IdeType,
  isJetBrainsIde,
  isSupportedJetBrainsTerminal,
  isSupportedTerminal,
  toIDEDisplayName,
} from '../../utils/ide.js';
import { getCurrentWorktreeSession } from '../../utils/worktree.js';

type IDEScreenProps = {
  availableIDEs: DetectedIDEInfo[];
  unavailableIDEs: DetectedIDEInfo[];
  selectedIDE?: DetectedIDEInfo | null;
  onClose: () => void;
  onSelect: (ide?: DetectedIDEInfo) => void;
};

function IDEScreen({
  availableIDEs,
  unavailableIDEs,
  selectedIDE,
  onClose,
  onSelect,
}: IDEScreenProps): React.ReactNode {
  const [selectedValue, setSelectedValue] = useState(selectedIDE?.port?.toString() ?? 'None');
  const [showAutoConnectDialog, setShowAutoConnectDialog] = useState(false);
  const [showDisableAutoConnectDialog, setShowDisableAutoConnectDialog] = useState(false);

  const handleSelectIDE = useCallback(
    (value: string) => {
      if (value !== 'None' && shouldShowAutoConnectDialog()) {
        setShowAutoConnectDialog(true);
      } else if (value === 'None' && shouldShowDisableAutoConnectDialog()) {
        setShowDisableAutoConnectDialog(true);
      } else {
        onSelect(availableIDEs.find(ide => ide.port === parseInt(value, 10)));
      }
    },
    [availableIDEs, onSelect],
  );

  const ideCounts = availableIDEs.reduce<Record<string, number>>((acc, ide) => {
    acc[ide.name] = (acc[ide.name] || 0) + 1;
    return acc;
  }, {});

  const options = availableIDEs
    .map(ide => {
      const hasMultipleInstances = (ideCounts[ide.name] || 0) > 1;
      const showWorkspace = hasMultipleInstances && ide.workspaceFolders.length > 0;

      return {
        label: ide.name,
        value: ide.port.toString(),
        description: showWorkspace ? formatWorkspaceFolders(ide.workspaceFolders) : undefined,
      };
    })
    .concat([{ label: 'None', value: 'None', description: undefined }]);

  if (showAutoConnectDialog) {
    return <IdeAutoConnectDialog onComplete={() => handleSelectIDE(selectedValue)} />;
  }

  if (showDisableAutoConnectDialog) {
    return (
      <IdeDisableAutoConnectDialog
        onComplete={() => {
          // 当用户选择 "None" 时总是断开连接，无论其对禁用自动连接的选择如何
          onSelect(undefined);
        }}
      />
    );
  }

  return (
    <Dialog
      title="Select IDE"
      subtitle="Connect to an IDE for integrated development features."
      onCancel={onClose}
      color="ide"
    >
      <Box flexDirection="column">
        {availableIDEs.length === 0 && (
          <Text dimColor>
            {isSupportedJetBrainsTerminal()
              ? 'No available IDEs detected. Please install the plugin and restart your IDE:\n' +
                'https://docs.claude.com/s/claude-code-jetbrains'
              : 'No available IDEs detected. Make sure your IDE has the Claude Code extension or plugin installed and is running.'}
          </Text>
        )}

        {availableIDEs.length !== 0 && (
          <Select
            defaultValue={selectedValue}
            defaultFocusValue={selectedValue}
            options={options}
            onChange={value => {
              setSelectedValue(value);
              handleSelectIDE(value);
            }}
          />
        )}
        {availableIDEs.length !== 0 &&
          availableIDEs.some(ide => ide.name === 'VS Code' || ide.name === 'Visual Studio Code') && (
            <Box marginTop={1}>
              <Text color="warning">Note: Only one Claude Code instance can be connected to VS Code at a time.</Text>
            </Box>
          )}
        {availableIDEs.length !== 0 && !isSupportedTerminal() && (
          <Box marginTop={1}>
            <Text dimColor>Tip: You can enable auto-connect to IDE in /config or with the --ide flag</Text>
          </Box>
        )}

        {unavailableIDEs.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              Found {unavailableIDEs.length} other running IDE(s). However, their workspace/project directories do not
              match the current cwd.
            </Text>
            <Box marginTop={1} flexDirection="column">
              {unavailableIDEs.map((ide, index) => (
                <Box key={index} paddingLeft={3}>
                  <Text dimColor>
                    • {ide.name}: {formatWorkspaceFolders(ide.workspaceFolders)}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
      </Box>
    </Dialog>
  );
}

async function findCurrentIDE(
  availableIDEs: DetectedIDEInfo[],
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>,
): Promise<DetectedIDEInfo | null> {
  const currentConfig = dynamicMcpConfig?.ide;
  if (!currentConfig || (currentConfig.type !== 'sse-ide' && currentConfig.type !== 'ws-ide')) {
    return null;
  }
  for (const ide of availableIDEs) {
    if (ide.url === currentConfig.url) {
      return ide;
    }
  }
  return null;
}

type IDEOpenSelectionProps = {
  availableIDEs: DetectedIDEInfo[];
  onSelectIDE: (ide?: DetectedIDEInfo) => void;
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

function IDEOpenSelection({ availableIDEs, onSelectIDE, onDone }: IDEOpenSelectionProps): React.ReactNode {
  const [selectedValue, setSelectedValue] = useState(availableIDEs[0]?.port?.toString() ?? '');

  const handleSelectIDE = useCallback(
    (value: string) => {
      const selectedIDE = availableIDEs.find(ide => ide.port === parseInt(value, 10));
      onSelectIDE(selectedIDE);
    },
    [availableIDEs, onSelectIDE],
  );

  const options = availableIDEs.map(ide => ({
    label: ide.name,
    value: ide.port.toString(),
  }));

  function handleCancel(): void {
    onDone('IDE selection cancelled', { display: 'system' });
  }

  return (
    <Dialog title="Select an IDE to open the project" onCancel={handleCancel} color="ide">
      <Select
        defaultValue={selectedValue}
        defaultFocusValue={selectedValue}
        options={options}
        onChange={value => {
          setSelectedValue(value);
          handleSelectIDE(value);
        }}
      />
    </Dialog>
  );
}

function RunningIDESelector({
  runningIDEs,
  onSelectIDE,
  onDone,
}: {
  runningIDEs: IdeType[];
  onSelectIDE: (ide: IdeType) => void;
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
}): React.ReactNode {
  const [selectedValue, setSelectedValue] = useState(runningIDEs[0] ?? '');

  const handleSelectIDE = useCallback(
    (value: string) => {
      onSelectIDE(value as IdeType);
    },
    [onSelectIDE],
  );

  const options = runningIDEs.map(ide => ({
    label: toIDEDisplayName(ide),
    value: ide,
  }));

  function handleCancel(): void {
    onDone('IDE selection cancelled', { display: 'system' });
  }

  return (
    <Dialog title="Select IDE to install extension" onCancel={handleCancel} color="ide">
      <Select
        defaultFocusValue={selectedValue}
        options={options}
        onChange={value => {
          setSelectedValue(value);
          handleSelectIDE(value);
        }}
      />
    </Dialog>
  );
}

function InstallOnMount({ ide, onInstall }: { ide: IdeType; onInstall: (ide: IdeType) => void }): React.ReactNode {
  useEffect(() => {
    onInstall(ide);
  }, [ide, onInstall]);
  return null;
}

export async function call(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode | null> {
  logEvent('tengu_ext_ide_command', {});
  const {
    options: { dynamicMcpConfig },
    onChangeDynamicMcpConfig,
  } = context;

  // 处理 'open' 参数
  if (args?.trim() === 'open') {
    const worktreeSession = getCurrentWorktreeSession();
    const targetPath = worktreeSession ? worktreeSession.worktreePath : getCwd();

    // 探测可用的 IDE
    const detectedIDEs = await detectIDEs(true);
    const availableIDEs = detectedIDEs.filter(ide => ide.isValid);

    if (availableIDEs.length === 0) {
      onDone('No IDEs with Claude Code extension detected.');
      return null;
    }

    // 返回 IDE 选择组件
    return (
      <IDEOpenSelection
        availableIDEs={availableIDEs}
        onSelectIDE={async (selectedIDE?: DetectedIDEInfo) => {
          if (!selectedIDE) {
            onDone('No IDE selected.');
            return;
          }

          // 尝试在所选 IDE 中打开项目
          if (
            selectedIDE.name.toLowerCase().includes('vscode') ||
            selectedIDE.name.toLowerCase().includes('cursor') ||
            selectedIDE.name.toLowerCase().includes('windsurf')
          ) {
            // 基于 VS Code 的 IDE
            const { code } = await execFileNoThrow('code', [targetPath]);
            if (code === 0) {
              onDone(`Opened ${worktreeSession ? 'worktree' : 'project'} in ${chalk.bold(selectedIDE.name)}`);
            } else {
              onDone(`Failed to open in ${selectedIDE.name}. Try opening manually: ${targetPath}`);
            }
          } else if (isSupportedJetBrainsTerminal()) {
            // JetBrains IDE - 通常通过其 CLI 工具打开
            onDone(
              `Please open the ${worktreeSession ? 'worktree' : 'project'} manually in ${chalk.bold(selectedIDE.name)}: ${targetPath}`,
            );
          } else {
            onDone(
              `Please open the ${worktreeSession ? 'worktree' : 'project'} manually in ${chalk.bold(selectedIDE.name)}: ${targetPath}`,
            );
          }
        }}
        onDone={() => {
          onDone('Exited without opening IDE', { display: 'system' });
        }}
      />
    );
  }

  const detectedIDEs = await detectIDEs(true);

  // 若未检测到带扩展的 IDE，则检查运行中的 IDE 并提供安装选项
  if (detectedIDEs.length === 0 && context.onInstallIDEExtension && !isSupportedTerminal()) {
    const runningIDEs = await detectRunningIDEs();

    const onInstall = (ide: IdeType) => {
      if (context.onInstallIDEExtension) {
        context.onInstallIDEExtension(ide);
        // 安装完成后会显示完成消息
        if (isJetBrainsIde(ide)) {
          onDone(
            `Installed plugin to ${chalk.bold(toIDEDisplayName(ide))}\n` +
              `Please ${chalk.bold('restart your IDE')} completely for it to take effect`,
          );
        } else {
          onDone(`Installed extension to ${chalk.bold(toIDEDisplayName(ide))}`);
        }
      }
    };

    if (runningIDEs.length > 1) {
      // 当有多个 IDE 运行时显示选择器
      return (
        <RunningIDESelector
          runningIDEs={runningIDEs}
          onSelectIDE={onInstall}
          onDone={() => {
            onDone('No IDE selected.', { display: 'system' });
          }}
        />
      );
    } else if (runningIDEs.length === 1) {
      return <InstallOnMount ide={runningIDEs[0]!} onInstall={onInstall} />;
    }
  }

  const availableIDEs = detectedIDEs.filter(ide => ide.isValid);
  const unavailableIDEs = detectedIDEs.filter(ide => !ide.isValid);

  const currentIDE = await findCurrentIDE(availableIDEs, dynamicMcpConfig);

  return (
    <IDECommandFlow
      availableIDEs={availableIDEs}
      unavailableIDEs={unavailableIDEs}
      currentIDE={currentIDE}
      dynamicMcpConfig={dynamicMcpConfig}
      onChangeDynamicMcpConfig={onChangeDynamicMcpConfig}
      onDone={onDone}
    />
  );
}

// 连接超时比 30s 的 MCP 连接超时稍长
const IDE_CONNECTION_TIMEOUT_MS = 35000;

type IDECommandFlowProps = {
  availableIDEs: DetectedIDEInfo[];
  unavailableIDEs: DetectedIDEInfo[];
  currentIDE: DetectedIDEInfo | null;
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>;
  onChangeDynamicMcpConfig?: (config: Record<string, ScopedMcpServerConfig>) => void;
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void;
};

function IDECommandFlow({
  availableIDEs,
  unavailableIDEs,
  currentIDE,
  dynamicMcpConfig,
  onChangeDynamicMcpConfig,
  onDone,
}: IDECommandFlowProps): React.ReactNode {
  const [connectingIDE, setConnectingIDE] = useState<DetectedIDEInfo | null>(null);
  const ideClient = useAppState(s => s.mcp.clients.find(c => c.name === 'ide'));
  const setAppState = useSetAppState();
  const isFirstCheckRef = useRef(true);

  // 监听连接结果
  useEffect(() => {
    if (!connectingIDE) return;
    // 跳过首次检查 — 它反映的是配置变更分发之前的旧状态
    if (isFirstCheckRef.current) {
      isFirstCheckRef.current = false;
      return;
    }
    if (!ideClient || ideClient.type === 'pending') return;
    if (ideClient.type === 'connected') {
      onDone(`Connected to ${connectingIDE.name}.`);
    } else if (ideClient.type === 'failed') {
      onDone(`Failed to connect to ${connectingIDE.name}.`);
    }
  }, [ideClient, connectingIDE, onDone]);

  // 超时兜底
  useEffect(() => {
    if (!connectingIDE) return;
    const timer = setTimeout(onDone, IDE_CONNECTION_TIMEOUT_MS, `Connection to ${connectingIDE.name} timed out.`);
    return () => clearTimeout(timer);
  }, [connectingIDE, onDone]);

  const handleSelectIDE = useCallback(
    (selectedIDE?: DetectedIDEInfo) => {
      if (!onChangeDynamicMcpConfig) {
        onDone('Error connecting to IDE.');
        return;
      }
      const newConfig = { ...(dynamicMcpConfig || {}) };
      if (currentIDE) {
        delete newConfig.ide;
      }
      if (!selectedIDE) {
        // 关闭 MCP 传输并从状态中移除 client
        if (ideClient && ideClient.type === 'connected' && currentIDE) {
          // 将 onclose 置为空以阻止自动重连
          ideClient.client.onclose = () => {};
          void clearServerCache('ide', ideClient.config);
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.filter(c => c.name !== 'ide'),
              tools: prev.mcp.tools.filter(t => !t.name?.startsWith('mcp__ide__')),
              commands: prev.mcp.commands.filter(c => !c.name?.startsWith('mcp__ide__')),
            },
          }));
        }
        onChangeDynamicMcpConfig(newConfig);
        onDone(currentIDE ? `Disconnected from ${currentIDE.name}.` : 'No IDE selected.');
        return;
      }
      const url = selectedIDE.url;
      newConfig.ide = {
        type: url.startsWith('ws:') ? 'ws-ide' : 'sse-ide',
        url: url,
        ideName: selectedIDE.name,
        authToken: selectedIDE.authToken,
        ideRunningInWindows: selectedIDE.ideRunningInWindows,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig;
      isFirstCheckRef.current = true;
      setConnectingIDE(selectedIDE);
      onChangeDynamicMcpConfig(newConfig);
    },
    [dynamicMcpConfig, currentIDE, ideClient, setAppState, onChangeDynamicMcpConfig, onDone],
  );

  if (connectingIDE) {
    return <Text dimColor>Connecting to {connectingIDE.name}…</Text>;
  }

  return (
    <IDEScreen
      availableIDEs={availableIDEs}
      unavailableIDEs={unavailableIDEs}
      selectedIDE={currentIDE}
      onClose={() => onDone('IDE selection cancelled', { display: 'system' })}
      onSelect={handleSelectIDE}
    />
  );
}

/**
 * 格式化工作区文件夹以便展示，剥离 cwd 并显示路径的尾部
 * @param folders 文件夹路径数组
 * @param maxLength 格式化后字符串的最大总长度
 * @returns 格式化后的文件夹路径字符串
 */
export function formatWorkspaceFolders(folders: string[], maxLength: number = 100): string {
  if (folders.length === 0) return '';

  const cwd = getCwd();

  // 仅显示前 2 个工作区
  const foldersToShow = folders.slice(0, 2);
  const hasMore = folders.length > 2;

  // 若有更多文件夹，预留 ", …" 的字符数
  const ellipsisOverhead = hasMore ? 3 : 0; // ", …"

  // 计算路径之间的逗号和空格（", " = 每个分隔符 2 个字符）
  const separatorOverhead = (foldersToShow.length - 1) * 2;
  const availableLength = maxLength - separatorOverhead - ellipsisOverhead;

  const maxLengthPerPath = Math.floor(availableLength / foldersToShow.length);

  const cwdNFC = cwd.normalize('NFC');
  const formattedFolders = foldersToShow.map(folder => {
    // 若存在则从开头剥离 cwd
    // 将两者都规范化为 NFC 以便一致比较（macOS 使用 NFD 路径）
    const folderNFC = folder.normalize('NFC');
    if (folderNFC.startsWith(cwdNFC + path.sep)) {
      folder = folderNFC.slice(cwdNFC.length + 1);
    }

    if (folder.length <= maxLengthPerPath) {
      return folder;
    }
    return '…' + folder.slice(-(maxLengthPerPath - 1));
  });

  let result = formattedFolders.join(', ');
  if (hasMore) {
    result += ', …';
  }

  return result;
}
