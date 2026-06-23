import { feature } from 'bun:bundle'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import { getAutoMemPath, isAutoMemoryEnabled } from './paths.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('./teamMemPaths.js') as typeof import('./teamMemPaths.js'))
  : null

import { getKairosActive, getOriginalCwd } from '../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'
import { isReplModeEnabled } from '@claude-code-best/builtin-tools/tools/REPLTool/constants.js'
import { logForDebugging } from '../utils/debug.js'
import { hasEmbeddedSearchTools } from '../utils/embeddedTools.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { formatFileSize } from '../utils/format.js'
import { getProjectDir } from '../utils/sessionStorage.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
  WHEN_TO_ACCESS_SECTION,
} from './memoryTypes.js'

export const ENTRYPOINT_NAME = 'MEMORY.md'
export const MAX_ENTRYPOINT_LINES = 200
// 200 行时约 125 字符/行。目前在 p97；捕获滑过行上限的长行索引
// （p100 观察到：200 行下 197KB）。
export const MAX_ENTRYPOINT_BYTES = 25_000
const AUTO_MEM_DISPLAY_NAME = 'auto memory'

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

/**
 * 将 MEMORY.md 内容截断到行和字节上限，附加说明哪个上限触发的警告。
 * 先按行截断（自然边界），然后在上限前的最后一个换行符处按字节截断，
 * 这样不会在行中间切断。
 *
 * 由 buildMemoryPrompt 和 claudemd getMemoryFiles 共享（之前
 * 重复了仅行的逻辑）。
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = trimmed.length

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  // 检查原始字节数 —— 长行是字节上限目标故障模式，所以行截断后的大小
  // 会低估警告。
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  if (truncated.length > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES)
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES)
  }

  const reason =
    wasByteTruncated && !wasLineTruncated
      ? `${formatFileSize(byteCount)}（上限：${formatFileSize(MAX_ENTRYPOINT_BYTES)}）——索引条目过长`
      : wasLineTruncated && !wasByteTruncated
        ? `${lineCount} 行（上限：${MAX_ENTRYPOINT_LINES}）`
        : `${lineCount} 行且 ${formatFileSize(byteCount)}`

  return {
    content:
      truncated +
      `\n\n> 警告：${ENTRYPOINT_NAME} 超出限制（${reason}），仅加载了部分内容。请将索引条目保持在一行约 200 字符以内；详细内容请移至主题文件。`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPrompts = feature('TEAMMEM')
  ? (require('./teamMemPrompts.js') as typeof import('./teamMemPrompts.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 附加到每个记忆目录提示行的共享指导文本。
 * 添加此内容是因为 Claude 在写入前会消耗回合在 `ls`/`mkdir -p` 上。
 * 控制逻辑通过 ensureMemoryDirExists() 保证目录存在。
 */
export const DIR_EXISTS_GUIDANCE =
  '此目录已存在——请直接使用 Write 工具写入（无需运行 mkdir 或检查目录是否存在）。'
export const DIRS_EXIST_GUIDANCE =
  '两个目录均已存在——请直接使用 Write 工具写入（无需运行 mkdir 或检查目录是否存在）。'

/**
 * 确保记忆目录存在。幂等 - 由 loadMemoryPrompt 调用（通过
 * systemPromptSection 缓存每会话一次），这样模型总是可以直接写入
 * 而无需先检查存在性。FsOperations.mkdir 默认递归且已吞并 EEXIST，
 * 所以完整的父链（~/.claude/projects/<slug>/memory/）在一次调用中
 * 创建，正常路径无需 try/catch。
 */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
  const fs = getFsImplementation()
  try {
    await fs.mkdir(memoryDir)
  } catch (e) {
    // fs.mkdir 已在内部处理 EEXIST。到达这里的是真正的问题
    // （EACCES/EPERM/EROFS）- 记录日志以便 --debug 显示原因。
    // 提示构建无论如何都会继续；模型的 Write 会显示真正的权限
    // 错误（且 FileWriteTool 会自己对父级执行 mkdir）。
    const code =
      e instanceof Error && 'code' in e && typeof e.code === 'string'
        ? e.code
        : undefined
    logForDebugging(
      `ensureMemoryDirExists failed for ${memoryDir}: ${code ?? String(e)}`,
      { level: 'debug' },
    )
  }
}

/**
 * 异步记录记忆目录文件/子目录计数。
 * 即发即忘 - 不阻塞提示构建。
 */
