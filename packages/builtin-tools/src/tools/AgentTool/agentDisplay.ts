/**
 * 显示代理信息的共享工具函数。
 * 同时被 CLI `claude agents` 处理器和交互式 `/agents` 命令使用。
 */

import { getDefaultSubagentModel } from 'src/utils/model/agent.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from 'src/utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type AgentSource = SettingSource | 'built-in' | 'plugin'

export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * 按显示顺序排列的代理来源分组列表。
 * CLI 和交互式 UI 都应使用此列表以确保一致的排序。
 */
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: 'User agents', source: 'userSettings' },
  { label: 'Project agents', source: 'projectSettings' },
  { label: 'Local agents', source: 'localSettings' },
  { label: 'Managed agents', source: 'policySettings' },
  { label: 'Plugin agents', source: 'plugin' },
  { label: 'CLI arg agents', source: 'flagSettings' },
  { label: 'Built-in agents', source: 'built-in' },
]

export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource
}

/**
 * 通过与活动（优胜）代理列表对比，为代理标注覆盖信息。
 * 当同类型代理来自更高优先级来源时，该代理被视为"已被覆盖"。
 *
 * 同时按 (agentType, source) 去重，以处理 git worktree 重复加载的情况
 * （同一代理文件可能从 worktree 和主仓库各加载一次）。
 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // 遍历 allAgents，使用 activeAgents 中的覆盖信息标注每个代理。
  // 按 (agentType, source) 去重，以处理 git worktree 重复。
  for (const agent of allAgents) {
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) continue
    seen.add(key)

    const active = activeMap.get(agent.agentType)
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/**
 * 解析代理的显示模型字符串。
 * 返回模型别名或 'inherit'（用于显示）。
 */
export function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined {
  const model = agent.model || getDefaultSubagentModel()
  if (!model) return undefined
  return model === 'inherit' ? 'inherit' : model
}

/**
 * 获取覆盖代理的来源的人类可读标签。
 * 返回小写字符串，例如 "user"、"project"、"managed"。
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * 按名称字母顺序（不区分大小写）比较代理。
 */
export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
