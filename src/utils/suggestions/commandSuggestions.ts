import Fuse from 'fuse.js'
import {
  type Command,
  formatDescriptionWithSource,
  getCommand,
  getCommandName,
} from '../../commands.js'
import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import { getSkillUsageScore } from './skillUsageTracking.js'

// 将这些字符视为命令搜索时的单词分隔符
const SEPARATORS = /[:_-]/g

type CommandSearchItem = {
  descriptionKey: string[]
  partKey: string[] | undefined
  commandName: string
  command: Command
  aliasKey: string[] | undefined
}

// 以 commands 数组的身份为键缓存 Fuse 索引。commands
// 数组是稳定的（在 REPL.tsx 中做了 memoize），所以我们只在它变化时
// 重建索引，而不是每次按键都重建。
let fuseCache: {
  commands: Command[]
  fuse: Fuse<CommandSearchItem>
} | null = null

function getCommandFuse(commands: Command[]): Fuse<CommandSearchItem> {
  if (fuseCache?.commands === commands) {
    return fuseCache.fuse
  }

  const commandData: CommandSearchItem[] = commands
    .filter(cmd => !cmd.isHidden)
    .map(cmd => {
      const commandName = getCommandName(cmd)
      const parts = commandName.split(SEPARATORS).filter(Boolean)

      return {
        descriptionKey: (cmd.description ?? '')
          .split(' ')
          .map(word => cleanWord(word))
          .filter(Boolean),
        partKey: parts.length > 1 ? parts : undefined,
        commandName,
        command: cmd,
        aliasKey: cmd.aliases,
      }
    })

  const fuse = new Fuse(commandData, {
    includeScore: true,
    threshold: 0.3, // 相对严格的匹配
    location: 0, // 优先匹配字符串开头的部分
    distance: 100, // 增大以允许在描述中匹配
    keys: [
      {
        name: 'commandName',
        weight: 3, // 命令名称优先级最高
      },
      {
        name: 'partKey',
        weight: 2, // 命令片段优先级次高
      },
      {
        name: 'aliasKey',
        weight: 2, // 别名同样享有高优先级
      },
      {
        name: 'descriptionKey',
        weight: 0.5, // 描述优先级较低
      },
    ],
  })

  fuseCache = { commands, fuse }
  return fuse
}

/**
 * 类型守卫：检查 suggestion 的 metadata 是否为 Command。
 * Command 具有 name 字符串属性和 type 属性。
 */
function isCommandMetadata(metadata: unknown): metadata is Command {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'name' in metadata &&
    typeof (metadata as { name: unknown }).name === 'string' &&
    'type' in metadata
  )
}

/**
 * 表示在输入中间（非开头）发现的斜杠命令
 */
export type MidInputSlashCommand = {
  token: string // 例如 "/com"
  startPos: number // "/" 的位置
  partialCommand: string // 例如 "com"
}

/**
 * 在输入中间（非位置 0）查找斜杠命令 token。
 * 中间输入的斜杠命令是指前面有空白字符的 "/"，且光标
 * 位于 "/" 处或之后。
 *
 * @param input 完整的输入字符串
 * @param cursorOffset 当前光标位置
 * @returns 中间输入的斜杠命令信息，未找到则返回 null
 */
export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  // 如果输入以 "/" 开头，属于开头输入的情况（在其他地方处理）
  if (input.startsWith('/')) {
    return null
  }

  // 从光标位置向前查找，找到前面有空白字符的 "/"
  const beforeCursor = input.slice(0, cursorOffset)

  // 找到光标前文本中最后一个 "/"
  // 匹配模式：空白字符后跟 "/" 再跟可选的字母数字/横杠字符。
  // 避免使用 (?<=\s) 后行断言——它会破坏 JSC 中的 YARR JIT，即使
  // 有 $ 锚点，解释器也会以 O(n) 扫描。改为捕获空白字符
  // 并将 match.index 偏移 1。
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/)
  if (!match || match.index === undefined) {
    return null
  }

  // 获取完整 token（可能延伸到光标之后）
  const slashPos = match.index + 1
  const textAfterSlash = input.slice(slashPos + 1)

  // 提取命令部分（直到空白字符或末尾）
  const commandMatch = textAfterSlash.match(/^[a-zA-Z0-9_:-]*/)
  const fullCommand = commandMatch ? commandMatch[0] : ''

  // 如果光标已过命令末尾（在空格之后），不显示 ghost 文本
  if (cursorOffset > slashPos + 1 + fullCommand.length) {
    return null
  }

  return {
    token: '/' + fullCommand,
    startPos: slashPos,
    partialCommand: fullCommand,
  }
}