function logMemoryDirCounts(
  memoryDir: string,
  baseMetadata: Record<
    string,
    | number
    | boolean
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  >,
): void {
  const fs = getFsImplementation()
  void fs.readdir(memoryDir).then(
    dirents => {
      let fileCount = 0
      let subdirCount = 0
      for (const d of dirents) {
        if (d.isFile()) {
          fileCount++
        } else if (d.isDirectory()) {
          subdirCount++
        }
      }
      logEvent('tengu_memdir_loaded', {
        ...baseMetadata,
        total_file_count: fileCount,
        total_subdir_count: subdirCount,
      })
    },
    () => {
      // 目录不可读 —— 记录不带计数的日志
      logEvent('tengu_memdir_loaded', baseMetadata)
    },
  )
}

/**
 * 构建类型化记忆行为指令（不包含 MEMORY.md 内容）。将记忆限制在封闭的
 * 四种类型分类法（user / feedback / project / reference）—— 可从当前项目
 * 状态派生的内容（代码模式、架构、git 历史）被明确排除。
 *
 * 仅个人变体：无 `## Memory scope` 部分，类型块中无 <scope> 标签，
 * 示例中去除团队/私有限定符。
 *
 * 由 buildMemoryPrompt（代理记忆，包含内容）和 loadMemoryPrompt
 * （系统提示，内容通过用户上下文注入）共同使用。
 */
export function buildMemoryLines(
  displayName: string,
  memoryDir: string,
  extraGuidelines?: string[],
  skipIndex = false,
): string[] {
  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '将每条记忆写入独立文件（如 `user_role.md`、`feedback_testing.md`），使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 保持记忆文件中 name、description、type 字段与内容同步更新',
        '- 按主题语义组织记忆，而非按时间顺序',
        '- 更新或删除已过时或错误的记忆',
        '- 不要写重复的记忆。写新记忆前先检查是否有可更新的已有记忆。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存记忆分为两步：',
        '',
        '**步骤一** — 将记忆写入独立文件（如 `user_role.md`、`feedback_testing.md`），使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**步骤二** — 在 \`${ENTRYPOINT_NAME}\` 中添加指向该文件的指针。\`${ENTRYPOINT_NAME}\` 是索引而非记忆——每条记录应为单行、约 150 字符以内：\`- [标题](file.md) — 一行摘要\`。无需 frontmatter。切勿将记忆内容直接写入 \`${ENTRYPOINT_NAME}\`。`,
        '',
        `- \`${ENTRYPOINT_NAME}\` 始终加载到对话上下文中——超过 ${MAX_ENTRYPOINT_LINES} 行的内容将被截断，请保持索引简洁`,
        '- 保持记忆文件中 name、description、type 字段与内容同步更新',
        '- 按主题语义组织记忆，而非按时间顺序',
        '- 更新或删除已过时或错误的记忆',
        '- 不要写重复的记忆。写新记忆前先检查是否有可更新的已有记忆。',
      ]

  const lines: string[] = [
    `# ${displayName}`,
    '',
    `你拥有一个持久化的基于文件的记忆系统，路径为 \`${memoryDir}\`。${DIR_EXISTS_GUIDANCE}`,
    '',
    '你应随时间积累此记忆系统，以便未来的对话能够完整了解用户是谁、他们希望如何与你协作、哪些行为应避免或重复，以及用户交给你的工作背后的背景。',
    '',
    '如果用户明确要求你记住某事，请立即将其保存为最合适的类型。如果他们要求你忘记某事，请找到并删除相关条目。',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
    '',
    ...WHEN_TO_ACCESS_SECTION,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## 记忆与其他持久化方式',
    '记忆是你在某次对话中协助用户时可用的多种持久化机制之一。两者的关键区别在于：记忆可在未来的对话中调取，而不应用于存储仅在当前对话范围内有用的信息。',
    '- 何时使用或更新计划而非记忆：如果你即将开始一项非trivial的实现任务并希望与用户就方案达成共识，应使用计划而非将其保存为记忆。同样，如果对话中已有计划且你改变了方案，应通过更新计划来持久化变更，而非保存为记忆。',
    '- 何时使用或更新任务而非记忆：当你需要将当前对话中的工作拆分为离散步骤或跟踪进度时，应使用任务而非保存为记忆。任务非常适合持久化当前对话中需完成的工作信息，但记忆应留给在未来对话中有用的信息。',
    '',
    ...(extraGuidelines ?? []),
    '',
  ]

  lines.push(...buildSearchingPastContextSection(memoryDir))

  return lines
}

/**
 * 构建包含 MEMORY.md 内容的类型化记忆提示。
 * 供代理记忆使用（没有等效的 getClaudeMds()）。
 */
