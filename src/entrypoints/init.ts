import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from 'src/bootstrap/state.js'
import type { AttributedCounter } from '../bootstrap/state.js'
import { getSessionCounter, setMeter } from '../bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policyLimits/index.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
  waitForRemoteManagedSettingsToLoad,
} from '../services/remoteManagedSettings/index.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  enableConfigs,
  getGlobalConfig,
  recordFirstStartTime,
  saveGlobalConfig,
} from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在错误路径中动态导入，以避免在初始化时加载 React
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utils/gracefulShutdown.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
// initializeTelemetry 通过 import() 在 setMeterState() 中懒加载，将
// ~400KB 的 OpenTelemetry + protobuf 模块推迟到遥测真正初始化时才加载。
// gRPC exporters（通过 @grpc/grpc-js 约 700KB）在 instrumentation.ts 中进一步懒加载。
import { configureGlobalAgents } from '../utils/proxy.js'
import { isBetaTracingEnabled } from '../utils/telemetry/betaSessionTracing.js'
import { getTelemetryAttributes } from '../utils/telemetryAttributes.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'
import { initSentry } from '../utils/sentry.js'
import { initUser } from '../utils/user.js'
import { initLangfuse, shutdownLangfuse } from '../services/langfuse/index.js'
import { setThemeConfigCallbacks } from '@anthropic/ink'

// initialize1PEventLogging 动态导入以推迟 OpenTelemetry sdk-logs/resources 加载

// 跟踪遥测是否已初始化，防止重复初始化
let telemetryInitialized = false

/**
 * 一次性全局初始化函数（memoized，整个进程生命周期只执行一次）。
 *
 * 调用时机：在 Commander preAction hook 中，每个命令执行前调用。
 *
 * 初始化内容（按执行顺序）：
 *   1. enableConfigs()        —— 启用配置读取（settings.json、global config）
 *   2. applySafeConfigEnvironmentVariables() —— 应用安全的环境变量（trust 前可执行的部分）
 *   3. applyExtraCACertsFromConfig() —— 加载额外 CA 证书（必须在首次 TLS 握手前）
 *   4. setupGracefulShutdown() —— 注册进程退出清理钩子
 *   5. 初始化 1P event logging（异步，不阻塞）
 *   6. 启动 balance polling（查询 API 余额，异步）
 *   7. populateOAuthAccountInfoIfNeeded() —— 补充 OAuth 账户信息
 *   8. initJetBrainsDetection() —— 检测 JetBrains IDE 环境
 *   9. 初始化远程管理设置 / 策略限制的 loading promise
 *  10. configureGlobalMTLS() + configureGlobalAgents() —— 配置 mTLS 和 HTTP 代理
 *  11. initSentry() + initLangfuse() —— 错误上报 / 链路追踪
 *  12. preconnectAnthropicApi() —— TCP+TLS 预连接（节省 ~100-200ms）
 *  13. setShellIfWindows() —— Windows 下设置 git-bash shell
 *  14. ensureScratchpadDir() —— 创建临时工作目录
 *
 * 如果配置文件解析失败（ConfigParseError），会弹出交互式错误对话框。
 */