/**
 * 为部分命令字符串查找最佳匹配命令。
 * 委托给 generateCommandSuggestions 并过滤出前缀匹配。
 *
 * @param partialCommand 用户输入的部分命令（不含 "/"）
 * @param commands 可用命令列表
 * @returns 补全后缀（例如部分输入 "com" 匹配 "commit" 时返回 "mit"），无匹配则返回 null
 */
export function getBestCommandMatch(
  partialCommand: string,
  commands: Command[],
): { suffix: string; fullCommand: string } | null {
  if (!partialCommand) {
    return null
  }

  // 使用已有的建议逻辑
  const suggestions = generateCommandSuggestions('/' + partialCommand, commands)
  if (suggestions.length === 0) {
    return null
  }

  // 查找第一个前缀匹配的 suggestion（用于内联补全）
  const query = partialCommand.toLowerCase()
  for (const suggestion of suggestions) {
    if (!isCommandMetadata(suggestion.metadata)) {
      continue
    }
    const name = getCommandName(suggestion.metadata)
    if (name.toLowerCase().startsWith(query)) {
      const suffix = name.slice(partialCommand.length)
      // 只在有内容可补全时返回
      if (suffix) {
        return { suffix, fullCommand: name }
      }
    }
  }

  return null
}

/**
 * 检查输入是否为命令（以斜杠开头）
 */
export function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}

/**
 * 检查命令输入是否带有参数
 * 只有尾随空格的命令视为没有参数
 */
export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false

  if (!input.includes(' ')) return false

  if (input.endsWith(' ')) return false

  return true
}

/**
 * 以标准格式格式化命令
 */
export function formatCommand(command: string): string {
  return `/${command} `
}

/**
 * 为命令 suggestion 生成确定性的唯一 ID。
 * 来自不同源的同名命令会获得唯一 ID。
 *
 * 只有 prompt 命令可能重复（来自用户设置、项目
 * 设置、插件等）。内置命令（local、local-jsx）在代码中
 * 只定义一次，不会重复。
 */
function getCommandId(cmd: Command): string {
  const commandName = getCommandName(cmd)
  if (cmd.type === 'prompt') {
    // 对于插件命令，包含仓库信息以消除歧义
    if (cmd.source === 'plugin' && cmd.pluginInfo?.repository) {
      return `${commandName}:${cmd.source}:${cmd.pluginInfo.repository}`
    }
    return `${commandName}:${cmd.source}`
  }
  // 内置命令包含 type 作为向后兼容的备用方案
  return `${commandName}:${cmd.type}`
}

/**
 * 检查查询是否匹配命令的任何别名。
 * 找到则返回匹配的别名，否则返回 undefined。
 */
function findMatchedAlias(
  query: string,
  aliases?: string[],
): string | undefined {
  if (!aliases || aliases.length === 0 || query === '') {
    return undefined
  }
  // 检查查询是否是任何别名的前缀（不区分大小写）
  return aliases.find(alias => alias.toLowerCase().startsWith(query))
}

/**
 * 从命令创建 suggestion 项。
 * 只有当用户输入了别名时才在括号中显示匹配的别名。
 */
function createCommandSuggestionItem(
  cmd: Command,
  matchedAlias?: string,
): SuggestionItem {
  const commandName = getCommandName(cmd)
  // 只在用户输入了别名时才显示
  const aliasText = matchedAlias ? ` (${matchedAlias})` : ''

  const isWorkflow = cmd.type === 'prompt' && cmd.kind === 'workflow'

  // 为项目级 prompt 命令显示 "local" 标签
  const scopeTag =
    cmd.type === 'prompt' &&
    !isWorkflow &&
    (cmd.source === 'projectSettings' || cmd.source === 'localSettings')
      ? 'local'
      : undefined

  const fullDescription =
    (isWorkflow ? cmd.description : formatDescriptionWithSource(cmd)) +
    (cmd.type === 'prompt' && cmd.argNames?.length
      ? ` (arguments: ${cmd.argNames.join(', ')})`
      : '')

  return {
    id: getCommandId(cmd),
    displayText: `/${commandName}${aliasText}`,
    tag: isWorkflow ? 'workflow' : scopeTag,
    description: fullDescription,
    metadata: cmd,
  }
}

/**
 * 根据输入生成命令建议
 */
