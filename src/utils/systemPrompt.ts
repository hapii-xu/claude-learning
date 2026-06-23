import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from './debug.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from './envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

export { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// Dead code elimination: conditional import for proactive mode.
// Same pattern as prompts.ts — lazy require to avoid pulling the module
// into non-proactive builds.
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

/**
 * Builds the effective system prompt array based on priority:
 * 0. Override system prompt (if set, e.g., via loop mode - REPLACES all other prompts)
 * 1. Coordinator system prompt (if coordinator mode is active)
 * 2. Agent system prompt (if mainThreadAgentDefinition is set)
 *    - In proactive mode: agent prompt is APPENDED to default (agent adds domain
 *      instructions on top of the autonomous agent prompt, like teammates do)
 *    - Otherwise: agent prompt REPLACES default
 * 3. Custom system prompt (if specified via --system-prompt)
 * 4. Default system prompt (the standard Claude Code prompt)
 *
 * Plus appendSystemPrompt is always added at the end if specified (except when override is set).
 */
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  logForDebugging(
    `[systemPrompt] buildEffectiveSystemPrompt 入口: overrideSystemPrompt=${overrideSystemPrompt ? `已设置(${overrideSystemPrompt.length}字符)` : '未设置'} customSystemPrompt=${customSystemPrompt ? `已设置(${customSystemPrompt.length}字符)` : '未设置'} appendSystemPrompt=${appendSystemPrompt ? `已设置(${appendSystemPrompt.length}字符)` : '未设置'} agentDef=${mainThreadAgentDefinition ? (mainThreadAgentDefinition.agentType ?? 'custom') : '无'} defaultSystemPrompt段落数=${defaultSystemPrompt.length}`,
    { level: 'info' },
  )
  // appendSystemPrompt 有 5 种来源（均在 main.tsx 中拼接）：
  //   1. --append-system-prompt CLI 标志
  //   2. --append-system-prompt-file CLI 标志（读取文件内容）
  //   3. teammate system prompt addendum（tmux 团队模式）
  //   4. Claude in Chrome 系统提示（启用/自动启用时）
  //   5. proactive prompt / assistant addendum（proactive 模式）
  //   6. custom instructions（settings.json customInstructions 字段）
  // buildEffectiveSystemPrompt 本身只负责把它追加到最终结果末尾。

  if (overrideSystemPrompt) {
    logForDebugging(
      `[systemPrompt] 分支: overrideSystemPrompt → 替换全部其他提示，忽略 appendSystemPrompt`,
      { level: 'info' },
    )
    return asSystemPrompt([overrideSystemPrompt])
  }
  // Coordinator mode: use coordinator prompt instead of default
  // Use inline env check instead of coordinatorModule to avoid circular
  // dependency issues during test module loading.
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    logForDebugging(
      `[systemPrompt] 分支: COORDINATOR_MODE → 使用 coordinatorSystemPrompt${appendSystemPrompt ? ' + appendSystemPrompt' : ''}`,
      { level: 'info' },
    )
    // Lazy require to avoid circular dependency at module load time
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  // Log agent memory loaded event for main loop agents
  if (mainThreadAgentDefinition?.memory) {
    logEvent('tengu_agent_memory_loaded', {
      ...(process.env.USER_TYPE === 'ant' && {
        agent_type:
          mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // In proactive mode, agent instructions are appended to the default prompt
  // rather than replacing it. The proactive default prompt is already lean
  // (autonomous agent identity + memory + env + proactive section), and agents
  // add domain-specific behavior on top — same pattern as teammates.
  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    logForDebugging(
      `[systemPrompt] 分支: proactive/kairos + agentSystemPrompt → defaultSystemPrompt(${defaultSystemPrompt.length}段) + Custom Agent Instructions${appendSystemPrompt ? ' + appendSystemPrompt' : ''}`,
      { level: 'info' },
    )
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  const branch = agentSystemPrompt
    ? 'agentSystemPrompt'
    : customSystemPrompt
      ? 'customSystemPrompt'
      : 'defaultSystemPrompt'
  logForDebugging(
    `[systemPrompt] 分支: ${branch}(${agentSystemPrompt ? agentSystemPrompt.length : customSystemPrompt ? customSystemPrompt.length : defaultSystemPrompt.length}字符/段)${appendSystemPrompt ? ' + appendSystemPrompt' : ''}`,
    { level: 'info' },
  )
  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
