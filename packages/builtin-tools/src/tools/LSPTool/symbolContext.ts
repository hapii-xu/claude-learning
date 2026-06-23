import { logForDebugging } from 'src/utils/debug.js'
import { truncate } from 'src/utils/format.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { expandPath } from 'src/utils/path.js'

const MAX_READ_BYTES = 64 * 1024

/**
 * 提取文件中特定位置的符号/单词。
 * 用于在工具使用消息中展示上下文。
 *
 * @param filePath - 文件路径（绝对或相对）
 * @param line - 从 0 开始的行号
 * @param character - 行内从 0 开始的字符位置
 *
 * 注意：此处使用同步文件 I/O，因为它从 renderToolUseMessage（同步 React
 * 渲染函数）调用。读取包裹在 try/catch 中，使 ENOENT 等错误能优雅回退。
 * @returns 该位置的符号，若提取失败则返回 null
 */
export function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
): string | null {
  try {
    const fs = getFsImplementation()
    const absolutePath = expandPath(filePath)

    // 只读取前 64KB 而非整个文件。大多数 LSP hover/goto 目标都靠近最近
    // 编辑位置；64KB 约覆盖 ~1000 行典型代码。
    // 如果目标行超出此窗口，则回退为 null（UI 已经通过显示
    // `position: line:char` 处理该情况）。
    // eslint-disable-next-line custom-rules/no-sync-fs -- 从同步 React 渲染（renderToolUseMessage）调用
    const { buffer, bytesRead } = fs.readSync(absolutePath, {
      length: MAX_READ_BYTES,
    })
    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split('\n')

    if (line < 0 || line >= lines.length) {
      return null
    }
    // 如果填满了整个缓冲区，说明文件在我们窗口之外还有内容，
    // 因此最后一个切分元素可能被截断在行中间。
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) {
      return null
    }

    const lineContent = lines[line]
    if (!lineContent || character < 0 || character >= lineContent.length) {
      return null
    }

    // 提取该字符位置处的单词/符号
    // 模式匹配：
    // - 标准标识符：字母数字 + 下划线 + 美元符
    // - Rust 生命周期：'a、'static
    // - Rust 宏：macro_name!
    // - 运算符和特殊符号：+、-、* 等
    // 这里更宽松，以适配各种编程语言
    const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g
    let match: RegExpExecArray | null

    while ((match = symbolPattern.exec(lineContent)) !== null) {
      const start = match.index
      const end = start + match[0].length

      // 检查字符位置是否落在此匹配范围内
      if (character >= start && character < end) {
        const symbol = match[0]
        // 限制长度为 30 个字符，避免符号过长
        return truncate(symbol, 30)
      }
    }

    return null
  } catch (error) {
    // 记录意外错误以供调试（权限问题、编码问题等）
    // 使用 logForDebugging，因为这只是展示增强，不是关键错误
    if (error instanceof Error) {
      logForDebugging(
        `符号提取失败 ${filePath}:${line}:${character}: ${error.message}`,
        { level: 'warn' },
      )
    }
    // 仍返回 null 以优雅回退到位置展示
    return null
  }
}
