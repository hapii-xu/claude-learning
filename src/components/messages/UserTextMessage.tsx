import { feature } from 'bun:bundle';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js';
import {
  COMMAND_MESSAGE_TAG,
  FORK_BOILERPLATE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../constants/xml.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';
import { extractTag, INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } from '../../utils/messages.js';
import { InterruptedByUser } from '../InterruptedByUser.js';
import { MessageResponse } from '../MessageResponse.js';
import { UserAgentNotificationMessage } from './UserAgentNotificationMessage.js';
import { UserBashInputMessage } from './UserBashInputMessage.js';
import { UserBashOutputMessage } from './UserBashOutputMessage.js';
import { UserCommandMessage } from './UserCommandMessage.js';
import { UserLocalCommandOutputMessage } from './UserLocalCommandOutputMessage.js';
import { UserMemoryInputMessage } from './UserMemoryInputMessage.js';
import { UserPlanMessage } from './UserPlanMessage.js';
import { UserPromptMessage } from './UserPromptMessage.js';
import { UserResourceUpdateMessage } from './UserResourceUpdateMessage.js';
import { UserTeammateMessage } from './UserTeammateMessage.js';

type Props = {
  addMargin: boolean;
  param: TextBlockParam;
  verbose: boolean;
  planContent?: string;
  isTranscriptMode?: boolean;
  timestamp?: string;
};

export function UserTextMessage({
  addMargin,
  param,
  verbose,
  planContent,
  isTranscriptMode,
  timestamp,
}: Props): React.ReactNode {
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null;
  }

  // Plan to implement 消息（清除上下文流程）
  if (planContent) {
    return <UserPlanMessage addMargin={addMargin} planContent={planContent} />;
  }

  if (extractTag(param.text, TICK_TAG)) {
    return null;
  }

  // 隐藏合成的 caveat 消息（应被 isMeta 过滤，这是防御性处理）
  if (param.text.includes(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)) {
    return null;
  }

  // 显示 bash 输出
  if (param.text.startsWith('<bash-stdout') || param.text.startsWith('<bash-stderr')) {
    return <UserBashOutputMessage content={param.text} verbose={verbose} />;
  }

  // 显示命令输出
  if (param.text.startsWith('<local-command-stdout') || param.text.startsWith('<local-command-stderr')) {
    return <UserLocalCommandOutputMessage content={param.text} />;
  }

  // 特殊处理中断消息
  if (param.text === INTERRUPT_MESSAGE || param.text === INTERRUPT_MESSAGE_FOR_TOOL_USE) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    );
  }

  // GitHub webhook 事件（check_run、review 评论、push）通过
  // /subscribe-pr 后的绑定会话路由传递。tag 常量已从外部构建中剥离 ——
  // 内联字面量以避免 import 失败。
  // 当两个 flag 都关闭时，下面的 require() 会被死代码消除。使用 startsWith（非
  // includes）且在下方 includes 检查之前：作为深度防御，以防
  // sanitizer 被削弱。
  if (feature('KAIROS_GITHUB_WEBHOOKS')) {
    if (param.text.startsWith('<github-webhook-activity>')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { UserGitHubWebhookMessage } =
        require('./UserGitHubWebhookMessage.js') as typeof import('./UserGitHubWebhookMessage.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      return <UserGitHubWebhookMessage addMargin={addMargin} param={param} />;
    }
  }

  // Bash 输入！
  if (param.text.includes('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />;
  }

  // 斜杠命令/
  if (param.text.includes(`<${COMMAND_MESSAGE_TAG}>`)) {
    return <UserCommandMessage addMargin={addMargin} param={param} />;
  }

  if (param.text.includes('<user-memory-input>')) {
    return <UserMemoryInputMessage addMargin={addMargin} text={param.text} />;
  }

  // Teammate 消息 - 仅在启用 swarms 时检查
  if (isAgentSwarmsEnabled() && param.text.includes(`<${TEAMMATE_MESSAGE_TAG}`)) {
    return <UserTeammateMessage addMargin={addMargin} param={param} isTranscriptMode={isTranscriptMode} />;
  }

  // 任务通知（agent 完成、bash 完成等）
  if (param.text.includes(`<${TASK_NOTIFICATION_TAG}`)) {
    return <UserAgentNotificationMessage addMargin={addMargin} param={param} />;
  }

  // MCP 资源和轮询更新通知
  if (param.text.includes('<mcp-resource-update') || param.text.includes('<mcp-polling-update')) {
    return <UserResourceUpdateMessage addMargin={addMargin} param={param} />;
  }

  // Fork 子进程的第一条消息：折叠 rules/format 样板文本，仅
  // 显示用户 prompt。与 FORK_SUBAGENT flag 无关 —— fork agent
  // transcript 总是需要将 prompt 渲染为正常的用户气泡。
  if (param.text.includes(`<${FORK_BOILERPLATE_TAG}>`)) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { UserForkBoilerplateMessage } =
      require('./UserForkBoilerplateMessage.js') as typeof import('./UserForkBoilerplateMessage.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return (
      <UserForkBoilerplateMessage
        addMargin={addMargin}
        param={param}
        isTranscriptMode={isTranscriptMode}
        timestamp={timestamp}
      />
    );
  }

  // 跨会话 UDS 消息（来自另一个 Claude 会话的 SendMessage）。
  // CROSS_SESSION_MESSAGE_TAG 被内联，这样在 feature('UDS_INBOX') 为 false 的
  // 外部构建中就不会打包该 import。
  if (feature('UDS_INBOX')) {
    if (param.text.includes('<cross-session-message')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { UserCrossSessionMessage } =
        require('./UserCrossSessionMessage.js') as typeof import('./UserCrossSessionMessage.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      return <UserCrossSessionMessage addMargin={addMargin} param={param} />;
    }
  }

  // 入站 channel 消息（MCP 服务器推送）。
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    if (param.text.includes('<channel source="')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { UserChannelMessage } = require('./UserChannelMessage.js') as typeof import('./UserChannelMessage.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      return <UserChannelMessage addMargin={addMargin} param={param} />;
    }
  }

  // 用户 prompts>
  return (
    <UserPromptMessage addMargin={addMargin} param={param} isTranscriptMode={isTranscriptMode} timestamp={timestamp} />
  );
}
