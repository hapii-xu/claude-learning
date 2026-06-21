/**
 * `caCerts.ts` 的配置/设置支持的 NODE_EXTRA_CA_CERTS 填充。
 *
 * 从 `caCerts.ts` 分离，因为 `config.ts` → `file.ts` →
 * `permissions/filesystem.ts` → `commands.ts` 传递性地拉入约 5300 个
 * 模块（REPL、React、每个斜杠命令）。`proxy.ts`/`mtls.ts`（以及
 * 因此通过我们的代理 agent 使用 HTTPS 的任何东西 —— WebSocketTransport、
 * CCRClient、telemetry）不能依赖该图，否则 Agent SDK 包
 *（`connectRemoteControl` 路径）会从约 0.4 MB 膨胀到约 10.8 MB。
 *
 * `getCACertificates()` 仅读取 `process.env.NODE_EXTRA_CA_CERTS`。此模块
 * 是唯一允许导入 `config.ts` 以在 CLI 启动时*填充*该环境变量的地方。
 * 只有 `init.ts` 导入此文件。
 */

import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * 在初始化早期、任何 TLS 连接建立之前，将 settings.json 中的
 * NODE_EXTRA_CA_CERTS 应用到 process.env。
 *
 * Bun 在进程启动时通过 BoringSSL 缓存 TLS 证书存储。
 * 如果启动时环境中未设置 NODE_EXTRA_CA_CERTS，Bun 不会
 * 包含自定义 CA 证书。通过在任何 TLS 连接之前设置到 process.env，
 * 我们给 Bun 一个获取它的机会（如果证书存储是延迟初始化的），
 * 并确保 Node.js 兼容性。
 *
 * 在信任对话框之前调用此函数是安全的，因为我们只从
 * 用户控制的文件（~/.claude/settings.json 和 ~/.claude.json）读取，
 * 不从项目级设置读取。
 */
export function applyExtraCACertsFromConfig(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) {
    return // 已在环境中设置，无需操作
  }
  const configPath = getExtraCertsPathFromConfig()
  if (configPath) {
    process.env.NODE_EXTRA_CA_CERTS = configPath
    logForDebugging(
      `CA certs: Applied NODE_EXTRA_CA_CERTS from config to process.env: ${configPath}`,
    )
  }
}

/**
 * 从设置/配置中读取 NODE_EXTRA_CA_CERTS 作为回退。
 *
 * NODE_EXTRA_CA_CERTS 被归类为非安全环境变量（它允许
 * 信任攻击者控制的服务器），因此只在信任对话框之后才应用到 process.env。
 * 但我们需要尽早获取 CA 证书以在 init() 期间建立到 HTTPS 代理的 TLS 连接。
 *
 * 我们从全局配置（~/.claude.json）和用户设置
 *（~/.claude/settings.json）读取。这些是用户控制的文件，
 * 不需要信任批准。
 */
function getExtraCertsPathFromConfig(): string | undefined {
  try {
    const globalConfig = getGlobalConfig()
    const globalEnv = globalConfig?.env
    // 仅从用户控制的设置（~/.claude/settings.json）读取，
    // 不从项目级设置读取，以防止恶意项目在信任对话框之前
    // 注入 CA 证书。
    const settings = getSettingsForSource('userSettings')
    const settingsEnv = settings?.env

    logForDebugging(
      `CA certs: Config fallback - globalEnv keys: ${globalEnv ? Object.keys(globalEnv).join(',') : 'none'}, settingsEnv keys: ${settingsEnv ? Object.keys(settingsEnv).join(',') : 'none'}`,
    )

    // 设置覆盖全局配置（与 applyConfigEnvironmentVariables 相同的优先级）
    const path =
      settingsEnv?.NODE_EXTRA_CA_CERTS || globalEnv?.NODE_EXTRA_CA_CERTS
    if (path) {
      logForDebugging(
        `CA certs: Found NODE_EXTRA_CA_CERTS in config/settings: ${path}`,
      )
    }
    return path
  } catch (error) {
    logForDebugging(`CA certs: Config fallback failed: ${error}`, {
      level: 'error',
    })
    return undefined
  }
}
