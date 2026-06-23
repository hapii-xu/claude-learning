/**
 * 如果 bash 命令的首行是 `# 注释`（而非 `#!` shebang），
 * 返回去掉 `#` 前缀后的注释文本；否则返回 undefined。
 *
 * 在全屏模式下，这既是非冗长的 tool-use 标签，
 * 也是折叠组 ⎿ 提示——它是 Claude 写给人类阅读的内容。
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}
