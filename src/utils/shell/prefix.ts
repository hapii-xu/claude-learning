/**
 * 基于 Haiku LLM 的共享命令前缀抽取模块
 *
 * 本模块提供一个工厂，用于创建可被不同 shell 工具复用的命令前缀
 * 抽取器。核心逻辑（Haiku 查询、响应校验）是共享的，而工具特定
 * 的部分（示例、预检查）可以按需配置。
 */

import chalk from 'chalk'
import type { QuerySource } from '../../constants/querySource.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { queryHaiku } from '../../services/api/claude.js'
import { startsWithApiErrorPrefix } from '../../services/api/errors.js'
import { memoizeWithLRU } from '../memoize.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'

/**
 * 绝不能被当作裸前缀接受的 shell 可执行文件。
 * 允许例如 "bash:*" 会让任何命令都通过，使权限系统失效。
 * 包含 Unix shell 以及 Windows 等价物。
 */
const DANGEROUS_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash.exe',
])

/**
 * 命令前缀抽取的结果
 */
export type CommandPrefixResult = {
  /** 检测到的命令前缀；无法确定时为 null */
  commandPrefix: string | null
}

/**
 * 包含复合命令子命令前缀的结果
 */
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

/**
 * 用于创建命令前缀抽取器的配置
 */
export type PrefixExtractorConfig = {
  /** 工具名称，用于日志和告警 */
  toolName: string

  /** 提供给 Haiku 的 policy spec（含示例） */
  policySpec: string
  /** 日志使用的 analytics 事件名 */
  eventName: string

  /** API 调用的 query source 标识 */
  querySource: QuerySource

  /** 可选的预检查函数，可短路 Haiku 调用 */
  preCheck?: (command: string) => CommandPrefixResult | null
}

/**
 * 创建一个 memoized 的命令前缀抽取函数。
 *
 * 采用双层 memoization：外层 memoized 函数负责创建 promise，并附加
 * 一个 .catch handler，在 rejection 时驱逐对应的缓存项。这样可以避免
 * 被中止或失败的 Haiku 调用污染后续查询。
 *
 * 通过 LRU 限制最多 200 条，避免高强度会话中无限制增长。
 *
 * @param config - 抽取器的配置
 * @returns 一个 memoized 的异步函数，用于抽取命令前缀
 */
export function createCommandPrefixExtractor(config: PrefixExtractorConfig) {
  const { toolName, policySpec, eventName, querySource, preCheck } = config

  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandPrefixResult | null> => {
      const promise = getCommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        toolName,
        policySpec,
        eventName,
        querySource,
        preCheck,
      )
      // rejection 时驱逐缓存，避免被中止的调用污染后续轮次。
      // 身份守护：LRU 驱逐之后，该 key 下可能已经是一个更新的 promise；
      // 陈旧的 rejection 不应该把它删掉。
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    command => command, // 仅按 command 做 memoize
    200,
  )

  return memoized
}

/**
 * 创建一个 memoized 函数，用于获取带子命令的复合命令的前缀。
 *
 * 采用与 createCommandPrefixExtractor 相同的双层 memoization 模式：
 * 通过 .catch handler 在 rejection 时驱逐缓存项以避免污染。
 *
 * @param getPrefix - 单命令前缀抽取器（来自 createCommandPrefixExtractor）
 * @param splitCommand - 把复合命令拆分为子命令的函数
 * @returns 一个 memoized 的异步函数，抽取主命令及所有子命令的前缀
 */
export function createSubcommandPrefixExtractor(
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommand: (command: string) => string[] | Promise<string[]>,
) {
  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandSubcommandPrefixResult | null> => {
      const promise = getCommandSubcommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        getPrefix,
        splitCommand,
      )
      // rejection 时驱逐缓存，避免被中止的调用污染后续轮次。
      // 身份守护：LRU 驱逐之后，该 key 下可能已经是一个更新的 promise；
      // 陈旧的 rejection 不应该把它删掉。
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    command => command, // 仅按 command 做 memoize
    200,
  )

  return memoized
}

