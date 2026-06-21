import { feature } from 'bun:bundle'

/**
 * 检查对 team memory 路径的文件写入/编辑是否包含密钥。
 * 如果检测到密钥则返回错误消息，安全则返回 null。
 *
 * 此函数由 FileWriteTool 和 FileEditTool 的 validateInput 调用，
 * 用于阻止模型将密钥写入 team memory 文件，
 * 否则这些密钥会被同步给所有仓库协作者。
 *
 * 调用方可以无条件导入并调用此函数 —— 内部的
 * feature('TEAMMEM') 守卫会在构建标志关闭时保持其惰性。
 * secretScanner 会在运行时组装敏感前缀（ANT_KEY_PFX）。
 */
export function checkTeamMemSecrets(
  filePath: string,
  content: string,
): string | null {
  if (feature('TEAMMEM')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isTeamMemPath } =
      require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js')
    const { scanForSecrets } =
      require('./secretScanner.js') as typeof import('./secretScanner.js')
    /* eslint-enable @typescript-eslint/no-require-imports */

    if (!isTeamMemPath(filePath)) {
      return null
    }

    const matches = scanForSecrets(content)
    if (matches.length === 0) {
      return null
    }

    const labels = matches.map(m => m.label).join(', ')
    return (
      `Content contains potential secrets (${labels}) and cannot be written to team memory. ` +
      'Team memory is shared with all repository collaborators. ' +
      'Remove the sensitive content and try again.'
    )
  }
  return null
}
