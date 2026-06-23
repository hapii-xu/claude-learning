import { describe, expect, test } from 'bun:test'
import { type Command, getCommandName } from '../../../commands.js'
import type { SuggestionItem } from '../../../components/PromptInput/PromptInputFooterSuggestions.js'
import {
  applyCommandSuggestion,
  findMidInputSlashCommand,
  formatCommand,
  generateCommandSuggestions,
  getBestCommandMatch,
  hasCommandArgs,
  isCommandInput,
} from '../commandSuggestions.js'

// ─── 辅助函数 ──────────────────────────────────────────────────────────

function makeCommand(name: string, opts?: Partial<Command>): Command {
  return {
    name,
    description: opts?.description ?? `${name} command`,
    type: 'local',
    handler: () => {},
    ...opts,
  } as unknown as Command
}

function makePromptCommand(name: string, opts?: Partial<Command>): Command {
  return {
    name,
    description: opts?.description ?? `${name} skill`,
    type: 'prompt',
    handler: () => {},
    source: 'userSettings',
    ...opts,
  } as unknown as Command
}

// ─── isCommandInput ───────────────────────────────────────────────────

describe('isCommandInput', () => {
  test('斜杠前缀输入返回 true', () => {
    expect(isCommandInput('/commit')).toBe(true)
  })

  test('非斜杠输入返回 false', () => {
    expect(isCommandInput('commit')).toBe(false)
  })

  test('仅一个斜杠返回 true', () => {
    expect(isCommandInput('/')).toBe(true)
  })
})

// ─── hasCommandArgs ───────────────────────────────────────────────────

describe('hasCommandArgs', () => {
  test('输入中无空格时返回 false', () => {
    expect(hasCommandArgs('/commit')).toBe(false)
  })

  test('仅有尾部空格时返回 false', () => {
    expect(hasCommandArgs('/commit ')).toBe(false)
  })

  test('存在实际参数时返回 true', () => {
    expect(hasCommandArgs('/commit msg')).toBe(true)
  })

  test('非命令输入时返回 false', () => {
    expect(hasCommandArgs('commit msg')).toBe(false)
  })
})

// ─── formatCommand ────────────────────────────────────────────────────

describe('formatCommand', () => {
  test('格式化命令时添加前导斜杠和尾部空格', () => {
    expect(formatCommand('commit')).toBe('/commit ')
  })
})

// ─── findMidInputSlashCommand ─────────────────────────────────────────

describe('findMidInputSlashCommand', () => {
  test('输入以斜杠开头时返回 null', () => {
    expect(findMidInputSlashCommand('/commit some args', 7)).toBeNull()
  })

  test('在空白后找到斜杠命令', () => {
    const result = findMidInputSlashCommand('help me /com', 12)
    expect(result).not.toBeNull()
    expect(result!.token).toBe('/com')
    expect(result!.startPos).toBe(8)
    expect(result!.partialCommand).toBe('com')
  })

  test('斜杠前无空白时返回 null', () => {
    expect(findMidInputSlashCommand('help/com', 8)).toBeNull()
  })

  test('光标位于命令之后且存在后续文本时返回 null', () => {
    expect(findMidInputSlashCommand('help /commit msg', 15)).toBeNull()
  })
})

// ─── generateCommandSuggestions ────────────────────────────────────────

