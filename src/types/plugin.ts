import type { LspServerConfig } from '../services/lsp/types.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type { BundledSkillDefinition } from '../skills/bundledSkills.js'
import type {
  CommandMetadata,
  PluginAuthor,
  PluginManifest,
} from '../utils/plugins/schemas.js'
import type { HooksSettings } from '../utils/settings/types.js'

export type { PluginAuthor, PluginManifest, CommandMetadata }

/**
 * 随 CLI 一起发布的内置 plugin 定义。
 * 内置 plugin 会出现在 /plugin UI 中，用户可以启用/禁用
 *（持久化到用户设置）。
 */
export type BuiltinPluginDefinition = {
  /** Plugin 名（用于 `{name}@builtin` 标识符） */
  name: string
  /** 在 /plugin UI 中展示的描述 */
  description: string
  /** 可选的版本字符串 */
  version?: string
  /** 该 plugin 提供的 skills */
  skills?: BundledSkillDefinition[]
  /** 该 plugin 提供的 hooks */
  hooks?: HooksSettings
  /** 该 plugin 提供的 MCP servers */
  mcpServers?: Record<string, McpServerConfig>
  /** 该 plugin 是否可用（例如根据系统能力判断）。不可用的 plugin 会完全隐藏。 */
  isAvailable?: () => boolean
  /** 用户设置偏好之前的默认启用状态（默认为 true） */
  defaultEnabled?: boolean
}

export type PluginRepository = {
  url: string
  branch: string
  lastUpdated?: string
  commitSha?: string
}

export type PluginConfig = {
  repositories: Record<string, PluginRepository>
}

export type LoadedPlugin = {
  name: string
  manifest: PluginManifest
  path: string
  source: string
  repository: string // 仓库标识，通常与 source 相同
  enabled?: boolean
  isBuiltin?: boolean // 随 CLI 发布的内置 plugin 为 true
  sha?: string // 用于版本固定的 Git commit SHA（来自 marketplace entry source）
  commandsPath?: string
  commandsPaths?: string[] // manifest 中额外的 command 路径
  commandsMetadata?: Record<string, CommandMetadata> // object-mapping 格式的具名 command 元数据
  agentsPath?: string
  agentsPaths?: string[] // manifest 中额外的 agent 路径
  skillsPath?: string
  skillsPaths?: string[] // manifest 中额外的 skill 路径
  outputStylesPath?: string
  outputStylesPaths?: string[] // manifest 中额外的 output style 路径
  hooksConfig?: HooksSettings
  mcpServers?: Record<string, McpServerConfig>
  lspServers?: Record<string, LspServerConfig>
  settings?: Record<string, unknown>
}

export type PluginComponent =
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'output-styles'

/**
 * plugin 错误类型的可辨识联合。
 * 每种错误类型都带有特定的上下文数据，便于调试和用户引导。
 *
 * 它取代了过去基于字符串的错误匹配方式，改用类型安全的错误处理，
 * 不会因为错误消息变更而失效。
 *
 * 实现状态：
 * 当前生产环境使用（2 种）：
 * - generic-error：用于各种 plugin 加载失败
 * - plugin-not-found：在 marketplace 中找不到 plugin 时使用
 *
 * 计划未来使用（10 种 —— 见 pluginLoader.ts 中的 TODO）：
 * - path-not-found、git-auth-failed、git-timeout、network-error
 * - manifest-parse-error、manifest-validation-error
 * - marketplace-not-found、marketplace-load-failed
 * - mcp-config-invalid、hook-load-failed、component-load-failed
 *
 * 这些未使用的类型支持 UI 格式化，为改进错误
 * 特异性提供了清晰的路线图。随着错误创建点的重构，
 * 可逐步落地。
 */
export type PluginError =
  | {
      type: 'path-not-found'
      source: string
      plugin?: string
      path: string
      component: PluginComponent
    }
  | {
      type: 'git-auth-failed'
      source: string
      plugin?: string
      gitUrl: string
      authType: 'ssh' | 'https'
    }
  | {
      type: 'git-timeout'
      source: string
      plugin?: string
      gitUrl: string
      operation: 'clone' | 'pull'
    }
  | {
      type: 'network-error'
      source: string
      plugin?: string
      url: string
      details?: string
    }
  | {
      type: 'manifest-parse-error'
      source: string
      plugin?: string
      manifestPath: string
      parseError: string
    }
  | {
      type: 'manifest-validation-error'
      source: string
      plugin?: string
      manifestPath: string
      validationErrors: string[]
    }
  | {
      type: 'plugin-not-found'
      source: string
      pluginId: string
      marketplace: string
    }
  | {
      type: 'marketplace-not-found'
      source: string
      marketplace: string
      availableMarketplaces: string[]
    }
  | {
      type: 'marketplace-load-failed'
      source: string
      marketplace: string
      reason: string
    }
  | {
      type: 'mcp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'mcp-server-suppressed-duplicate'
      source: string
      plugin: string
      serverName: string
      duplicateOf: string
    }
  | {
      type: 'lsp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'hook-load-failed'
      source: string
      plugin: string
      hookPath: string
      reason: string
    }
  | {
      type: 'component-load-failed'
      source: string
      plugin: string
      component: PluginComponent
      path: string
      reason: string
    }
  | {
      type: 'mcpb-download-failed'
      source: string
      plugin: string
      url: string
      reason: string
    }
  | {
      type: 'mcpb-extract-failed'
      source: string
      plugin: string
      mcpbPath: string
      reason: string
    }
  | {
      type: 'mcpb-invalid-manifest'
      source: string
      plugin: string
      mcpbPath: string
      validationError: string
    }
  | {
      type: 'lsp-config-invalid'
      source: string
      plugin: string
      serverName: string
      validationError: string
    }
  | {
      type: 'lsp-server-start-failed'
      source: string
      plugin: string
      serverName: string
      reason: string
    }
  | {
      type: 'lsp-server-crashed'
      source: string
      plugin: string
      serverName: string
      exitCode: number | null
      signal?: string
    }
  | {
      type: 'lsp-request-timeout'
      source: string
      plugin: string
      serverName: string
      method: string
      timeoutMs: number
    }
  | {
      type: 'lsp-request-failed'
      source: string
      plugin: string
      serverName: string
      method: string
      error: string
    }
  | {
      type: 'marketplace-blocked-by-policy'
      source: string
      plugin?: string
      marketplace: string
      blockedByBlocklist?: boolean // true if blocked by blockedMarketplaces, false if not in strictKnownMarketplaces
      allowedSources: string[] // Formatted source strings (e.g., "github:owner/repo")
    }
  | {
      type: 'dependency-unsatisfied'
      source: string
      plugin: string
      dependency: string
      reason: 'not-enabled' | 'not-found'
    }
  | {
      type: 'plugin-cache-miss'
      source: string
      plugin: string
      installPath: string
    }
  | {
      type: 'generic-error'
      source: string
      plugin?: string
      error: string
    }

