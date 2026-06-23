import { realpath } from 'fs/promises'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  sep as pathSep,
  relative,
} from 'path'
import {
  getAdditionalDirectoriesForClaudeMd,
  getSessionId,
} from '../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Command, PromptCommand } from '../types/command.js'
import {
  parseArgumentNames,
  substituteArguments,
} from '../utils/argumentSubstitution.js'
import { logForDebugging } from '../utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from '../utils/effort.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
} from '../utils/envUtils.js'
import { isENOENT, isFsInaccessible } from '../utils/errors.js'
import {
  coerceDescriptionToString,
  type FrontmatterData,
  type FrontmatterShell,
  parseBooleanFrontmatter,
  parseFrontmatter,
  parseShellFrontmatter,
  splitPathInFrontmatter,
} from '../utils/frontmatterParser.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { isPathGitignored } from '../utils/git/gitignore.js'
import { logError } from '../utils/log.js'
import {
  extractDescriptionFromMarkdown,
  getProjectDirsUpToHome,
  loadMarkdownFilesForSubdir,
  type MarkdownFile,
  parseSlashCommandToolsFromFrontmatter,
} from '../utils/markdownConfigLoader.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import type { SettingSource } from '../utils/settings/constants.js'
import { isSettingSourceEnabled } from '../utils/settings/constants.js'
import { getManagedFilePath } from '../utils/settings/managedPath.js'
import { isRestrictedToPluginOnly } from '../utils/settings/pluginOnlyPolicy.js'
import { HooksSchema, type HooksSettings } from '../utils/settings/types.js'
import { createSignal } from '../utils/signal.js'
import { registerMCPSkillBuilders } from './mcpSkillBuilders.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

export type LoadedFrom =
  | 'commands_DEPRECATED'
  | 'skills'
  | 'plugin'
  | 'managed'
  | 'bundled'
  | 'mcp'

/**
 * 返回给定源的 claude 配置目录路径。
 */
export function getSkillsPath(
  source: SettingSource | 'plugin',
  dir: 'skills' | 'commands',
): string {
  logForDebugging(
    `[Hapii] ------ getSkillsPath 开始 ------ source=${source} dir=${dir}`,
  )
  let result: string
  switch (source) {
    case 'policySettings':
      result = join(getManagedFilePath(), CLAUDE_DIR_NAME, dir)
      break
    case 'userSettings':
      result = join(getClaudeConfigHomeDir(), dir)
      break
    case 'projectSettings':
      result = `.hclaude/${dir}`
      break
    case 'plugin':
      result = 'plugin'
      break
    default:
      result = ''
  }
  logForDebugging(`[Hapii] ------ getSkillsPath 结束 ------ result="${result}"`)
  return result
}

/**
 * 仅基于 frontmatter（name、description、whenToUse）估算技能的 token 数，
 * 因为完整内容仅在调用时加载。
 */
export function estimateSkillFrontmatterTokens(skill: Command): number {
  logForDebugging(
    `[Hapii] ------ estimateSkillFrontmatterTokens 开始 ------ skill.name=${skill.name}`,
  )
  const frontmatterText = [skill.name, skill.description, skill.whenToUse]
    .filter(Boolean)
    .join(' ')
  const tokens = roughTokenCountEstimation(frontmatterText)
  logForDebugging(
    `[Hapii] ------ estimateSkillFrontmatterTokens 结束 ------ textLen=${frontmatterText.length} tokens=${tokens}`,
  )
  return tokens
}

/**
 * 通过将符号链接解析为规范路径来获取文件的唯一标识符。
 * 这允许检测通过不同路径（例如，通过符号链接或重叠的父目录）
 * 访问的重复文件。
 * 如果文件不存在或无法解析，则返回 null。
 *
 * 使用 realpath 解析符号链接，这是与文件系统无关的，避免了
 * 报告不可靠 inode 值的文件系统的问题（例如，某些虚拟/容器/NFS
 * 文件系统上的 inode 0，或 ExFAT 上的精度损失）。
 * 参见：https://github.com/anthropics/claude-code/issues/13893
 */
async function getFileIdentity(filePath: string): Promise<string | null> {
  logForDebugging(
    `[Hapii] ------ getFileIdentity 开始 ------ filePath=${filePath}`,
  )
  try {
    const resolved = await realpath(filePath)
    logForDebugging(
      `[Hapii] ------ getFileIdentity 结束 ------ resolved=${resolved}`,
    )
    return resolved
  } catch (e) {
    logForDebugging(
      `[Hapii] ------ getFileIdentity 结束 ------ realpath失败, 返回null err=${e}`,
    )
    return null
  }
}

// 内部类型，用于跟踪技能及其文件路径以进行去重
type SkillWithPath = {
  skill: Command
  filePath: string
}

/**
 * 从 frontmatter 解析并验证 hooks。
 * 如果 hooks 未定义或无效，则返回 undefined。
 */
function parseHooksFromFrontmatter(
  frontmatter: FrontmatterData,
  skillName: string,
): HooksSettings | undefined {
  logForDebugging(
    `[Hapii] ------ parseHooksFromFrontmatter 开始 ------ skillName=${skillName} hasHooks=${!!frontmatter.hooks}`,
  )
  if (!frontmatter.hooks) {
    logForDebugging(
      `[Hapii] ------ parseHooksFromFrontmatter 结束 ------ 无hooks字段, 返回undefined`,
    )
    return undefined
  }

  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `[Hapii] ------ parseHooksFromFrontmatter 结束 ------ hooks校验失败: ${result.error.message}`,
    )
    logForDebugging(
      `Invalid hooks in skill '${skillName}': ${result.error.message}`,
    )
    return undefined
  }

  logForDebugging(
    `[Hapii] ------ parseHooksFromFrontmatter 结束 ------ hooks校验通过`,
  )
  return result.data
}

