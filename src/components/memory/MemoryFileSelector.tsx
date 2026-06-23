import { feature } from 'bun:bundle';
import chalk from 'chalk';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import * as React from 'react';
import { use, useEffect, useState } from 'react';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text, ListItem } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js';
import { logEvent } from '../../services/analytics/index.js';
import { isAutoDreamEnabled } from '../../services/autoDream/config.js';
import { readLastConsolidatedAt } from '../../services/autoDream/consolidationLock.js';
import { useAppState } from '../../state/AppState.js';
import { getAgentMemoryDir } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js';
import { openPath } from '../../utils/browser.js';
import { getMemoryFiles, type MemoryFileInfo } from '../../utils/claudemd.js';
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatRelativeTimeAgo } from '../../utils/format.js';
import { projectIsInGitRepo } from '../../utils/memory/versions.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { Select } from '../CustomSelect/index.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js'))
  : null;
/* eslint-enable @typescript-eslint/no-require-imports */

interface ExtendedMemoryFileInfo extends MemoryFileInfo {
  isNested?: boolean;
  exists: boolean;
}

// 记住上次选择的路径
let lastSelectedPath: string | undefined;

const OPEN_FOLDER_PREFIX = '__open_folder__';

type Props = {
  onSelect: (path: string) => void;
  onCancel: () => void;
};

