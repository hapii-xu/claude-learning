import { fileURLToPath } from 'url'
import * as path from 'path'

/**
 * 根据当前模块位置解析 dist 根目录。
 *
 * 兼容所有构建产物布局：
 * - 单文件：dist/cli.js → dist/
 * - 代码分割：dist/chunks/chunk-xxx.js → dist/
 * - Dev 模式：src/utils/distRoot.ts → <project_root>/
 */
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const distRoot = (() => {
  const parts = __dirname.split(path.sep)
  const distIdx = parts.lastIndexOf('dist')
  if (distIdx !== -1) {
    return parts.slice(0, distIdx + 1).join(path.sep)
  }
  // Dev 模式：从 src/utils/ 推算到项目根目录
  const srcIdx = parts.lastIndexOf('src')
  if (srcIdx !== -1) {
    return parts.slice(0, srcIdx).join(path.sep)
  }
  return __dirname
})()

export { distRoot }
