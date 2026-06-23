import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'

const WEB_BROWSER_TOOL_NAME = 'WebBrowser'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().describe('要获取并提取内容的 URL'),
    action: z
      .enum(['navigate', 'screenshot'])
      .optional()
      .describe(
        '要执行的操作。"navigate" 获取页面内容（默认）。"screenshot" 返回页面的文本快照。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type BrowserInput = z.infer<InputSchema>

type BrowserOutput = {
  title: string
  url: string
  content?: string
  screenshot?: string
}

export const WebBrowserTool = buildTool({
  name: WEB_BROWSER_TOOL_NAME,
  searchHint: 'web 浏览器 导航 url 页面 截图 点击',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return '通过 HTTP 获取并读取网页内容'
  },
  async prompt() {
    return `通过 HTTP 获取网页并提取其文本内容。这是一个轻量级浏览器工具（HTTP 抓取，并非完整的浏览器引擎）。

支持的操作：
- navigate：获取 URL 并提取页面标题 + 文本内容
- screenshot：与 navigate 相同（返回文本快照，而非可视化截图）

限制：
- 不执行 JavaScript — 仅能看到服务器端渲染的 HTML
- click/type/scroll 需要完整的浏览器运行时（不可用）
- 如需完整的浏览器交互，请改用 Claude-in-Chrome MCP 工具

适用场景：
- 阅读网页内容和文档
- 检查返回 HTML 的 API 端点
- 快速提取页面标题/内容`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return '浏览器'
  },

  renderToolUseMessage(input: Partial<BrowserInput>) {
    const action = input.action ?? 'navigate'
    return `浏览器 ${action}: ${input.url ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${content.title} (${content.url})\n${content.content ?? ''}`,
    }
  },

  async call(input: BrowserInput) {
    const action = input.action ?? 'navigate'

    if (action === 'navigate' || action === 'screenshot') {
      // 通过 HTTP 获取页面内容
      try {
        const response = await fetch(input.url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
        })

        if (!response.ok) {
          return {
            data: {
              title: `HTTP ${response.status}`,
              url: input.url,
              content: `错误：${response.status} ${response.statusText}`,
            },
          }
        }

        const html = await response.text()

        // 提取标题
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
        const title = titleMatch?.[1]?.trim() ?? ''

        // 提取文本内容（剥离 HTML 标签、脚本、样式）
        let textContent = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        // 截断到合理大小
        if (textContent.length > 50_000) {
          textContent = textContent.slice(0, 50_000) + '\n[truncated]'
        }

        if (action === 'screenshot') {
          return {
            data: {
              title,
              url: response.url,
              content: `[文本快照 — 可视化截图需要 Chrome 浏览器工具]\n\n${textContent}`,
            },
          }
        }

        return {
          data: {
            title,
            url: response.url,
            content: textContent,
          },
        }
      } catch (err) {
        return {
          data: {
            title: 'Error',
            url: input.url,
            content: `获取失败：${err instanceof Error ? err.message : String(err)}`,
          },
        }
      }
    }

    // 不可达 — schema 仅允许 navigate/screenshot
    return {
      data: {
        title: '',
        url: input.url,
        content: `未知操作 "${action}"。`,
      },
    }
  },
})