export type PluginLoadResult = {
  enabled: LoadedPlugin[]
  disabled: LoadedPlugin[]
  errors: PluginError[]
}

/**
 * 从任意 PluginError 取得展示消息的辅助函数
 * 用于日志和简单的错误展示
 */
export function getPluginErrorMessage(error: PluginError): string {
  switch (error.type) {
    case 'generic-error':
      return error.error
    case 'path-not-found':
      return `Path not found: ${error.path} (${error.component})`
    case 'git-auth-failed':
      return `Git authentication failed (${error.authType}): ${error.gitUrl}`
    case 'git-timeout':
      return `Git ${error.operation} timeout: ${error.gitUrl}`
    case 'network-error':
      return `Network error: ${error.url}${error.details ? ` - ${error.details}` : ''}`
    case 'manifest-parse-error':
      return `Manifest parse error: ${error.parseError}`
    case 'manifest-validation-error':
      return `Manifest validation failed: ${error.validationErrors.join(', ')}`
    case 'plugin-not-found':
      return `Plugin ${error.pluginId} not found in marketplace ${error.marketplace}`
    case 'marketplace-not-found':
      return `Marketplace ${error.marketplace} not found`
    case 'marketplace-load-failed':
      return `Marketplace ${error.marketplace} failed to load: ${error.reason}`
    case 'mcp-config-invalid':
      return `MCP server ${error.serverName} invalid: ${error.validationError}`
    case 'mcp-server-suppressed-duplicate': {
      const dup = error.duplicateOf.startsWith('plugin:')
        ? `server provided by plugin "${error.duplicateOf.split(':')[1] ?? '?'}"`
        : `already-configured "${error.duplicateOf}"`
      return `MCP server "${error.serverName}" skipped — same command/URL as ${dup}`
    }
    case 'hook-load-failed':
      return `Hook load failed: ${error.reason}`
    case 'component-load-failed':
      return `${error.component} load failed from ${error.path}: ${error.reason}`
    case 'mcpb-download-failed':
      return `Failed to download MCPB from ${error.url}: ${error.reason}`
    case 'mcpb-extract-failed':
      return `Failed to extract MCPB ${error.mcpbPath}: ${error.reason}`
    case 'mcpb-invalid-manifest':
      return `MCPB manifest invalid at ${error.mcpbPath}: ${error.validationError}`
    case 'lsp-config-invalid':
      return `Plugin "${error.plugin}" has invalid LSP server config for "${error.serverName}": ${error.validationError}`
    case 'lsp-server-start-failed':
      return `Plugin "${error.plugin}" failed to start LSP server "${error.serverName}": ${error.reason}`
    case 'lsp-server-crashed':
      if (error.signal) {
        return `Plugin "${error.plugin}" LSP server "${error.serverName}" crashed with signal ${error.signal}`
      }
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" crashed with exit code ${error.exitCode ?? 'unknown'}`
    case 'lsp-request-timeout':
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" timed out on ${error.method} request after ${error.timeoutMs}ms`
    case 'lsp-request-failed':
      return `Plugin "${error.plugin}" LSP server "${error.serverName}" ${error.method} request failed: ${error.error}`
    case 'marketplace-blocked-by-policy':
      if (error.blockedByBlocklist) {
        return `Marketplace '${error.marketplace}' is blocked by enterprise policy`
      }
      return `Marketplace '${error.marketplace}' is not in the allowed marketplace list`
    case 'dependency-unsatisfied': {
      const hint =
        error.reason === 'not-enabled'
          ? 'disabled — enable it or remove the dependency'
          : 'not found in any configured marketplace'
      return `Dependency "${error.dependency}" is ${hint}`
    }
    case 'plugin-cache-miss':
      return `Plugin "${error.plugin}" not cached at ${error.installPath} — run /plugins to refresh`
  }
}
