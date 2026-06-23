import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import type { ToolUseContext } from '../../Tool.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/prompt.js'
import { REMOTE_TRIGGER_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/RemoteTriggerTool/prompt.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { checkRepoForRemoteAccess } from '../../utils/background/remote/preconditions.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  detectCurrentRepositoryWithHost,
  parseGitRemote,
} from '../../utils/detectRepository.js'
import { getRemoteUrl } from '../../utils/git.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  createDefaultCloudEnvironment,
  type EnvironmentResource,
  fetchEnvironments,
} from '../../utils/teleport/environments.js'
import { registerBundledSkill } from '../bundledSkills.js'

// Base58 字母表（比特币风格），用于标签 ID 系统
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * 将 mcpsrv_ 标签 ID 解码为 UUID 字符串。
 * 标签 ID 格式：mcpsrv_01{base58(uuid.int)}
 * 其中 01 是版本前缀。
 *
 * TODO(public-ship): 在公开发布之前，/v1/mcp_servers 端点
 * 应直接返回原始 UUID，这样我们就不需要这种客户端解码。
 * 标签 ID 格式是一种内部实现细节，可能会变更。
 */
function taggedIdToUUID(taggedId: string): string | null {
  const prefix = 'mcpsrv_'
  if (!taggedId.startsWith(prefix)) {
    return null
  }
  const rest = taggedId.slice(prefix.length)
  // 跳过版本前缀（2 个字符，始终为 "01"）
  const base58Data = rest.slice(2)

  // 将 base58 解码为大整数
  let n = 0n
  for (const c of base58Data) {
    const idx = BASE58.indexOf(c)
    if (idx === -1) {
      return null
    }
    n = n * 58n + BigInt(idx)
  }

  // 转换为 UUID 十六进制字符串
  const hex = n.toString(16).padStart(32, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

type ConnectorInfo = {
  uuid: string
  name: string
  url: string
}

function getConnectedClaudeAIConnectors(
  mcpClients: MCPServerConnection[],
): ConnectorInfo[] {
  const connectors: ConnectorInfo[] = []
  for (const client of mcpClients) {
    if (client.type !== 'connected') {
      continue
    }
    if (client.config.type !== 'claudeai-proxy') {
      continue
    }
    const uuid = taggedIdToUUID(client.config.id)
    if (!uuid) {
      continue
    }
    connectors.push({
      uuid,
      name: client.name,
      url: client.config.url,
    })
  }
  return connectors
}

function sanitizeConnectorName(name: string): string {
  return name
    .replace(/^claude[.\s-]ai[.\s-]/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function formatConnectorsInfo(connectors: ConnectorInfo[]): string {
  if (connectors.length === 0) {
    return '未找到已连接的 MCP 连接器。用户可能需要在 https://claude.ai/settings/connectors 连接服务器。'
  }
  const lines = ['已连接的连接器（可用于触发器）：']
  for (const c of connectors) {
    const safeName = sanitizeConnectorName(c.name)
    lines.push(
      `- ${c.name} (connector_uuid: ${c.uuid}, name: ${safeName}, url: ${c.url})`,
    )
  }
  return lines.join('\n')
}

const BASE_QUESTION = '您想对计划的远程 Agent 执行什么操作？'

/**
 * 将设置说明格式化为项目符号的提示块。在初始 AskUserQuestion
 * 对话框文本（无参数路径）和提示正文部分（有参数路径）之间共享，
 * 以确保说明不会被悄悄丢弃。
 */
function formatSetupNotes(notes: string[]): string {
  const items = notes.map(n => `- ${n}`).join('\n')
  return `⚠ 注意：\n${items}`
}

async function getCurrentRepoHttpsUrl(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    return null
  }
  const parsed = parseGitRemote(remoteUrl)
  if (!parsed) {
    return null
  }
  return `https://${parsed.host}/${parsed.owner}/${parsed.name}`
}

function buildPrompt(opts: {
  userTimezone: string
  connectorsInfo: string
  gitRepoUrl: string | null
  environmentsInfo: string
  createdEnvironment: EnvironmentResource | null
  setupNotes: string[]
  needsGitHubAccessReminder: boolean
  userArgs: string
}): string {
  const {
    userTimezone,
    connectorsInfo,
    gitRepoUrl,
    environmentsInfo,
    createdEnvironment,
    setupNotes,
    needsGitHubAccessReminder,
    userArgs,
  } = opts
  // 当用户传入参数时，跳过初始的 AskUserQuestion 对话框。
  // 设置说明必须在提示正文中呈现，否则它们会被计算后悄悄丢弃
  // （相对于旧的硬阻塞是一种回归）。
  const setupNotesSection =
    userArgs && setupNotes.length > 0
      ? `\n## 配置说明\n\n${formatSetupNotes(setupNotes)}\n`
      : ''
  const initialQuestion =
    setupNotes.length > 0
      ? `${formatSetupNotes(setupNotes)}\n\n${BASE_QUESTION}`
      : BASE_QUESTION
  const firstStep = userArgs
    ? `用户已告知您他们想要什么（参见底部的用户请求）。跳过初始问题，直接执行对应的工作流。`
    : `您的**第一个**操作必须是单次 ${ASK_USER_QUESTION_TOOL_NAME} 工具调用（无前言）。请将以下字符串**原样**用于 \`question\` 字段——不要改写或缩短：

${jsonStringify(initialQuestion)}

将 \`header\` 设为 \`"Action"\`，并提供四个操作选项（create/list/update/run）。用户选择后，按对应的工作流执行。`

  return `# 计划远程 Agent

您正在帮助用户调度、更新、列出或运行**远程** Claude Code Agent。这些不是本地 cron 任务——每个触发器会在 Anthropic 的云基础设施中按 cron 计划生成一个完全隔离的远程会话（CCR）。Agent 在沙箱环境中运行，拥有独立的 git 检出、工具和可选的 MCP 连接。

## 第一步

${firstStep}
${setupNotesSection}

## 您可以执行的操作

使用 \`${REMOTE_TRIGGER_TOOL_NAME}\` 工具（先通过 \`SearchExtraTools select:${REMOTE_TRIGGER_TOOL_NAME}\` 加载；认证在进程内处理——请勿使用 curl）：

- \`{action: "list"}\` — 列出所有触发器
- \`{action: "get", trigger_id: "..."}\` — 获取单个触发器
- \`{action: "create", body: {...}}\` — 创建触发器
- \`{action: "update", trigger_id: "...", body: {...}}\` — 部分更新
- \`{action: "run", trigger_id: "..."}\` — 立即运行触发器

您**无法**删除触发器。如果用户要求删除，请引导他们访问：https://claude.ai/code/scheduled

## 创建请求体结构

\`\`\`json
{
  "name": "AGENT_NAME",
  "cron_expression": "CRON_EXPR",
  "enabled": true,
  "job_config": {
    "ccr": {
      "environment_id": "ENVIRONMENT_ID",
      "session_context": {
        "model": "claude-sonnet-4-6",
        "sources": [
          {"git_repository": {"url": "${gitRepoUrl || 'https://github.com/ORG/REPO'}"}}
        ],
        "allowed_tools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]
      },
      "events": [
        {"data": {
          "uuid": "<lowercase v4 uuid>",
          "session_id": "",
          "type": "user",
          "parent_tool_use_id": null,
          "message": {"content": "PROMPT_HERE", "role": "user"}
        }}
      ]
    }
  }
}
\`\`\`

为 \`events[].data.uuid\` 自行生成一个新的小写 UUID。

## 可用的 MCP 连接器

以下是用户当前已连接的 claude.ai MCP 连接器：

${connectorsInfo}

附加连接器到触发器时，请使用上方显示的 \`connector_uuid\` 和 \`name\`（名称已过滤，仅包含字母、数字、连字符和下划线），以及连接器的 URL。\`mcp_connections\` 中的 \`name\` 字段只能包含 \`[a-zA-Z0-9_-]\`——不允许使用点和空格。

**重要：** 从用户描述中推断 Agent 所需的服务。例如，如果用户说"check Datadog and Slack me errors"，Agent 同时需要 Datadog 和 Slack 连接器。与上方列表交叉核对，若有必需服务未连接则发出警告。如果缺少所需连接器，请引导用户前往 https://claude.ai/settings/connectors 先行连接。

## 环境

每个触发器都需要在 job config 中指定 \`environment_id\`，它决定远程 Agent 的运行位置。请询问用户要使用哪个环境。

${environmentsInfo}

将 \`id\` 值用作 \`job_config.ccr.environment_id\`。
${createdEnvironment ? `\n**注意：** 由于用户没有环境，系统刚刚为其创建了新环境 \`${createdEnvironment.name}\`（id：\`${createdEnvironment.environment_id}\`）。请将此 id 用于 \`job_config.ccr.environment_id\`，并在确认触发器配置时告知用户此次创建。\n` : ''}

## API 字段参考

### 创建触发器——必填字段
- \`name\`（string）— 描述性名称
- \`cron_expression\`（string）— 5 字段 cron 表达式。**最小间隔为 1 小时。**
- \`job_config\`（object）— 会话配置（参见上方结构）

### 创建触发器——可选字段
- \`enabled\`（boolean，默认：true）
- \`mcp_connections\`（array）— 要附加的 MCP 服务器：
  \`\`\`json
  [{"connector_uuid": "uuid", "name": "server-name", "url": "https://..."}]
  \`\`\`

### 更新触发器——可选字段
所有字段均可选（部分更新）：
- \`name\`、\`cron_expression\`、\`enabled\`、\`job_config\`
- \`mcp_connections\` — 替换 MCP 连接
- \`clear_mcp_connections\`（boolean）— 移除所有 MCP 连接

### Cron 表达式示例

用户的本地时区为 **${userTimezone}**。Cron 表达式始终使用 UTC。当用户说一个本地时间时，将其转换为 UTC 并与用户确认："9am ${userTimezone} = X时 UTC，cron 表达式为 \`0 X * * 1-5\`。"

- \`0 9 * * 1-5\` — 每个工作日 **UTC** 9:00
- \`0 */2 * * *\` — 每 2 小时
- \`0 0 * * *\` — 每天 **UTC** 0:00
- \`30 14 * * 1\` — 每周一 **UTC** 14:30
- \`0 8 1 * *\` — 每月 1 日 **UTC** 8:00

最小间隔为 1 小时，\`*/30 * * * *\` 将被拒绝。

## 工作流程

### 创建新触发器：

1. **了解目标** — 询问他们希望远程 Agent 做什么。涉及哪些仓库？什么任务？提醒他们 Agent 是远程运行的——无法访问其本地机器、本地文件或本地环境变量。
2. **编写提示词** — 帮助他们写出有效的 Agent 提示词。好的提示词应：
   - 明确指出要做什么以及成功的标准
   - 清楚说明要关注哪些文件/区域
   - 明确要采取的动作（开 PR、提交、仅分析等）
3. **设置计划** — 询问何时以及多频繁执行。用户时区为 ${userTimezone}。当用户说一个时间（如"every morning at 9am"），默认为其本地时间并转换为 UTC。始终确认转换："9am ${userTimezone} = X时 UTC。"
4. **选择模型** — 默认为 \`claude-sonnet-4-6\`。告知用户您默认使用的模型并询问是否需要更换。
5. **验证连接** — 从用户描述中推断 Agent 所需的服务。例如，"check Datadog and Slack me errors"需要同时有 Datadog 和 Slack MCP 连接器。与上方连接器列表交叉核对，若有缺失则警告用户并引导至 https://claude.ai/settings/connectors 先行连接。${gitRepoUrl ? `默认 git 仓库已设置为 \`${gitRepoUrl}\`。询问用户这是否是正确的仓库或是否需要使用其他仓库。` : '询问远程 Agent 需要克隆哪些 git 仓库到其环境中。'}
6. **审查并确认** — 创建之前展示完整配置，允许用户调整。
7. **\u521b\u5efa** \u2014 \u8c03\u7528 \`${REMOTE_TRIGGER_TOOL_NAME}\`\uff0c\`action: "create"\`\uff0c\u5c55\u793a\u7ed3\u679c\u3002\u54cd\u5e94\u4e2d\u5305\u542b\u89e6\u53d1\u5668 ID\u3002\u6700\u540e\u59cb\u7ec8\u8f93\u51fa\u94fe\u63a5\uff1a\`https://claude.ai/code/scheduled/{TRIGGER_ID}\`

### \u66f4\u65b0\u89e6\u53d1\u5668\uff1a

1. \u5148\u5217\u51fa\u89e6\u53d1\u5668\uff0c\u8ba9\u7528\u6237\u9009\u62e9
2. \u8be2\u95ee\u8981\u4fee\u6539\u4ec0\u4e48
3. \u5c55\u793a\u5f53\u524d\u503c\u4e0e\u5efa\u8bae\u503c
4. \u786e\u8ba4\u5e76\u66f4\u65b0

### \u5217\u51fa\u89e6\u53d1\u5668\uff1a

1. \u83b7\u53d6\u5e76\u4ee5\u53ef\u8bfb\u683c\u5f0f\u5c55\u793a
2. \u663e\u793a\uff1a\u540d\u79f0\u3001\u8ba1\u5212\uff08\u53ef\u8bfb\u5f62\u5f0f\uff09\u3001\u542f\u7528/\u7981\u7528\u72b6\u6001\u3001\u4e0b\u6b21\u8fd0\u884c\u65f6\u95f4\u3001\u4ed3\u5e93

### \u7acb\u5373\u8fd0\u884c\uff1a

1. \u82e5\u7528\u6237\u672a\u6307\u5b9a\uff0c\u5148\u5217\u51fa\u89e6\u53d1\u5668
2. \u786e\u8ba4\u8981\u8fd0\u884c\u7684\u89e6\u53d1\u5668
3. \u6267\u884c\u5e76\u786e\u8ba4

## 重要说明

- 这些是**远程** Agent——在 Anthropic 的云端运行，而非用户本地机器。它们无法访问本地文件、本地服务或本地环境变量。
- 展示时始终将 cron 表达式转换为可读形式
- 默认 \`enabled: true\`，除非用户另有说明
- 接受任何格式的 GitHub URL（https://github.com/org/repo、org/repo 等），统一规范化为完整的 HTTPS URL（不含 .git 后缀）
- 提示词是最重要的部分——花时间把它写好。远程 Agent 从零上下文开始，提示词必须自包含。
- 要删除触发器，请引导用户前往 https://claude.ai/code/scheduled
${needsGitHubAccessReminder ? `- 如果用户的请求似乎需要访问 GitHub 仓库（如克隆仓库、开 PR、读取代码），请提醒用户：${getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) ? '需要运行 /web-setup 连接 GitHub 账号（或在仓库上安装 Claude GitHub App 作为替代方案）——否则远程 Agent 将无法访问该仓库' : '需要在仓库上安装 Claude GitHub App——否则远程 Agent 将无法访问该仓库'}。` : ''}
${userArgs ? `\n## 用户请求\n\n用户说："${userArgs}"\n\n请先理解用户意图，然后按上方对应的工作流程执行。` : ''}`
}

