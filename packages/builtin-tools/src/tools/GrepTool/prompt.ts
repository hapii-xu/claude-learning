import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `基于 ripgrep 的强大搜索工具

  用法：
  - 搜索任务请始终使用 ${GREP_TOOL_NAME}。绝不可以通过 ${BASH_TOOL_NAME} 命令调用 \`grep\` 或 \`rg\`。${GREP_TOOL_NAME} 工具已针对正确的权限和访问做了优化。
  - 支持完整正则语法（如 "log.*Error"、"function\\s+\\w+"）
  - 使用 glob 参数（如 "*.js"、"**/*.tsx"）或 type 参数（如 "js"、"py"、"rust"）过滤文件
  - 输出模式："content" 显示匹配行，"files_with_matches" 只显示文件路径（默认），"count" 显示匹配数
  - 对于需要多轮的开放式搜索，请使用 ${AGENT_TOOL_NAME} 工具
  - 模式语法：使用 ripgrep（而非 grep）—— 字面花括号需要转义（用 \`interface\\{\\}\` 在 Go 代码中查找 \`interface{}\`）
  - 多行匹配：默认情况下模式仅匹配单行。对于跨行模式（如 \`struct \\{[\\s\\S]*?field\`），请使用 \`multiline: true\`
`
}
