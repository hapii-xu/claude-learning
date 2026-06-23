import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/Tool.js'
import type { PermissionUpdate } from 'src/types/permissions.js'
import { formatFileSize } from 'src/utils/format.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from 'src/utils/permissions/permissions.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { isPreapprovedHost } from './preapproved.js'
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import {
  applyPromptToMarkdown,
  type FetchedContent,
  fetchContentWithTavily,
  getURLMarkdownContent,
  isPreapprovedUrl,
  MAX_MARKDOWN_LENGTH,
} from './utils.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('要获取内容的 URL'),
    prompt: z.string().describe('对获取到的内容运行的提示'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    bytes: z.number().describe('获取到的内容大小（字节）'),
    code: z.number().describe('HTTP 响应码'),
    codeText: z.string().describe('HTTP 响应码文本'),
    result: z
      .string()
      .describe('将提示应用到内容后得到的处理结果'),
    durationMs: z
      .number()
      .describe('获取并处理内容所花费的时间'),
    url: z.string().describe('所获取的 URL'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function webFetchToolInputToPermissionRuleContent(input: {
  [k: string]: unknown
}): string {
  try {
    const parsedInput = WebFetchTool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return `input:${input.toString()}`
    }
    const { url } = parsedInput.data
    const hostname = new URL(url).hostname
    return `domain:${hostname}`
  } catch {
    return `input:${input.toString()}`
  }
}

export const WebFetchTool = buildTool({
  name: WEB_FETCH_TOOL_NAME,
  searchHint: 'fetch and extract content from a URL',
  // 100K 字符 - 工具结果持久化阈值
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    const { url } = input as { url: string }
    try {
      const hostname = new URL(url).hostname
      return `Claude 想要获取来自 ${hostname} 的内容`
    } catch {
      return `Claude 想要获取此 URL 的内容`
    }
  },
  userFacingName() {
    return '抓取'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `正在抓取 ${summary}` : '正在抓取网页'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // 检查主机名是否在预批准列表中
    try {
      const { url } = input as { url: string }
      const parsedUrl = new URL(url)
      if (isPreapprovedHost(parsedUrl.hostname, parsedUrl.pathname)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'other', reason: '预批准的主机' },
        }
      }
    } catch {
      // 如果 URL 解析失败，继续进行常规权限检查
    }

    // 检查与工具输入匹配（匹配主机名）的专用规则
    const ruleContent = webFetchToolInputToPermissionRuleContent(input)

    const denyRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'deny',
    ).get(ruleContent)
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `${WebFetchTool.name} 被拒绝访问 ${ruleContent}。`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }

    const askRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'ask',
    ).get(ruleContent)
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude 请求使用 ${WebFetchTool.name} 的权限，但您尚未授予。`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
        suggestions: buildSuggestions(ruleContent),
      }
    }

    const allowRule = getRuleByContentsForTool(
      permissionContext,
      WebFetchTool,
      'allow',
    ).get(ruleContent)
    if (allowRule) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: allowRule,
        },
      }
    }

    return {
      behavior: 'ask',
      message: `Claude 请求使用 ${WebFetchTool.name} 的权限，但您尚未授予。`,
      suggestions: buildSuggestions(ruleContent),
    }
  },
  async prompt(_options) {
    // 无论 SearchExtraTools 当前是否在工具列表中，都始终包含此认证警告。
    // 根据 SearchExtraTools 的可用性条件性地切换此前缀，会导致工具描述在
    // SDK query() 调用之间闪烁（当 SearchExtraTools 的启用状态因 MCP 工具
    // 数量阈值而变化时），在每次切换时都会使 Anthropic API 提示缓存失效 —
    // 每次闪烁事件会造成两次连续的缓存未命中。
    return `IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.
