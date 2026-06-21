/**
 * 在 Commander.js 处理参数之前提前解析 CLI 标志值。
 * 支持空格分隔（--flag value）和等号分隔（--flag=value）两种语法。
 *
 * 此函数用于必须在 init() 运行前解析的标志，例如影响配置加载的 --settings。
 * 常规标志解析请依赖 Commander.js，它会自动处理。
 *
 * @param flagName 包含破折号的标志名（如 '--settings'）
 * @param argv 可选的 argv 数组（默认使用 process.argv）
 * @returns 找到则返回值，否则返回 undefined
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // 处理 --flag=value 语法
    if (arg?.startsWith(`${flagName}=`)) {
      return arg.slice(flagName.length + 1)
    }
    // 处理 --flag value 语法
    if (arg === flagName && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return undefined
}

/**
 * 处理 CLI 参数中标准的 Unix `--` 分隔符约定。
 *
 * 使用 Commander.js 的 `.passThroughOptions()` 时，`--` 分隔符
 * 会作为位置参数传递而非被消耗。
 * 这意味着当用户运行：
 *   `cmd --opt value name -- subcmd --flag arg`
 *
 * Commander 解析为：
 *   positional1 = "name", positional2 = "--", rest = ["subcmd", "--flag", "arg"]
 *
 * 此函数通过从 rest 数组中提取实际命令来纠正解析，
 * 当位置参数为 `--` 时生效。
 *
 * @param commandOrValue - 可能是 "--" 的已解析位置参数
 * @param args - 剩余参数数组
 * @returns 包含纠正后命令和参数的对象
 */
export function extractArgsAfterDoubleDash(
  commandOrValue: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (commandOrValue === '--' && args.length > 0) {
    return {
      command: args[0]!,
      args: args.slice(1),
    }
  }
  return { command: commandOrValue, args }
}