export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  logForDebugging(
    '-------------- init 开始 -----------\n' +
      `[Hapii] init.initOnce 首次初始化开始\n` +
      `  initStartTime=${new Date(initStartTime).toISOString()}\n` +
      `  NODE_ENV=${process.env.NODE_ENV}\n` +
      `  USER_TYPE=${process.env.USER_TYPE ?? 'undefined'}\n` +
      `  CLAUDE_CODE_REMOTE=${process.env.CLAUDE_CODE_REMOTE ?? 'undefined'}\n` +
      `  argv=${JSON.stringify(process.argv.slice(2))}`,
    { level: 'info' },
  )
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 校验配置并启用配置系统
  try {
    const configsStart = Date.now()
    logForDebugging('[Hapii] init: enableConfigs() 调用前', { level: 'debug' })
    enableConfigs()
    logForDebugging(
      `[Hapii] init: enableConfigs() 完成 耗时=${Date.now() - configsStart}ms`,
      { level: 'debug' },
    )

    logForDebugging('[Hapii] init: setThemeConfigCallbacks() 调用前', {
      level: 'debug',
    })
    setThemeConfigCallbacks({
      loadTheme: () => getGlobalConfig().theme,
      saveTheme: setting =>
        saveGlobalConfig(current => ({ ...current, theme: setting })),
    })
    logForDebugging('[Hapii] init: setThemeConfigCallbacks() 完成', {
      level: 'debug',
    })

    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在 trust dialog 之前仅应用安全的环境变量
    // 完整环境变量会在 trust 确立后应用
    const envVarsStart = Date.now()
    logForDebugging(
      '[Hapii] init: applySafeConfigEnvironmentVariables() 调用前\n' +
        '  （仅应用 trust 前可安全执行的环境变量）',
      { level: 'debug' },
    )
    applySafeConfigEnvironmentVariables()
    logForDebugging(
      `[Hapii] init: applySafeConfigEnvironmentVariables() 完成 耗时=${Date.now() - envVarsStart}ms`,
      { level: 'debug' },
    )

    // 尽早将 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env，
    // 早于任何 TLS 连接。Bun 在启动时通过 BoringSSL 缓存 TLS 证书存储，
    // 因此这必须在首次 TLS 握手之前完成。
    const caCertsStart = Date.now()
    logForDebugging(
      '[Hapii] init: applyExtraCACertsFromConfig() 调用前\n' +
        '  （必须在首次 TLS 握手前完成，Bun BoringSSL 缓存 TLS 证书存储）',
      { level: 'debug' },
    )
    applyExtraCACertsFromConfig()
    logForDebugging(
      `[Hapii] init: applyExtraCACertsFromConfig() 完成 耗时=${Date.now() - caCertsStart}ms`,
      { level: 'debug' },
    )

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保退出时刷缓存
    const gsStart = Date.now()
    logForDebugging('[Hapii] init: setupGracefulShutdown() 调用前', {
      level: 'debug',
    })
    setupGracefulShutdown()
    logForDebugging(
      `[Hapii] init: setupGracefulShutdown() 完成 耗时=${Date.now() - gsStart}ms`,
      { level: 'debug' },
    )
    profileCheckpoint('init_after_graceful_shutdown')
    logForDebugging('[Hapii] init: graceful shutdown hooks 已注册', {
      level: 'info',
    })

    // 初始化 1P event logging（无安全问题，但推迟以避免
    // 在启动时加载 OpenTelemetry sdk-logs）。growthbook.js 此时已经在
    // 模块缓存中（firstPartyEventLogger 导入了它），因此第二次
    // 动态导入不会增加加载成本。
    const fpLogStart = Date.now()
    logForDebugging(
      '[Hapii] init: 启动 1P event logging 初始化\n' +
        '  （动态导入 firstPartyEventLogger + growthbook，fire-and-forget）',
      { level: 'info' },
    )
    void Promise.all([
      import('../services/analytics/firstPartyEventLogger.js'),
      import('../services/analytics/growthbook.js'),
    ]).then(([fp, gb]) => {
      logForDebugging(
        `[Hapii] init: 1P event logging 动态导入完成 耗时=${Date.now() - fpLogStart}ms`,
        { level: 'debug' },
      )
      fp.initialize1PEventLogging()
      logForDebugging('[Hapii] init: initialize1PEventLogging() 完成', {
        level: 'debug',
      })
      // 如果 tengu_1p_event_batch_config 在会话中途变化，重建 logger provider。
      // 变更检测（isEqual）在 handler 内部，因此未变化的 refresh 是 no-op。
      gb.onGrowthBookRefresh(() => {
        logForDebugging(
          '[Hapii] init: GrowthBook refresh 触发，检查是否需要重建 logger provider',
          { level: 'debug' },
        )
        void fp.reinitialize1PEventLoggingIfConfigChanged()
      })
    })
    profileCheckpoint('init_after_1p_event_logging')

    // 启动余额轮询（除非通过环境变量配置了 provider，否则为 no-op）。
    logForDebugging(
      '[Hapii] init: 启动余额轮询（动态导入 poller.js，fire-and-forget）',
      { level: 'info' },
    )
    void import('../services/providerUsage/balance/poller.js').then(m => {
      logForDebugging(
        '[Hapii] init: poller 模块加载完成，调用 startBalancePolling()',
        {
          level: 'debug',
        },
      )
      m.startBalancePolling()
    })
    profileCheckpoint('init_after_balance_polling')

    // 如果 OAuth 账户信息尚未缓存到 config 中，则补充填充。这很必要，因为
    // 通过 VSCode 扩展登录时 OAuth 账户信息可能未被填充。
    logForDebugging(
      '[Hapii] init: populateOAuthAccountInfoIfNeeded() 调用前\n' +
        '  （VSCode 扩展登录时 OAuth 账户信息可能未填充）',
      { level: 'info' },
    )
    void populateOAuthAccountInfoIfNeeded()
    profileCheckpoint('init_after_oauth_populate')

    // 异步初始化 JetBrains IDE 检测（填充缓存以供后续同步访问）
    logForDebugging(
      '[Hapii] init: initJetBrainsDetection() 调用前\n' +
        '  （异步检测，填充缓存供后续同步访问）',
      { level: 'info' },
    )
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（填充缓存以供 gitDiff PR 链接使用）
    logForDebugging(
      '[Hapii] init: detectCurrentRepository() 调用前\n' +
        '  （异步检测 GitHub 仓库，供 gitDiff PR 链接使用）',
      { level: 'debug' },
    )
    void detectCurrentRepository()

    // 提前初始化 loading promise，以便其他系统（如 plugin hooks）
    // 可以 await 远程设置加载。该 promise 包含超时，以防止
    // loadRemoteManagedSettings() 从未被调用时（例如 Agent SDK 测试）出现死锁。
    const eligibleRemote = isEligibleForRemoteManagedSettings()
    const eligiblePolicy = isPolicyLimitsEligible()
    logForDebugging(
      '[Hapii] init: 远程设置资格检查\n' +
        `  isEligibleForRemoteManagedSettings=${eligibleRemote}\n` +
        `  isPolicyLimitsEligible=${eligiblePolicy}`,
      { level: 'info' },
    )
    if (eligibleRemote) {
      logForDebugging(
        '[Hapii] init: initializeRemoteManagedSettingsLoadingPromise() 调用',
        { level: 'debug' },
      )
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (eligiblePolicy) {
      logForDebugging(
        '[Hapii] init: initializePolicyLimitsLoadingPromise() 调用',
        {
          level: 'debug',
        },
      )
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间
    logForDebugging('[Hapii] init: recordFirstStartTime() 调用', {
      level: 'debug',
    })
    recordFirstStartTime()

    // 配置全局 mTLS 设置
    const mtlsStart = Date.now()
    logForDebugging(
      '[Hapii] init: configureGlobalMTLS() 调用前\n' +
        '  （配置 mTLS 客户端证书，影响后续所有 HTTPS 请求）',
      { level: 'info' },
    )
    configureGlobalMTLS()
    logForDebugging(
      `[Hapii] init: configureGlobalMTLS() 完成 耗时=${Date.now() - mtlsStart}ms`,
      { level: 'debug' },
    )
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })

    // 配置全局 HTTP agents（代理和/或 mTLS）
    const proxyStart = Date.now()
    logForDebugging(
      '[Hapii] init: configureGlobalAgents() 调用前\n' +
        '  （配置 HTTP/HTTPS 代理 agent，影响后续所有 HTTP 请求）',
      { level: 'info' },
    )
    configureGlobalAgents()
    logForDebugging(
      `[Hapii] init: configureGlobalAgents() 完成 耗时=${Date.now() - proxyStart}ms`,
      { level: 'debug' },
    )
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    profileCheckpoint('init_network_configured')

    // 初始化 Sentry 错误上报（若未设置 SENTRY_DSN 则为 no-op）
    const sentryStart = Date.now()
    logForDebugging(
      '[Hapii] init: initSentry() 调用前\n' +
        `  SENTRY_DSN=${process.env.SENTRY_DSN ? '已设置' : '未设置(no-op)'}`,
      { level: 'info' },
    )
    initSentry()
    logForDebugging(
      `[Hapii] init: initSentry() 完成 耗时=${Date.now() - sentryStart}ms`,
      { level: 'debug' },
    )

    // 初始化 Langfuse 链路追踪（若未配置 keys 则为 no-op）
    // 预热用户 email 缓存，以便 Langfuse traces 包含 userId
    const langfuseStart = Date.now()
    logForDebugging(
      '[Hapii] init: initUser() + initLangfuse() 调用前\n' +
        '  （initUser 预热 email 缓存，initLangfuse 初始化链路追踪）',
      { level: 'info' },
    )
    await initUser()
    logForDebugging(
      `[Hapii] init: initUser() 完成 耗时=${Date.now() - langfuseStart}ms`,
      { level: 'debug' },
    )
    initLangfuse()
    logForDebugging('[Hapii] init: initLangfuse() 完成', { level: 'debug' })
    registerCleanup(shutdownLangfuse)

    // 预连接 Anthropic API —— 让 TCP+TLS 握手（~100-200ms）与
    // API 请求之前约 ~100ms 的 action-handler 工作重叠。
    // 在 CA 证书 + 代理 agents 配置完成后执行，以便预热的
    // 连接使用正确的传输。Fire-and-forget；对于
    // 代理/mTLS/unix/cloud-provider 场景会跳过，因为 SDK 的 dispatcher 不会
    // 复用全局连接池。
    const preconnectStart = Date.now()
    logForDebugging(
      '[Hapii] init: preconnectAnthropicApi() 调用前\n' +
        '  （TCP+TLS 握手 ~100-200ms，fire-and-forget）\n' +
        '  （代理/mTLS/unix/cloud-provider 场景会跳过）',
      { level: 'info' },
    )
    preconnectAnthropicApi()
    logForDebugging(
      `[Hapii] init: preconnectAnthropicApi() 完成 耗时=${Date.now() - preconnectStart}ms`,
      { level: 'debug' },
    )

    // CCR upstreamproxy：启动本地 CONNECT 中继，以便 agent 子进程
    // 可以在凭证注入下访问组织配置的上游。通过 CLAUDE_CODE_REMOTE +
    // GrowthBook 控制；出错时 fail-open。懒加载以便
    // 非 CCR 启动不必付出模块加载成本。getUpstreamProxyEnv
    // 函数注册到 subprocessEnv.ts，这样子进程派生时可以
    // 注入代理变量，而无需静态导入 upstreamproxy 模块。
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      logForDebugging(
        '[Hapii] init: CLAUDE_CODE_REMOTE 已启用，初始化 upstreamproxy\n' +
          '  （启动本地 CONNECT 中继，供 agent 子进程使用）',
        { level: 'info' },
      )
      try {
        const upStart = Date.now()
        logForDebugging('[Hapii] init: 动态导入 upstreamproxy.js', {
          level: 'debug',
        })
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        logForDebugging(
          `[Hapii] init: upstreamproxy.js 导入完成 耗时=${Date.now() - upStart}ms`,
          { level: 'debug' },
        )
        const { registerUpstreamProxyEnvFn } = await import(
          '../utils/subprocessEnv.js'
        )
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        logForDebugging('[Hapii] init: registerUpstreamProxyEnvFn() 完成', {
          level: 'debug',
        })
        await initUpstreamProxy()
        logForDebugging(
          `[Hapii] init: initUpstreamProxy() 完成 总耗时=${Date.now() - upStart}ms`,
          { level: 'info' },
        )
      } catch (err) {
        logForDebugging(
          `[Hapii] init: upstreamproxy 初始化失败：${err instanceof Error ? err.message : String(err)}；将在无代理情况下继续`,
          { level: 'warn' },
        )
      }
    } else {
      logForDebugging(
        '[Hapii] init: CLAUDE_CODE_REMOTE 未启用，跳过 upstreamproxy 初始化',
        { level: 'debug' },
      )
    }

    // 如相关则设置 git-bash
    logForDebugging('[Hapii] init: setShellIfWindows() 调用前', {
      level: 'info',
    })
    setShellIfWindows()
    logForDebugging('[Hapii] init: setShellIfWindows() 完成', {
      level: 'debug',
    })

    // 注册 LSP manager 清理（初始化在 main.tsx 中处理完 --plugin-dir 后进行）
    logForDebugging(
      '[Hapii] init: registerCleanup(shutdownLspServerManager) 注册',
      { level: 'debug' },
    )
    registerCleanup(shutdownLspServerManager)

    // gh-32730：由 subagent（或没有显式 TeamDelete 的主 agent）创建的
    // team 会永远留在磁盘上。为本会话创建的所有 team 注册清理。
    // 懒导入：swarm 代码在 feature gate 之后，大多数会话从不创建 team。
    logForDebugging(
      '[Hapii] init: registerCleanup(cleanupSessionTeams) 注册\n' +
        '  （清理由 subagent 创建的残留 team 目录）',
      { level: 'debug' },
    )
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 如启用则初始化 scratchpad 目录
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      logForDebugging('[Hapii] init: ensureScratchpadDir() 调用前', {
        level: 'debug',
      })
      await ensureScratchpadDir()
      logForDebugging(
        `[Hapii] init: ensureScratchpadDir() 完成 耗时=${Date.now() - scratchpadStart}ms`,
        { level: 'debug' },
      )
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    } else {
      logForDebugging('[Hapii] init: scratchpad 未启用，跳过', {
        level: 'debug',
      })
    }

    // 每会话一次提示 ripgrep fallback（例如 Android/Termux）。
    // 输出到 stderr，避免污染 pipe 模式（`-p`）的 stdout。
    try {
      const { getRipgrepStatus } = await import('../utils/ripgrep.js')
      const status = getRipgrepStatus()
      if (status.note) {
        logForDebugging(`[Hapii] init: ripgrep fallback 提示：${status.note}`, {
          level: 'info',
        })
        process.stderr.write(`[ripgrep] ${status.note}\n`)
      } else {
        logForDebugging('[Hapii] init: ripgrep 状态正常，无 fallback 提示', {
          level: 'debug',
        })
      }
    } catch {
      // ripgrep 状态是 best-effort；绝不阻塞 init。
      logForDebugging('[Hapii] init: ripgrep 状态检查失败（已跳过）', {
        level: 'debug',
      })
    }

    logForDebugging(
      '------------ init 结束 ------------\n' +
        `[Hapii] init.initOnce 完成\n` +
        `  总耗时=${Date.now() - initStartTime}ms\n` +
        `  sessionId=${getSessionId()}`,
      { level: 'info' },
    )
    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    const errorType =
      error instanceof Error ? error.constructor.name : typeof error
    const errorMsg = error instanceof Error ? error.message : String(error)
    logForDebugging(
      '------------ init 异常结束 ------------\n' +
        `[Hapii] init.initOnce 捕获异常\n` +
        `  errorType=${errorType}\n` +
        `  errorMsg=${errorMsg}\n` +
        `  耗时=${Date.now() - initStartTime}ms`,
      { level: 'error' },
    )
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `[Hapii] init: ConfigParseError 捕获\n` +
          `  filePath=${error.filePath}\n` +
          `  isNonInteractive=${getIsNonInteractiveSession()}`,
        { level: 'error' },
      )
      // 当无法安全渲染交互式 Ink 对话框时跳过。
      // 该对话框会破坏 JSON 消费者（例如在 VM 沙箱中运行
      // `plugin marketplace list --json` 的桌面版 marketplace 插件管理器）。
      if (getIsNonInteractiveSession()) {
        logForDebugging('[Hapii] init: 非交互会话，直接输出错误并退出', {
          level: 'error',
        })
        process.stderr.write(
          `配置错误，文件 ${error.filePath}：${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 显示无效配置对话框，展示 error 对象并等待其完成
      logForDebugging('[Hapii] init: 动态导入 InvalidConfigDialog 显示对话框', {
        level: 'debug',
      })
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
      // 对话框自身会处理 process.exit，因此这里不需要额外清理
    } else {
      // 非配置错误则重新抛出
      logForDebugging('[Hapii] init: 非 ConfigParseError，重新抛出异常', {
        level: 'error',
      })
      throw error
    }
  }
})

/**
 * 在用户确认 trust dialog 之后初始化遥测（OTel）。
 *
 * 为什么要等到 trust 之后？
 *   遥测需要读取用户配置（远程管理设置可能改变环境变量），
 *   而读取配置必须先通过 trust dialog 确认项目是可信的。
 *
 * 两种路径：
 *   - 符合远程管理设置资格的用户：等远程设置加载完 → 重新应用环境变量 → 初始化遥测
 *   - 其他用户：直接初始化遥测
 *
 * 此函数只应调用一次（trust 确认后）。
 */
export function initializeTelemetryAfterTrust(): void {
  logForDebugging(
    '-------------- initializeTelemetryAfterTrust 开始 -----------\n' +
      `[Hapii] initializeTelemetryAfterTrust 调用\n` +
      `  isEligibleForRemoteManagedSettings=${isEligibleForRemoteManagedSettings()}\n` +
      `  isNonInteractive=${getIsNonInteractiveSession()}\n` +
      `  isBetaTracingEnabled=${isBetaTracingEnabled()}`,
    { level: 'info' },
  )
  if (isEligibleForRemoteManagedSettings()) {
    // 对于启用 beta tracing 的 SDK/headless 模式，先紧急初始化，
    // 以确保 tracer 在首个 query 运行前就绪。
    // 下面的异步路径仍会运行，但 doInitializeTelemetry() 会防止重复初始化。
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      logForDebugging(
        '[Hapii] initializeTelemetryAfterTrust: 紧急遥测初始化（beta tracing + headless）',
        { level: 'info' },
      )
      void doInitializeTelemetry().catch(error => {
        logForDebugging(
          `[Hapii] initializeTelemetryAfterTrust: 紧急遥测初始化失败：${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    }
    logForDebugging(
      '[Hapii] initializeTelemetryAfterTrust: 等待远程托管设置加载',
      { level: 'info' },
    )
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        logForDebugging(
          '[Hapii] initializeTelemetryAfterTrust: 远程托管设置已加载，开始初始化遥测',
          { level: 'info' },
        )
        // 重新应用 env vars，以便在初始化遥测前吸收远程设置。
        applyConfigEnvironmentVariables()
        await doInitializeTelemetry()
      })
      .catch(error => {
        logForDebugging(
          `[Hapii] initializeTelemetryAfterTrust: 遥测初始化失败（远程设置路径）：${errorMessage(error)}`,
          { level: 'error' },
        )
      })
  } else {
    logForDebugging(
      '[Hapii] initializeTelemetryAfterTrust: 非远程管理用户，直接初始化遥测',
      { level: 'info' },
    )
    void doInitializeTelemetry().catch(error => {
      logForDebugging(
        `[Hapii] initializeTelemetryAfterTrust: 遥测初始化失败：${errorMessage(error)}`,
        { level: 'error' },
      )
    })
  }
  logForDebugging(
    '------------ initializeTelemetryAfterTrust 结束 ------------',
    {
      level: 'info',
    },
  )
}

