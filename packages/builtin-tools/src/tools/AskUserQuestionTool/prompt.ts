import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  '向用户提出多选问题，以收集信息、澄清歧义、了解偏好、做出决策或提供选择。'

export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
预览功能：
当向用户展示需要视觉对比的具体内容时，可在选项上使用可选的 \`preview\` 字段：
- UI 布局或组件的 ASCII 示意图
- 展示不同实现方式的代码片段
- 图表变体
- 配置示例

预览内容以等宽字体框中的 markdown 格式渲染。支持多行文本和换行符。当任意选项有预览时，UI 切换为左右分栏布局，左侧为垂直选项列表，右侧为预览内容。对于仅凭标签和描述即可说明的简单偏好问题，请勿使用预览。注意：预览仅支持单选问题（不支持 multiSelect）。
`,
  html: `
预览功能：
当向用户展示需要视觉对比的具体内容时，可在选项上使用可选的 \`preview\` 字段：
- UI 布局或组件的 HTML 示意图
- 展示不同实现方式的格式化代码片段
- 视觉对比或图表

预览内容必须是自包含的 HTML 片段（不含 <html>/<body> 包装，不含 <script> 或 <style> 标签 —— 请改用内联 style 属性）。对于仅凭标签和描述即可说明的简单偏好问题，请勿使用预览。注意：预览仅支持单选问题（不支持 multiSelect）。
`,
} as const

export const ASK_USER_QUESTION_TOOL_PROMPT = `当你在执行过程中需要向用户提问时使用此工具。这允许你：
1. 收集用户偏好或需求
2. 澄清模糊的指令
3. 在工作时就实现方案做出决策
4. 向用户提供方向选择。

使用说明：
- 用户始终可以选择"其他"来提供自定义文本输入
- 使用 multiSelect: true 可允许某个问题选择多个答案
- 如果你推荐某个特定选项，请将其作为列表中的第一个选项，并在标签末尾添加"（推荐）"

计划模式说明：在计划模式下，请在确定计划之前使用此工具澄清需求或在不同方案中做出选择。不要使用此工具询问"我的计划准备好了吗？"或"是否可以继续？"—— 请使用 ${EXIT_PLAN_MODE_TOOL_NAME} 来审批计划。重要：请勿在问题中引用"计划"（例如"你对计划有什么反馈吗？"、"计划看起来如何？"），因为在你调用 ${EXIT_PLAN_MODE_TOOL_NAME} 之前，用户在 UI 中是看不到计划的。如果需要审批计划，请改用 ${EXIT_PLAN_MODE_TOOL_NAME}。
`
