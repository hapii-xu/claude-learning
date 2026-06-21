import { isEnvTruthy } from './envUtils.js'

/**
 * 此构建是否将 bfs/ugrep 嵌入到 bun 二进制中（仅限 ant-native）。
 *
 * 为 true 时：
 * - Claude Bash shell 中的 `find` 和 `grep` 会被 shell 函数遮蔽，
 *   这些函数以 argv0='bfs' / argv0='ugrep' 调用 bun 二进制
 *  （与嵌入式 ripgrep 使用相同技巧）
 * - 专用的 Glob/Grep 工具会从工具注册表中移除
 * - 引导 Claude 远离 find/grep 的提示指导会被省略
 *
 * 在 scripts/build-with-plugins.ts 中作为构建时 define 设置，
 * 仅用于 ant-native 构建。
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * 包含嵌入式搜索工具的 bun 二进制路径。
 * 仅在 hasEmbeddedSearchTools() 为 true 时有意义。
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