export function MemoryFileSelector({ onSelect, onCancel }: Props): React.ReactNode {
  const existingMemoryFiles = use(getMemoryFiles()) as MemoryFileInfo[];

  // 即便不存在，也为 User 和 Project CLAUDE.md 创建条目
  const userMemoryPath = join(getClaudeConfigHomeDir(), 'CLAUDE.md');
  const projectMemoryPath = join(getOriginalCwd(), 'CLAUDE.md');

  // 检查这些是否已经在现有文件中
  const hasUserMemory = existingMemoryFiles.some(f => f.path === userMemoryPath);
  const hasProjectMemory = existingMemoryFiles.some(f => f.path === projectMemoryPath);

  // 过滤掉 AutoMem/TeamMem 入口点：这些是 MEMORY.md 文件，而
  // /memory 已经在下方提供"打开 auto-memory 文件夹" / "打开 team memory
  // 文件夹"选项。单独列出入口点文件是冗余的。
  const allMemoryFiles: ExtendedMemoryFileInfo[] = [
    ...existingMemoryFiles.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem').map(f => ({ ...f, exists: true })),
    // 如果不存在则添加 User memory
    ...(hasUserMemory
      ? []
      : [
          {
            path: userMemoryPath,
            type: 'User' as const,
            content: '',
            exists: false,
          },
        ]),
    // 如果不存在则添加 Project memory
    ...(hasProjectMemory
      ? []
      : [
          {
            path: projectMemoryPath,
            type: 'Project' as const,
            content: '',
            exists: false,
          },
        ]),
  ];

  const depths = new Map<string, number>();

  // 为 select 组件创建选项
  const memoryOptions = allMemoryFiles.map(file => {
    const displayPath = getDisplayPath(file.path);
    const existsLabel = file.exists ? '' : ' (new)';

    // 根据 parent 计算深度
    const depth = file.parent ? (depths.get(file.parent) ?? 0) + 1 : 0;
    depths.set(file.path, depth);
    const indent = depth > 0 ? '  '.repeat(depth - 1) : '';

    // 根据类型格式化标签
    let label: string;
    if (file.type === 'User' && !file.isNested && file.path === userMemoryPath) {
      label = `User memory`;
    } else if (file.type === 'Project' && !file.isNested && file.path === projectMemoryPath) {
      label = `Project memory`;
    } else if (depth > 0) {
      // 对于子节点（导入的文件），显示带缩进的 L
      label = `${indent}L ${displayPath}${existsLabel}`;
    } else {
      // 对于其他 memory 文件，仅显示路径
      label = `${displayPath}`;
    }

    // 根据类型创建描述 - 保留内置类型的原始描述
    let description: string;
    const isGit = projectIsInGitRepo(getOriginalCwd());

    if (file.type === 'User' && !file.isNested) {
      description = 'Saved in ~/.hclaude/CLAUDE.md';
    } else if (file.type === 'Project' && !file.isNested && file.path === projectMemoryPath) {
      description = `${isGit ? 'Checked in at' : 'Saved in'} ./CLAUDE.md`;
    } else if (file.parent) {
      // 对于导入的文件（通过 @-import）
      description = '@-imported';
    } else if (file.isNested) {
      // 对于嵌套文件（动态加载）
      description = 'dynamically loaded';
    } else {
      description = '';
    }

    return {
      label,
      value: file.path,
      description,
    };
  });

  // 为 auto-memory 和 agent memory 目录添加"打开文件夹"选项
  const folderOptions: Array<{
    label: string;
    value: string;
    description: string;
  }> = [];

  const agentDefinitions = useAppState(s => s.agentDefinitions);
  if (isAutoMemoryEnabled()) {
    // 始终显示 auto-memory 文件夹选项
    folderOptions.push({
      label: 'Open auto-memory folder',
      value: `${OPEN_FOLDER_PREFIX}${getAutoMemPath()}`,
      description: '',
    });

    // team memory 直接位于 auto-memory 之下（team 目录是 auto 目录的子目录）
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
      folderOptions.push({
        label: 'Open team memory folder',
        value: `${OPEN_FOLDER_PREFIX}${teamMemPaths!.getTeamMemPath()}`,
        description: '',
      });
    }

    // 为配置了 memory 的 agent 添加 agent memory 文件夹
    for (const agent of agentDefinitions.activeAgents) {
      if (agent.memory) {
        const agentDir = getAgentMemoryDir(agent.agentType, agent.memory);
        folderOptions.push({
          label: `Open ${chalk.bold(agent.agentType)} agent memory`,
          value: `${OPEN_FOLDER_PREFIX}${agentDir}`,
          description: `${agent.memory} scope`,
        });
      }
    }
  }

  memoryOptions.push(...folderOptions);

  // 如果上次选择的路径仍在选项中则用它初始化，否则使用第一个选项
  const initialPath =
    lastSelectedPath && memoryOptions.some(opt => opt.value === lastSelectedPath)
      ? lastSelectedPath
      : memoryOptions[0]?.value || '';

  // 切换状态（设置的本地副本，以便 UI 立即更新）
  const [autoMemoryOn, setAutoMemoryOn] = useState(isAutoMemoryEnabled);
  const [autoDreamOn, setAutoDreamOn] = useState(isAutoDreamEnabled);

  // Dream 行仅在 auto-memory 开启时有意义（dream 会整合该目录）。
  // 在挂载时快照，以防用户在导航过程中切换 auto-memory 导致行消失。
  const [showDreamRow] = useState(isAutoMemoryEnabled);

  // Dream 状态：优先使用实时任务状态（由本会话触发），否则回退到
  // 跨进程锁的 mtime。
  const isDreamRunning = useAppState(s =>
    Object.values(s.tasks).some(t => t.type === 'dream' && t.status === 'running'),
  );
  const [lastDreamAt, setLastDreamAt] = useState<number | null>(null);
  useEffect(() => {
    if (!showDreamRow) return;
    void readLastConsolidatedAt().then(setLastDreamAt);
  }, [showDreamRow, isDreamRunning]);

  const dreamStatus = isDreamRunning
    ? 'running'
    : lastDreamAt === null
      ? '' // stat 进行中
      : lastDreamAt === 0
        ? 'never'
        : `last ran ${formatRelativeTimeAgo(new Date(lastDreamAt))}`;

  // null = Select 拥有焦点，0 = auto-memory，1 = auto-dream（当 showDreamRow 为 true 时）
  const [focusedToggle, setFocusedToggle] = useState<number | null>(null);
  const toggleFocused = focusedToggle !== null;
  const lastToggleIndex = showDreamRow ? 1 : 0;

  function handleToggleAutoMemory(): void {
    const newValue = !autoMemoryOn;
    updateSettingsForSource('userSettings', { autoMemoryEnabled: newValue });
    setAutoMemoryOn(newValue);
    logEvent('tengu_auto_memory_toggled', { enabled: newValue });
  }

  function handleToggleAutoDream(): void {
    const newValue = !autoDreamOn;
    updateSettingsForSource('userSettings', { autoDreamEnabled: newValue });
    setAutoDreamOn(newValue);
    logEvent('tengu_auto_dream_toggled', { enabled: newValue });
  }

  useExitOnCtrlCDWithKeybindings();

  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' });

  useKeybinding(
    'confirm:yes',
    () => {
      if (focusedToggle === 0) handleToggleAutoMemory();
      else if (focusedToggle === 1) handleToggleAutoDream();
    },
    { context: 'Confirmation', isActive: toggleFocused },
  );
  useKeybinding(
    'select:next',
    () => {
      setFocusedToggle(prev => (prev !== null && prev < lastToggleIndex ? prev + 1 : null));
    },
    { context: 'Select', isActive: toggleFocused },
  );
  useKeybinding(
    'select:previous',
    () => {
      setFocusedToggle(prev => (prev !== null && prev > 0 ? prev - 1 : prev));
    },
    { context: 'Select', isActive: toggleFocused },
  );

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginBottom={1}>
        <ListItem isFocused={focusedToggle === 0}>
          <Text>Auto-memory: {autoMemoryOn ? 'on' : 'off'}</Text>
        </ListItem>
        {showDreamRow && (
          <ListItem isFocused={focusedToggle === 1} styled={false}>
            <Text color={focusedToggle === 1 ? 'suggestion' : undefined}>
              Auto-dream: {autoDreamOn ? 'on' : 'off'}
              {dreamStatus && <Text dimColor> · {dreamStatus}</Text>}
              {!isDreamRunning && autoDreamOn && <Text dimColor> · /dream to run</Text>}
            </Text>
          </ListItem>
        )}
      </Box>

      <Select
        defaultFocusValue={initialPath}
        options={memoryOptions}
        isDisabled={toggleFocused}
        onChange={value => {
          if (value.startsWith(OPEN_FOLDER_PREFIX)) {
            const folderPath = value.slice(OPEN_FOLDER_PREFIX.length);
            // 在打开之前确保文件夹存在（幂等；吞掉权限错误
            // 以匹配之前的行为）
            void mkdir(folderPath, { recursive: true })
              .catch(() => {})
              .then(() => openPath(folderPath));
            return;
          }
          lastSelectedPath = value; // 记住选择
          onSelect(value);
        }}
        onCancel={onCancel}
        onUpFromFirstItem={() => setFocusedToggle(lastToggleIndex)}
      />
    </Box>
  );
}
