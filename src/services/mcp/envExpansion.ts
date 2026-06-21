/**
 * 在 MCP 服务端配置中展开环境变量的共享工具函数
 */

/**
 * 展开字符串值中的环境变量
 * 支持 ${VAR} 和 ${VAR:-default} 语法
 * @returns 包含展开后字符串和缺失变量列表的对象
 */
export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
    // 按 :- 分割以支持默认值（限制为 2 部分，以保留默认值中的 :-）
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = process.env[varName]

    if (envValue !== undefined) {
      return envValue
    }
    if (defaultValue !== undefined) {
      return defaultValue
    }

    // 追踪缺失变量，用于错误报告
    missingVars.push(varName)
    // 未找到时返回原始值（便于调试，但会作为错误报告）
    return match
  })

  return {
    expanded,
    missingVars,
  }
}