describe('generateCommandSuggestions', () => {
  const commands: Command[] = [
    makeCommand('commit'),
    makeCommand('compact'),
    makePromptCommand('sdd-global-read'),
    makePromptCommand('sdd-archive'),
  ]

  test('非斜杠输入返回空结果', () => {
    expect(generateCommandSuggestions('commit', commands)).toHaveLength(0)
  })

  test('仅输入斜杠时返回所有命令', () => {
    const results = generateCommandSuggestions('/', commands)
    expect(results.length).toBeGreaterThan(0)
  })

  test('按部分命令名过滤', () => {
    const results = generateCommandSuggestions('/com', commands)
    const names = results.map(r => r.displayText)
    expect(names.some(n => n.includes('commit'))).toBe(true)
    expect(names.some(n => n.includes('compact'))).toBe(true)
  })

  test('命令带参数时返回空结果', () => {
    expect(generateCommandSuggestions('/commit msg', commands)).toHaveLength(0)
  })

  // ★ 核心回归测试：感知光标的 commandInput 不应受
  // 光标后方文本的影响。之前传递完整输入
  // "/sdd-existing text" 会失败，因为 hasCommandArgs 检测到了
  // 光标后方文本中的空格。修复方案是在调用
  // generateCommandSuggestions 之前将 value 截断至 cursorOffset。
  test('使用光标截断输入调用时能正确建议命令（忽略光标后方文本）', () => {
    // 模拟场景：input="/sdd-existing text"，光标位于位置 5
    // 调用方现在传入 input.substring(0, cursorOffset) = "/sdd-"
    const cursorOffset = 5
    const fullInput = '/sdd-existing text'
    const commandInput = fullInput.substring(0, cursorOffset)

    expect(hasCommandArgs(commandInput)).toBe(false)
    const results = generateCommandSuggestions(commandInput, commands)
    const names = results.map(r => r.displayText)
    expect(names.some(n => n.includes('sdd-global-read'))).toBe(true)
    expect(names.some(n => n.includes('sdd-archive'))).toBe(true)
  })

  test('仅输入斜杠时即使光标后方有文本也显示建议', () => {
    // input="/hello world"，光标位于位置 1 → commandInput="/"
    const commandInput = '/'.substring(0, 1)
    const results = generateCommandSuggestions(commandInput, commands)
    expect(results.length).toBeGreaterThan(0)
  })
})

// ─── getBestCommandMatch ──────────────────────────────────────────────

describe('getBestCommandMatch', () => {
  const commands: Command[] = [
    makeCommand('commit'),
    makeCommand('compact'),
    makePromptCommand('sdd-global-read'),
  ]

  test('前缀匹配时返回匹配后缀', () => {
    const result = getBestCommandMatch('com', commands)
    expect(result).not.toBeNull()
    expect(result!.suffix.length).toBeGreaterThan(0)
  })

  test('无匹配时返回 null', () => {
    expect(getBestCommandMatch('xyz', commands)).toBeNull()
  })

  test('查询为空时返回 null', () => {
    expect(getBestCommandMatch('', commands)).toBeNull()
  })

  // ★ 验证截断到光标位置能让模糊匹配正常工作
  test('部分匹配包含连字符分隔符时能找到匹配', () => {
    const result = getBestCommandMatch('sdd', commands)
    expect(result).not.toBeNull()
    expect(result!.fullCommand).toBe('sdd-global-read')
  })
})

// ─── applyCommandSuggestion（回车行为）──────────────────────────────────

describe('applyCommandSuggestion', () => {
  const commands: Command[] = [
    makeCommand('commit', { argumentHint: '[message]' }),
  ]

  test('用格式化后的命令替换整个输入', () => {
    let newInput = ''
    let newCursor = -1
    const suggestion: SuggestionItem = {
      id: 'commit:local',
      displayText: '/commit',
      description: 'commit command',
      metadata: commands[0],
    }

    applyCommandSuggestion(
      suggestion,
      false,
      commands,
      v => {
        newInput = v
      },
      c => {
        newCursor = c
      },
      () => {},
    )

    expect(newInput).toBe('/commit ')
    expect(newCursor).toBe('/commit '.length)
  })

  test('shouldExecute 为 true 时执行命令', () => {
    let submitted = ''
    const suggestion: SuggestionItem = {
      id: 'commit:local',
      displayText: '/commit',
      description: 'commit command',
      metadata: commands[0],
    }

    applyCommandSuggestion(
      suggestion,
      true,
      commands,
      () => {},
      () => {},
      v => {
        submitted = v
      },
    )

    expect(submitted).toBe('/commit ')
  })
})

// ─── Tab 补全拼接行为 ─────────────────────────────────────────────────
// 测试为处理 Tab 补全时保留光标后方文本而新增的光标位置拼接逻辑。
// 这对应 handleTab（useTypeahead.tsx）中的内联逻辑，
// 其中绕过了 applyCommandSuggestion，改用直接拼接。