export function buildMemoryPrompt(params: {
  displayName: string
  memoryDir: string
  extraGuidelines?: string[]
}): string {
  const { displayName, memoryDir, extraGuidelines } = params
  const fs = getFsImplementation()
  const entrypoint = memoryDir + ENTRYPOINT_NAME

  // 目录创建是调用者的责任（loadMemoryPrompt / loadAgentMemoryPrompt）。
  // 构建器只读取，不 mkdir。

  // 读取现有记忆入口（同步：提示构建是同步的）
  let entrypointContent = ''
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    entrypointContent = fs.readFileSync(entrypoint, { encoding: 'utf-8' })
  } catch {
    // 尚无记忆文件
  }

  const lines = buildMemoryLines(displayName, memoryDir, extraGuidelines)

  if (entrypointContent.trim()) {
    const t = truncateEntrypointContent(entrypointContent)
    const memoryType = displayName === AUTO_MEM_DISPLAY_NAME ? 'auto' : 'agent'
    logMemoryDirCounts(memoryDir, {
      content_length: t.byteCount,
      line_count: t.lineCount,
      was_truncated: t.wasLineTruncated,
      was_byte_truncated: t.wasByteTruncated,
      memory_type:
        memoryType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    lines.push(`## ${ENTRYPOINT_NAME}`, '', t.content)
  } else {
    lines.push(
      `## ${ENTRYPOINT_NAME}`,
      '',
      `当前 ${ENTRYPOINT_NAME} 为空。保存新记忆后，它们将显示在此处。`,
    )
  }

  return lines.join('\n')
}

/**
 * 助手模式每日日志提示。在 feature('KAIROS') 门控之后。
 *
 * 助手会话实际上是永久的，所以代理将记忆仅追加写入以日期命名的日志文件，
 * 而不是维护 MEMORY.md 作为实时索引。单独的 nightly /dream 技能将日志提炼
 * 为主题文件 + MEMORY.md。MEMORY.md 仍然加载到上下文中（通过 claudemd.ts）
 * 作为提炼的索引 —— 此提示只改变新记忆的去向。
 */
function buildAssistantDailyLogPrompt(skipIndex = false): string {
  const memoryDir = getAutoMemPath()
  // 将路径描述为模式而非内联今天的字面路径：此提示由
  // systemPromptSection('memory', ...) 缓存，不在日期更改时失效。
  // 模型从 date_change 附件（在午夜翻转时追加到尾部）派生当前日期，
  // 而非用户上下文消息 —— 后者故意保持陈旧以在午夜保留提示缓存前缀。
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  const lines: string[] = [
    '# auto memory',
    '',
    `你拥有一个持久化的基于文件的记忆系统，路径为：\`${memoryDir}\``,
    '',
    '本会话为长期会话。工作过程中，请通过**追加**写入今日日志文件来记录值得保存的内容：',
    '',
    `\`${logPathPattern}\``,
    '',
    '将 `YYYY-MM-DD` 替换为今天的日期（来自上下文中的 `currentDate`）。若会话跨越午夜，请开始追加写入新日期的文件。',
    '',
    '每条记录写成带时间戳的简短要点。首次写入时若文件（及父目录）不存在，请创建。不要重写或重组日志——它是仅追加的。单独的夜间流程会将这些日志提炼为 `MEMORY.md` 和主题文件。',
    '',
    '## 记录什么',
    '- 用户的更正和偏好（"用 bun，不用 npm"；"不要总结 diff"）',
    '- 关于用户、其角色或目标的事实',
    '- 无法从代码派生的项目背景（截止日期、事故、决策及其理由）',
    '- 外部系统的指针（仪表盘、Linear 项目、Slack 频道）',
    '- 用户明确要求你记住的任何内容',
    '',
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...(skipIndex
      ? []
      : [
          `## ${ENTRYPOINT_NAME}`,
          `\`${ENTRYPOINT_NAME}\` 是经提炼的索引（每晚由日志维护），会自动加载到你的上下文中。可读取以了解概况，但不要直接编辑——请将新信息记录到今日日志中。`,
          '',
        ]),
    ...buildSearchingPastContextSection(memoryDir),
  ]

  return lines.join('\n')
}

/**
 * 构建"搜索过去上下文"部分（如果功能门控已启用）。
 */
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_coral_fern', false)) {
    return []
  }
  const projectDir = getProjectDir(getOriginalCwd())
  // Ant-native 构建将 grep 别名为内嵌 ugrep 并移除专用
  // Grep 工具，所以在那里给模型一个真实的 shell 调用。
  // 在 REPL 模式下，Grep 和 Bash 都隐藏不直接使用 ——
  // 模型从 REPL 脚本内部调用它们，所以 grep shell 形式
  // 就是它在脚本中写入的内容。
  const embedded = hasEmbeddedSearchTools() || isReplModeEnabled()
  const memSearch = embedded
    ? `grep -rn "<搜索词>" ${autoMemDir} --include="*.md"`
    : `${GREP_TOOL_NAME} with pattern="<搜索词>" path="${autoMemDir}" glob="*.md"`
  const transcriptSearch = embedded
    ? `grep -rn "<搜索词>" ${projectDir}/ --include="*.jsonl"`
    : `${GREP_TOOL_NAME} with pattern="<搜索词>" path="${projectDir}/" glob="*.jsonl"`
  return [
    '## 搜索过去上下文',
    '',
    '查找过去上下文时：',
    '1. 在记忆目录的主题文件中搜索：',
    '```',
    memSearch,
    '```',
    '2. 会话记录日志（最后手段——文件较大，速度较慢）：',
    '```',
    transcriptSearch,
    '```',
    '使用精确的搜索词（错误信息、文件路径、函数名），而非宽泛的关键词。',
    '',
  ]
}

