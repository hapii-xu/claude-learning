import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
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
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 校验配置并启用配置系统
  try {
    const configsStart = Date.now()
    enableConfigs()
    setThemeConfigCallbacks({
      loadTheme: () => getGlobalConfig().theme,
      saveTheme: setting =>
        saveGlobalConfig(current => ({ ...current, theme: setting })),
    })
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在 trust dialog 之前仅应用安全的环境变量
    // 完整环境变量会在 trust 确立后应用
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 尽早将 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env，
    // 早于任何 TLS 连接。Bun 在启动时通过 BoringSSL 缓存 TLS 证书存储，
    // 因此这必须在首次 TLS 握手之前完成。
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保退出时刷缓存
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 初始化 1P event logging（无安全问题，但推迟以避免
    // 在启动时加载 OpenTelemetry sdk-logs）。growthbook.js 此时已经在
    // 模块缓存中（firstPartyEventLogger 导入了它），因此第二次
    // 动态导入不会增加加载成本。
    void Promise.all([
      import('../services/analytics/firstPartyEventLogger.js'),
      import('../services/analytics/growthbook.js'),
    ]).then(([fp, gb]) => {
      fp.initialize1PEventLogging()
      // 如果 tengu_1p_event_batch_config 在会话中途变化，重建 logger provider。
      // 变更检测（isEqual）在 handler 内部，因此未变化的 refresh 是 no-op。
      gb.onGrowthBookRefresh(() => {
        void fp.reinitialize1PEventLoggingIfConfigChanged()
      })
    })
    profileCheckpoint('init_after_1p_event_logging')

    // 启动余额轮询（除非通过环境变量配置了 provider，否则为 no-op）。
    void import('../services/providerUsage/balance/poller.js').then(m =>
      m.startBalancePolling(),
    )
    profileCheckpoint('init_after_balance_polling')

    // 如果 OAuth 账户信息尚未缓存到 config 中，则补充填充。这很必要，因为
    // 通过 VSCode 扩展登录时 OAuth 账户信息可能未被填充。
    void populateOAuthAccountInfoIfNeeded()
    profileCheckpoint('init_after_oauth_populate')

    // 异步初始化 JetBrains IDE 检测（填充缓存以供后续同步访问）
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（填充缓存以供 gitDiff PR 链接使用）
    void detectCurrentRepository()

    // 提前初始化 loading promise，以便其他系统（如 plugin hooks）
    // 可以 await 远程设置加载。该 promise 包含超时，以防止
    // loadRemoteManagedSettings() 从未被调用时（例如 Agent SDK 测试）出现死锁。
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间
    recordFirstStartTime()

    // 配置全局 mTLS 设置
    const mtlsStart = Date.now()
    logForDebugging('[init] 正在启动 configureGlobalMTLS')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    logForDebugging('[init] configureGlobalMTLS 完成')

    // 配置全局 HTTP agents（代理和/或 mTLS）
    const proxyStart = Date.now()
    logForDebugging('[init] 正在启动 configureGlobalAgents')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    logForDebugging('[init] configureGlobalAgents 完成')
    profileCheckpoint('init_network_configured')

    // 初始化 Sentry 错误上报（若未设置 SENTRY_DSN 则为 no-op）
    initSentry()

    // 初始化 Langfuse 链路追踪（若未配置 keys 则为 no-op）
    // 预热用户 email 缓存，以便 Langfuse traces 包含 userId
    await initUser()
    initLangfuse()
    registerCleanup(shutdownLangfuse)

    // 预连接 Anthropic API —— 让 TCP+TLS 握手（~100-200ms）与
    // API 请求之前约 ~100ms 的 action-handler 工作重叠。
    // 在 CA 证书 + 代理 agents 配置完成后执行，以便预热的
    // 连接使用正确的传输。Fire-and-forget；对于
    // 代理/mTLS/unix/cloud-provider 场景会跳过，因为 SDK 的 dispatcher 不会
    // 复用全局连接池。
    preconnectAnthropicApi()

    // CCR upstreamproxy：启动本地 CONNECT 中继，以便 agent 子进程
    // 可以在凭证注入下访问组织配置的上游。通过 CLAUDE_CODE_REMOTE +
    // GrowthBook 控制；出错时 fail-open。懒加载以便
    // 非 CCR 启动不必付出模块加载成本。getUpstreamProxyEnv
    // 函数注册到 subprocessEnv.ts，这样子进程派生时可以
    // 注入代理变量，而无需静态导入 upstreamproxy 模块。
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      try {
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        const { registerUpstreamProxyEnvFn } = await import(
          '../utils/subprocessEnv.js'
        )
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        await initUpstreamProxy()
      } catch (err) {
        logForDebugging(
          `[init] upstreamproxy 初始化失败：${err instanceof Error ? err.message : String(err)}；将在无代理情况下继续`,
          { level: 'warn' },
        )
      }
    }

    // 如相关则设置 git-bash
    setShellIfWindows()

    // 注册 LSP manager 清理（初始化在 main.tsx 中处理完 --plugin-dir 后进行）
    registerCleanup(shutdownLspServerManager)

    // gh-32730：由 subagent（或没有显式 TeamDelete 的主 agent）创建的
    // team 会永远留在磁盘上。为本会话创建的所有 team 注册清理。
    // 懒导入：swarm 代码在 feature gate 之后，大多数会话从不创建 team。
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 如启用则初始化 scratchpad 目录
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    // 每会话一次提示 ripgrep fallback（例如 Android/Termux）。
    // 输出到 stderr，避免污染 pipe 模式（`-p`）的 stdout。
    try {
      const { getRipgrepStatus } = await import('../utils/ripgrep.js')
      const status = getRipgrepStatus()
      if (status.note) {
        process.stderr.write(`[ripgrep] ${status.note}\n`)
      }
    } catch {
      // ripgrep 状态是 best-effort；绝不阻塞 init。
      logForDebugging('[init] 已跳过 ripgrep 状态检查')
    }

    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // 当无法安全渲染交互式 Ink 对话框时跳过。
      // 该对话框会破坏 JSON 消费者（例如在 VM 沙箱中运行
      // `plugin marketplace list --json` 的桌面版 marketplace 插件管理器）。
      if (getIsNonInteractiveSession()) {
        process.stderr.write(
          `配置错误，文件 ${error.filePath}：${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 显示无效配置对话框，展示 error 对象并等待其完成
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
      // 对话框自身会处理 process.exit，因此这里不需要额外清理
    } else {
      // 非配置错误则重新抛出
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
  if (isEligibleForRemoteManagedSettings()) {
    // 对于启用 beta tracing 的 SDK/headless 模式，先紧急初始化，
    // 以确保 tracer 在首个 query 运行前就绪。
    // 下面的异步路径仍会运行，但 doInitializeTelemetry() 会防止重复初始化。
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch(error => {
        logForDebugging(
          `[3P telemetry] 紧急遥测初始化失败（beta tracing）：${errorMessage(error)}`,
          { level: 'error' },
        )
      })
    }
    logForDebugging('[3P telemetry] 正在等待远程托管设置加载完毕后再初始化遥测')
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        logForDebugging('[3P telemetry] 远程托管设置已加载，正在初始化遥测')
        // 重新应用 env vars，以便在初始化遥测前吸收远程设置。
        applyConfigEnvironmentVariables()
        await doInitializeTelemetry()
      })
      .catch(error => {
        logForDebugging(
          `[3P telemetry] 遥测初始化失败（远程设置路径）：${errorMessage(error)}`,
          { level: 'error' },
        )
      })
  } else {
    void doInitializeTelemetry().catch(error => {
      logForDebugging(`[3P telemetry] 遥测初始化失败：${errorMessage(error)}`, {
        level: 'error',
      })
    })
  }
}

/**
 * 实际执行遥测初始化的内部函数。
 *
 * 前置条件：CLAUDE_CODE_ENABLE_TELEMETRY 环境变量必须为真，否则跳过。
 * 懒加载 OpenTelemetry 模块（~400KB），避免未启用遥测时浪费内存。
 * 初始化后会设置全局 Meter，供 attributed counter 使用。
 */
async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) {
    // 已初始化，无需操作
    return
  }

  // 未启用遥测时跳过整个 OTel 初始化。
  // 防止长时间运行的会话中 PerformanceMeasure 累积。
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)) {
    telemetryInitialized = true
    logForDebugging(
      '[3P telemetry] 已跳过 —— 未设置 CLAUDE_CODE_ENABLE_TELEMETRY',
    )
    return
  }

  // 在初始化前设置标志，防止重复初始化
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    // 失败时重置标志，以便后续调用可以重试
    telemetryInitialized = false
    throw error
  }
}

async function setMeterState(): Promise<void> {
  // 懒加载 instrumentation 以推迟 ~400KB 的 OpenTelemetry + protobuf 模块
  const { initializeTelemetry } = await import(
    '../utils/telemetry/instrumentation.js'
  )
  // 初始化客户 OTLP 遥测（metrics、logs、traces）
  const meter = await initializeTelemetry()
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

    // 这里递增 session counter，因为启动遥测路径
    // 在这个异步初始化完成之前就运行了，那时 counter 还是 null。
    getSessionCounter()?.add(1)
  }
}