export function registerScheduleRemoteAgentsSkill(): void {
  registerBundledSkill({
    name: 'schedule',
    description:
      '创建、更新、列出或运行按 cron 计划执行的远程 Agent（触发器）。',
    whenToUse:
      '当用户想要调度一个周期性的远程 Agent、设置自动化任务、为 Claude Code 创建 cron 任务，或管理其计划 Agent/触发器时使用。',
    userInvocable: true,
    isEnabled: () =>
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_surreal_dali', false) &&
      isPolicyAllowed('allow_remote_sessions'),
    allowedTools: [REMOTE_TRIGGER_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME],
    async getPromptForCommand(args: string, context: ToolUseContext) {
      if (!getClaudeAIOAuthTokens()?.accessToken) {
        return [
          {
            type: 'text',
            text: '请先使用 claude.ai 账号进行认证，不支持 API 账号。运行 /login，然后再试 /schedule。',
          },
        ]
      }

      let environments: EnvironmentResource[]
      try {
        environments = await fetchEnvironments()
      } catch (err) {
        logForDebugging(`[schedule] Failed to fetch environments: ${err}`, {
          level: 'warn',
        })
        return [
          {
            type: 'text',
            text: '连接您的远程 claude.ai 账号时遇到问题，无法设置计划任务。请几分钟后再试 /schedule。',
          },
        ]
      }

      let createdEnvironment: EnvironmentResource | null = null
      if (environments.length === 0) {
        try {
          createdEnvironment = await createDefaultCloudEnvironment(
            'claude-code-default',
          )
          environments = [createdEnvironment]
        } catch (err) {
          logForDebugging(`[schedule] Failed to create environment: ${err}`, {
            level: 'warn',
          })
          return [
            {
              type: 'text',
              text: '未找到远程环境，也无法自动创建环境。请访问 https://claude.ai/code 手动设置，然后再试 /schedule。',
            },
          ]
        }
      }

      // 软性设置检查 —— 作为初始 AskUserQuestion 对话框中
      // 嵌入的提示收集。绝不阻塞 —— 触发器不需要 git 源
      // （例如，仅 Slack 轮询），且触发器的源可能指向
      // 与 cwd 不同的仓库。
      const setupNotes: string[] = []
      let needsGitHubAccessReminder = false

      const repo = await detectCurrentRepositoryWithHost()
      if (repo === null) {
        setupNotes.push(
          `不在 git 仓库中——您需要手动指定仓库 URL（或完全跳过仓库配置）。`,
        )
      } else if (repo.host === 'github.com') {
        const { hasAccess } = await checkRepoForRemoteAccess(
          repo.owner,
          repo.name,
        )
        if (!hasAccess) {
          needsGitHubAccessReminder = true
          const webSetupEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
            'tengu_cobalt_lantern',
            false,
          )
          const msg = webSetupEnabled
            ? `GitHub \u672a\u8fde\u63a5 ${repo.owner}/${repo.name}\u2014\u2014\u8fd0\u884c /web-setup \u540c\u6b65 GitHub \u51ed\u636e\uff0c\u6216\u5728\u4ed3\u5e93\u4e0a\u5b89\u88c5 Claude GitHub App\uff08https://claude.ai/code/onboarding?magic=github-app-setup\uff09\u4f5c\u4e3a\u66ff\u4ee3\u65b9\u6848\u3002`
            : `Claude GitHub App \u672a\u5b89\u88c5\u5728 ${repo.owner}/${repo.name} \u4e0a\u2014\u2014\u5982\u679c\u60a8\u7684\u89e6\u53d1\u5668\u9700\u8981\u6b64\u4ed3\u5e93\uff0c\u8bf7\u8bbf\u95ee https://claude.ai/code/onboarding?magic=github-app-setup \u5b89\u88c5\u3002`
          setupNotes.push(msg)
        }
      }
      // 非 github.com 主机（GHE/GitLab 等）：静默跳过。
      // GitHub App 检查仅针对 github.com，而"不在 git 仓库中"
      // 的说明在事实上是错误的 —— 下方的 getCurrentRepoHttpsUrl()
      // 仍会用 GHE URL 填充 gitRepoUrl。

      const connectors = getConnectedClaudeAIConnectors(
        context.options.mcpClients,
      )
      if (connectors.length === 0) {
        setupNotes.push(
          `没有 MCP 连接器——如需使用，请前往 https://claude.ai/settings/connectors 连接。`,
        )
      }

      const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const connectorsInfo = formatConnectorsInfo(connectors)
      const gitRepoUrl = await getCurrentRepoHttpsUrl()
      const lines = ['可用环境：']
      for (const env of environments) {
        lines.push(
          `- ${env.name} (id: ${env.environment_id}, kind: ${env.kind})`,
        )
      }
      const environmentsInfo = lines.join('\n')
      const prompt = buildPrompt({
        userTimezone,
        connectorsInfo,
        gitRepoUrl,
        environmentsInfo,
        createdEnvironment,
        setupNotes,
        needsGitHubAccessReminder,
        userArgs: args,
      })
      return [{ type: 'text', text: prompt }]
    },
  })
}
