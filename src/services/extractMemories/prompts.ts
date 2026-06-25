/**
 * 后台记忆提取 agent 使用的 prompt 模板。
 *
 * 提取 agent 以主对话的完美 fork 方式运行——相同的 system prompt，相同的消息前缀。
 * 主 agent 的 system prompt 始终包含完整的保存指令；当主 agent 自己写入 memory 时，
 * extractMemories.ts 会跳过该轮（hasMemoryWritesSince）。
 * 本 prompt 仅在主 agent 未写入时触发，因此此处的保存标准与 system prompt 的重叠是无害的。
 */

import { feature } from 'bun:bundle'
import {
  MEMORY_FRONTMATTER_EXAMPLE,
  TYPES_SECTION_COMBINED,
  TYPES_SECTION_INDIVIDUAL,
  WHAT_NOT_TO_SAVE_SECTION,
} from '../../memdir/memoryTypes.js'
import { BASH_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@claude-code-best/builtin-tools/tools/GrepTool/prompt.js'

/**
 * 两种 extract-prompt 变体共用的开场白。
 */
function opener(newMessageCount: number, existingMemories: string): string {
  const manifest =
    existingMemories.length > 0
      ? `\n\n## 已有的 memory 文件\n\n${existingMemories}\n\n写入前请先检查此列表——优先更新已有文件，而非创建重复文件。`
      : ''
  return [
    `你现在作为 memory 提取 subagent 运行。分析上方最近 ~${newMessageCount} 条消息，并用它们更新你的持久化 memory 系统。`,
    '',
    `可用 tools：${FILE_READ_TOOL_NAME}、${GREP_TOOL_NAME}、${GLOB_TOOL_NAME}、只读 ${BASH_TOOL_NAME}（ls/find/cat/stat/wc/head/tail 等），以及仅限 memory 目录路径的 ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME}。${BASH_TOOL_NAME} rm 不被允许。其他所有 tools——MCP、Agent、具有写入能力的 ${BASH_TOOL_NAME} 等——均会被拒绝。`,
    '',
    `你的 turn 预算有限。${FILE_EDIT_TOOL_NAME} 需要先对同一文件执行 ${FILE_READ_TOOL_NAME}，因此高效策略是：第 1 轮——对所有可能更新的文件并行发出所有 ${FILE_READ_TOOL_NAME} 调用；第 2 轮——并行发出所有 ${FILE_WRITE_TOOL_NAME}/${FILE_EDIT_TOOL_NAME} 调用。不要在多个 turn 中交错执行读写操作。`,
    '',
    `你只能使用最近 ~${newMessageCount} 条消息中的内容来更新持久化 memory。不要浪费任何 turn 去进一步调查或验证这些内容——不要 grep 源文件、不要读取代码来确认某个模式是否存在、不要执行 git 命令。` +
      manifest,
  ].join('\n')
}

/**
 * 构建仅限个人 memory（无 team memory）的提取 prompt。
 * 四类分类体系，无 scope 引导（单一目录）。
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  const howToSave = skipIndex
    ? [
        '## 如何保存 memory',
        '',
        '将每条 memory 写入独立文件（如 `user_role.md`、`feedback_testing.md`），使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 按主题语义组织 memory，而非按时间顺序',
        '- 更新或删除已证明错误或过时的 memory',
        '- 不要写重复的 memory。写新 memory 前先检查是否已有可以更新的文件。',
      ]
    : [
        '## 如何保存 memory',
        '',
        '保存 memory 是一个两步流程：',
        '',
        '**第 1 步** — 将 memory 写入独立文件（如 `user_role.md`、`feedback_testing.md`），使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**第 2 步** — 在 `MEMORY.md` 中添加指向该文件的指针。`MEMORY.md` 是索引，而非 memory 本身——每条记录应为一行，不超过约 150 个字符：`- [Title](file.md) — one-line hook`。它没有 frontmatter。永远不要将 memory 内容直接写入 `MEMORY.md`。',
        '',
        '- `MEMORY.md` 始终被加载到你的 system prompt 中——超过 200 行的内容会被截断，因此保持索引简洁',
        '- 按主题语义组织 memory，而非按时间顺序',
        '- 更新或删除已证明错误或过时的 memory',
        '- 不要写重复的 memory。写新 memory 前先检查是否已有可以更新的文件。',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    '如果用户明确要求你记住某事，立即将其保存为最合适的类型。如果他们要求你忘记某事，找到并删除相关条目。',
    '',
    ...TYPES_SECTION_INDIVIDUAL,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '',
    ...howToSave,
  ].join('\n')
}

/**
 * 构建个人 + team memory 合并的提取 prompt。
 * 四类分类体系，每个类型带有 <scope> 引导（目录选择已内嵌到各类型块中，
 * 无需单独的路由章节）。
 */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  if (!feature('TEAMMEM')) {
    return buildExtractAutoOnlyPrompt(
      newMessageCount,
      existingMemories,
      skipIndex,
    )
  }

  const howToSave = skipIndex
    ? [
        '## 如何保存 memory',
        '',
        '将每条 memory 写入所选目录（private 或 team，依据该类型的 scope 引导）中的独立文件，使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 按主题语义组织 memory，而非按时间顺序',
        '- 更新或删除已证明错误或过时的 memory',
        '- 不要写重复的 memory。写新 memory 前先检查是否已有可以更新的文件。',
      ]
    : [
        '## 如何保存 memory',
        '',
        '保存 memory 是一个两步流程：',
        '',
        '**第 1 步** — 将 memory 写入所选目录（private 或 team，依据该类型的 scope 引导）中的独立文件，使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '**第 2 步** — 在同一目录的 `MEMORY.md` 中添加指向该文件的指针。每个目录（private 和 team）各有其独立的 `MEMORY.md` 索引——每条记录应为一行，不超过约 150 个字符：`- [Title](file.md) — one-line hook`。它们没有 frontmatter。永远不要将 memory 内容直接写入 `MEMORY.md`。',
        '',
        '- 两个 `MEMORY.md` 索引都会被加载到你的 system prompt 中——超过 200 行的内容会被截断，因此保持它们简洁',
        '- 按主题语义组织 memory，而非按时间顺序',
        '- 更新或删除已证明错误或过时的 memory',
        '- 不要写重复的 memory。写新 memory 前先检查是否已有可以更新的文件。',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    '如果用户明确要求你记住某事，立即将其保存为最合适的类型。如果他们要求你忘记某事，找到并删除相关条目。',
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- 你必须避免在共享的 team memory 中保存敏感数据。例如，永远不要保存 API keys 或用户凭证（credentials）。',
    '',
    ...howToSave,
  ].join('\n')
}
