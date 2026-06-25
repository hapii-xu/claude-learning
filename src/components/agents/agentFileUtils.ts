import { mkdir, open, unlink } from 'fs/promises'
import { join } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getManagedFilePath } from 'src/utils/settings/managedPath.js'
import type { AgentMemoryScope } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js'
import {
  type AgentDefinition,
  isBuiltInAgent,
  isPluginAgent,
} from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import type { EffortValue } from '../../utils/effort.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { AGENT_PATHS } from './types.js'

/**
 * 将 agent 数据格式化为 markdown 文件内容
 */
export function formatAgentAsMarkdown(
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
): string {
  // 对于 YAML 双引号字符串，需要进行以下转义：
  // - 反斜杠：\ -> \\
  // - 双引号：" -> \"
  // - 换行符：\n -> \\n（使 yaml 将其读取为字面量反斜杠-n，而非换行）
  const escapedWhenToUse = whenToUse
    .replace(/\\/g, '\\\\') // 先转义反斜杠
    .replace(/"/g, '\\"') // 转义双引号
    .replace(/\n/g, '\\\\n') // 将换行符转义为 \\n，使 yaml 保留为 \n

  // 当 tools 为 undefined 或为 ['*']（允许使用全部工具）时，完全省略 tools 字段
  const isAllTools =
    tools === undefined || (tools.length === 1 && tools[0] === '*')
  const toolsLine = isAllTools ? '' : `\ntools: ${tools.join(', ')}`
  const modelLine = model ? `\nmodel: ${model}` : ''
  const effortLine = effort !== undefined ? `\neffort: ${effort}` : ''
  const colorLine = color ? `\ncolor: ${color}` : ''
  const memoryLine = memory ? `\nmemory: ${memory}` : ''

  return `---
name: ${agentType}
description: "${escapedWhenToUse}"${toolsLine}${modelLine}${effortLine}${colorLine}${memoryLine}
---

${systemPrompt}
`
}

/**
 * 根据 agent 位置获取目录路径
 */
function getAgentDirectoryPath(location: SettingSource): string {
  switch (location) {
    case 'flagSettings':
      throw new Error(`无法获取 ${location} 类型 agent 的目录路径`)
    case 'userSettings':
      return join(getClaudeConfigHomeDir(), AGENT_PATHS.AGENTS_DIR)
    case 'projectSettings':
      return join(getCwd(), AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    case 'policySettings':
      return join(
        getManagedFilePath(),
        AGENT_PATHS.FOLDER_NAME,
        AGENT_PATHS.AGENTS_DIR,
      )
    case 'localSettings':
      return join(getCwd(), AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
  }
}

function getRelativeAgentDirectoryPath(location: SettingSource): string {
  switch (location) {
    case 'projectSettings':
      return join('.', AGENT_PATHS.FOLDER_NAME, AGENT_PATHS.AGENTS_DIR)
    default:
      return getAgentDirectoryPath(location)
  }
}

/**
 * 根据 agent 名称获取新 agent 的文件路径
 * 用于创建新的 agent 文件时
 */
export function getNewAgentFilePath(agent: {
  source: SettingSource
  agentType: string
}): string {
  const dirPath = getAgentDirectoryPath(agent.source)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * 获取现有 agent 的实际文件路径（处理文件名与 agentType 不一致的情况）
 * 对于已存在的 agent，始终使用此方法获取其真实文件位置
 */
export function getActualAgentFilePath(agent: AgentDefinition): string {
  if (agent.source === 'built-in') {
    return '内置'
  }
  if (agent.source === 'plugin') {
    throw new Error('无法获取插件 agent 的文件路径')
  }

  const dirPath = getAgentDirectoryPath(agent.source)
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * 根据 agent 名称获取新 agent 的相对文件路径
 * 用于显示新 agent 文件将被创建的位置
 */
export function getNewRelativeAgentFilePath(agent: {
  source: SettingSource | 'built-in'
  agentType: string
}): string {
  if (agent.source === 'built-in') {
    return '内置'
  }
  const dirPath = getRelativeAgentDirectoryPath(agent.source)
  return join(dirPath, `${agent.agentType}.md`)
}

/**
 * 获取现有 agent 的实际相对文件路径（处理文件名与 agentType 不一致的情况）
 */
export function getActualRelativeAgentFilePath(agent: AgentDefinition): string {
  if (isBuiltInAgent(agent)) {
    return '内置'
  }
  if (isPluginAgent(agent)) {
    return `插件：${agent.plugin || '未知'}`
  }
  if (agent.source === 'flagSettings') {
    return 'CLI 参数'
  }

  const dirPath = getRelativeAgentDirectoryPath(agent.source)
  const filename = agent.filename || agent.agentType
  return join(dirPath, `${filename}.md`)
}

/**
 * 确保 agent 位置对应的目录已存在
 */
async function ensureAgentDirectoryExists(
  source: SettingSource,
): Promise<string> {
  const dirPath = getAgentDirectoryPath(source)
  await mkdir(dirPath, { recursive: true })
  return dirPath
}

/**
 * 将 agent 保存到文件系统
 * @param checkExists - 若为 true，当文件已存在时抛出错误
 */
export async function saveAgentToFile(
  source: SettingSource | 'built-in',
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  checkExists = true,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
): Promise<void> {
  if (source === 'built-in') {
    throw new Error('无法保存内置 agent')
  }

  await ensureAgentDirectoryExists(source)
  const filePath = getNewAgentFilePath({ source, agentType })

  const content = formatAgentAsMarkdown(
    agentType,
    whenToUse,
    tools,
    systemPrompt,
    color,
    model,
    memory,
    effort,
  )
  try {
    await writeFileAndFlush(filePath, content, checkExists ? 'wx' : 'w')
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') {
      throw new Error(`Agent 文件已存在：${filePath}`)
    }
    throw e
  }
}

/**
 * 更新已存在的 agent 文件
 */
export async function updateAgentFile(
  agent: AgentDefinition,
  newWhenToUse: string,
  newTools: string[] | undefined,
  newSystemPrompt: string,
  newColor?: string,
  newModel?: string,
  newMemory?: AgentMemoryScope,
  newEffort?: EffortValue,
): Promise<void> {
  if (agent.source === 'built-in') {
    throw new Error('无法更新内置 agent')
  }

  const filePath = getActualAgentFilePath(agent)

  const content = formatAgentAsMarkdown(
    agent.agentType,
    newWhenToUse,
    newTools,
    newSystemPrompt,
    newColor,
    newModel,
    newMemory,
    newEffort,
  )

  await writeFileAndFlush(filePath, content)
}

/**
 * 删除 agent 文件
 */
export async function deleteAgentFromFile(
  agent: AgentDefinition,
): Promise<void> {
  if (agent.source === 'built-in') {
    throw new Error('无法删除内置 agent')
  }

  const filePath = getActualAgentFilePath(agent)

  try {
    await unlink(filePath)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }
}

async function writeFileAndFlush(
  filePath: string,
  content: string,
  flag: 'w' | 'wx' = 'w',
): Promise<void> {
  const handle = await open(filePath, flag)
  try {
    await handle.writeFile(content, { encoding: 'utf-8' })
    await handle.datasync()
  } finally {
    await handle.close()
  }
}
