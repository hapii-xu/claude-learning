import {
  type ClaudeForChromeContext,
  createClaudeForChromeMcpServer,
  type Logger,
  type LoggerDetail,
  type PermissionMode,
} from '@ant/claude-for-chrome-mcp'
import { initializeAnalyticsSink } from '../../services/analytics/sink.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { format } from 'util'
import { shutdownDatadog } from '../../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../../services/analytics/firstPartyEventLogger.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'

import { getClaudeAIOAuthTokens } from '../auth.js'
import { enableConfigs, getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { sideQuery } from '../sideQuery.js'
import { getAllSocketPaths, getSecureSocketPath } from './common.js'

const EXTENSION_DOWNLOAD_URL = 'https://claude.ai/chrome'
const BUG_REPORT_URL =
  'https://github.com/anthropics/claude-code/issues/new?labels=bug,claude-in-chrome'

// 可安全转发到 analytics 的字符串元数据键。像 error_message 这样的键
// 被排除，因为它们可能包含页面内容或用户数据。
const SAFE_BRIDGE_STRING_KEYS = new Set([
  'bridge_status',
  'error_type',
  'tool_name',
])

const PERMISSION_MODES: readonly PermissionMode[] = [
  'ask',
  'skip_all_permission_checks',
  'follow_a_plan',
]

function isPermissionMode(raw: string): raw is PermissionMode {
  return PERMISSION_MODES.some(m => m === raw)
}

/**
 * 根据环境和功能标志解析 Chrome bridge URL。
 * 功能标志启用时使用 bridge；ant 用户始终使用
 * bridge。API key / 第三方用户回退到原生消息通信。
 */
function getChromeBridgeUrl(): string | undefined {
  const bridgeEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_copper_bridge', false)

  if (!bridgeEnabled) {
    return undefined
  }

  if (
    isEnvTruthy(process.env.USE_LOCAL_OAUTH) ||
    isEnvTruthy(process.env.LOCAL_BRIDGE)
  ) {
    return 'ws://localhost:8765'
  }

  if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
    return 'wss://bridge-staging.claudeusercontent.com'
  }

  return 'wss://bridge.claudeusercontent.com'
}

function isLocalBridge(): boolean {
  return (
    isEnvTruthy(process.env.USE_LOCAL_OAUTH) ||
    isEnvTruthy(process.env.LOCAL_BRIDGE)
  )
}

/**
 * 构建 ClaudeForChromeContext，子进程 MCP server 和
 * MCP client 中的进程内路径都使用它。
 */
