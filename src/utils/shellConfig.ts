/**
 * Shell 配置文件（如 .bashrc、.zshrc）管理工具
 * 用于管理 claude 别名和 PATH 条目
 */

import { open, readFile, stat } from 'fs/promises'
import { homedir as osHomedir } from 'os'
import { join } from 'path'
import { isFsInaccessible } from './errors.js'
import { getLocalClaudePath } from './localInstaller.js'

export const CLAUDE_ALIAS_REGEX = /^\s*alias\s+claude\s*=/

type EnvLike = Record<string, string | undefined>

type ShellConfigOptions = {
  env?: EnvLike
  homedir?: string
}

/**
 * 获取 shell 配置文件的路径
 * 尊重 zsh 用户的 ZDOTDIR 设置
 * @param options 可选的测试覆盖（env、homedir）
 */
export function getShellConfigPaths(
  options?: ShellConfigOptions,
): Record<string, string> {
  const home = options?.homedir ?? osHomedir()
  const env = options?.env ?? process.env
  const zshConfigDir = env.ZDOTDIR || home
  return {
    zsh: join(zshConfigDir, '.zshrc'),
    bash: join(home, '.bashrc'),
    fish: join(home, '.config/fish/config.fish'),
  }
}

/**
 * 从行数组中过滤安装器创建的 claude 别名
 * 仅移除指向 $HOME/.claude/local/claude 的别名
 * 保留指向其他位置的自定义用户别名
 * 返回过滤后的行以及是否找到默认安装器别名
 */
export function filterClaudeAliases(lines: string[]): {
  filtered: string[]
  hadAlias: boolean
} {
  let hadAlias = false
  const filtered = lines.filter(line => {
    // 检查是否为 claude 别名
    if (CLAUDE_ALIAS_REGEX.test(line)) {
      // 提取别名目标 - 处理空格、引号和各种格式
      // 首先尝试带引号的格式
      let match = line.match(/alias\s+claude\s*=\s*["']([^"']+)["']/)
      if (!match) {
        // 尝试不带引号（捕获直到行尾或注释）
        match = line.match(/alias\s+claude\s*=\s*([^#\n]+)/)
      }

      if (match && match[1]) {
        const target = match[1].trim()
        // 仅当指向安装器位置时移除
        // 安装器始终创建带完整展开路径的别名
        if (target === getLocalClaudePath()) {
          hadAlias = true
          return false // 移除此行
        }
      }
      // 保留不指向安装器位置的自定义别名
    }
    return true
  })
  return { filtered, hadAlias }
}

/**
 * 读取文件并按行拆分
 * 文件不存在或无法读取时返回 null
 */
export async function readFileLines(
  filePath: string,
): Promise<string[] | null> {
  try {
    const content = await readFile(filePath, { encoding: 'utf8' })
    return content.split('\n')
  } catch (e: unknown) {
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * 将行写回文件
 */
export async function writeFileLines(
  filePath: string,
  lines: string[],
): Promise<void> {
  const fh = await open(filePath, 'w')
  try {
    await fh.writeFile(lines.join('\n'), { encoding: 'utf8' })
    await fh.datasync()
  } finally {
    await fh.close()
  }
}

/**
 * 检查任何 shell 配置文件中是否存在 claude 别名
 * 找到时返回别名目标，否则返回 null
 * @param options 可选的测试覆盖（env、homedir）
 */
export async function findClaudeAlias(
  options?: ShellConfigOptions,
): Promise<string | null> {
  const configs = getShellConfigPaths(options)

  for (const configPath of Object.values(configs)) {
    const lines = await readFileLines(configPath)
    if (!lines) continue

    for (const line of lines) {
      if (CLAUDE_ALIAS_REGEX.test(line)) {
        // 提取别名目标
        const match = line.match(/alias\s+claude=["']?([^"'\s]+)/)
        if (match && match[1]) {
          return match[1]
        }
      }
    }
  }

  return null
}

/**
 * 检查 claude 别名是否存在且指向有效的可执行文件
 * 有效时返回别名目标，否则返回 null
 * @param options 可选的测试覆盖（env、homedir）
 */
export async function findValidClaudeAlias(
  options?: ShellConfigOptions,
): Promise<string | null> {
  const aliasTarget = await findClaudeAlias(options)
  if (!aliasTarget) return null

  const home = options?.homedir ?? osHomedir()

  // 将 ~ 展开为主目录
  const expandedPath = aliasTarget.startsWith('~')
    ? aliasTarget.replace('~', home)
    : aliasTarget

  // 检查目标是否存在且可执行
  try {
    const stats = await stat(expandedPath)
    // 检查是否为文件（可能是可执行文件或符号链接）
    if (stats.isFile() || stats.isSymbolicLink()) {
      return aliasTarget
    }
  } catch {
    // 目标不存在或无法访问
  }

  return null
}
