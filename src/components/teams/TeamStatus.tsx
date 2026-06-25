import * as React from 'react';
import { Text } from '@anthropic/ink';
import { useAppState } from '../../state/AppState.js';

type Props = {
  teamsSelected: boolean;
  showHint: boolean;
};

/**
 * 显示队友数量的底部状态指示器
 * 类似于 BackgroundTaskStatus，但用于队友
 */
export function TeamStatus({ teamsSelected, showHint }: Props): React.ReactNode {
  const teamContext = useAppState(s => s.teamContext);

  // 从 teamContext 派生队友数量（无需文件系统 I/O）
  const totalTeammates = teamContext
    ? Object.values(teamContext.teammates).filter(t => t.name !== 'team-lead').length
    : 0;

  if (totalTeammates === 0) {
    return null;
  }

  const hint =
    showHint && teamsSelected ? (
      <>
        <Text dimColor>· </Text>
        <Text dimColor>Enter 查看</Text>
      </>
    ) : null;

  const statusText = `${totalTeammates} 名队友`;

  return (
    <>
      <Text key={teamsSelected ? 'selected' : 'normal'} color="background" inverse={teamsSelected}>
        {statusText}
      </Text>
      {hint ? <Text> {hint}</Text> : null}
    </>
  );
}
