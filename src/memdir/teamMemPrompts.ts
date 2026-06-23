import {
  buildSearchingPastContextSection,
  DIRS_EXIST_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from './memdir.js'
import {
  MEMORY_DRIFT_CAVEAT,
  MEMORY_FRONTMATTER_EXAMPLE,
  TRUSTING_RECALL_SECTION,
  TYPES_SECTION_COMBINED,
  WHAT_NOT_TO_SAVE_SECTION,
} from './memoryTypes.js'
import { getAutoMemPath } from './paths.js'
import { getTeamMemPath } from './teamMemPaths.js'

/**
 * 当自动记忆和团队记忆同时启用时构建组合提示。
 * 封闭的四类分类法（user / feedback / project / reference），
 * 每类的 <scope> 指导嵌入在 XML 风格的 <type> 块中。
 */
export function buildCombinedMemoryPrompt(
  extraGuidelines?: string[],
  skipIndex = false,
): string {
  const autoDir = getAutoMemPath()
  const teamDir = getTeamMemPath()

  const howToSave = skipIndex
    ? [
        '## 如何保存记忆',
        '',
        '将每条记忆写入所选目录（私有或团队，按类型的范围指导）的独立文件，使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        '- 保持记忆文件中 name、description、type 字段与内容同步更新',
        '- 按主题语义组织记忆，而非按时间顺序',
        '- 更新或删除已过时或错误的记忆',
        '- 不要写重复的记忆。写新记忆前先检查是否有可更新的已有记忆。',
      ]
    : [
        '## 如何保存记忆',
        '',
        '保存记忆分为两步：',
        '',
        '**步骤一** — 将记忆写入所选目录（私有或团队，按类型的范围指导）的独立文件，使用以下 frontmatter 格式：',
        '',
        ...MEMORY_FRONTMATTER_EXAMPLE,
        '',
        `**步骤二** — 在同一目录的 \`${ENTRYPOINT_NAME}\` 中添加指向该文件的指针。每个目录（私有和团队）都有各自的 \`${ENTRYPOINT_NAME}\` 索引——每条记录应为单行、约 150 字符以内：\`- [标题](file.md) — 一行摘要\`。无需 frontmatter。切勿将记忆内容直接写入 \`${ENTRYPOINT_NAME}\`。`,
        '',
        `- 两个 \`${ENTRYPOINT_NAME}\` 索引均会加载到对话上下文中——超过 ${MAX_ENTRYPOINT_LINES} 行的内容将被截断，请保持索引简洁`,
        '- 保持记忆文件中 name、description、type 字段与内容同步更新',
        '- 按主题语义组织记忆，而非按时间顺序',
        '- 更新或删除已过时或错误的记忆',
        '- 不要写重复的记忆。写新记忆前先检查是否有可更新的已有记忆。',
      ]

  const lines = [
    '# 记忆',
    '',
    `你拥有一个持久化的基于文件的记忆系统，包含两个目录：私有目录 \`${autoDir}\` 和共享团队目录 \`${teamDir}\`。${DIRS_EXIST_GUIDANCE}`,
    '',
    '你应随时间积累此记忆系统，以便未来的对话能够完整了解用户是谁、他们希望如何与你协作、哪些行为应避免或重复，以及用户交给你的工作背后的背景。',
    '',
    '如果用户明确要求你记住某事，请立即将其保存为最合适的类型。如果他们要求你忘记某事，请找到并删除相关条目。',
    '',
    '## 记忆范围',
    '',
    '有两个范围级别：',
    '',
    `- private（私有）：你与当前用户之间的私有记忆。仅在与该特定用户的对话中持久存在，存储于根目录 \`${autoDir}\`。`,
    `- team（团队）：与在此项目目录中工作的所有用户共享并由其贡献的记忆。团队记忆在每次会话开始时同步，存储于 \`${teamDir}\`。`,
    '',
    ...TYPES_SECTION_COMBINED,
    ...WHAT_NOT_TO_SAVE_SECTION,
    '- 切勿在共享团队记忆中保存敏感数据。例如，绝不保存 API 密钥或用户凭据。',
    '',
    ...howToSave,
    '',
    '## 何时访问记忆',
    '- 当记忆（个人或团队）似乎相关时，或用户提及与他们或其组织中其他人的过往工作时。',
    '- 当用户明确要求你检查、回忆或记住某事时，你必须访问记忆。',
    '- 如果用户说要*忽略*或*不使用*记忆：请视 MEMORY.md 为空。不要应用已记住的事实、引用、对比或提及记忆内容。',
    MEMORY_DRIFT_CAVEAT,
    '',
    ...TRUSTING_RECALL_SECTION,
    '',
    '## 记忆与其他持久化方式',
    '记忆是你在某次对话中协助用户时可用的多种持久化机制之一。两者的关键区别在于：记忆可在未来的对话中调取，而不应用于存储仅在当前对话范围内有用的信息。',
    '- 何时使用或更新计划而非记忆：如果你即将开始一项非trivial的实现任务并希望与用户就方案达成共识，应使用计划而非将其保存为记忆。同样，如果对话中已有计划且你改变了方案，应通过更新计划来持久化变更，而非保存为记忆。',
    '- 何时使用或更新任务而非记忆：当你需要将当前对话中的工作拆分为离散步骤或跟踪进度时，应使用任务而非保存为记忆。任务非常适合持久化当前对话中需完成的工作信息，但记忆应留给在未来对话中有用的信息。',
    ...(extraGuidelines ?? []),
    '',
    ...buildSearchingPastContextSection(autoDir),
  ]

  return lines.join('\n')
}
