import { isCompactLinePrefixEnabled } from 'src/utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

function getPreReadInstruction(): string {
  return `\n- 在编辑之前，你必须在对话中至少使用过一次 \`${FILE_READ_TOOL_NAME}\` 工具。如果你尝试在未读取文件的情况下进行编辑，此工具会报错。 `
}

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? '行号 + 制表符'
    : '空格 + 行号 + 箭头'
  const minimalUniquenessHint =
    process.env.USER_TYPE === 'ant'
      ? `\n- 使用最小且明显唯一的 old_string — 通常 2-4 行相邻行就足够了。避免在更少的上下文即可唯一标识目标时包含 10+ 行上下文。`
      : ''
  return `在文件中执行精确字符串替换。

用法：${getPreReadInstruction()}
- 从 Read 工具输出中编辑文本时，确保保留行号前缀之后出现的精确缩进（制表符/空格）。行号前缀格式为：${prefixFormat}。之后的所有内容都是要匹配的实际文件内容。永远不要在 old_string 或 new_string 中包含行号前缀的任何部分。
- 始终优先编辑代码库中的现有文件。除非明确要求，否则永远不要编写新文件。
- 仅在用户明确要求时使用 emoji。除非被要求，否则避免向文件添加 emoji。
- 如果 \`old_string\` 在文件中不唯一，编辑将失败。提供更大的字符串以包含更多周围上下文使其唯一，或使用 \`replace_all\` 更改 \`old_string\` 的每个实例。${minimalUniquenessHint}
- 使用 \`replace_all\` 在整个文件中替换和重命名字符串。例如，当你要重命名一个变量时，此参数很有用。`
}
