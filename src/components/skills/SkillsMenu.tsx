import * as React from 'react';
import { useMemo, useState } from 'react';
import {
  type Command,
  type CommandBase,
  type CommandResultDisplay,
  getCommandName,
  type PromptCommand,
} from '../../commands.js';
import { Box, FuzzyPicker, Text } from '@anthropic/ink';
import type { Theme } from '@anthropic/ink';
import { estimateSkillFrontmatterTokens } from '../../skills/loadSkillsDir.js';
import { formatTokens } from '../../utils/format.js';
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Dialog } from '@anthropic/ink';
import { filterSkills } from './filterSkills.js';

// Skills 总是带 CommandBase 属性的 PromptCommands
type SkillCommand = CommandBase & PromptCommand;

type SkillSource = SettingSource | 'plugin' | 'mcp';

const ORDERED_SOURCES: SkillSource[] = [
  'projectSettings',
  'localSettings',
  'userSettings',
  'flagSettings',
  'policySettings',
  'plugin',
  'mcp',
];

type Props = {
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void;
  commands: Command[];
};

function getSourceLabel(source: SkillSource): string {
  if (source === 'plugin') return 'plugin';
  if (source === 'mcp') return 'mcp';
  return getSettingSourceName(source);
}

export function SkillsMenu({ onExit, commands }: Props): React.ReactNode {
  const [searchQuery, setSearchQuery] = useState('');

  // 过滤出 skills 命令并强制转换为 SkillCommand
  const skills = useMemo(() => {
    return commands.filter(
      (cmd): cmd is SkillCommand =>
        cmd.type === 'prompt' &&
        (cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'commands_DEPRECATED' ||
          cmd.loadedFrom === 'plugin' ||
          cmd.loadedFrom === 'mcp'),
    );
  }, [commands]);

  // 应用输入即过滤：构建 SkillItem 形状的投影并过滤
  const filteredSkills = useMemo(() => {
    return filterSkills(
      skills.map(s => ({
        ...s,
        name: getCommandName(s),
        description: s.description ?? '',
      })),
      searchQuery,
    );
  }, [skills, searchQuery]);

  const skillsBySource = useMemo((): Record<SkillSource, SkillCommand[]> => {
    const groups: Record<SkillSource, SkillCommand[]> = {
      policySettings: [],
      userSettings: [],
      projectSettings: [],
      localSettings: [],
      flagSettings: [],
      plugin: [],
      mcp: [],
    };

    for (const skill of filteredSkills) {
      const source = skill.source as SkillSource;
      if (source in groups) {
        groups[source].push(skill);
      }
    }

    for (const group of Object.values(groups)) {
      group.sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)));
    }

    return groups;
  }, [filteredSkills]);

  const handleCancel = (): void => {
    onExit('Skills 对话框已关闭', { display: 'system' });
  };

  if (skills.length === 0) {
    return (
      <Dialog title="Skills" subtitle="未找到 skill" onCancel={handleCancel} hideInputGuide>
        <Text dimColor>在 .hclaude/skills/ 或 ~/.hclaude/skills/ 中创建 skill</Text>
        <Text dimColor italic>
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="关闭" />
        </Text>
      </Dialog>
    );
  }

  const getScopeTag = (source: string): { label: string; color: string } | undefined => {
    switch (source) {
      case 'projectSettings':
      case 'localSettings':
        return { label: '本地', color: 'yellow' };
      case 'userSettings':
        return { label: '全局', color: 'cyan' };
      case 'policySettings':
        return { label: '托管', color: 'magenta' };
      default:
        return undefined;
    }
  };

  const renderSkillItem = (skill: SkillCommand, isFocused: boolean) => {
    const estimatedTokens = estimateSkillFrontmatterTokens(skill);
    const tokenDisplay = `~${formatTokens(estimatedTokens)}`;
    const pluginName = skill.source === 'plugin' ? skill.pluginInfo?.pluginManifest.name : undefined;
    const scopeTag = getScopeTag(skill.source);

    return (
      <Box>
        <Text color={isFocused ? ('suggestion' as keyof Theme) : undefined}>{getCommandName(skill)}</Text>
        {scopeTag && <Text color={scopeTag.color as keyof Theme}> [{scopeTag.label}]</Text>}
        <Text dimColor>
          {pluginName ? ` · ${pluginName}` : ''} · {getSourceLabel(skill.source as SkillSource)} · {tokenDisplay} tokens
        </Text>
      </Box>
    );
  };

  // 保留 source 分组顺序的扁平有序过滤 skills 列表
  const orderedFilteredSkills = useMemo(() => {
    return ORDERED_SOURCES.flatMap(source => skillsBySource[source]);
  }, [skillsBySource]);

  const subtitle =
    searchQuery.trim() === '' ? `${skills.length} 个 skill` : `${filteredSkills.length}/${skills.length} 个 skill`;

  // Source 分组标题 —— 通过 renderItem 在选择器列表内作为分节标签渲染。
  // 我们为每个项标注其 source，以便检测分组边界变化。
  return (
    <FuzzyPicker
      title="Skills"
      placeholder="输入以过滤 skill…"
      items={orderedFilteredSkills}
      getKey={s => `${s.name}-${s.source}`}
      visibleCount={12}
      direction="down"
      onQueryChange={setSearchQuery}
      onSelect={skill => {
        onExit(`/${getCommandName(skill)}`, { display: 'user' });
      }}
      onCancel={handleCancel}
      emptyMessage={q => (q.trim() ? `没有匹配 "${q.trim()}" 的 skill` : '未找到 skill')}
      matchLabel={subtitle}
      selectAction="调用 skill"
      renderItem={(skill, isFocused) => renderSkillItem(skill, isFocused)}
    />
  );
}