export function createChromeContext(
  env?: Record<string, string>,
): ClaudeForChromeContext {
  const logger = new DebugLogger()
  const chromeBridgeUrl = getChromeBridgeUrl()
  logger.info(`Bridge URL: ${chromeBridgeUrl ?? 'none (using native socket)'}`)
  const rawPermissionMode =
    env?.CLAUDE_CHROME_PERMISSION_MODE ??
    process.env.CLAUDE_CHROME_PERMISSION_MODE
  let initialPermissionMode: PermissionMode | undefined
  if (rawPermissionMode) {
    if (isPermissionMode(rawPermissionMode)) {
      initialPermissionMode = rawPermissionMode
    } else {
      logger.warn(
        `Invalid CLAUDE_CHROME_PERMISSION_MODE "${rawPermissionMode}". Valid values: ${PERMISSION_MODES.join(', ')}`,
      )
    }
  }
  return {
    serverName: 'Claude in Chrome',
    logger,
    socketPath: getSecureSocketPath(),
    getSocketPaths: getAllSocketPaths,
    clientTypeId: 'claude-code',
    onAuthenticationError: () => {
      logger.warn(
        'Authentication error occurred. Please ensure you are logged into the Claude browser extension with the same claude.ai account as Claude Code.',
      )
    },
    onToolCallDisconnected: () => {
      return `Browser extension is not connected. Please ensure the Claude browser extension is installed and running (${EXTENSION_DOWNLOAD_URL}), and that you are logged into claude.ai with the same account as Claude Code. If this is your first time connecting to Chrome, you may need to restart Chrome for the installation to take effect. If you continue to experience issues, please report a bug: ${BUG_REPORT_URL}`
    },
    onExtensionPaired: (deviceId: string, name: string) => {
      saveGlobalConfig(config => {
        if (
          config.chromeExtension?.pairedDeviceId === deviceId &&
          config.chromeExtension?.pairedDeviceName === name
        ) {
          return config
        }
        return {
          ...config,
          chromeExtension: {
            pairedDeviceId: deviceId,
            pairedDeviceName: name,
          },
        }
      })
      logger.info(`Paired with "${name}" (${deviceId.slice(0, 8)})`)
    },
    getPersistedDeviceId: () => {
      return getGlobalConfig().chromeExtension?.pairedDeviceId
    },
    ...(chromeBridgeUrl && {
      bridgeConfig: {
        url: chromeBridgeUrl,
        getUserId: async () => {
          return getGlobalConfig().oauthAccount?.accountUuid
        },
        getOAuthToken: async () => {
          return getClaudeAIOAuthTokens()?.accessToken ?? ''
        },
        ...(isLocalBridge() && { devUserId: 'dev_user_local' }),
      },
    }),
    ...(initialPermissionMode && { initialPermissionMode }),
    // 为 browser_task 工具连接 inference — chrome-mcp server 在 Node 中运行
    // 一个 lightning-mode agent 循环，并在每次迭代中调用扩展的
    // lightning_turn 工具来执行。
    //
    // 仅限 Ant：扩展的 lightning_turn 通过
    // import.meta.env.ANT_ONLY_BUILD 在构建时门控 — 整个 lightning/ 模块图
    // 在公共扩展构建中被 tree-shake 移除（build:prod 会 grep
    // 标记来验证）。若无此注入，Node MCP server 的
    // ListTools 也会过滤掉 browser_task + lightning_turn，因此外部
    // 用户永远不会看到这些工具的广告。三道独立门控。
    //
    // 内联类型：AnthropicMessagesRequest/Response 位于
    // @ant/claude-for-chrome-mcp@0.4.0 中，尚未发布。CI 安装
    // 0.3.0。callAnthropicMessages 字段也是 0.4.0 独有，但将
    // 额外属性展开到 ClaudeForChromeContext 中对两个版本都没问题 —
    // 0.3.0 看到未知字段（展开允许），0.4.0 看到结构匹配的。
    // 0.4.0 发布后，可以切换到包导出的类型并升级依赖。
    ...(process.env.USER_TYPE === 'ant' && {
      callAnthropicMessages: async (req: {
        model: string
        max_tokens: number
        system: string
        messages: Parameters<typeof sideQuery>[0]['messages']
        stop_sequences?: string[]
        signal?: AbortSignal
      }): Promise<{
        content: Array<{ type: 'text'; text: string }>
        stop_reason: string | null
        usage?: { input_tokens: number; output_tokens: number }
      }> => {
        // sideQuery 处理 OAuth 归因指纹、代理、模型 betas。
        // skipSystemPromptPrefix：lightning prompt 本身已完整；
        // CLI 前缀会稀释批处理指令。
        // tools: [] 是关键 — 没有它 Sonnet 会在文本命令前输出
        // <function_calls> XML。原始的
        // lightning-harness.js（apps 仓库）也这样做。
        const response = await sideQuery({
          model: req.model,
          system: req.system,
          messages: req.messages,
          max_tokens: req.max_tokens,
          stop_sequences: req.stop_sequences,
          signal: req.signal,
          skipSystemPromptPrefix: true,
          tools: [],
          querySource: 'chrome_mcp',
        })
        // BetaContentBlock 是 TextBlock | ThinkingBlock | ToolUseBlock | ...
        // 只有 text 块携带模型的命令输出。
        const textBlocks: Array<{ type: 'text'; text: string }> = []
        for (const b of response.content) {
          if (b.type === 'text') {
            textBlocks.push({ type: 'text', text: b.text })
          }
        }
        return {
          content: textBlocks,
          stop_reason: response.stop_reason,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        }
      },
    }),
    trackEvent: (eventName, metadata) => {
      const safeMetadata: {
        [key: string]:
          | boolean
          | number
          | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          | undefined
      } = {}
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          // 将 'status' 重命名为 'bridge_status' 以避免 Datadog 的保留字段
          const safeKey = key === 'status' ? 'bridge_status' : key
          if (typeof value === 'boolean' || typeof value === 'number') {
            safeMetadata[safeKey] = value
          } else if (
            typeof value === 'string' &&
            SAFE_BRIDGE_STRING_KEYS.has(safeKey)
          ) {
            // 仅转发白名单内的字符串键 — 像 error_message 这样的字段
            // 可能包含页面内容或用户数据
            safeMetadata[safeKey] =
              value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          }
        }
      }
      logEvent(eventName, safeMetadata)
    },
  }
}

export async function runClaudeInChromeMcpServer(): Promise<void> {
  enableConfigs()
  initializeAnalyticsSink()
  const context = createChromeContext()

  const server = createClaudeForChromeMcpServer(context)
  const transport = new StdioServerTransport()

  // 父进程死亡（stdin 管道关闭）时退出。
  // 退出前 flush analytics，避免最后批次事件（如 disconnect）丢失。
  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    await shutdown1PEventLogging()
    await shutdownDatadog()
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Claude in Chrome] Starting MCP server')
  await server.connect(transport)
  logForDebugging('[Claude in Chrome] MCP server started')
}

class DebugLogger implements Logger {
  silly(message: string, detail?: LoggerDetail): void {
    logForDebugging(format(message, detail ?? ''), { level: 'debug' })
  }
  debug(message: string, detail?: LoggerDetail): void {
    logForDebugging(format(message, detail ?? ''), { level: 'debug' })
  }
  info(message: string, detail?: LoggerDetail): void {
    logForDebugging(format(message, detail ?? ''), { level: 'info' })
  }
  warn(message: string, detail?: LoggerDetail): void {
    logForDebugging(format(message, detail ?? ''), { level: 'warn' })
  }
  error(message: string, detail?: LoggerDetail): void {
    logForDebugging(format(message, detail ?? ''), { level: 'error' })
  }
}
