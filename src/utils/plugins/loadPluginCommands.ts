import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join } from 'path'
import { getInlinePlugins, getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import {
  parseArgumentNames,
  substituteArguments,
} from '../argumentSubstitution.js'
import { logForDebugging } from '../debug.js'
import { EFFORT_LEVELS, parseEffortValue } from '../effort.js'
import { isBareMode } from '../envUtils.js'
import { isENOENT } from '../errors.js'
import {
  coerceDescriptionToString,
  type FrontmatterData,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parseShellFrontmatter,
} from '../frontmatterParser.js'
import { getFsImplementation, isDuplicatePath } from '../fsOperations.js'
import {
  extractDescriptionFromMarkdown,
  parseSlashCommandToolsFromFrontmatter,
} from '../markdownConfigLoader.js'
import { parseUserSpecifiedModel } from '../model/model.js'
import { executeShellCommandsInPrompt } from '../promptShellExecution.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'
import {
  loadPluginOptions,
  substitutePluginVariables,
  substituteUserConfigInContent,
} from './pluginOptionsStorage.js'
import type { CommandMetadata, PluginManifest } from './schemas.js'
import { walkPluginMarkdown } from './walkPluginMarkdown.js'

// 与 MarkdownFile 类似，但用于插件来源
type PluginMarkdownFile = {
  filePath: string
  baseDir: string
  frontmatter: FrontmatterData
  content: string
}

// 加载命令或技能的配置
type LoadConfig = {
  isSkillMode: boolean // 从 skills/ 目录加载时为 true
}

/**
 * 检查文件路径是否为技能文件（SKILL.md）
 */
function isSkillFile(filePath: string): boolean {
  return /^skill\.md$/i.test(basename(filePath))
}

/**
 * 从文件路径获取命令名称，同时处理普通文件和技能
 */
function getCommandNameFromFile(
  filePath: string,
  baseDir: string,
  pluginName: string,
): string {
  const isSkill = isSkillFile(filePath)

  if (isSkill) {
    // 对于技能，使用父目录名称
    const skillDirectory = dirname(filePath)
    const parentOfSkillDir = dirname(skillDirectory)
    const commandBaseName = basename(skillDirectory)

    // 从技能目录的父目录构建命名空间
    const relativePath = parentOfSkillDir.startsWith(baseDir)
      ? parentOfSkillDir.slice(baseDir.length).replace(/^\//, '')
      : ''
    const namespace = relativePath ? relativePath.split('/').join(':') : ''

    return namespace
      ? `${pluginName}:${namespace}:${commandBaseName}`
      : `${pluginName}:${commandBaseName}`
  } else {
    // 对于普通文件，使用不含 .md 的文件名
    const fileDirectory = dirname(filePath)
    const commandBaseName = basename(filePath).replace(/\.md$/, '')

    // 从文件目录构建命名空间
    const relativePath = fileDirectory.startsWith(baseDir)
      ? fileDirectory.slice(baseDir.length).replace(/^\//, '')
      : ''
    const namespace = relativePath ? relativePath.split('/').join(':') : ''

    return namespace
      ? `${pluginName}:${namespace}:${commandBaseName}`
      : `${pluginName}:${commandBaseName}`
  }
}

/**
 * 从目录中递归收集所有 markdown 文件
 */
async function collectMarkdownFiles(
  dirPath: string,
  baseDir: string,
  loadedPaths: Set<string>,
): Promise<PluginMarkdownFile[]> {
  const files: PluginMarkdownFile[] = []
  const fs = getFsImplementation()

  await walkPluginMarkdown(
    dirPath,
    async fullPath => {
      if (isDuplicatePath(fs, fullPath, loadedPaths)) return
      const content = await fs.readFile(fullPath, { encoding: 'utf-8' })
      const { frontmatter, content: markdownContent } = parseFrontmatter(
        content,
        fullPath,
      )
      files.push({
        filePath: fullPath,
        baseDir,
        frontmatter,
        content: markdownContent,
      })
    },
    { stopAtSkillDir: true, logLabel: 'commands' },
  )

  return files
}

/**
 * 转换插件 markdown 文件以处理技能目录
 */
function transformPluginSkillFiles(
  files: PluginMarkdownFile[],
): PluginMarkdownFile[] {
  const filesByDir = new Map<string, PluginMarkdownFile[]>()

  for (const file of files) {
    const dir = dirname(file.filePath)
    const dirFiles = filesByDir.get(dir) ?? []
    dirFiles.push(file)
    filesByDir.set(dir, dirFiles)
  }

  const result: PluginMarkdownFile[] = []

  for (const [dir, dirFiles] of filesByDir) {
    const skillFiles = dirFiles.filter(f => isSkillFile(f.filePath))
    if (skillFiles.length > 0) {
      // 如果存在多个技能文件，则使用第一个
      const skillFile = skillFiles[0]!
      if (skillFiles.length > 1) {
        logForDebugging(
          `Multiple skill files found in ${dir}, using ${basename(skillFile.filePath)}`,
        )
      }
      // 该目录有技能——只包含技能文件
      result.push(skillFile)
    } else {
      result.push(...dirFiles)
    }
  }

  return result
}

async function loadCommandsFromDirectory(
  commandsPath: string,
  pluginName: string,
  sourceName: string,
  pluginManifest: PluginManifest,
  pluginPath: string,
  config: LoadConfig = { isSkillMode: false },
  loadedPaths: Set<string> = new Set(),
): Promise<Command[]> {
  // 收集所有 markdown 文件
  const markdownFiles = await collectMarkdownFiles(
    commandsPath,
    commandsPath,
    loadedPaths,
  )

  // 应用技能转换
  const processedFiles = transformPluginSkillFiles(markdownFiles)

  // 转换为命令
  const commands: Command[] = []
  for (const file of processedFiles) {
    const commandName = getCommandNameFromFile(
      file.filePath,
      file.baseDir,
      pluginName,
    )

    const command = createPluginCommand(
      commandName,
      file,
      sourceName,
      pluginManifest,
      pluginPath,
      isSkillFile(file.filePath),
      config,
    )

    if (command) {
      commands.push(command)
    }
  }

  return commands
}

/**
 * 从插件 markdown 文件创建命令
 */
function createPluginCommand(
  commandName: string,
  file: PluginMarkdownFile,
  sourceName: string,
  pluginManifest: PluginManifest,
  pluginPath: string,
  isSkill: boolean,
  config: LoadConfig = { isSkillMode: false },
): Command | null {
  try {
    const { frontmatter, content } = file

    const validatedDescription = coerceDescriptionToString(
      frontmatter.description,
      commandName,
    )
    const description =
      validatedDescription ??
      extractDescriptionFromMarkdown(
        content,
        isSkill ? 'Plugin skill' : 'Plugin command',
      )

    // 在解析之前，将 allowed-tools 中的 ${CLAUDE_PLUGIN_ROOT} 替换
    const rawAllowedTools = frontmatter['allowed-tools']
    const substitutedAllowedTools =
      typeof rawAllowedTools === 'string'
        ? substitutePluginVariables(rawAllowedTools, {
            path: pluginPath,
            source: sourceName,
          })
        : Array.isArray(rawAllowedTools)
          ? rawAllowedTools.map(tool =>
              typeof tool === 'string'
                ? substitutePluginVariables(tool, {
                    path: pluginPath,
                    source: sourceName,
                  })
                : tool,
            )
          : rawAllowedTools
    const allowedTools = parseSlashCommandToolsFromFrontmatter(
      substitutedAllowedTools,
    )

    const argumentHint = frontmatter['argument-hint'] as string | undefined
    const argumentNames = parseArgumentNames(
      frontmatter.arguments as string | string[] | undefined,
    )
    const whenToUse = frontmatter.when_to_use as string | undefined
    const version = frontmatter.version as string | undefined
    const displayName = frontmatter.name as string | undefined

    // 处理模型配置，解析 'haiku'、'sonnet'、'opus' 等别名
    const model =
      frontmatter.model === 'inherit'
        ? undefined
        : frontmatter.model
          ? parseUserSpecifiedModel(frontmatter.model as string)
          : undefined

    const effortRaw = frontmatter['effort']
    const effort =
      effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined
    if (effortRaw !== undefined && effort === undefined) {
      logForDebugging(
        `Plugin command ${commandName} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
      )
    }

    const disableModelInvocation = parseBooleanFrontmatter(
      frontmatter['disable-model-invocation'],
    )

    const userInvocableValue = frontmatter['user-invocable']
    const userInvocable =
      userInvocableValue === undefined
        ? true
        : parseBooleanFrontmatter(userInvocableValue)

    const shell = parseShellFrontmatter(frontmatter.shell, commandName)

    return {
      type: 'prompt',
      name: commandName,
      description,
      hasUserSpecifiedDescription: validatedDescription !== null,
      allowedTools,
      argumentHint,
      argNames: argumentNames.length > 0 ? argumentNames : undefined,
      whenToUse,
      version,
      model,
      effort,
      disableModelInvocation,
      userInvocable,
      contentLength: content.length,
      source: 'plugin' as const,
      loadedFrom: isSkill || config.isSkillMode ? 'plugin' : undefined,
      pluginInfo: {
        pluginManifest,
        repository: sourceName,
      },
      isHidden: !userInvocable,
      progressMessage: isSkill || config.isSkillMode ? 'loading' : 'running',
      userFacingName(): string {
        return displayName || commandName
      },
      async getPromptForCommand(args, context) {
        // 对于来自 skills/ 目录的技能，包含基础目录
        let finalContent = config.isSkillMode
          ? `Base directory for this skill: ${dirname(file.filePath)}\n\n${content}`
          : content

        finalContent = substituteArguments(
          finalContent,
          args,
          true,
          argumentNames,
        )

        // 将 ${CLAUDE_PLUGIN_ROOT} 和 ${CLAUDE_PLUGIN_DATA} 替换为其路径
        finalContent = substitutePluginVariables(finalContent, {
          path: pluginPath,
          source: sourceName,
        })

        // 将 ${user_config.X} 替换为已保存的选项值。敏感键
        // 会被替换为描述性占位符——技能内容会进入模型提示词，
        // 我们不在其中放置密钥。
        if (pluginManifest.userConfig) {
          finalContent = substituteUserConfigInContent(
            finalContent,
            loadPluginOptions(sourceName),
            pluginManifest.userConfig,
          )
        }

        // 将 ${CLAUDE_SKILL_DIR} 替换为该技能的具体目录。
        // 与 ${CLAUDE_PLUGIN_ROOT} 不同：一个插件可包含多个
        // 技能，因此 CLAUDE_PLUGIN_ROOT 指向插件根目录，而
        // CLAUDE_SKILL_DIR 指向各个技能的子目录。
        if (config.isSkillMode) {
          const rawSkillDir = dirname(file.filePath)
          const skillDir =
            process.platform === 'win32'
              ? rawSkillDir.replace(/\\/g, '/')
              : rawSkillDir
          finalContent = finalContent.replace(
            /\$\{CLAUDE_SKILL_DIR\}/g,
            skillDir,
          )
        }

        // 将 ${CLAUDE_SESSION_ID} 替换为当前会话 ID
        finalContent = finalContent.replace(
          /\$\{CLAUDE_SESSION_ID\}/g,
          getSessionId(),
        )

        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          {
            ...context,
            getAppState() {
              const appState = context.getAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: allowedTools,
                  },
                },
              }
            },
          },
          `/${commandName}`,
          shell,
        )

        return [{ type: 'text', text: finalContent }]
      },
    } satisfies Command
  } catch (error) {
    logForDebugging(
      `Failed to create command from ${file.filePath}: ${error}`,
      {
        level: 'error',
      },
    )
    return null
  }
}

export const getPluginCommands = memoize(async (): Promise<Command[]> => {
  // --bare：跳过市场插件自动加载。显式的 --plugin-dir 仍然
  // 有效——getInlinePlugins() 由 main.tsx 从 --plugin-dir 设置。
  // 当 inlinePlugins.length > 0 时，loadAllPluginsCacheOnly 已短路为仅内联。
  if (isBareMode() && getInlinePlugins().length === 0) {
    return []
  }
  // 仅从已启用的插件加载命令
  const { enabled, errors } = await loadAllPluginsCacheOnly()

  if (errors.length > 0) {
    logForDebugging(
      `Plugin loading errors: ${errors.map(e => getPluginErrorMessage(e)).join(', ')}`,
    )
  }

  // 并行处理插件；每个插件有其自己的 loadedPaths 作用域
  const perPluginCommands = await Promise.all(
    enabled.map(async (plugin): Promise<Command[]> => {
      // 跟踪已加载的文件路径，以防止该插件内出现重复
      const loadedPaths = new Set<string>()
      const pluginCommands: Command[] = []

      // 从默认命令目录加载命令
      if (plugin.commandsPath) {
        try {
          const commands = await loadCommandsFromDirectory(
            plugin.commandsPath,
            plugin.name,
            plugin.source,
            plugin.manifest,
            plugin.path,
            { isSkillMode: false },
            loadedPaths,
          )
          pluginCommands.push(...commands)

          if (commands.length > 0) {
            logForDebugging(
              `Loaded ${commands.length} commands from plugin ${plugin.name} default directory`,
            )
          }
        } catch (error) {
          logForDebugging(
            `Failed to load commands from plugin ${plugin.name} default directory: ${error}`,
            { level: 'error' },
          )
        }
      }

      // 从 manifest 中指定的附加路径加载命令
      if (plugin.commandsPaths) {
        logForDebugging(
          `Plugin ${plugin.name} has commandsPaths: ${plugin.commandsPaths.join(', ')}`,
        )
        // 并行处理所有 commandsPaths。isDuplicatePath 是同步的
        // （检查并添加），因此对 loadedPaths 的并发访问是安全的。
        const pathResults = await Promise.all(
          plugin.commandsPaths.map(async (commandPath): Promise<Command[]> => {
            try {
              const fs = getFsImplementation()
              const stats = await fs.stat(commandPath)
              logForDebugging(
                `Checking commandPath ${commandPath} - isDirectory: ${stats.isDirectory()}, isFile: ${stats.isFile()}`,
              )

              if (stats.isDirectory()) {
                // 从目录加载所有 .md 文件和技能目录
                const commands = await loadCommandsFromDirectory(
                  commandPath,
                  plugin.name,
                  plugin.source,
                  plugin.manifest,
                  plugin.path,
                  { isSkillMode: false },
                  loadedPaths,
                )

                if (commands.length > 0) {
                  logForDebugging(
                    `Loaded ${commands.length} commands from plugin ${plugin.name} custom path: ${commandPath}`,
                  )
                } else {
                  logForDebugging(
                    `Warning: No commands found in plugin ${plugin.name} custom directory: ${commandPath}. Expected .md files or SKILL.md in subdirectories.`,
                    { level: 'warn' },
                  )
                }
                return commands
              } else if (stats.isFile() && commandPath.endsWith('.md')) {
                if (isDuplicatePath(fs, commandPath, loadedPaths)) {
                  return []
                }

                // 加载单个命令文件
                const content = await fs.readFile(commandPath, {
                  encoding: 'utf-8',
                })
                const { frontmatter, content: markdownContent } =
                  parseFrontmatter(content, commandPath)

                // 检查该命令是否有元数据（对象映射格式）
                let commandName: string | undefined
                let metadataOverride: CommandMetadata | undefined

                if (plugin.commandsMetadata) {
                  // 通过将命令的绝对路径与元数据来源匹配来查找元数据
                  // 将 metadata.source（相对于插件根目录）转换为绝对路径进行比较
                  for (const [name, metadata] of Object.entries(
                    plugin.commandsMetadata,
                  ) as [string, CommandMetadata][]) {
                    if (metadata.source) {
                      const fullMetadataPath = join(
                        plugin.path,
                        metadata.source,
                      )
                      if (commandPath === fullMetadataPath) {
                        commandName = `${plugin.name}:${name}`
                        metadataOverride = metadata
                        break
                      }
                    }
                  }
                }

                // 如果没有元数据，回退到基于文件名的命名
                if (!commandName) {
                  commandName = `${plugin.name}:${basename(commandPath).replace(/\.md$/, '')}`
                }

                // 将元数据覆盖应用到 frontmatter
                const finalFrontmatter = metadataOverride
                  ? {
                      ...frontmatter,
                      ...(metadataOverride.description && {
                        description: metadataOverride.description,
                      }),
                      ...(metadataOverride.argumentHint && {
                        'argument-hint': metadataOverride.argumentHint,
                      }),
                      ...(metadataOverride.model && {
                        model: metadataOverride.model,
                      }),
                      ...(metadataOverride.allowedTools && {
                        'allowed-tools':
                          metadataOverride.allowedTools.join(','),
                      }),
                    }
                  : frontmatter

                const file: PluginMarkdownFile = {
                  filePath: commandPath,
                  baseDir: dirname(commandPath),
                  frontmatter: finalFrontmatter,
                  content: markdownContent,
                }

                const command = createPluginCommand(
                  commandName,
                  file,
                  plugin.source,
                  plugin.manifest,
                  plugin.path,
                  false,
                )

                if (command) {
                  logForDebugging(
                    `Loaded command from plugin ${plugin.name} custom file: ${commandPath}${metadataOverride ? ' (with metadata override)' : ''}`,
                  )
                  return [command]
                }
              }
              return []
            } catch (error) {
              logForDebugging(
                `Failed to load commands from plugin ${plugin.name} custom path ${commandPath}: ${error}`,
                { level: 'error' },
              )
              return []
            }
          }),
        )
        for (const commands of pathResults) {
          pluginCommands.push(...commands)
        }
      }

      // 加载含内联内容的命令（无来源文件）
      // 注意：带有来源文件的命令在前一个循环遍历 commandsPaths 时已加载。
      // 此循环处理指定内联内容而非文件引用的元数据条目。
      if (plugin.commandsMetadata) {
        for (const [name, metadata] of Object.entries(
          plugin.commandsMetadata,
        ) as [string, CommandMetadata][]) {
          // 仅处理含内联内容（无来源）的条目
          if (metadata.content && !metadata.source) {
            try {
              // 解析内联内容中的 frontmatter
              const { frontmatter, content: markdownContent } =
                parseFrontmatter(
                  metadata.content,
                  `<inline:${plugin.name}:${name}>`,
                )

              // 将元数据覆盖应用到 frontmatter
              const finalFrontmatter: FrontmatterData = {
                ...frontmatter,
                ...(metadata.description && {
                  description: metadata.description,
                }),
                ...(metadata.argumentHint && {
                  'argument-hint': metadata.argumentHint,
                }),
                ...(metadata.model && {
                  model: metadata.model,
                }),
                ...(metadata.allowedTools && {
                  'allowed-tools': metadata.allowedTools.join(','),
                }),
              }

              const commandName = `${plugin.name}:${name}`
              const file: PluginMarkdownFile = {
                filePath: `<inline:${commandName}>`, // 内联内容的虚拟路径
                baseDir: plugin.path, // 使用插件根目录作为基础目录
                frontmatter: finalFrontmatter,
                content: markdownContent,
              }

              const command = createPluginCommand(
                commandName,
                file,
                plugin.source,
                plugin.manifest,
                plugin.path,
                false,
              )

              if (command) {
                pluginCommands.push(command)
                logForDebugging(
                  `Loaded inline content command from plugin ${plugin.name}: ${commandName}`,
                )
              }
            } catch (error) {
              logForDebugging(
                `Failed to load inline content command ${name} from plugin ${plugin.name}: ${error}`,
                { level: 'error' },
              )
            }
          }
        }
      }
      return pluginCommands
    }),
  )

  const allCommands = perPluginCommands.flat()
  logForDebugging(`Total plugin commands loaded: ${allCommands.length}`)
  return allCommands
})

export function clearPluginCommandCache(): void {
  getPluginCommands.cache?.clear?.()
}

/**
 * 从插件技能目录加载技能
 * 技能是包含 SKILL.md 文件的目录
 */
async function loadSkillsFromDirectory(
  skillsPath: string,
  pluginName: string,
  sourceName: string,
  pluginManifest: PluginManifest,
  pluginPath: string,
  loadedPaths: Set<string>,
): Promise<Command[]> {
  const fs = getFsImplementation()
  const skills: Command[] = []

  // 首先，检查 skillsPath 本身是否包含 SKILL.md（直接技能目录）
  const directSkillPath = join(skillsPath, 'SKILL.md')
  let directSkillContent: string | null = null
  try {
    directSkillContent = await fs.readFile(directSkillPath, {
      encoding: 'utf-8',
    })
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      logForDebugging(`Failed to load skill from ${directSkillPath}: ${e}`, {
        level: 'error',
      })
      return skills
    }
    // ENOENT：没有直接的 SKILL.md，继续扫描子目录
  }

  if (directSkillContent !== null) {
    // 这是一个直接技能目录，从此处加载技能
    if (isDuplicatePath(fs, directSkillPath, loadedPaths)) {
      return skills
    }
    try {
      const { frontmatter, content: markdownContent } = parseFrontmatter(
        directSkillContent,
        directSkillPath,
      )

      const skillName = `${pluginName}:${basename(skillsPath)}`

      const file: PluginMarkdownFile = {
        filePath: directSkillPath,
        baseDir: dirname(directSkillPath),
        frontmatter,
        content: markdownContent,
      }

      const skill = createPluginCommand(
        skillName,
        file,
        sourceName,
        pluginManifest,
        pluginPath,
        true, // 是技能
        { isSkillMode: true }, // 配置
      )

      if (skill) {
        skills.push(skill)
      }
    } catch (error) {
      logForDebugging(
        `Failed to load skill from ${directSkillPath}: ${error}`,
        {
          level: 'error',
        },
      )
    }
    return skills
  }

  // 否则，扫描包含 SKILL.md 文件的子目录
  let entries
  try {
    entries = await fs.readdir(skillsPath)
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      logForDebugging(
        `Failed to load skills from directory ${skillsPath}: ${e}`,
        { level: 'error' },
      )
    }
    return skills
  }

  await Promise.all(
    entries.map(async entry => {
      // 接受目录和符号链接（符号链接可能指向技能目录）
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        return
      }

      const skillDirPath = join(skillsPath, entry.name)
      const skillFilePath = join(skillDirPath, 'SKILL.md')

      // 尝试直接读取 SKILL.md；如果不存在则跳过
      let content: string
      try {
        content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
      } catch (e: unknown) {
        if (!isENOENT(e)) {
          logForDebugging(`Failed to load skill from ${skillFilePath}: ${e}`, {
            level: 'error',
          })
        }
        return
      }

      if (isDuplicatePath(fs, skillFilePath, loadedPaths)) {
        return
      }

      try {
        const { frontmatter, content: markdownContent } = parseFrontmatter(
          content,
          skillFilePath,
        )

        const skillName = `${pluginName}:${entry.name}`

        const file: PluginMarkdownFile = {
          filePath: skillFilePath,
          baseDir: dirname(skillFilePath),
          frontmatter,
          content: markdownContent,
        }

        const skill = createPluginCommand(
          skillName,
          file,
          sourceName,
          pluginManifest,
          pluginPath,
          true, // 是技能
          { isSkillMode: true }, // 配置
        )

        if (skill) {
          skills.push(skill)
        }
      } catch (error) {
        logForDebugging(
          `Failed to load skill from ${skillFilePath}: ${error}`,
          { level: 'error' },
        )
      }
    }),
  )

  return skills
}

export const getPluginSkills = memoize(async (): Promise<Command[]> => {
  // --bare：与上面 getPluginCommands 相同的门控——遵从显式的
  // --plugin-dir，跳过市场自动加载。
  if (isBareMode() && getInlinePlugins().length === 0) {
    return []
  }
  // 仅从已启用的插件加载技能
  const { enabled, errors } = await loadAllPluginsCacheOnly()

  if (errors.length > 0) {
    logForDebugging(
      `Plugin loading errors: ${errors.map(e => getPluginErrorMessage(e)).join(', ')}`,
    )
  }

  logForDebugging(
    `getPluginSkills: Processing ${enabled.length} enabled plugins`,
  )

  // 并行处理插件；每个插件有其自己的 loadedPaths 作用域
  const perPluginSkills = await Promise.all(
    enabled.map(async (plugin): Promise<Command[]> => {
      // 跟踪已加载的文件路径，以防止该插件内出现重复
      const loadedPaths = new Set<string>()
      const pluginSkills: Command[] = []

      logForDebugging(
        `Checking plugin ${plugin.name}: skillsPath=${plugin.skillsPath ? 'exists' : 'none'}, skillsPaths=${plugin.skillsPaths ? plugin.skillsPaths.length : 0} paths`,
      )
      // 从默认技能目录加载技能
      if (plugin.skillsPath) {
        logForDebugging(
          `Attempting to load skills from plugin ${plugin.name} default skillsPath: ${plugin.skillsPath}`,
        )
        try {
          const skills = await loadSkillsFromDirectory(
            plugin.skillsPath,
            plugin.name,
            plugin.source,
            plugin.manifest,
            plugin.path,
            loadedPaths,
          )
          pluginSkills.push(...skills)

          logForDebugging(
            `Loaded ${skills.length} skills from plugin ${plugin.name} default directory`,
          )
        } catch (error) {
          logForDebugging(
            `Failed to load skills from plugin ${plugin.name} default directory: ${error}`,
            { level: 'error' },
          )
        }
      }

      // 从 manifest 中指定的附加路径加载技能
      if (plugin.skillsPaths) {
        logForDebugging(
          `Attempting to load skills from plugin ${plugin.name} skillsPaths: ${plugin.skillsPaths.join(', ')}`,
        )
        // 并行处理所有 skillsPaths。isDuplicatePath 是同步的
        // （检查并添加），因此对 loadedPaths 的并发访问是安全的。
        const pathResults = await Promise.all(
          plugin.skillsPaths.map(async (skillPath): Promise<Command[]> => {
            try {
              logForDebugging(
                `Loading from skillPath: ${skillPath} for plugin ${plugin.name}`,
              )
              const skills = await loadSkillsFromDirectory(
                skillPath,
                plugin.name,
                plugin.source,
                plugin.manifest,
                plugin.path,
                loadedPaths,
              )

              logForDebugging(
                `Loaded ${skills.length} skills from plugin ${plugin.name} custom path: ${skillPath}`,
              )
              return skills
            } catch (error) {
              logForDebugging(
                `Failed to load skills from plugin ${plugin.name} custom path ${skillPath}: ${error}`,
                { level: 'error' },
              )
              return []
            }
          }),
        )
        for (const skills of pathResults) {
          pluginSkills.push(...skills)
        }
      }
      return pluginSkills
    }),
  )

  const allSkills = perPluginSkills.flat()
  logForDebugging(`Total plugin skills loaded: ${allSkills.length}`)
  return allSkills
})

export function clearPluginSkillsCache(): void {
  getPluginSkills.cache?.clear?.()
}