${DESCRIPTION}`
  },
  async validateInput(input) {
    const { url } = input
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `错误：无效的 URL "${url}"。提供的 URL 无法解析。`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(
    { url, prompt },
    { abortController, options: { isNonInteractiveSession } },
  ) {
    const start = Date.now()

    // 选择后端：settings.webFetchAdapter → 默认 'tavily'
    const settings = getSettings_DEPRECATED()
    const backend = settings.webFetchAdapter ?? 'tavily'

    // Tavily 路径：/extract 直接返回 Markdown — 跳过 turndown + queryHaiku
    if (backend === 'tavily') {
      const response = await fetchContentWithTavily(url, abortController)

      if ('type' in response && response.type === 'redirect') {
        const statusText = 'See Other'
        const message = `检测到重定向：该 URL 重定向到不同的主机。
原始 URL：${(response as { originalUrl: string }).originalUrl}
重定向 URL：${(response as { redirectUrl: string }).redirectUrl}

请使用重定向 URL 再次调用 WebFetch。`

        const output: Output = {
          bytes: Buffer.byteLength(message),
          code: 302,
          codeText: statusText,
          result: message,
          durationMs: Date.now() - start,
          url,
        }
        return { data: output }
      }

      const {
        content,
        bytes,
        code,
        codeText,
        contentType,
        persistedPath,
        persistedSize,
      } = response as FetchedContent

      let result = content
      if (prompt && prompt.trim()) {
        // Tavily extract 返回原始 Markdown — 如果用户提供了提示，
        // 仍然运行辅助模型调用以处理内容
        result = await applyPromptToMarkdown(
          prompt,
          content,
          abortController.signal,
          isNonInteractiveSession,
          isPreapprovedUrl(url),
        )
      }

      if (persistedPath) {
        result += `\n\n[二进制内容（${contentType}，${formatFileSize(persistedSize ?? bytes)}）已保存到 ${persistedPath}]`
      }

      const output: Output = {
        bytes,
        code,
        codeText,
        result,
        durationMs: Date.now() - start,
        url,
      }
      return { data: output }
    }

    // HTTP 直连路径（原始行为）：fetch + turndown + queryHaiku
    const response = await getURLMarkdownContent(url, abortController)

    // 检查是否收到了到不同主机的重定向
    if ('type' in response && response.type === 'redirect') {
      const statusText =
        response.statusCode === 301
          ? 'Moved Permanently'
          : response.statusCode === 308
            ? 'Permanent Redirect'
            : response.statusCode === 307
              ? 'Temporary Redirect'
              : 'Found'

      const message = `检测到重定向：该 URL 重定向到不同的主机。

原始 URL：${response.originalUrl}
重定向 URL：${response.redirectUrl}
状态：${response.statusCode} ${statusText}

为了完成您的请求，我需要从重定向 URL 获取内容。请使用以下参数再次调用 WebFetch：
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`

      const output: Output = {
        bytes: Buffer.byteLength(message),
        code: response.statusCode,
        codeText: statusText,
        result: message,
        durationMs: Date.now() - start,
        url,
      }

      return {
        data: output,
      }
    }

    const {
      content,
      bytes,
      code,
      codeText,
      contentType,
      persistedPath,
      persistedSize,
    } = response as FetchedContent

    const isPreapproved = isPreapprovedUrl(url)

    let result: string
    if (
      isPreapproved &&
      contentType.includes('text/markdown') &&
      content.length < MAX_MARKDOWN_LENGTH
    ) {
      result = content
    } else {
      result = await applyPromptToMarkdown(
        prompt,
        content,
        abortController.signal,
        isNonInteractiveSession,
        isPreapproved,
      )
    }

    // 二进制内容（PDF 等）会额外保存到磁盘，文件扩展名由 MIME 类型派生。
    // 这里做标记以便 Claude 可以检查原始文件（如果上面的 Haiku 摘要不够用）。
    if (persistedPath) {
      result += `\n\n[二进制内容（${contentType}，${formatFileSize(persistedSize ?? bytes)}）已保存到 ${persistedPath}]`
    }

    const output: Output = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url,
    }

    return {
      data: output,
    }
  },
  mapToolResultToToolResultBlockParam({ result }, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function buildSuggestions(ruleContent: string): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      destination: 'localSettings',
      rules: [{ toolName: WEB_FETCH_TOOL_NAME, ruleContent }],
      behavior: 'allow',
    },
  ]
}
