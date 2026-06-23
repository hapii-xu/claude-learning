import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import type { AgentColorName } from '@claude-code-best/builtin-tools/tools/AgentTool/agentColorManager.js'
import {
  type AgentMemoryScope,
  loadAgentMemoryPrompt,
} from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js'
import type { AgentDefinition } from '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { EFFORT_LEVELS, parseEffortValue } from '../effort.js'
import {
  coerceDescriptionToString,
  parseFrontmatter,
  parsePositiveIntFromFrontmatter,
} from '../frontmatterParser.js'
import { getFsImplementation, isDuplicatePath } from '../fsOperations.js'
import {
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from '../markdownConfigLoader.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'
import {
  loadPluginOptions,
  substitutePluginVariables,
  substituteUserConfigInContent,
} from './pluginOptionsStorage.js'
import type { PluginManifest } from './schemas.js'
import { walkPluginMarkdown } from './walkPluginMarkdown.js'

const VALID_MEMORY_SCOPES: AgentMemoryScope[] = ['user', 'project', 'local']

async function loadAgentsFromDirectory(
  agentsPath: string,
  pluginName: string,
  sourceName: string,
  pluginPath: string,
  pluginManifest: PluginManifest,
  loadedPaths: Set<string>,
): Promise<AgentDefinition[]> {
  const agents: AgentDefinition[] = []
  await walkPluginMarkdown(
    agentsPath,
    async (fullPath, namespace) => {
      const agent = await loadAgentFromFile(
        fullPath,
        pluginName,
        namespace,
        sourceName,
        pluginPath,
        pluginManifest,
        loadedPaths,
      )
      if (agent) agents.push(agent)
    },
    { logLabel: 'agents' },
  )
  return agents
}

async function loadAgentFromFile(
  filePath: string,
  pluginName: string,
  namespace: string[],
  sourceName: string,
  pluginPath: string,
  pluginManifest: PluginManifest,
  loadedPaths: Set<string>,
): Promise<AgentDefinition | null> {
  const fs = getFsImplementation()
  if (isDuplicatePath(fs, filePath, loadedPaths)) {
    return null
  }
  try {
    const content = await fs.readFile(filePath, { encoding: 'utf-8' })
    const { frontmatter, content: markdownContent } = parseFrontmatter(
      content,
      filePath,
    )

    const baseAgentName =
      (frontmatter.name as string) || basename(filePath).replace(/\.md$/, '')

    // 应用命名空间前缀，与命令的处理方式相同
    const nameParts = [pluginName, ...namespace, baseAgentName]
    const agentType = nameParts.join(':')

    // 从 frontmatter 解析代理元数据
    const whenToUse =
      coerceDescriptionToString(frontmatter.description, agentType) ??
      coerceDescriptionToString(frontmatter['when-to-use'], agentType) ??
      `Agent from ${pluginName} plugin`

    let tools = parseAgentToolsFromFrontmatter(frontmatter.tools)
    const skills = parseSlashCommandToolsFromFrontmatter(frontmatter.skills)
    const color = frontmatter.color as AgentColorName | undefined
    const modelRaw = frontmatter.model
    let model: string | undefined
    if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
      const trimmed = modelRaw.trim()
      model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
    }
    const backgroundRaw = frontmatter.background
    const background =
      backgroundRaw === 'true' || backgroundRaw === true ? true : undefined
    // 替换 ${CLAUDE_PLUGIN_ROOT} 使代理可以引用捆绑文件，
    // 替换 ${user_config.X}（仅非敏感）使代理可以嵌入已配置的
    // 用户名、端点等。敏感引用解析为占位符。
    let systemPrompt = substitutePluginVariables(markdownContent.trim(), {
      path: pluginPath,
      source: sourceName,
    })
    if (pluginManifest.userConfig) {
      systemPrompt = substituteUserConfigInContent(
        systemPrompt,
        loadPluginOptions(sourceName),
        pluginManifest.userConfig,
      )
    }

    // 解析记忆作用域
    const memoryRaw = frontmatter.memory as string | undefined
    let memory: AgentMemoryScope | undefined
    if (memoryRaw !== undefined) {
      if (VALID_MEMORY_SCOPES.includes(memoryRaw as AgentMemoryScope)) {
        memory = memoryRaw as AgentMemoryScope
      } else {
        logForDebugging(
          `Plugin agent file ${filePath} has invalid memory value '${memoryRaw}'. Valid options: ${VALID_MEMORY_SCOPES.join(', ')}`,
        )
      }
    }

    // 解析隔离模式
    const isolationRaw = frontmatter.isolation as string | undefined
    const isolation =
      isolationRaw === 'worktree' ? ('worktree' as const) : undefined

    // 解析努力程度（字符串级别或整数）
    const effortRaw = frontmatter.effort
    const effort =
      effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined
    if (effortRaw !== undefined && effort === undefined) {
      logForDebugging(
        `Plugin agent file ${filePath} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
      )
    }

    // permissionMode、hooks 和 mcpServers 对插件代理有意不解析。
    // 插件是第三方市场代码；这些字段会让代理的能力超出用户在安装时批准的范围。
    // 需要此级别控制时，应在 .hclaude/agents/ 中定义代理，用户在那里
    // 显式编写了 frontmatter。（注意：插件仍可在清单级别附带 hooks 和 MCP 服务器
    // —— 那是安装时的信任边界。按代理声明会让 agents/ 中某个隐蔽的代理文件
    // 静默添加它们。）参见 PR #22558 审查。
    for (const field of ['permissionMode', 'hooks', 'mcpServers'] as const) {
      if (frontmatter[field] !== undefined) {
        logForDebugging(
          `Plugin agent file ${filePath} sets ${field}, which is ignored for plugin agents. Use .hclaude/agents/ for this level of control.`,
          { level: 'warn' },
        )
      }
    }

    // 解析 maxTurns
    const maxTurnsRaw = frontmatter.maxTurns
    const maxTurns = parsePositiveIntFromFrontmatter(maxTurnsRaw)
    if (maxTurnsRaw !== undefined && maxTurns === undefined) {
      logForDebugging(
        `Plugin agent file ${filePath} has invalid maxTurns '${maxTurnsRaw}'. Must be a positive integer.`,
      )
    }

    // 解析 disallowedTools
    const disallowedTools =
      frontmatter.disallowedTools !== undefined
        ? parseAgentToolsFromFrontmatter(frontmatter.disallowedTools)
        : undefined

    // 若启用了记忆，注入 Write/Edit/Read 工具以访问记忆
    if (isAutoMemoryEnabled() && memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    return {
      agentType,
      whenToUse,
      tools,
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && memory) {
          const memoryPrompt = loadAgentMemoryPrompt(agentType, memory)
          return systemPrompt + '\n\n' + memoryPrompt
        }
        return systemPrompt
      },
      source: 'plugin' as const,
      color,
      model,
      filename: baseAgentName,
      plugin: sourceName,
      ...(background ? { background } : {}),
      ...(memory ? { memory } : {}),
      ...(isolation ? { isolation } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    } as AgentDefinition
  } catch (error) {
    logForDebugging(`Failed to load agent from ${filePath}: ${error}`, {
      level: 'error',
    })
    return null
  }
}

export const loadPluginAgents = memoize(
  async (): Promise<AgentDefinition[]> => {
    // 仅从已启用插件加载代理
    const { enabled, errors } = await loadAllPluginsCacheOnly()

    if (errors.length > 0) {
      logForDebugging(
        `Plugin loading errors: ${errors.map(e => getPluginErrorMessage(e)).join(', ')}`,
      )
    }

    // 并行处理插件；每个插件有自己的 loadedPaths 作用域
    const perPluginAgents = await Promise.all(
      enabled.map(async (plugin): Promise<AgentDefinition[]> => {
        // 跟踪已加载的文件路径，防止该插件内重复
        const loadedPaths = new Set<string>()
        const pluginAgents: AgentDefinition[] = []

        // 从默认代理目录加载代理
        if (plugin.agentsPath) {
          try {
            const agents = await loadAgentsFromDirectory(
              plugin.agentsPath,
              plugin.name,
              plugin.source,
              plugin.path,
              plugin.manifest,
              loadedPaths,
            )
            pluginAgents.push(...agents)

            if (agents.length > 0) {
              logForDebugging(
                `Loaded ${agents.length} agents from plugin ${plugin.name} default directory`,
              )
            }
          } catch (error) {
            logForDebugging(
              `Failed to load agents from plugin ${plugin.name} default directory: ${error}`,
              { level: 'error' },
            )
          }
        }

        // 从清单中指定的额外路径加载代理
        if (plugin.agentsPaths) {
          // 并行处理所有 agentsPaths。isDuplicatePath 是同步的
          // （检查并添加），因此并发访问 loadedPaths 是安全的。
          const pathResults = await Promise.all(
            plugin.agentsPaths.map(
              async (agentPath): Promise<AgentDefinition[]> => {
                try {
                  const fs = getFsImplementation()
                  const stats = await fs.stat(agentPath)

                  if (stats.isDirectory()) {
                    // 从目录中加载所有 .md 文件
                    const agents = await loadAgentsFromDirectory(
                      agentPath,
                      plugin.name,
                      plugin.source,
                      plugin.path,
                      plugin.manifest,
                      loadedPaths,
                    )

                    if (agents.length > 0) {
                      logForDebugging(
                        `Loaded ${agents.length} agents from plugin ${plugin.name} custom path: ${agentPath}`,
                      )
                    }
                    return agents
                  } else if (stats.isFile() && agentPath.endsWith('.md')) {
                    // 加载单个代理文件
                    const agent = await loadAgentFromFile(
                      agentPath,
                      plugin.name,
                      [],
                      plugin.source,
                      plugin.path,
                      plugin.manifest,
                      loadedPaths,
                    )
                    if (agent) {
                      logForDebugging(
                        `Loaded agent from plugin ${plugin.name} custom file: ${agentPath}`,
                      )
                      return [agent]
                    }
                  }
                  return []
                } catch (error) {
                  logForDebugging(
                    `Failed to load agents from plugin ${plugin.name} custom path ${agentPath}: ${error}`,
                    { level: 'error' },
                  )
                  return []
                }
              },
            ),
          )
          for (const agents of pathResults) {
            pluginAgents.push(...agents)
          }
        }
        return pluginAgents
      }),
    )

    const allAgents = perPluginAgents.flat()
    logForDebugging(`Total plugin agents loaded: ${allAgents.length}`)
    return allAgents
  },
)

export function clearPluginAgentCache(): void {
  loadPluginAgents.cache?.clear?.()
}
