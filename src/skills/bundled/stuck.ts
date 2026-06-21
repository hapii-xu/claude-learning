import { registerBundledSkill } from '../bundledSkills.js'

// 提示文本包含 `ps` 命令作为 Claude 运行的指令，
// 而非本文件执行的命令。
// eslint-disable-next-line custom-rules/no-direct-ps-commands
const STUCK_PROMPT = `# /stuck — 诊断卡死/缓慢的 Claude Code 会话

用户认为本机上另一个 Claude Code 会话已冻结、卡死或非常缓慢。请进行排查并将报告发布到 #claude-code-feedback。

## 排查目标

扫描其他 Claude Code 进程（排除当前进程——PID 在 \`process.pid\` 中，shell 命令中直接排除运行本提示时看到的 PID）。进程名通常为 \`claude\`（已安装版本）或 \`cli\`（原生开发构建）。

卡死会话的特征：
- **CPU 持续高占用（≥90%）** —— 可能是无限循环。间隔 1-2 秒采样两次，确认非短暂峰值。
- **进程状态 \`D\`（不可中断睡眠）** —— 通常是 I/O 挂起。查看 \`ps\` 输出的 \`state\` 列；第一个字符有效（忽略 \`+\`、\`s\`、\`<\` 等修饰符）。
- **进程状态 \`T\`（已停止）** —— 用户可能误按了 Ctrl+Z。
- **进程状态 \`Z\`（僵尸进程）** —— 父进程未回收。
- **RSS 极高（≥4GB）** —— 可能存在内存泄漏导致会话变慢。
- **子进程卡死** —— 挂起的 \`git\`、\`node\` 或 shell 子进程会冻结父进程。对每个会话执行 \`pgrep -lP <pid>\` 检查。

## 排查步骤

1. **列出所有 Claude Code 进程**（macOS/Linux）：
   \`\`\`
   ps -axo pid=,pcpu=,rss=,etime=,state=,comm=,command= | grep -E '(claude|cli)' | grep -v grep
   \`\`\`
   筛选 \`comm\` 为 \`claude\` 或（\`cli\` 且命令路径含 "claude"）的行。

2. **对可疑进程**，收集更多上下文：
   - 子进程：\`pgrep -lP <pid>\`
   - 若 CPU 高：1-2 秒后再次采样确认是否持续
   - 若子进程看起来挂起（如 git 命令），用 \`ps -p <child_pid> -o command=\` 记录其完整命令行
   - 若能推断出会话 ID，查看调试日志：\`~/.hclaude/debug/<session-id>.txt\`（最后几百行通常能看出挂起前在做什么）

3. **考虑堆栈转储**（适用于真正冻结的进程，高级，可选）：
   - macOS：\`sample <pid> 3\` 获取 3 秒原生堆栈采样
   - 输出较大——仅在进程明显挂起且需要知道*原因*时使用

## 报告

**只有真正发现卡死问题时才发布到 Slack。** 若所有会话看起来都正常，直接告知用户——不要发布"一切正常"的消息到频道。

若确实发现卡死/缓慢的会话，使用 Slack MCP 工具发布到 **#claude-code-feedback**（频道 ID：\`C07VBSHV7EV\`）。若 \`slack_send_message\` 未加载，使用 SearchExtraTools 查找。

**使用两条消息结构**，保持频道易于浏览：

1. **顶层消息** —— 一行简短内容：主机名、Claude Code 版本、简要症状描述（如"会话 PID 12345 CPU 100% 持续 10 分钟"或"git 子进程在 D 状态挂起"）。无代码块，无详情。
2. **线程回复** —— 完整诊断信息。将顶层消息的 \`ts\` 作为 \`thread_ts\` 传入，包含：
   - PID、CPU%、RSS、状态、运行时长、命令行、子进程
   - 对可能原因的诊断
   - 相关调试日志末尾或 \`sample\` 输出（若已捕获）

若 Slack MCP 不可用，将报告格式化为用户可复制粘贴到 #claude-code-feedback 的消息（并提示用户自行在线程中附上详情）。

## 注意事项
- 不要终止或向任何进程发送信号——这只是诊断性操作。
- 若用户提供了参数（如特定 PID 或症状描述），优先聚焦于此。
`

export function registerStuckSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'stuck',
    description:
      '[仅限 ANT] 排查本机上冻结/卡死/缓慢的 Claude Code 会话，并将诊断报告发布到 #claude-code-feedback。',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = STUCK_PROMPT
      if (args) {
        prompt += `\n## User-provided context\n\n${args}\n`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
