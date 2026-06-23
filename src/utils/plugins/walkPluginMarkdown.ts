import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'

const SKILL_MD_RE = /^skill\.md$/i

/**
 * 递归遍历插件目录，对每个 .md 文件调用 onFile。
 *
 * namespace 数组追踪相对根目录的子目录路径
 * （如 root/foo/bar/file.md 对应 ['foo', 'bar']）。不需要
 * 命名空间的调用者可以忽略第二个参数。
 *
 * 当 stopAtSkillDir 为 true 且目录包含 SKILL.md 时，onFile 会
 * 对该目录中所有 .md 文件调用，但不扫描子目录
 * — skill 目录是叶容器。
 *
 * Readdir 错误被吞掉并记录调试日志，以免一个坏目录
 * 中止插件加载。
 */
export async function walkPluginMarkdown(
  rootDir: string,
  onFile: (fullPath: string, namespace: string[]) => Promise<void>,
  opts: { stopAtSkillDir?: boolean; logLabel?: string } = {},
): Promise<void> {
  const fs = getFsImplementation()
  const label = opts.logLabel ?? 'plugin'

  async function scan(dirPath: string, namespace: string[]): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath)

      if (
        opts.stopAtSkillDir &&
        entries.some(e => e.isFile() && SKILL_MD_RE.test(e.name))
      ) {
        // Skill 目录：收集此处的 .md 文件，不递归。
        await Promise.all(
          entries.map(entry =>
            entry.isFile() && entry.name.toLowerCase().endsWith('.md')
              ? onFile(join(dirPath, entry.name), namespace)
              : undefined,
          ),
        )
        return
      }

      await Promise.all(
        entries.map(entry => {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory()) {
            return scan(fullPath, [...namespace, entry.name])
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            return onFile(fullPath, namespace)
          }
          return undefined
        }),
      )
    } catch (error) {
      logForDebugging(
        `Failed to scan ${label} directory ${dirPath}: ${error}`,
        { level: 'error' },
      )
    }
  }

  await scan(rootDir, [])
}
