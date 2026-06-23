/**
 * 集中式插件目录配置。
 *
 * 本模块提供插件目录路径的单一数据来源。
 * 支持通过以下方式在 'plugins' 和 'cowork_plugins' 目录之间切换：
 * - CLI 标志：--cowork
 * - 环境变量：CLAUDE_CODE_USE_COWORK_PLUGINS
 *
 * 基础目录可通过 CLAUDE_CODE_PLUGIN_CACHE_DIR 覆盖。
 */

import { mkdirSync } from 'fs'
import { readdir, rm, stat } from 'fs/promises'
import { delimiter, join } from 'path'
import { getUseCoworkPlugins } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { errorMessage, isFsInaccessible } from '../errors.js'
import { formatFileSize } from '../format.js'
import { expandTilde } from '../permissions/pathValidation.js'

const PLUGINS_DIR = 'plugins'
const COWORK_PLUGINS_DIR = 'cowork_plugins'

/**
 * 根据当前模式获取插件目录名称。
 * 使用会话状态（来自 --cowork 标志）或环境变量。
 *
 * 优先级：
 * 1. 会话状态（由 CLI 标志 --cowork 设置）
 * 2. 环境变量 CLAUDE_CODE_USE_COWORK_PLUGINS
 * 3. 默认值：'plugins'
 */
function getPluginsDirectoryName(): string {
  // 会话状态优先（由 CLI 标志设置）
  if (getUseCoworkPlugins()) {
    return COWORK_PLUGINS_DIR
  }
  // 回退到环境变量
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)) {
    return COWORK_PLUGINS_DIR
  }
  return PLUGINS_DIR
}

/**
 * 获取插件目录的完整路径。
 *
 * 优先级：
 * 1. CLAUDE_CODE_PLUGIN_CACHE_DIR 环境变量（显式覆盖）
 * 2. 默认值：~/.claude/plugins 或 ~/.claude/cowork_plugins
 */
export function getPluginsDirectory(): string {
  // expandTilde：当 CLAUDE_CODE_PLUGIN_CACHE_DIR 通过 settings.json 的
  // `env`（非 shell）设置时，~ 不会被 shell 展开。若不这样做，类似
  // "~/.claude/plugins" 的值会在每个项目的 cwd 中创建一个字面的 `~` 目录
  //（gh-30794 / CC-212）。
  const envOverride = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  if (envOverride) {
    return expandTilde(envOverride)
  }
  return join(getClaudeConfigHomeDir(), getPluginsDirectoryName())
}

/**
 * 获取只读插件种子目录（若已配置）。
 *
 * 客户可以将已填充的插件目录预烘焙到其容器镜像中，
 * 并将 CLAUDE_CODE_PLUGIN_SEED_DIR 指向它。CC 会将其用作主插件目录下的
 * 只读回退层 —— 种子中找到的 marketplace 和插件缓存会原地使用，无需重新克隆。
 *
 * 多个种子目录可使用平台路径分隔符（Unix 上为 ':'，Windows 上为 ';'）
 * 以类似 PATH 的优先级顺序分层 —— 包含给定 marketplace 或插件缓存的第一个种子胜出。
 *
 * 种子结构镜像主插件目录：
 *   $CLAUDE_CODE_PLUGIN_SEED_DIR/
 *     known_marketplaces.json
 *     marketplaces/<name>/...
 *     cache/<marketplace>/<plugin>/<version>/...
 *
 * @returns 按优先级顺序排列的种子目录绝对路径（未设置时为空）
 */
export function getPluginSeedDirs(): string[] {
  // 与 getPluginsDirectory 相同的波浪号展开理由（gh-30794）。
  const raw = process.env.CLAUDE_CODE_PLUGIN_SEED_DIR
  if (!raw) return []
  return raw.split(delimiter).filter(Boolean).map(expandTilde)
}

function sanitizePluginId(pluginId: string): string {
  // 与安装缓存清理器（pluginLoader.ts）相同的字符类
  return pluginId.replace(/[^a-zA-Z0-9\-_]/g, '-')
}

/** 纯路径 —— 不执行 mkdir。用于显示（例如卸载对话框）。 */
export function pluginDataDirPath(pluginId: string): string {
  return join(getPluginsDirectory(), 'data', sanitizePluginId(pluginId))
}

/**
 * 每个插件的持久化数据目录，作为 ${CLAUDE_PLUGIN_DATA} 暴露给插件。
 * 与版本作用域的安装缓存（${CLAUDE_PLUGIN_ROOT}，每次更新时会被孤立并 GC）
 * 不同，此目录在插件更新后仍保留 —— 仅在最后一个作用域卸载时移除。
 *
 * 调用时创建目录（mkdir）。*惰性*行为在 substitutePluginVariables
 * 调用点 —— DATA 模式使用函数形式的 .replace()，因此除非存在
 * ${CLAUDE_PLUGIN_DATA}，否则不会调用此函数（ROOT 也使用函数形式，
 * 但是为了 $ 模式安全性，而非惰性）。
 * 环境变量导出点（MCP/LSP 服务器环境、hook 环境）急切调用此函数，
 * 因为子进程可能期望目录在写入前已存在。
 *
 * 同步是因为它从 substitutePluginVariables（同步，在 String.replace 内部）
 * 调用 —— 将此函数改为异步会级联影响 6 个调用点及其同步迭代循环。
 * 插件加载路径中的一个 mkdir 开销很小。
 */
export function getPluginDataDir(pluginId: string): string {
  const dir = pluginDataDirPath(pluginId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 卸载确认提示中数据目录的大小。当目录不存在或为空时返回 null，
 * 以便调用者可以完全跳过提示。
 * 递归遍历 —— 非热路径（仅在卸载时）。
 */
export async function getPluginDataDirSize(
  pluginId: string,
): Promise<{ bytes: number; human: string } | null> {
  const dir = pluginDataDirPath(pluginId)
  let bytes = 0
  const walk = async (p: string) => {
    for (const entry of await readdir(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else {
        // 每个条目的捕获：损坏的符号链接会使 stat() 抛出 ENOENT。
        // 若不处理，一个损坏的链接会冒泡到外部 catch →
        // 返回 null → 跳过对话框 → 数据被静默删除。
        try {
          bytes += (await stat(full)).size
        } catch {
          // 损坏的符号链接 / 竞争删除 —— 跳过此条目，继续遍历
        }
      }
    }
  }
  try {
    await walk(dir)
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
  if (bytes === 0) return null
  return { bytes, human: formatFileSize(bytes) }
}

/**
 * 在最后一个作用域卸载时尽力清理。失败会被记录但不抛出 ——
 * 卸载本身已经成功；我们不希望清理副作用显示为"卸载失败"。
 * 与 deletePluginOptions（pluginOptionsStorage.ts）相同的理由。
 */
export async function deletePluginDataDir(pluginId: string): Promise<void> {
  const dir = pluginDataDirPath(pluginId)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    logForDebugging(
      `Failed to delete plugin data dir ${dir}: ${errorMessage(e)}`,
      { level: 'warn' },
    )
  }
}
