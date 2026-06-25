import * as React from 'react';
import { Box, Text, KeyboardShortcutHint } from '@anthropic/ink';
import { toInkColor } from '../utils/ink.js';
import { useAppState } from '../state/AppState.js';
import { getViewedTeammateTask } from '../state/selectors.js';

import { OffscreenFreeze } from './OffscreenFreeze.js';

/**
 * 查看 teammate transcript 时显示的头部。
 * 显示 teammate 名称（带颜色）、任务描述和退出提示。
 */
export function TeammateViewHeader(): React.ReactNode {
  const viewedTeammate = useAppState(s => getViewedTeammateTask(s));

  if (!viewedTeammate) {
    return null;
  }

  const nameColor = toInkColor(viewedTeammate.identity.color);

  return (
    <OffscreenFreeze>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text>正在查看 </Text>
          <Text color={nameColor} bold>
            @{viewedTeammate.identity.agentName}
          </Text>
          <Text dimColor>
            {' · '}
            <KeyboardShortcutHint shortcut="esc" action="return" />
          </Text>
        </Box>
        <Text dimColor>{viewedTeammate.prompt}</Text>
      </Box>
    </OffscreenFreeze>
  );
}