/**
 * 从技能中解析 paths frontmatter，使用与 CLAUDE.md 规则相同的格式。
 * 如果未指定路径或所有模式都是全匹配，则返回 undefined。
 */
function parseSkillPaths(frontmatter: FrontmatterData): string[] | undefined {
  logForDebugging(
    `[Hapii] ------ parseSkillPaths 开始 ------ hasPaths=${!!frontmatter.paths}`,
  )
  if (!frontmatter.paths) {
    logForDebugging(
      `[Hapii] ------ parseSkillPaths 结束 ------ 无paths字段, 返回undefined`,
    )
    return undefined
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      // 移除 /** 后缀——ignore 库将 'path' 视为同时匹配路径本身
      // 和其内部的所有内容
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  logForDebugging(
    `[Hapii] parseSkillPaths rawPatterns=${patterns.length} [${patterns.join(', ')}]`,
  )

  // 如果所有模式都是 **（全匹配），则视为无路径（undefined）
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    logForDebugging(
      `[Hapii] ------ parseSkillPaths 结束 ------ 全匹配模式, 返回undefined`,
    )
    return undefined
  }

  logForDebugging(
    `[Hapii] ------ parseSkillPaths 结束 ------ patterns=[${patterns.join(', ')}]`,
  )
  return patterns
}

/**
 * 解析基于文件的和 MCP 技能加载之间共享的所有技能 frontmatter 字段。
 * 调用方单独提供解析后的技能名称以及 source/loadedFrom/baseDir/paths 字段。
 */
