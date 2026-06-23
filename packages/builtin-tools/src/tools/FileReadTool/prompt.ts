import { isPDFSupported } from 'src/utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// 使用字符串常量表示工具名以避免循环依赖
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  '文件自上次读取以来未变化。本对话中较早前的 Read tool_result 内容仍然有效 —— 请参考它而不是重新读取。'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = '从本地文件系统读取文件。'

export const LINE_FORMAT_INSTRUCTION = '- 结果以 cat -n 格式返回，行号从 1 开始'

export const OFFSET_INSTRUCTION_DEFAULT =
  '- 你可以选择性地指定行 offset 和 limit（对长文件尤其方便），但建议不提供这些参数以读取整个文件'

export const OFFSET_INSTRUCTION_TARGETED =
  '- 当你已经知道需要文件的哪一部分时，只读取那一部分即可。这对较大的文件很重要。'

/**
 * 渲染 Read 工具的 prompt 模板。调用方（FileReadTool）提供运行时计算的部分。
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `从本地文件系统读取文件。你可以直接使用本工具访问任意文件。
假设本工具能够读取机器上的所有文件。如果用户提供了文件路径，则假定该路径有效。读取不存在的文件也没关系，会返回错误。

用法：
- file_path 参数必须是绝对路径，不能是相对路径
- 默认从文件开头最多读取 ${MAX_LINES_TO_READ} 行${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- 本工具支持 Claude Code 读取图片（如 PNG、JPG 等）。读取图片文件时，内容会以视觉方式呈现，因为 Claude Code 是多模态 LLM。${
    isPDFSupported()
      ? '\n- 本工具可以读取 PDF 文件（.pdf）。对于超过 10 页的大 PDF，必须提供 pages 参数来读取特定页面范围（例如 pages: "1-5"）。不提供 pages 参数读取大 PDF 将会失败。每次请求最多 20 页。'
      : ''
  }
- 本工具可以读取 Jupyter notebook（.ipynb 文件），并返回所有单元格及其输出，整合代码、文本和可视化内容。
- 本工具只能读取文件，不能读取目录。要列出目录内容，请通过 ${BASH_TOOL_NAME} 工具执行 ls 命令。
- 你会经常被要求读取截图。如果用户提供了截图路径，请务必使用本工具查看该路径下的文件。本工具可处理所有临时文件路径。
- 如果读取的文件存在但内容为空，你会收到一条系统提醒警告来代替文件内容。`
}
