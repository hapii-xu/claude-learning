export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `
- 从指定 URL 获取内容并使用 AI 模型进行处理
- 以 URL 和提示作为输入
- 获取 URL 内容，将 HTML 转换为 Markdown
- 使用一个小巧、快速的模型根据提示处理内容
- 返回模型对该内容的响应
- 当您需要获取并分析网页内容时，请使用此工具

使用说明：
  - 重要：如果有 MCP 提供的 web fetch 工具可用，请优先使用该工具，因为它可能限制更少。
  - URL 必须是完整合法的 URL
  - HTTP URL 将自动升级为 HTTPS
  - 提示应描述您希望从页面中提取什么信息
  - 此工具是只读的，不会修改任何文件
  - 如果内容非常大，结果可能会被摘要
  - 包含 15 分钟自动清理的缓存，便于在重复访问同一 URL 时加快响应
  - 当 URL 重定向到不同的主机时，工具会以特殊格式通知您并提供重定向 URL。此时应使用重定向 URL 再次发起 WebFetch 请求以获取内容。
  - 对于 GitHub URL，请优先通过 Bash 使用 gh CLI（例如 gh pr view、gh issue view、gh api）。
`

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `请根据上述内容提供简洁的回复。根据需要包含相关细节、代码示例和文档摘录。`
    : `请仅根据上述内容提供简洁的回复。在回复中：
 - 对任何来源文档的引用严格执行 125 字符上限。只要尊重许可证，开源软件是可以的。
 - 对文章中的精确措辞使用引号；引号之外的任何内容都不应逐字相同。
 - 您不是律师，绝不就自己提示和回复的合法性发表意见。
 - 绝不生成或复现精确的歌曲歌词。`

  return `
网页内容：
---
${markdownContent}
---

${prompt}

${guidelines}
`
}