async function getCommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  toolName: string,
  policySpec: string,
  eventName: string,
  querySource: QuerySource,
  preCheck?: (command: string) => CommandPrefixResult | null,
): Promise<CommandPrefixResult | null> {
  if (process.env.NODE_ENV === 'test') {
    return null
  }

  // 如果提供了 pre-check 则先执行（例如 Bash 的 isHelpCommand）
  if (preCheck) {
    const preCheckResult = preCheck(command)
    if (preCheckResult !== null) {
      return preCheckResult
    }
  }

  let preflightCheckTimeoutId: NodeJS.Timeout | undefined
  const startTime = Date.now()
  let result: CommandPrefixResult | null = null

  try {
    // 预检耗时过长时记录告警
    preflightCheckTimeoutId = setTimeout(
      (tn, nonInteractive) => {
        const message = `[${tn}Tool] Pre-flight check is taking longer than expected. Run with ANTHROPIC_LOG=debug to check for failed or slow API requests.`
        if (nonInteractive) {
          process.stderr.write(jsonStringify({ level: 'warn', message }) + '\n')
        } else {
          console.warn(chalk.yellow(`⚠️  ${message}`))
        }
      },
      10000, // 10 秒
      toolName,
      isNonInteractiveSession,
    )

    const useSystemPromptPolicySpec = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_cork_m4q',
      false,
    )

    const response = await queryHaiku({
      systemPrompt: asSystemPrompt(
        useSystemPromptPolicySpec
          ? [
              `Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\n${policySpec}`,
            ]
          : [
              `Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\nThis policy spec defines how to determine the prefix of a ${toolName} command:`,
            ],
      ),
      userPrompt: useSystemPromptPolicySpec
        ? `Command: ${command}`
        : `${policySpec}\n\nCommand: ${command}`,
      signal: abortSignal,
      options: {
        enablePromptCaching: useSystemPromptPolicySpec,
        querySource,
        agents: [],
        isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // 查询已完成，清除超时
    clearTimeout(preflightCheckTimeoutId)
    const durationMs = Date.now() - startTime

    const prefix =
      typeof response.message.content === 'string'
        ? response.message.content
        : Array.isArray(response.message.content)
          ? (response.message.content.find(_ => _.type === 'text')?.text ??
            'none')
          : 'none'

    if (startsWithApiErrorPrefix(prefix)) {
      logEvent(eventName, {
        success: false,
        error:
          'API error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = null
    } else if (prefix === 'command_injection_detected') {
      // Haiku 检测到可疑内容 - 视作无可用前缀
      logEvent(eventName, {
        success: false,
        error:
          'command_injection_detected' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else if (
      prefix === 'git' ||
      DANGEROUS_SHELL_PREFIXES.has(prefix.toLowerCase())
    ) {
      // 绝不接受裸 `git` 或 shell 可执行文件作为前缀
      logEvent(eventName, {
        success: false,
        error:
          'dangerous_shell_prefix' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else if (prefix === 'none') {
      // 未检测到前缀
      logEvent(eventName, {
        success: false,
        error:
          'prefix "none"' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else {
      // 校验该 prefix 确实是命令的前缀

      if (!command.startsWith(prefix)) {
        // 该 prefix 实际上不是命令的前缀
        logEvent(eventName, {
          success: false,
          error:
            'command did not start with prefix' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs,
        })
        result = {
          commandPrefix: null,
        }
      } else {
        logEvent(eventName, {
          success: true,
          durationMs,
        })
        result = {
          commandPrefix: prefix,
        }
      }
    }

    return result
  } catch (error) {
    clearTimeout(preflightCheckTimeoutId)
    throw error
  }
}

async function getCommandSubcommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommandFn: (command: string) => string[] | Promise<string[]>,
): Promise<CommandSubcommandPrefixResult | null> {
  const subcommands = await splitCommandFn(command)

  const [fullCommandPrefix, ...subcommandPrefixesResults] = await Promise.all([
    getPrefix(command, abortSignal, isNonInteractiveSession),
    ...subcommands.map(async subcommand => ({
      subcommand,
      prefix: await getPrefix(subcommand, abortSignal, isNonInteractiveSession),
    })),
  ])

  if (!fullCommandPrefix) {
    return null
  }

  const subcommandPrefixes = subcommandPrefixesResults.reduce(
    (acc, { subcommand, prefix }) => {
      if (prefix) {
        acc.set(subcommand, prefix)
      }
      return acc
    },
    new Map<string, CommandPrefixResult>(),
  )

  return {
    ...fullCommandPrefix,
    subcommandPrefixes,
  }
}