export function parseSkillFrontmatterFields(
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: 'Skill' | 'Custom command' = 'Skill',
): {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: ReturnType<typeof parseUserSpecifiedModel> | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: HooksSettings | undefined
  executionContext: 'fork' | undefined
  agent: string | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
} {
  logForDebugging(
    `[Hapii] ------ parseSkillFrontmatterFields 开始 ------ resolvedName=${resolvedName} fallbackLabel=${descriptionFallbackLabel} mdLen=${markdownContent.length}`,
  )
  const validatedDescription = coerceDescriptionToString(
    frontmatter.description,
    resolvedName,
  )
  const description =
    validatedDescription ??
    extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel)

  const userInvocable =
    frontmatter['user-invocable'] === undefined
      ? true
      : parseBooleanFrontmatter(frontmatter['user-invocable'])

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
      `Skill ${resolvedName} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
    )
  }

  const parsed: {
    displayName: string | undefined
    description: string
    hasUserSpecifiedDescription: boolean
    allowedTools: string[]
    argumentHint: string | undefined
    argumentNames: string[]
    whenToUse: string | undefined
    version: string | undefined
    model: ReturnType<typeof parseUserSpecifiedModel> | undefined
    disableModelInvocation: boolean
    userInvocable: boolean
    hooks: HooksSettings | undefined
    executionContext: 'fork' | undefined
    agent: string | undefined
    effort: EffortValue | undefined
    shell: FrontmatterShell | undefined
  } = {
    displayName:
      frontmatter.name != null ? String(frontmatter.name) : undefined,
    description,
    hasUserSpecifiedDescription: validatedDescription !== null,
    allowedTools: parseSlashCommandToolsFromFrontmatter(
      frontmatter['allowed-tools'],
    ),
    argumentHint:
      frontmatter['argument-hint'] != null
        ? String(frontmatter['argument-hint'])
        : undefined,
    argumentNames: parseArgumentNames(
      frontmatter.arguments as string | string[] | undefined,
    ),
    whenToUse: frontmatter.when_to_use as string | undefined,
    version: frontmatter.version as string | undefined,
    model,
    disableModelInvocation: parseBooleanFrontmatter(
      frontmatter['disable-model-invocation'],
    ),
    userInvocable,
    hooks: parseHooksFromFrontmatter(frontmatter, resolvedName),
    executionContext: frontmatter.context === 'fork' ? 'fork' : undefined,
    agent: frontmatter.agent as string | undefined,
    effort,
    shell: parseShellFrontmatter(frontmatter.shell, resolvedName),
  }
  logForDebugging(
    `[Hapii] ------ parseSkillFrontmatterFields 结束 ------ ` +
      `userInvocable=${parsed.userInvocable} tools=${parsed.allowedTools.length} ` +
      `args=${parsed.argumentNames.length} hasModel=${!!parsed.model} ` +
      `hasHooks=${!!parsed.hooks} ctx=${parsed.executionContext ?? 'inline'} ` +
      `agent=${parsed.agent ?? 'none'} effort=${parsed.effort ?? 'default'}`,
  )
  return parsed
}

/**
 * 从解析的数据创建技能命令
 */
export function createSkillCommand({
  skillName,
  displayName,
  description,
  hasUserSpecifiedDescription,
  markdownContent,
  allowedTools,
  argumentHint,
  argumentNames,
  whenToUse,
  version,
  model,
  disableModelInvocation,
  userInvocable,
  source,
  baseDir,
  loadedFrom,
  hooks,
  executionContext,
  agent,
  paths,
  effort,
  shell,
}: {
  skillName: string
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  markdownContent: string
  allowedTools: string[]
  argumentHint: string | undefined
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  disableModelInvocation: boolean
  userInvocable: boolean
  source: PromptCommand['source']
  baseDir: string | undefined
  loadedFrom: LoadedFrom
  hooks: HooksSettings | undefined
  executionContext: 'inline' | 'fork' | undefined
  agent: string | undefined
  paths: string[] | undefined
  effort: EffortValue | undefined
  shell: FrontmatterShell | undefined
}): Command {
  logForDebugging(
    `[Hapii] ------ createSkillCommand 开始 ------ ` +
      `skillName=${skillName} source=${source} loadedFrom=${loadedFrom} ` +
      `tools=${allowedTools.length} args=${argumentNames.length} ` +
      `mdLen=${markdownContent.length} userInvocable=${userInvocable}`,
  )
  const command: Command = {
    type: 'prompt',
    name: skillName,
    description,
    hasUserSpecifiedDescription,
    allowedTools,
    argumentHint,
    argNames: argumentNames.length > 0 ? argumentNames : undefined,
    whenToUse,
    version,
    model,
    disableModelInvocation,
    userInvocable,
    context: executionContext,
    agent,
    effort,
    paths,
    contentLength: markdownContent.length,
    isHidden: !userInvocable,
    progressMessage: 'running',
    userFacingName(): string {
      return displayName || skillName
    },
    source,
    loadedFrom,
    hooks,
    skillRoot: baseDir,
    async getPromptForCommand(args, toolUseContext) {
      let finalContent = baseDir
        ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
        : markdownContent

      finalContent = substituteArguments(
        finalContent,
        args,
        true,
        argumentNames,
      )

      // 将 ${CLAUDE_SKILL_DIR} 替换为技能自身的目录，以便 bash
      // 注入（!`...`）可以引用捆绑的脚本。在 Windows 上将反斜杠
      // 规范为正斜杠，这样 shell 命令不会将它们视为转义符。
      if (baseDir) {
        const skillDir =
          process.platform === 'win32' ? baseDir.replace(/\\/g, '/') : baseDir
        finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
      }

      // 将 ${CLAUDE_SESSION_ID} 替换为当前会话 ID
      finalContent = finalContent.replace(
        /\$\{CLAUDE_SESSION_ID\}/g,
        getSessionId(),
      )

      // 安全性：MCP 技能是远程且不受信任的——永远不要从它们的
      // markdown 主体执行内联 shell 命令（!`…` / ```! … ```）。
      // ${CLAUDE_SKILL_DIR} 对 MCP 技能反正没有意义。
      if (loadedFrom !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(
          finalContent,
          {
            ...toolUseContext,
            getAppState() {
              const appState = toolUseContext.getAppState()
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
          `/${skillName}`,
          shell,
        )
      }

      return [{ type: 'text', text: finalContent }]
    },
  }
  logForDebugging(
    `[Hapii] ------ createSkillCommand 结束 ------ skill="${command.name}" contentLen=${command.contentLength}`,
  )
  return command
}

/**
 * 从 /skills/ 目录路径加载技能。
 * 仅支持目录格式：skill-name/SKILL.md
 */
async function loadSkillsFromSkillsDir(
  basePath: string,
  source: SettingSource,
): Promise<SkillWithPath[]> {
  logForDebugging(
    `[Hapii] ------ loadSkillsFromSkillsDir 开始 ------ basePath=${basePath} source=${source}`,
  )
  const fs = getFsImplementation()

  let entries
  try {
    entries = await fs.readdir(basePath)
  } catch (e: unknown) {
    if (!isFsInaccessible(e)) logError(e)
    logForDebugging(
      `[Hapii] ------ loadSkillsFromSkillsDir 结束 ------ basePath=${basePath} 目录不可访问，返回空 err=${e}`,
    )
    return []
  }

  logForDebugging(
    `[Hapii] loadSkillsFromSkillsDir 读取目录 entries=${entries.length} basePath=${basePath}`,
  )

  const results = await Promise.all(
    entries.map(async (entry, idx): Promise<SkillWithPath | null> => {
      try {
        logForDebugging(
          `[Hapii] loadSkillsFromSkillsDir 处理条目 [${idx + 1}/${entries.length}] name="${entry.name}" isDir=${entry.isDirectory()} isSymlink=${entry.isSymbolicLink()}`,
        )
        // 仅支持目录格式：skill-name/SKILL.md
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          logForDebugging(
            `[Hapii] loadSkillsFromSkillsDir 跳过非目录/非符号链接 "${entry.name}"`,
          )
          // /skills/ 目录不支持单个 .md 文件
          return null
        }

        const skillDirPath = join(basePath, entry.name)
        const skillFilePath = join(skillDirPath, 'SKILL.md')

        let content: string
        try {
          content = await fs.readFile(skillFilePath, { encoding: 'utf-8' })
          logForDebugging(
            `[Hapii] loadSkillsFromSkillsDir 读取SKILL.md成功 skillFilePath=${skillFilePath} contentLen=${content.length}`,
          )
        } catch (e: unknown) {
          // SKILL.md 不存在，跳过此条目。记录非 ENOENT 错误
          // （EACCES/EPERM/EIO），以便诊断权限/IO 问题。
          if (!isENOENT(e)) {
            logForDebugging(`[skills] failed to read ${skillFilePath}: ${e}`, {
              level: 'warn',
            })
          } else {
            logForDebugging(
              `[Hapii] loadSkillsFromSkillsDir SKILL.md不存在(ENOENT) skillFilePath=${skillFilePath}`,
            )
          }
          return null
        }

        logForDebugging(
          `[Hapii] loadSkillsFromSkillsDir 解析frontmatter skillFilePath=${skillFilePath}`,
        )
        const { frontmatter, content: markdownContent } = parseFrontmatter(
          content,
          skillFilePath,
        )

        const skillName = entry.name
        const parsed = parseSkillFrontmatterFields(
          frontmatter,
          markdownContent,
          skillName,
        )
        const paths = parseSkillPaths(frontmatter)

        logForDebugging(
          `[Hapii] loadSkillsFromSkillsDir 成功加载 skill="${skillName}" ` +
            `source=${source} desc="${parsed.description.slice(0, 40)}..." ` +
            `tools=${parsed.allowedTools.length} paths=${paths ? paths.length : 0}`,
        )

        return {
          skill: createSkillCommand({
            ...parsed,
            skillName,
            markdownContent,
            source,
            baseDir: skillDirPath,
            loadedFrom: 'skills',
            paths,
          }),
          filePath: skillFilePath,
        }
      } catch (error) {
        logError(error)
        logForDebugging(
          `[Hapii] loadSkillsFromSkillsDir 处理条目异常 name="${entry.name}" err=${error}`,
          { level: 'warn' },
        )
        return null
      }
    }),
  )

  const validResults = results.filter((r): r is SkillWithPath => r !== null)
  logForDebugging(
    `[Hapii] ------ loadSkillsFromSkillsDir 结束 ------ basePath=${basePath} 有效=${validResults.length}/${entries.length}`,
  )
  return validResults
}

// --- 旧版 /commands/ 加载器 ---

function isSkillFile(filePath: string): boolean {
  const result = /^skill\.md$/i.test(basename(filePath))
  logForDebugging(
    `[Hapii] ------ isSkillFile 开始 ------ filePath=${filePath} isSkill=${result}`,
  )
  return result
}

/**
 * 转换 markdown 文件以处理旧版 /commands/ 文件夹中的 "skill" 命令。
 * 当目录中存在 SKILL.md 文件时，仅加载该文件，
 * 并使用其父目录的名称。
 */
function transformSkillFiles(files: MarkdownFile[]): MarkdownFile[] {
  logForDebugging(
    `[Hapii] ------ transformSkillFiles 开始 ------ files=${files.length}`,
  )
  const filesByDir = new Map<string, MarkdownFile[]>()

  for (const file of files) {
    const dir = dirname(file.filePath)
    const dirFiles = filesByDir.get(dir) ?? []
    dirFiles.push(file)
    filesByDir.set(dir, dirFiles)
  }

  const result: MarkdownFile[] = []

  for (const [dir, dirFiles] of filesByDir) {
    const skillFiles = dirFiles.filter(f => isSkillFile(f.filePath))
    if (skillFiles.length > 0) {
      const skillFile = skillFiles[0]!
      if (skillFiles.length > 1) {
        logForDebugging(
          `Multiple skill files found in ${dir}, using ${basename(skillFile.filePath)}`,
        )
      }
      result.push(skillFile)
    } else {
      result.push(...dirFiles)
    }
  }

  logForDebugging(
    `[Hapii] ------ transformSkillFiles 结束 ------ result=${result.length} dirs=${filesByDir.size}`,
  )
  return result
}

function buildNamespace(targetDir: string, baseDir: string): string {
  logForDebugging(
    `[Hapii] ------ buildNamespace 开始 ------ targetDir=${targetDir} baseDir=${baseDir}`,
  )
  const normalizedBaseDir = baseDir.endsWith(pathSep)
    ? baseDir.slice(0, -1)
    : baseDir

  if (targetDir === normalizedBaseDir) {
    logForDebugging(
      `[Hapii] ------ buildNamespace 结束 ------ targetDir===baseDir, 返回空命名空间`,
    )
    return ''
  }

  const relativePath = targetDir.slice(normalizedBaseDir.length + 1)
  const ns = relativePath ? relativePath.split(pathSep).join(':') : ''
  logForDebugging(`[Hapii] ------ buildNamespace 结束 ------ namespace="${ns}"`)
  return ns
}

function getSkillCommandName(filePath: string, baseDir: string): string {
  logForDebugging(
    `[Hapii] ------ getSkillCommandName 开始 ------ filePath=${filePath} baseDir=${baseDir}`,
  )
  const skillDirectory = dirname(filePath)
  const parentOfSkillDir = dirname(skillDirectory)
  const commandBaseName = basename(skillDirectory)

  const namespace = buildNamespace(parentOfSkillDir, baseDir)
  const result = namespace ? `${namespace}:${commandBaseName}` : commandBaseName
  logForDebugging(
    `[Hapii] ------ getSkillCommandName 结束 ------ name="${result}"`,
  )
  return result
}

function getRegularCommandName(filePath: string, baseDir: string): string {
  logForDebugging(
    `[Hapii] ------ getRegularCommandName 开始 ------ filePath=${filePath} baseDir=${baseDir}`,
  )
  const fileName = basename(filePath)
  const fileDirectory = dirname(filePath)
  const commandBaseName = fileName.replace(/\.md$/, '')

  const namespace = buildNamespace(fileDirectory, baseDir)
  const result = namespace ? `${namespace}:${commandBaseName}` : commandBaseName
  logForDebugging(
    `[Hapii] ------ getRegularCommandName 结束 ------ name="${result}"`,
  )
  return result
}

function getCommandName(file: MarkdownFile): string {
  logForDebugging(
    `[Hapii] ------ getCommandName 开始 ------ filePath=${file.filePath} baseDir=${file.baseDir}`,
  )
  const isSkill = isSkillFile(file.filePath)
  const result = isSkill
    ? getSkillCommandName(file.filePath, file.baseDir)
    : getRegularCommandName(file.filePath, file.baseDir)
  logForDebugging(
    `[Hapii] ------ getCommandName 结束 ------ isSkill=${isSkill} name="${result}"`,
  )
  return result
}

/**
 * 从旧版 /commands/ 目录加载技能。
 * 同时支持目录格式（SKILL.md）和单个 .md 文件格式。
 * 来自 /commands/ 的命令默认为 user-invocable: true
 */
async function loadSkillsFromCommandsDir(
  cwd: string,
): Promise<SkillWithPath[]> {
  logForDebugging(
    `[Hapii] ------ loadSkillsFromCommandsDir 开始 ------ cwd=${cwd} (旧版 /commands/ 格式)`,
  )
  try {
    const markdownFiles = await loadMarkdownFilesForSubdir('commands', cwd)
    logForDebugging(
      `[Hapii] loadSkillsFromCommandsDir 加载markdown文件 markdownFiles=${markdownFiles.length}`,
    )
    const processedFiles = transformSkillFiles(markdownFiles)
    logForDebugging(
      `[Hapii] loadSkillsFromCommandsDir 转换后 processedFiles=${processedFiles.length}`,
    )

    const skills: SkillWithPath[] = []

    for (let i = 0; i < processedFiles.length; i++) {
      const { baseDir, filePath, frontmatter, content, source } =
        processedFiles[i]!
      try {
        logForDebugging(
          `[Hapii] loadSkillsFromCommandsDir 处理 [${i + 1}/${processedFiles.length}] filePath=${filePath} source=${source}`,
        )
        const isSkillFormat = isSkillFile(filePath)
        const skillDirectory = isSkillFormat ? dirname(filePath) : undefined
        const cmdName = getCommandName({
          baseDir,
          filePath,
          frontmatter,
          content,
          source,
        })
        logForDebugging(
          `[Hapii] loadSkillsFromCommandsDir cmdName="${cmdName}" isSkillFormat=${isSkillFormat}`,
        )

        const parsed = parseSkillFrontmatterFields(
          frontmatter,
          content,
          cmdName,
          'Custom command',
        )

        skills.push({
          skill: createSkillCommand({
            ...parsed,
            skillName: cmdName,
            displayName: undefined,
            markdownContent: content,
            source,
            baseDir: skillDirectory,
            loadedFrom: 'commands_DEPRECATED',
            paths: undefined,
          }),
          filePath,
        })
      } catch (error) {
        logError(error)
        logForDebugging(
          `[Hapii] loadSkillsFromCommandsDir 处理单个文件失败 filePath=${filePath} err=${error}`,
          { level: 'warn' },
        )
      }
    }

    logForDebugging(
      `[Hapii] ------ loadSkillsFromCommandsDir 结束 ------ 加载=${skills.length} 个旧版命令`,
    )
    return skills
  } catch (error) {
    logError(error)
    logForDebugging(
      '[Hapii] ------ loadSkillsFromCommandsDir 结束 ------ 异常，返回空数组',
      {
        level: 'warn',
      },
    )
    return []
  }
}

/**
 * 从 /skills/ 和旧版 /commands/ 目录加载所有技能。
 *
 * 来自 /skills/ 目录的技能：
 * - 仅支持目录格式：skill-name/SKILL.md
 * - 默认为 user-invocable: true（可以使用 user-invocable: false 选择退出）
 *
 * 来自旧版 /commands/ 目录的技能：
 * - 同时支持目录格式（SKILL.md）和单个 .md 文件格式
 * - 默认为 user-invocable: true（用户可以输入 /cmd）
 *
 * @param cwd 当前工作目录，用于项目目录遍历
 */
export const getSkillDirCommands = memoize(
  async (cwd: string): Promise<Command[]> => {
    const userSkillsDir = join(getClaudeConfigHomeDir(), 'skills')
    const managedSkillsDir = join(
      getManagedFilePath(),
      CLAUDE_DIR_NAME,
      'skills',
    )
    const projectSkillsDirs = getProjectDirsUpToHome('skills', cwd)

    logForDebugging(
      `[Hapii] ------ getSkillDirCommands 开始 ------ cwd=${cwd}`,
      {
        level: 'info',
      },
    )
    logForDebugging(
      `[Hapii] getSkillDirCommands 目录: managed=${managedSkillsDir}, user=${userSkillsDir}, project=[${projectSkillsDirs.join(', ')}]`,
    )

    // 从额外目录加载（--add-dir）
    const additionalDirs = getAdditionalDirectoriesForClaudeMd()
    const skillsLocked = isRestrictedToPluginOnly('skills')
    const projectSettingsEnabled =
      isSettingSourceEnabled('projectSettings') && !skillsLocked

    logForDebugging(
      `[Hapii] getSkillDirCommands 配置: additionalDirs=${additionalDirs.length} skillsLocked=${skillsLocked} projectSettingsEnabled=${projectSettingsEnabled} bareMode=${isBareMode()}`,
    )

    // --bare：跳过自动发现（managed/user/project 目录遍历 + 旧版
    // commands 目录）。仅加载显式的 --add-dir 路径。捆绑技能单独注册。
    // skillsLocked 仍然适用——--bare 不是策略绕过。
    if (isBareMode()) {
      if (additionalDirs.length === 0 || !projectSettingsEnabled) {
        logForDebugging(
          `[Hapii] ------ getSkillDirCommands 结束 ------ [bare] 跳过技能发现 (${additionalDirs.length === 0 ? '无 --add-dir' : 'projectSettings 禁用或 skillsLocked'})`,
        )
        return []
      }
      const additionalSkillsNested = await Promise.all(
        additionalDirs.map(dir =>
          loadSkillsFromSkillsDir(
            join(dir, CLAUDE_DIR_NAME, 'skills'),
            'projectSettings',
          ),
        ),
      )
      // 无需去重——显式目录，用户控制唯一性。
      const result = additionalSkillsNested.flat().map(s => s.skill)
      logForDebugging(
        `[Hapii] ------ getSkillDirCommands 结束 ------ [bare] 仅加载 --add-dir 技能 total=${result.length}`,
        { level: 'info' },
      )
      return result
    }

    // 并行从 /skills/ 目录、额外目录和旧版 /commands/ 加载
    // （全部独立——不同的目录，没有共享状态）
    logForDebugging(
      `[Hapii] getSkillDirCommands 开始并行加载 5 个来源 (managed/user/project/additional/legacy)`,
    )
    const [
      managedSkills,
      userSkills,
      projectSkillsNested,
      additionalSkillsNested,
      legacyCommands,
    ] = await Promise.all([
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS)
        ? Promise.resolve([])
        : loadSkillsFromSkillsDir(managedSkillsDir, 'policySettings'),
      isSettingSourceEnabled('userSettings') && !skillsLocked
        ? loadSkillsFromSkillsDir(userSkillsDir, 'userSettings')
        : Promise.resolve([]),
      projectSettingsEnabled
        ? Promise.all(
            projectSkillsDirs.map(dir =>
              loadSkillsFromSkillsDir(dir, 'projectSettings'),
            ),
          )
        : Promise.resolve([]),
      projectSettingsEnabled
        ? Promise.all(
            additionalDirs.map(dir =>
              loadSkillsFromSkillsDir(
                join(dir, CLAUDE_DIR_NAME, 'skills'),
                'projectSettings',
              ),
            ),
          )
        : Promise.resolve([]),
      // 旧版 commands-as-skills 通过 subdir='commands' 进入
      // markdownConfigLoader，我们那里的 agents-only 守卫会跳过它。
      // 当技能被锁定时在此处阻止——这些确实是技能，无论它们
      // 从哪个目录加载。
      skillsLocked ? Promise.resolve([]) : loadSkillsFromCommandsDir(cwd),
    ])

    logForDebugging(
      `[Hapii] getSkillDirCommands 并行加载完成: managed=${managedSkills.length} user=${userSkills.length} ` +
        `project=${projectSkillsNested.flat().length} additional=${additionalSkillsNested.flat().length} ` +
        `legacy=${legacyCommands.length}`,
    )

    // 扁平化并合并所有技能
    const allSkillsWithPaths = [
      ...managedSkills,
      ...userSkills,
      ...projectSkillsNested.flat(),
      ...additionalSkillsNested.flat(),
      ...legacyCommands,
    ]

    // 按解析路径去重（处理符号链接和重复的父目录）
    // 并行预计算文件标识（realpath 调用是独立的），
    // 然后同步去重（顺序依赖的首次获胜）
    logForDebugging(
      `[Hapii] getSkillDirCommands 开始去重 allSkillsWithPaths=${allSkillsWithPaths.length}`,
    )
    const fileIds = await Promise.all(
      allSkillsWithPaths.map(({ skill, filePath }) =>
        skill.type === 'prompt'
          ? getFileIdentity(filePath)
          : Promise.resolve(null),
      ),
    )

    const seenFileIds = new Map<
      string,
      SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
    >()
    const deduplicatedSkills: Command[] = []

    for (let i = 0; i < allSkillsWithPaths.length; i++) {
      const entry = allSkillsWithPaths[i]
      if (entry === undefined || entry.skill.type !== 'prompt') continue
      const { skill } = entry

      const fileId = fileIds[i]
      if (fileId === null || fileId === undefined) {
        deduplicatedSkills.push(skill)
        continue
      }

      const existingSource = seenFileIds.get(fileId)
      if (existingSource !== undefined) {
        logForDebugging(
          `[Hapii] getSkillDirCommands 跳过重复技能 '${skill.name}' from=${skill.source} existingSource=${existingSource}`,
        )
        continue
      }

      seenFileIds.set(fileId, skill.source)
      deduplicatedSkills.push(skill)
    }

    const duplicatesRemoved =
      allSkillsWithPaths.length - deduplicatedSkills.length
    logForDebugging(
      `[Hapii] getSkillDirCommands 去重完成 duplicatesRemoved=${duplicatesRemoved} remaining=${deduplicatedSkills.length}`,
    )

    // 将条件技能（带 paths frontmatter）与无条件技能分开
    const unconditionalSkills: Command[] = []
    const newConditionalSkills: Command[] = []
    for (const skill of deduplicatedSkills) {
      if (
        skill.type === 'prompt' &&
        skill.paths &&
        skill.paths.length > 0 &&
        !activatedConditionalSkillNames.has(skill.name)
      ) {
        newConditionalSkills.push(skill)
      } else {
        unconditionalSkills.push(skill)
      }
    }

    // 存储条件技能以便在触及匹配文件时后续激活
    for (const skill of newConditionalSkills) {
      conditionalSkills.set(skill.name, skill)
    }

    if (newConditionalSkills.length > 0) {
      logForDebugging(
        `[Hapii] getSkillDirCommands 条件技能(带paths) stored=${newConditionalSkills.length} names=[${newConditionalSkills.map(s => s.name).join(', ')}]`,
      )
    }

    logForDebugging(
      `[Hapii] ------ getSkillDirCommands 结束 ------ ` +
        `返回=${unconditionalSkills.length} (无条件) ` +
        `条件暂存=${newConditionalSkills.length} ` +
        `去重后总数=${deduplicatedSkills.length} ` +
        `(managed=${managedSkills.length} user=${userSkills.length} ` +
        `project=${projectSkillsNested.flat().length} ` +
        `additional=${additionalSkillsNested.flat().length} ` +
        `legacy=${legacyCommands.length})`,
      { level: 'info' },
    )

    return unconditionalSkills
  },
)

export function clearSkillCaches() {
  logForDebugging(
    `[Hapii] ------ clearSkillCaches 开始 ------ 清除 getSkillDirCommands/loadMarkdownFilesForSubdir/conditionalSkills/activatedConditionalSkillNames`,
  )
  getSkillDirCommands.cache?.clear?.()
  loadMarkdownFilesForSubdir.cache?.clear?.()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
  logForDebugging(`[Hapii] ------ clearSkillCaches 结束 ------ 所有缓存已清除`)
}

// 测试的向后兼容别名
export { getSkillDirCommands as getCommandDirCommands }
export { clearSkillCaches as clearCommandCaches }
export { transformSkillFiles }

// --- 动态技能发现 ---

// 动态发现的技能的状态
const dynamicSkillDirs = new Set<string>()
const dynamicSkills = new Map<string, Command>()

// --- 条件技能（路径过滤）---

// 尚未激活的带 paths frontmatter 的技能
const conditionalSkills = new Map<string, Command>()
// 已激活技能的名称（在会话内的缓存清除后仍然保留）
const activatedConditionalSkillNames = new Set<string>()

// 当动态技能加载时触发的信号
const skillsLoaded = createSignal()

/**
 * 注册一个在动态技能加载时调用的回调。
 * 供其他模块用于清除缓存而不创建导入循环。
 * 返回取消订阅函数。
 */
export function onDynamicSkillsLoaded(callback: () => void): () => void {
  logForDebugging(
    `[Hapii] ------ onDynamicSkillsLoaded 开始 ------ 注册动态技能加载回调`,
  )
  // 在订阅时包装，这样抛出异常的监听器会被记录并跳过，
  // 而不是中止 skillsLoaded.emit() 并破坏技能加载。
  // 与 growthbook.ts 相同的 callSafe 模式——createSignal.emit() 没有
  // 每监听器的 try/catch。
  const unsubscribe = skillsLoaded.subscribe(() => {
    try {
      callback()
    } catch (error) {
      logError(error)
    }
  })
  logForDebugging(`[Hapii] ------ onDynamicSkillsLoaded 结束 ------ 回调已注册`)
  return unsubscribe
}

/**
 * 通过从文件路径向上遍历到 cwd 来发现技能目录。
 * 仅发现 cwd 下方的目录（cwd 级别的技能在启动时加载）。
 *
 * @param filePaths 要检查的文件路径数组
 * @param cwd 当前工作目录（发现的上限）
 * @returns 新发现的技能目录数组，按最深优先排序
 */
export async function discoverSkillDirsForPaths(
  filePaths: string[],
  cwd: string,
): Promise<string[]> {
  logForDebugging(
    `[Hapii] ------ discoverSkillDirsForPaths 开始 ------ filePaths=${filePaths.length} cwd=${cwd}`,
  )
  const fs = getFsImplementation()
  const resolvedCwd = cwd.endsWith(pathSep) ? cwd.slice(0, -1) : cwd
  const newDirs: string[] = []

  for (const filePath of filePaths) {
    // 从文件的父目录开始
    let currentDir = dirname(filePath)

    // 向上遍历到 cwd 但不包括 cwd 本身
    // CWD 级别的技能已在启动时加载，所以我们只发现嵌套的技能
    // 使用前缀+分隔符检查以避免在 cwd 为 /project 时匹配 /project-backup
    while (currentDir.startsWith(resolvedCwd + pathSep)) {
      const skillDir = join(currentDir, CLAUDE_DIR_NAME, 'skills')

      // 如果我们已经检查过此路径（命中或未命中）则跳过——避免
      // 在目录不存在时（常见情况）每次 Read/Write/Edit 调用都重复
      // 相同的失败 stat。
      if (!dynamicSkillDirs.has(skillDir)) {
        dynamicSkillDirs.add(skillDir)
        try {
          await fs.stat(skillDir)
          // 技能目录存在。加载前，检查包含目录是否被 gitignore——
          // 阻止例如 node_modules/pkg/.hclaude/skills 静默加载。
          // `git check-ignore` 处理嵌套的 .gitignore、.git/info/exclude
          // 和全局 gitignore。在 git 仓库外部失败时开放
          // （exit 128 → false）；调用时的信任对话框是真正的安全边界。
          if (await isPathGitignored(currentDir, resolvedCwd)) {
            logForDebugging(
              `[skills] Skipped gitignored skills dir: ${skillDir}`,
            )
            continue
          }
          newDirs.push(skillDir)
        } catch {
          // 目录不存在——已在上面记录，继续
        }
      }

      // 移动到父目录
      const parent = dirname(currentDir)
      if (parent === currentDir) break // 已到达根目录
      currentDir = parent
    }
  }

  // 按路径深度排序（最深优先），以便更接近文件的技能优先
  const sorted = newDirs.sort(
    (a, b) => b.split(pathSep).length - a.split(pathSep).length,
  )
  logForDebugging(
    `[Hapii] ------ discoverSkillDirsForPaths 结束 ------ newDirs=${sorted.length} ${sorted.length > 0 ? `paths=[${sorted.join(', ')}]` : ''}`,
  )
  return sorted
}

/**
 * 从给定目录加载技能并将它们合并到动态技能映射中。
 * 来自更接近文件（更深路径）的目录的技能优先。
 *
 * @param dirs 要加载的技能目录数组（应该按最深优先排序）
 */
export async function addSkillDirectories(dirs: string[]): Promise<void> {
  if (
    !isSettingSourceEnabled('projectSettings') ||
    isRestrictedToPluginOnly('skills')
  ) {
    logForDebugging(
      '[Hapii] ------ addSkillDirectories 结束 ------ 跳过: projectSettings 禁用或 plugin-only',
    )
    return
  }
  if (dirs.length === 0) {
    logForDebugging(
      '[Hapii] ------ addSkillDirectories 结束 ------ dirs为空, 无需加载',
    )
    return
  }
  logForDebugging(
    `[Hapii] ------ addSkillDirectories 开始 ------ dirs=${dirs.length} [${dirs.join(', ')}]`,
  )

  const previousSkillNamesForLogging = new Set(dynamicSkills.keys())

  // 从所有目录加载 skills
  const loadedSkills = await Promise.all(
    dirs.map(dir => loadSkillsFromSkillsDir(dir, 'projectSettings')),
  )

  // 以相反顺序处理（较浅优先），这样更深的路径会覆盖
  for (let i = loadedSkills.length - 1; i >= 0; i--) {
    for (const { skill } of loadedSkills[i] ?? []) {
      if (skill.type === 'prompt') {
        dynamicSkills.set(skill.name, skill)
      }
    }
  }

  const newSkillCount = loadedSkills.flat().length
  if (newSkillCount > 0) {
    const addedSkills = [...dynamicSkills.keys()].filter(
      n => !previousSkillNamesForLogging.has(n),
    )
    logForDebugging(
      `[Hapii] ------ addSkillDirectories 结束 ------ 新加载=${newSkillCount} 新增=${addedSkills.length} dynamicSkills总数=${dynamicSkills.size} ${addedSkills.length > 0 ? `names=[${addedSkills.join(', ')}]` : ''}`,
      { level: 'info' },
    )
    if (addedSkills.length > 0) {
      logEvent('tengu_dynamic_skills_changed', {
        source:
          'file_operation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        previousCount: previousSkillNamesForLogging.size,
        newCount: dynamicSkills.size,
        addedCount: addedSkills.length,
        directoryCount: dirs.length,
      })
    }
  }

  // 通知监听器技能已加载（以便它们可以清除缓存）
  logForDebugging(
    `[Hapii] ------ addSkillDirectories 结束 ------ 触发skillsLoaded信号`,
  )
  skillsLoaded.emit()
}

/**
 * 获取所有动态发现的技能。
 * 这些是在会话期间从文件路径发现的技能。
 */
export function getDynamicSkills(): Command[] {
  logForDebugging(
    `[Hapii] ------ getDynamicSkills 开始/结束 ------ count=${dynamicSkills.size} names=[${[...dynamicSkills.keys()].join(', ')}]`,
  )
  return Array.from(dynamicSkills.values())
}

/**
 * 激活路径模式与给定文件路径匹配的条件技能（带 paths frontmatter 的技能）。
 * 激活的技能被添加到动态技能映射中，使模型可以使用它们。
 *
 * 使用 `ignore` 库（gitignore 风格的匹配），与 CLAUDE.md 条件规则的行为匹配。
 *
 * @param filePaths 正在操作的文件路径数组
 * @param cwd 当前工作目录（路径相对于 cwd 匹配）
 * @returns 新激活的技能名称数组
 */
export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (conditionalSkills.size === 0) {
    logForDebugging(
      `[Hapii] ------ activateConditionalSkillsForPaths 结束 ------ 无条件技能待匹配, 直接返回`,
    )
    return []
  }
  logForDebugging(
    `[Hapii] ------ activateConditionalSkillsForPaths 开始 ------ filePaths=${filePaths.length} ` +
      `待匹配条件技能=${conditionalSkills.size} [${[...conditionalSkills.keys()].join(', ')}]`,
  )

  const activated: string[] = []

  for (const [name, skill] of conditionalSkills) {
    if (skill.type !== 'prompt' || !skill.paths || skill.paths.length === 0) {
      continue
    }

    const skillIgnore = ignore().add(skill.paths)
    for (const filePath of filePaths) {
      const relativePath = isAbsolute(filePath)
        ? relative(cwd, filePath)
        : filePath

      // ignore() 对空字符串、逃逸基础目录的路径（../）和绝对路径
      // （Windows 跨驱动器 relative() 返回绝对路径）会抛出异常。
      // cwd 外部的文件反正无法匹配 cwd 相对的模式。
      if (
        !relativePath ||
        relativePath.startsWith('..') ||
        isAbsolute(relativePath)
      ) {
        continue
      }

      if (skillIgnore.ignores(relativePath)) {
        // 通过将技能移动到动态技能来激活此技能
        dynamicSkills.set(name, skill)
        conditionalSkills.delete(name)
        activatedConditionalSkillNames.add(name)
        activated.push(name)
        logForDebugging(
          `[Hapii]   激活条件技能 '${name}' (匹配路径: ${relativePath})`,
          { level: 'info' },
        )
        break
      }
    }
  }

  if (activated.length > 0) {
    logForDebugging(
      `[Hapii] ------ activateConditionalSkillsForPaths 结束 ------ 激活=${activated.length} ` +
        `names=[${activated.join(', ')}] dynamicSkills总数=${dynamicSkills.size}`,
      { level: 'info' },
    )
    logEvent('tengu_dynamic_skills_changed', {
      source:
        'conditional_paths' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      previousCount: dynamicSkills.size - activated.length,
      newCount: dynamicSkills.size,
      addedCount: activated.length,
      directoryCount: 0,
    })

    // 通知监听器技能已加载（以便它们可以清除缓存）
    skillsLoaded.emit()
  } else {
    logForDebugging(
      `[Hapii] ------ activateConditionalSkillsForPaths 结束 ------ 无新激活的条件技能`,
    )
  }

  return activated
}

/**
 * 获取待处理条件技能的数量（用于测试/调试）。
 */
export function getConditionalSkillCount(): number {
  logForDebugging(
    `[Hapii] ------ getConditionalSkillCount 开始/结束 ------ count=${conditionalSkills.size}`,
  )
  return conditionalSkills.size
}

/**
 * 清除动态技能状态（用于测试）。
 */
export function clearDynamicSkills(): void {
  logForDebugging(
    `[Hapii] ------ clearDynamicSkills 开始 ------ dynamicSkillDirs=${dynamicSkillDirs.size} dynamicSkills=${dynamicSkills.size} conditionalSkills=${conditionalSkills.size} activated=${activatedConditionalSkillNames.size}`,
  )
  dynamicSkillDirs.clear()
  dynamicSkills.clear()
  conditionalSkills.clear()
  activatedConditionalSkillNames.clear()
  logForDebugging(
    `[Hapii] ------ clearDynamicSkills 结束 ------ 所有动态技能状态已清除`,
  )
}

// 通过叶子注册表模块向 MCP 技能发现公开 createSkillCommand +
// parseSkillFrontmatterFields。参见 mcpSkillBuilders.ts 了解为什么
// 需要这种间接方式（从 mcpSkills.ts 进行字面量动态导入会将单个边
// 扇出成许多循环违规；变量说明符的动态导入可通过 dep-cruiser 但在
// 运行时无法在 Bun 打包的二进制文件中解析）。
// eslint-disable-next-line custom-rules/no-top-level-side-effects -- 一次性写入注册，幂等
logForDebugging(
  `[Hapii] ------ registerMCPSkillBuilders ------ 注册 createSkillCommand + parseSkillFrontmatterFields`,
)
registerMCPSkillBuilders({
  createSkillCommand,
  parseSkillFrontmatterFields,
})