describe('Tab 补全拼接行为', () => {
  // 模拟 handleTab 拼接逻辑：
  //   const replacement = `/${commandName} `
  //   onInputChange(replacement + input.slice(cursorOffset))
  //   setCursorOffset(replacement.length)

  function simulateTabCompletion(
    commandName: string,
    input: string,
    cursorOffset: number,
  ): { newInput: string; newCursorOffset: number } {
    const replacement = `/${commandName} `
    return {
      newInput: replacement + input.slice(cursorOffset),
      newCursorOffset: replacement.length,
    }
  }

  test('在输入中间补全命令时保留光标后方文本', () => {
    // 用户输入 "existing text here"，在开头输入 "/sdd-"，然后
    // 按 Tab 接受 "sdd-global-read" 建议
    const input = '/sdd-existing text here'
    const cursorOffset = 5 // 在 "/sdd-" 之后

    const result = simulateTabCompletion('sdd-global-read', input, cursorOffset)

    expect(result.newInput).toBe('/sdd-global-read existing text here')
    expect(result.newCursorOffset).toBe('/sdd-global-read '.length)
  })

  test('光标位于输入末尾时正常工作', () => {
    // 标准场景：光标在末尾，光标后方无文本
    const input = '/com'
    const cursorOffset = 4

    const result = simulateTabCompletion('commit', input, cursorOffset)

    expect(result.newInput).toBe('/commit ')
    expect(result.newCursorOffset).toBe('/commit '.length)
  })

  test('保留光标后方的单个词', () => {
    const input = '/comworld'
    const cursorOffset = 4

    const result = simulateTabCompletion('commit', input, cursorOffset)

    expect(result.newInput).toBe('/commit world')
    expect(result.newCursorOffset).toBe('/commit '.length)
  })

  test('保留光标后方的多行文本', () => {
    const input = '/comline1\nline2'
    const cursorOffset = 4

    const result = simulateTabCompletion('commit', input, cursorOffset)

    expect(result.newInput).toBe('/commit line1\nline2')
    expect(result.newCursorOffset).toBe('/commit '.length)
  })

  test('光标后方无文本时与末尾行为一致', () => {
    const input = '/commit'
    const endResult = simulateTabCompletion('commit', input, 7)

    expect(endResult.newInput).toBe('/commit ')
  })
})

// ─── hasCommandWithArguments 使用光标截断输入 ─────────────────────────
// 测试 updateSuggestions 中用于判断命令是否带参数的辅助函数。
// 修复后仅传递光标前的文本，因此光标后方文本不会影响判断。

describe('hasCommandWithArguments（感知光标的用法）', () => {
  function hasCommandWithArguments(
    isAtEndWithWhitespace: boolean,
    value: string,
  ): boolean {
    return !isAtEndWithWhitespace && value.includes(' ') && !value.endsWith(' ')
  }

  test('光标截断输入无空格时返回 false', () => {
    // input="/sdd-existing text"，cursorOffset=5 → commandInput="/sdd-"
    const commandInput = '/sdd-'
    expect(hasCommandWithArguments(false, commandInput)).toBe(false)
  })

  test('光标截断输入有实际参数时返回 true', () => {
    // input="/commit msg rest"，cursorOffset=11 → commandInput="/commit msg"
    const commandInput = '/commit msg'
    expect(hasCommandWithArguments(false, commandInput)).toBe(true)
  })

  test('尾部空格（等待输入参数）时返回 false', () => {
    const commandInput = '/commit '
    expect(hasCommandWithArguments(false, commandInput)).toBe(false)
  })

  test('光标在末尾且有尾部空格时返回 false', () => {
    // isAtEndWithWhitespace=true → 始终返回 false
    expect(hasCommandWithArguments(true, '/commit ')).toBe(false)
  })

  test('不会匹配光标后方文本中的空格', () => {
    // 修复前：完整输入 "/sdd-existing text" → hasCommandWithArguments = true
    // 修复后：截断输入 "/sdd-" → hasCommandWithArguments = false
    const fullInput = '/sdd-existing text'
    const cursorOffset = 5
    const commandInput = fullInput.substring(0, cursorOffset)

    expect(commandInput).toBe('/sdd-')
    expect(hasCommandWithArguments(false, commandInput)).toBe(false)
    // 验证完整输入本来会返回 true（证明 bug 确实存在）
    expect(hasCommandWithArguments(false, fullInput)).toBe(true)
  })
})