export function generateCommandSuggestions(
  input: string,
  commands: Command[],
): SuggestionItem[] {
  // 只处理命令输入
  if (!isCommandInput(input)) {
    return []
  }

  // 如果有参数，不显示建议
  if (hasCommandArgs(input)) {
    return []
  }

  const query = input.slice(1).toLowerCase().trim()

  // 当只输入 '/' 没有额外文本时
  if (query === '') {
    const visibleCommands = commands.filter(cmd => !cmd.isHidden)

    // 查找最近使用的技能（只有 prompt 命令有使用记录跟踪）
    const recentlyUsed: Command[] = []
    const commandsWithScores = visibleCommands
      .filter(cmd => cmd.type === 'prompt')
      .map(cmd => ({
        cmd,
        score: getSkillUsageScore(getCommandName(cmd)),
      }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)

    // 取前 5 个最近使用的技能
    for (const item of commandsWithScores.slice(0, 5)) {
      recentlyUsed.push(item.cmd)
    }

    // 创建最近使用命令 ID 集合以避免重复
    const recentlyUsedIds = new Set(recentlyUsed.map(cmd => getCommandId(cmd)))

    // 对剩余命令进行分类（排除最近使用的）
    const builtinCommands: Command[] = []
    const userCommands: Command[] = []
    const projectCommands: Command[] = []
    const policyCommands: Command[] = []
    const otherCommands: Command[] = []

    visibleCommands.forEach(cmd => {
      // 如果已在最近使用中则跳过
      if (recentlyUsedIds.has(getCommandId(cmd))) {
        return
      }

      if (cmd.type === 'local' || cmd.type === 'local-jsx') {
        builtinCommands.push(cmd)
      } else if (
        cmd.type === 'prompt' &&
        (cmd.source === 'userSettings' || cmd.source === 'localSettings')
      ) {
        userCommands.push(cmd)
      } else if (cmd.type === 'prompt' && cmd.source === 'projectSettings') {
        projectCommands.push(cmd)
      } else if (cmd.type === 'prompt' && cmd.source === 'policySettings') {
        policyCommands.push(cmd)
      } else {
        otherCommands.push(cmd)
      }
    })

    // 对每个分类按字母顺序排序
    const sortAlphabetically = (a: Command, b: Command) =>
      getCommandName(a).localeCompare(getCommandName(b))

    builtinCommands.sort(sortAlphabetically)
    userCommands.sort(sortAlphabetically)
    projectCommands.sort(sortAlphabetically)
    policyCommands.sort(sortAlphabetically)
    otherCommands.sort(sortAlphabetically)

    // 合并结果，内置命令排在最近使用的之后，
    // 这样即使安装了很多技能，它们仍然可见
    return [
      ...recentlyUsed,
      ...builtinCommands,
      ...userCommands,
      ...projectCommands,
      ...policyCommands,
      ...otherCommands,
    ].map(cmd => createCommandSuggestionItem(cmd))
  }

  // Fuse 索引在构建时过滤了 isHidden，并以（memoized 的）commands 数组
  // 身份为键，因此在 Fuse 首次构建时被隐藏的命令在整个会话期间对 Fuse
  // 保持不可见。如果用户输入了当前隐藏命令的精确名称，将其放在
  // Fuse 结果前面，这样精确名称匹配总是胜过弱描述的模糊
  // 匹配——但仅当没有可见命令共享该名称时（那将是
  // 用户的显式覆盖，应当优先）。前置而非
  // 提前返回，这样可见的前缀兄弟命令（如 /voice-memo）仍然出现在
  // 下方，getBestCommandMatch 也能找到非空后缀。
  let hiddenExact = commands.find(
    cmd => cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
  )
  if (
    hiddenExact &&
    commands.some(
      cmd => !cmd.isHidden && getCommandName(cmd).toLowerCase() === query,
    )
  ) {
    hiddenExact = undefined
  }

  const fuse = getCommandFuse(commands)
  const searchResults = fuse.search(query)

  // 排序结果：精确/前缀命令名匹配优先于模糊描述匹配
  // 优先级顺序：
  // 1. 精确名称匹配（最高）
  // 2. 精确别名匹配
  // 3. 前缀名称匹配
  // 4. 前缀别名匹配
  // 5. 模糊匹配（最低）
  // 预先计算每项的值，避免在比较器中 O(n log n) 重复计算
  const withMeta = searchResults.map(r => {
    const name = r.item.commandName.toLowerCase()
    const aliases = r.item.aliasKey?.map(alias => alias.toLowerCase()) ?? []
    const usage =
      r.item.command.type === 'prompt'
        ? getSkillUsageScore(getCommandName(r.item.command))
        : 0
    return { r, name, aliases, usage }
  })

  const sortedResults = withMeta.sort((a, b) => {
    const aName = a.name
    const bName = b.name
    const aAliases = a.aliases
    const bAliases = b.aliases

    // 检查精确名称匹配（最高优先级）
    const aExactName = aName === query
    const bExactName = bName === query
    if (aExactName && !bExactName) return -1
    if (bExactName && !aExactName) return 1

    // 检查精确别名匹配
    const aExactAlias = aAliases.some(alias => alias === query)
    const bExactAlias = bAliases.some(alias => alias === query)
    if (aExactAlias && !bExactAlias) return -1
    if (bExactAlias && !aExactAlias) return 1

    // 检查前缀名称匹配
    const aPrefixName = aName.startsWith(query)
    const bPrefixName = bName.startsWith(query)
    if (aPrefixName && !bPrefixName) return -1
    if (bPrefixName && !aPrefixName) return 1
    // 在前缀名称匹配中，优先选择更短的名称（更接近精确匹配）
    if (aPrefixName && bPrefixName && aName.length !== bName.length) {
      return aName.length - bName.length
    }

    // 检查前缀别名匹配
    const aPrefixAlias = aAliases.find(alias => alias.startsWith(query))
    const bPrefixAlias = bAliases.find(alias => alias.startsWith(query))
    if (aPrefixAlias && !bPrefixAlias) return -1
    if (bPrefixAlias && !aPrefixAlias) return 1
    // 在前缀别名匹配中，优先选择更短的别名
    if (
      aPrefixAlias &&
      bPrefixAlias &&
      aPrefixAlias.length !== bPrefixAlias.length
    ) {
      return aPrefixAlias.length - bPrefixAlias.length
    }

    // 对于相似的匹配类型，使用 Fuse 分数，以使用频率作为决胜局
    const scoreDiff = (a.r.score ?? 0) - (b.r.score ?? 0)
    if (Math.abs(scoreDiff) > 0.1) {
      return scoreDiff
    }
    // 对于相似的 Fuse 分数，优先选择使用频率更高的技能
    return b.usage - a.usage
  })

  // 将搜索结果映射为 suggestion 项
  // 注意：我们有意不在此处去重，因为来自不同源（如 projectSettings
  // 与 userSettings）的同名命令可能有不同的实现，
  // 两者都应该对用户可用
  const fuseSuggestions = sortedResults.map(result => {
    const cmd = result.r.item.command
    // 只在用户输入了别名时才在括号中显示
    const matchedAlias = findMatchedAlias(query, cmd.aliases)
    return createCommandSuggestionItem(cmd, matchedAlias)
  })
  // 如果 hiddenExact 已在 fuseSuggestions 中则跳过前置——这
  // 发生在 isHidden 在会话中从 false 变为 true 时（OAuth 过期、
  // GrowthBook  kill-switch），过时的 Fuse 索引仍持有该
  // 命令。Fuse 已经将精确名称匹配排在最前，所以不需要
  // 重新排序；我们只是不想要重复的 id（重复的 React key，
  // 两行都渲染为选中状态）。
  if (hiddenExact) {
    const hiddenId = getCommandId(hiddenExact)
    if (!fuseSuggestions.some(s => s.id === hiddenId)) {
      return [createCommandSuggestionItem(hiddenExact), ...fuseSuggestions]
    }
  }
  return fuseSuggestions
}

/**
 * 将选中的命令应用到输入
 */
export function applyCommandSuggestion(
  suggestion: string | SuggestionItem,
  shouldExecute: boolean,
  commands: Command[],
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void,
): void {
  // 从字符串或 SuggestionItem metadata 中提取命令名称和对象
  let commandName: string
  let commandObj: Command | undefined
  if (typeof suggestion === 'string') {
    commandName = suggestion
    commandObj = shouldExecute ? getCommand(commandName, commands) : undefined
  } else {
    if (!isCommandMetadata(suggestion.metadata)) {
      return // 无效的 suggestion，无可应用的内容
    }
    commandName = getCommandName(suggestion.metadata)
    commandObj = suggestion.metadata
  }

  // 格式化命令输入，添加尾随空格
  const newInput = formatCommand(commandName)
  onInputChange(newInput)
  setCursorOffset(newInput.length)

  // 如果请求执行且命令不需要参数，则执行
  if (shouldExecute && commandObj) {
    if (
      commandObj.type !== 'prompt' ||
      (commandObj.argNames ?? []).length === 0
    ) {
      onSubmit(newInput, /* isSubmittingSlashCommand */ true)
    }
  }
}

// 按照 CLAUDE.md 规范将辅助函数放在文件底部
function cleanWord(word: string) {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 查找文本中所有 /command 模式的位置用于高亮。
 * 返回 {start, end} 位置数组。
 * 要求斜杠前有空白字符或位于字符串开头，以避免
 * 匹配路径如 /usr/bin。
 */
export function findSlashCommandPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  // 匹配前面有空白字符或位于字符串开头的 /command 模式
  const regex = /(^|[\s])(\/[a-zA-Z][a-zA-Z0-9:\-_]*)/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const precedingChar = match[1] ?? ''
    const commandName = match[2] ?? ''
    // 起始位置在空白字符之后（如果有）
    const start = match.index + precedingChar.length
    positions.push({ start, end: start + commandName.length })
  }
  return positions
}
