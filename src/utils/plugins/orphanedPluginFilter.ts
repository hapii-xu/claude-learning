/**
 * 为孤立插件版本提供 ripgrep glob 排除模式。
 *
 * 当插件版本更新时，旧版本以 `.orphaned_at` 文件标记，
 * 但在磁盘上保留 7 天（因为并发会话可能仍在引用它们）。
 * 在此窗口期间，Grep/Glob 可能返回孤立版本的文件，
 * 导致 Claude 使用过时的插件代码。
 *
 * 我们通过单次 ripgrep 调用查找 `.orphaned_at` 标记，
 * 并为其父目录生成 `--glob '!<dir>/**'` 模式。
 * 缓存在 main.tsx 中 cleanupOrphanedPluginVersionsInBackground
 * 稳定磁盘状态后预热。一旦填充，排除列表在会话中冻结，
 * 除非调用 /reload-plugins；后续磁盘变更（自动更新、并发会话）不影响它。
 */

import { dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import { ripGrep } from '../ripgrep.js'
import { getPluginsDirectory } from './pluginDirectories.js'

// 从 cacheUtils.ts 内联，以避免通过 commands.js 的循环依赖。
const ORPHANED_AT_FILENAME = '.orphaned_at'

/** 会话级缓存。计算后冻结 —— 仅通过显式 /reload-plugins 清除。 */
let cachedExclusions: string[] | null = null

/**
 * 获取孤立插件版本的 ripgrep glob 排除模式。
 *
 * @param searchPath - 若提供，仅当搜索与插件缓存目录重叠时才返回排除项
 *   （避免为缓存外的搜索添加不必要的 --glob 参数）。
 *
 * 在 main.tsx 中孤立版本 GC 后预热；此处的延迟计算路径是回退。
 * 尽力而为：若出现任何错误则返回空数组。
 */
export async function getGlobExclusionsForPluginCache(
  searchPath?: string,
): Promise<string[]> {
  const cachePath = normalize(join(getPluginsDirectory(), 'cache'))

  if (searchPath && !pathsOverlap(searchPath, cachePath)) {
    return []
  }

  if (cachedExclusions !== null) {
    return cachedExclusions
  }

  try {
    // 在插件缓存目录中查找所有 .orphaned_at 文件。
    // --hidden：标记是点文件。--no-ignore：不让流浪的 .gitignore 隐藏它。
    // --max-depth 4：标记始终位于
    // cache/<marketplace>/<plugin>/<version>/.orphaned_at —— 不递归进入
    // 插件内容（node_modules 等）。永不中止信号：无调用者信号到线程。
    const markers = await ripGrep(
      [
        '--files',
        '--hidden',
        '--no-ignore',
        '--max-depth',
        '4',
        '--glob',
        ORPHANED_AT_FILENAME,
      ],
      cachePath,
      new AbortController().signal,
    )

    cachedExclusions = markers.map(markerPath => {
      // ripgrep 可能返回绝对路径或相对路径 —— 规范化为相对路径。
      const versionDir = dirname(markerPath)
      const rel = isAbsolute(versionDir)
        ? relative(cachePath, versionDir)
        : versionDir
      // ripgrep glob 模式始终使用正斜杠，即使在 Windows 上也是如此
      const posixRelative = rel.replace(/\\/g, '/')
      return `!**/${posixRelative}/**`
    })
    return cachedExclusions
  } catch {
    // 尽力而为 —— 若 ripgrep 在此失败，不要破坏核心搜索工具
    cachedExclusions = []
    return cachedExclusions
  }
}

export function clearPluginCacheExclusions(): void {
  cachedExclusions = null
}

/**
 * 一个路径是另一个的前缀。对根目录做特殊处理（normalize('/') + sep = '//'）。
 * 在 win32 上不区分大小写，因为 normalize() 不会将驱动器字母小写，
 * 而 CLAUDE_CODE_PLUGIN_CACHE_DIR 可能与 resolved 不一致。
 */
function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  return (
    na === nb ||
    na === sep ||
    nb === sep ||
    na.startsWith(nb + sep) ||
    nb.startsWith(na + sep)
  )
}

function normalizeForCompare(p: string): string {
  const n = normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}
