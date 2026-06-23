import { getLocalMonthYear } from 'src/constants/common.js'

export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export function getWebSearchPrompt(): string {
  const currentMonthYear = getLocalMonthYear()
  return `
- 允许 Claude 搜索网络并使用搜索结果来辅助回答
- 为时事和最新数据提供最新的信息
- 以搜索结果块的形式返回搜索结果信息，并将链接作为 markdown 超链接
- 当需要获取 Claude 知识截止日期之后的信息时，请使用此工具
- 搜索会在单次 API 调用内自动完成

关键要求 - 你必须遵守：
  - 在回答用户问题之后，你必须在回复末尾包含一个 "Sources:" 部分
  - 在 Sources 部分，将搜索结果中所有相关的 URL 以 markdown 超链接形式列出：[标题](URL)
  - 这是强制要求 - 绝不在回复中遗漏来源
  - 示例格式：

    [在此写出你的回答]

    Sources:
    - [来源标题 1](https://example.com/1)
    - [来源标题 2](https://example.com/2)

使用说明：
  - 支持域名过滤以包含或屏蔽特定网站
  - 网络搜索仅在美国可用

重要 - 在搜索查询中使用正确的年份：
  - 当前月份是 ${currentMonthYear}。在搜索最新信息、文档或时事时，你必须使用当前年份。
  - 示例：如果用户询问 "latest React docs"，应使用当前年份搜索 "React documentation"，而不是去年
`
}