/**
 * 加载统一内存提示以包含在系统提示中。
 * 根据启用的内存系统进行调度：
 *   - 自动 + 团队：组合提示（两个目录）
 *   - 仅自动：内存行（单个目录）
 * 团队内存需要自动内存（由 isTeamMemoryEnabled 强制），
 * 所以没有仅团队的分支。
 *
 * 当自动内存禁用时返回 null。
 */
export async function loadMemoryPrompt(): Promise<string | null> {
  logForDebugging('[Hapii] Memdir.loadMemoryPrompt 开始加载记忆提示', {
    level: 'info',
  })
  const autoEnabled = isAutoMemoryEnabled()

  const skipIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )

  // KAIROS 每日日志模式优先于 TEAMMEM：仅追加
  // 日志范式不与团队同步组合（团队同步期望共享的
  // MEMORY.md 供双方读写）。在此处门控 `autoEnabled`
  // 意味着 !autoEnabled 的情况会落入下方的
  // tengu_memdir_disabled 遥测块，与非 KAIROS 路径匹配。
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    logMemoryDirCounts(getAutoMemPath(), {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return buildAssistantDailyLogPrompt(skipIndex)
  }

  // Cowork 通过环境变量注入内存策略文本；线程化到所有构建器。
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  const extraGuidelines =
    coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
      ? [coworkExtraGuidelines]
      : undefined

  if (feature('TEAMMEM')) {
    if (teamMemPaths!.isTeamMemoryEnabled()) {
      const autoDir = getAutoMemPath()
      const teamDir = teamMemPaths!.getTeamMemPath()
      // 框架保证这些目录存在，以便模型可以写入而无需检查。
      // 提示文本反映了这一点（"已经存在"）。
      // 只创建 teamDir 就足够了：getTeamMemPath() 定义为
      // join(getAutoMemPath(), 'team')，所以 teamDir 的递归 mkdir
      // 会附带创建 autoDir。如果 team dir 从 auto dir 下移出，
      // 在此处为 autoDir 添加第二个 ensureMemoryDirExists 调用。
      await ensureMemoryDirExists(teamDir)
      logMemoryDirCounts(autoDir, {
        memory_type:
          'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logMemoryDirCounts(teamDir, {
        memory_type:
          'team' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return teamMemPrompts!.buildCombinedMemoryPrompt(
        extraGuidelines,
        skipIndex,
      )
    }
  }

  if (autoEnabled) {
    const autoDir = getAutoMemPath()
    // 框架保证目录存在，以便模型可以写入而无需检查。
    // 提示文本反映了这一点（"已经存在"）。
    await ensureMemoryDirExists(autoDir)
    logMemoryDirCounts(autoDir, {
      memory_type:
        'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const result = buildMemoryLines(
      'auto memory',
      autoDir,
      extraGuidelines,
      skipIndex,
    ).join('\n')
    logForDebugging(
      `[Hapii] Memdir.loadMemoryPrompt 完成 mode=auto dir=${autoDir} chars=${result.length}`,
      { level: 'info' },
    )
    return result
  }

  logEvent('tengu_memdir_disabled', {
    disabled_by_env_var: isEnvTruthy(
      process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    ),
    disabled_by_setting:
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) &&
      getInitialSettings().autoMemoryEnabled === false,
  })
  // 直接在 GB 标志上门控，而不是 isTeamMemoryEnabled() ——
  // 该函数首先检查 isAutoMemoryEnabled()，在此分支中定义上为 false。
  // 我们想要的是"此用户是否曾参加过团队内存队列"。
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_herring_clock', false)) {
    logEvent('tengu_team_memdir_disabled', {})
  }
  logForDebugging(
    '[Hapii] Memdir.loadMemoryPrompt autoMemory 未启用，返回 null',
    { level: 'info' },
  )
  return null
}
