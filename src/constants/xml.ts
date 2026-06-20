// 用于在消息中标记 skill/command 元数据的 XML 标签名
export const COMMAND_NAME_TAG = 'command-name'
export const COMMAND_MESSAGE_TAG = 'command-message'
export const COMMAND_ARGS_TAG = 'command-args'

// 用户消息中用于标记 terminal/bash 命令输入输出的 XML 标签名
// 它们包裹的是终端活动相关内容，而非真实的用户 prompt
export const BASH_INPUT_TAG = 'bash-input'
export const BASH_STDOUT_TAG = 'bash-stdout'
export const BASH_STDERR_TAG = 'bash-stderr'
export const LOCAL_COMMAND_STDOUT_TAG = 'local-command-stdout'
export const LOCAL_COMMAND_STDERR_TAG = 'local-command-stderr'
export const LOCAL_COMMAND_CAVEAT_TAG = 'local-command-caveat'

// 所有与终端相关的标签，用于表明某条消息是终端输出而非用户 prompt
export const TERMINAL_OUTPUT_TAGS = [
  BASH_INPUT_TAG,
  BASH_STDOUT_TAG,
  BASH_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
] as const

export const TICK_TAG = 'tick'

// 用于任务通知（后台任务完成）的 XML 标签名
export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const TASK_TYPE_TAG = 'task-type'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const REASON_TAG = 'reason'
export const WORKTREE_TAG = 'worktree'
export const WORKTREE_PATH_TAG = 'worktreePath'
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'

// 用于 ultraplan 模式（远程并行规划会话）的 XML 标签名
export const ULTRAPLAN_TAG = 'ultraplan'

// 用于远程 /review 结果（teleport 后的评审会话输出）的 XML 标签名。
// 远程会话将其最终评审包裹在此标签中，本地轮询器从中提取。
export const REMOTE_REVIEW_TAG = 'remote-review'

// run_hunt.sh 的心跳每约 10 秒在此标签内回显 orchestrator 的
// progress.json。本地轮询器解析最新内容以获取任务状态行。
export const REMOTE_REVIEW_PROGRESS_TAG = 'remote-review-progress'

// 用于 teammate 消息（swarm 内 agent 间通信）的 XML 标签名
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

// 用于外部频道消息的 XML 标签名
export const CHANNEL_MESSAGE_TAG = 'channel-message'
export const CHANNEL_TAG = 'channel'

// 用于跨会话 UDS 消息（另一个 Claude 会话的 inbox）的 XML 标签名
export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

// 在 fork 子进程首条消息中包裹规则/格式样板文本的 XML 标签。
// 让转录渲染器可以折叠样板，只显示指令。
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
// 指令文本之前的前缀，由渲染器剥离。需在
// buildChildMessage（生成端）和 UserForkBoilerplateMessage（解析端）之间保持同步。
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '

// 请求帮助的 slash 命令常见参数模式
export const COMMON_HELP_ARGS = ['help', '-h', '--help']

// 请求当前状态/信息的 slash 命令常见参数模式
export const COMMON_INFO_ARGS = [
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]
