/**
 * 用于解释 PowerShell 退出码的命令语义配置。
 *
 * PowerShell 原生 cmdlet 不需要退出码语义：
 *   - Select-String（grep 等价物）无匹配时退出码为 0（返回 $null）
 *   - Compare-Object（diff 等价物）无论结果如何退出码都为 0
 *   - Test-Path 无论结果如何退出码都为 0（通过管道返回布尔值）
 * 原生 cmdlet 通过终止性错误（$?）而非退出码来表示失败。
 *
 * 但是从 PowerShell 调用的外部可执行文件确实会设置 $LASTEXITCODE，
 * 并且许多程序使用非零码传达信息而非失败：
 *   - grep.exe / rg.exe（Git for Windows、scoop 等）：1 = 无匹配
 *   - findstr.exe（Windows 原生）：1 = 无匹配
 *   - robocopy.exe（Windows 原生）：0-7 = 成功，8+ = 错误（臭名昭著！）
 *
 * 如果没有此模块，PowerShellTool 会在任何非零退出码时抛出 ShellError，
 * 因此 `robocopy` 报告"文件已成功复制"（退出码 1）会显示为错误。
 */

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * 默认语义：只有 0 视为成功，其他都视为错误
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message: exitCode !== 0 ? `命令失败，退出码为 ${exitCode}` : undefined,
})

/**
 * grep / ripgrep：0 = 找到匹配，1 = 无匹配，2+ = 错误
 */
const GREP_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode >= 2,
  message: exitCode === 1 ? '未找到匹配' : undefined,
})

/**
 * 针对特定外部可执行文件的命令语义。
 * 键是不带 .exe 后缀的小写命令名。
 *
 * 故意省略：
 *   - 'diff'：含义模糊。Windows PowerShell 5.1 将 `diff` 别名为 Compare-Object
 *     （差异时退出 0），但 PS Core / Git for Windows 可能解析为 diff.exe
 *     （差异时退出 1）。无法可靠解释。
 *   - 'fc'：含义模糊。PowerShell 将 `fc` 别名为 Format-Custom（原生 cmdlet），
 *     但 `fc.exe` 是 Windows 文件比较工具（差异时退出 1）。
 *     与 `diff` 相同的别名问题。
 *   - 'find'：含义模糊。Windows find.exe（文本搜索）与 Unix find.exe
 *     （通过 Git for Windows 的文件搜索）语义不同。
 *   - 'test'、'['：不是 PowerShell 构造。
 *   - 'select-string'、'compare-object'、'test-path'：原生 cmdlet 退出 0。
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // 外部 grep/ripgrep（Git for Windows、scoop、choco）
  ['grep', GREP_SEMANTIC],
  ['rg', GREP_SEMANTIC],

  // findstr.exe：Windows 原生文本搜索
  // 0 = 找到匹配，1 = 无匹配，2 = 错误
  ['findstr', GREP_SEMANTIC],

  // robocopy.exe：Windows 原生稳健文件复制
  // 退出码是位域 — 0-7 为成功，8+ 表示至少一个失败：
  //   0 = 未复制文件，无不匹配，无失败（已同步）
  //   1 = 文件复制成功
  //   2 = 检测到额外文件/目录（无复制）
  //   4 = 检测到不匹配的文件/目录
  //   8 = 部分文件/目录无法复制（复制错误）
  //  16 = 严重错误（robocopy 未复制任何文件）
  // 这是 Windows 上最常见的"CI 失败但实际无问题"陷阱。
  [
    'robocopy',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 8,
      message:
        exitCode === 0
          ? '未复制文件（已同步）'
          : exitCode >= 1 && exitCode < 8
            ? exitCode & 1
              ? '文件复制成功'
              : 'Robocopy 完成（无错误）'
            : undefined,
    }),
  ],
])

/**
 * 从单个管道段中提取命令名。
 * 去掉开头的 `&` / `.` 调用操作符和 `.exe` 后缀，并转为小写。
 */
function extractBaseCommand(segment: string): string {
  // 去掉 PowerShell 调用操作符：& "cmd"、. "cmd"
  //（& 和 . 在段开头后跟空白会调用下一个 token）
  const stripped = segment.trim().replace(/^[&.]\s+/, '')
  const firstToken = stripped.split(/\s+/)[0] || ''
  // 如果命令以 & "grep.exe" 形式调用，去掉外围引号
  const unquoted = firstToken.replace(/^["']|["']$/g, '')
  // 去掉路径：C:\bin\grep.exe → grep.exe，.\rg.exe → rg.exe
  const basename = unquoted.split(/[\\/]/).pop() || unquoted
  // 去掉 .exe 后缀（Windows 不区分大小写）
  return basename.toLowerCase().replace(/\.exe$/, '')
}

/**
 * 从 PowerShell 命令行中提取主命令。
 * 取最后一个管道段，因为它决定了退出码。
 *
 * 按 `;` 和 `|` 启发式分割 — 对带引号的字符串或复杂构造可能判断错误。
 * 不要依赖此函数做安全判断；它仅用于退出码解释
 * （漏报只会回退到默认行为）。
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = command.split(/[;|]/).filter(s => s.trim())
  const last = segments[segments.length - 1] || command
  return extractBaseCommand(last)
}

/**
 * 根据语义规则解释命令结果
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC
  return semantic(exitCode, stdout, stderr)
}