/**
 * 实际执行遥测初始化的内部函数。
 *
 * 前置条件：CLAUDE_CODE_ENABLE_TELEMETRY 环境变量必须为真，否则跳过。
 * 懒加载 OpenTelemetry 模块（~400KB），避免未启用遥测时浪费内存。
 * 初始化后会设置全局 Meter，供 attributed counter 使用。
 */
async function doInitializeTelemetry(): Promise<void> {
  logForDebugging(
    '-------------- doInitializeTelemetry 开始 -----------\n' +
      `[Hapii] doInitializeTelemetry 调用\n` +
      `  telemetryInitialized=${telemetryInitialized}\n` +
      `  CLAUDE_CODE_ENABLE_TELEMETRY=${process.env.CLAUDE_CODE_ENABLE_TELEMETRY ?? 'undefined'}`,
    { level: 'info' },
  )
  if (telemetryInitialized) {
    // 已初始化，无需操作
    logForDebugging('[Hapii] doInitializeTelemetry: 已初始化，跳过', {
      level: 'debug',
    })
    logForDebugging('------------ doInitializeTelemetry 结束 ------------', {
      level: 'info',
    })
    return
  }

  // 未启用遥测时跳过整个 OTel 初始化。
  // 防止长时间运行的会话中 PerformanceMeasure 累积。
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)) {
    telemetryInitialized = true
    logForDebugging(
      '[Hapii] doInitializeTelemetry: 未设置 CLAUDE_CODE_ENABLE_TELEMETRY，跳过 OTel 初始化',
      { level: 'info' },
    )
    logForDebugging('------------ doInitializeTelemetry 结束 ------------', {
      level: 'info',
    })
    return
  }

  // 在初始化前设置标志，防止重复初始化
  telemetryInitialized = true
  const startTime = Date.now()
  logForDebugging('[Hapii] doInitializeTelemetry: 开始 setMeterState()', {
    level: 'info',
  })
  try {
    await setMeterState()
    logForDebugging(
      `[Hapii] doInitializeTelemetry: setMeterState() 完成 耗时=${Date.now() - startTime}ms`,
      { level: 'info' },
    )
  } catch (error) {
    // 失败时重置标志，以便后续调用可以重试
    telemetryInitialized = false
    logForDebugging(
      `[Hapii] doInitializeTelemetry: setMeterState() 失败，重置 telemetryInitialized=false\n` +
        `  error=${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    throw error
  }
  logForDebugging('------------ doInitializeTelemetry 结束 ------------', {
    level: 'info',
  })
}

async function setMeterState(): Promise<void> {
  logForDebugging(
    '-------------- setMeterState 开始 -----------\n' +
      '[Hapii] setMeterState 调用\n' +
      '  （动态导入 instrumentation.js，约 400KB OpenTelemetry + protobuf）',
    { level: 'info' },
  )
  const importStart = Date.now()
  // 懒加载 instrumentation 以推迟 ~400KB 的 OpenTelemetry + protobuf 模块
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  logForDebugging(
    `[Hapii] setMeterState: instrumentation.js 导入完成 耗时=${Date.now() - importStart}ms`,
    { level: 'debug' },
  )
  // 初始化客户 OTLP 遥测（metrics、logs、traces）
  const meter = await initializeTelemetry()
  logForDebugging(
    `[Hapii] setMeterState: initializeTelemetry() 完成 meter=${meter ? '已创建' : 'null'}`,
    { level: 'info' },
  )
  if (meter) {
    // 为 attributed counters 创建工厂函数
    const createAttributedCounter = (
      name: string,
      options: MetricOptions,
    ): AttributedCounter => {
      const counter = meter?.createCounter(name, options)

      return {
        add(value: number, additionalAttributes: Attributes = {}) {
          // 始终获取最新的遥测属性，确保其是最新的
          const currentAttributes = getTelemetryAttributes()
          const mergedAttributes = {
            ...currentAttributes,
            ...additionalAttributes,
          }
          counter?.add(value, mergedAttributes)
        },
      }
    }

    setMeter(meter, createAttributedCounter)
    logForDebugging('[Hapii] setMeterState: setMeter() 完成', {
      level: 'debug',
    })

    // 这里递增 session counter，因为启动遥测路径
    // 在这个异步初始化完成之前就运行了，那时 counter 还是 null。
    const sessionCounter = getSessionCounter()
    if (sessionCounter) {
      sessionCounter.add(1)
      logForDebugging('[Hapii] setMeterState: sessionCounter.add(1) 完成', {
        level: 'debug',
      })
    } else {
      logForDebugging(
        '[Hapii] setMeterState: sessionCounter 为 null，跳过递增',
        { level: 'warn' },
      )
    }
  }
  logForDebugging('------------ setMeterState 结束 ------------', {
    level: 'info',
  })
}
