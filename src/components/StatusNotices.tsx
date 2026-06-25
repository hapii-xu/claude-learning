import * as React from 'react';
import { use } from 'react';
import { Box } from '@anthropic/ink';
import type { AgentDefinitionsResult } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js';
import { getMemoryFiles } from '../utils/claudemd.js';
import { getGlobalConfig } from '../utils/config.js';
import { getActiveNotices, type StatusNoticeContext } from '../utils/statusNoticeDefinitions.js';

type Props = {
  agentDefinitions?: AgentDefinitionsResult;
};

/**
 * StatusNotices 包含启动时显示给用户的信息。我们已将中性或正面的状态
 * 迁移到 src/components/Status.tsx，用户可以通过 /status 访问。
 */
export function StatusNotices({ agentDefinitions }: Props = {}): React.ReactNode {
  const context: StatusNoticeContext = {
    config: getGlobalConfig(),
    agentDefinitions,
    memoryFiles: use(getMemoryFiles()),
  };
  const activeNotices = getActiveNotices(context);
  if (activeNotices.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {activeNotices.map(notice => (
        <React.Fragment key={notice.id}>{notice.render(context)}</React.Fragment>
      ))}
    </Box>
  );
}
