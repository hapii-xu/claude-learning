import { z } from 'zod/v4'
import { HooksSchema } from '../../schemas/hooks.js'
import { McpServerConfigSchema } from '../../services/mcp/types.js'
import { lazySchema } from '../lazySchema.js'

/**
 * 防止官方 marketplace 冒充的第一层防线。
 *
 * 此校验阻止直接冒充尝试，如 "anthropic-official"、
 * "claude-marketplace" 等。间接变体（例如 "my-claude-marketplace"）
 * 不会被故意阻止，以避免对合法名称的误报。
 * 来源组织验证在注册/安装时提供额外保护。
 */

/**
 * 保留给 Anthropic/Claude 官方使用的 marketplace 名称。
 * 这些名称仅允许官方 marketplace 使用，第三方被阻止。
 */
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
])

/**
 * 默认不应自动更新的官方 marketplace。
 * 这些仍然是保留/允许的名称，但退出其他
 * 官方 marketplace 接收的自动更新默认值。
 */
const NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES = new Set(['knowledge-work-plugins'])

/**
 * 检查 marketplace 是否启用了自动更新。
 * 使用存储的值（如果已设置），否则基于是否为
 * Anthropic 官方 marketplace（true）或其他（false）进行默认。
 * NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES 中的官方 marketplace 被排除
 * 在自动更新默认值之外。
 *
 * @param marketplaceName - marketplace 名称
 * @param entry - marketplace 条目（可能已设置 autoUpdate）
 * @returns 此 marketplace 是否启用了自动更新
 */
export function isMarketplaceAutoUpdate(
  marketplaceName: string,
  entry: { autoUpdate?: boolean },
): boolean {
  const normalizedName = marketplaceName.toLowerCase()
  return (
    entry.autoUpdate ??
    (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalizedName) &&
      !NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES.has(normalizedName))
  )
}

/**
 * 检测冒充官方 Anthropic/Claude marketplace 的名称的模式。
 *
 * 匹配包含以下变体的名称：
 * - "official" 与 "anthropic" 或 "claude" 组合（例如 "official-claude-plugins"）
 * - "anthropic" 或 "claude" 与 "official" 组合（例如 "claude-official"）
 * - 以 "anthropic" 或 "claude" 开头，后跟听起来像官方的术语
 *   如 "marketplace"、"plugins"（例如 "anthropic-marketplace-new"、"claude-plugins-v2"）
 *
 * 模式不区分大小写。
 */
export const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(?:official[^a-z0-9]*(anthropic|claude)|(?:anthropic|claude)[^a-z0-9]*official|^(?:anthropic|claude)[^a-z0-9]*(marketplace|plugins|official))/i

/**
 * 检测可用于同形字攻击的非 ASCII 字符的模式。
 * Marketplace 名称应仅包含 ASCII 字符以防止通过
 * 外观相似的 Unicode 字符进行冒充（例如西里尔字母 'а' 代替拉丁字母 'a'）。
 */
const NON_ASCII_PATTERN = /[^\u0020-\u007E]/

/**
 * 检查 marketplace 名称是否冒充官方 Anthropic/Claude marketplace。
 *
 * @param name - 要检查的 marketplace 名称
 * @returns 如果名称被阻止（冒充官方）则返回 true，如果允许则返回 false
 */
export function isBlockedOfficialName(name: string): boolean {
  // 如果在允许列表中，则未被阻止
  if (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())) {
    return false
  }

  // 阻止包含非 ASCII 字符的名称以防止同形字攻击
  // （例如使用西里尔字母 'а' 冒充 'anthropic'）
  if (NON_ASCII_PATTERN.test(name)) {
    return true
  }

  // 检查是否匹配阻止模式
  return BLOCKED_OFFICIAL_NAME_PATTERN.test(name)
}

/**
 * Anthropic marketplace 的官方 GitHub 组织。
 * 保留名称必须来自此组织。
 */
export const OFFICIAL_GITHUB_ORG = 'anthropics'

/**
 * 验证具有保留名称的 marketplace 是否来自官方来源。
 *
 * 保留名称（在 ALLOWED_OFFICIAL_MARKETPLACE_NAMES 中）只能由
 * 来自官方 Anthropic GitHub 组织的 marketplace 使用。
 *
 * @param name - marketplace 名称
 * @param source - marketplace 来源配置
 * @returns 验证失败时的错误消息，有效时返回 null
 */
export function validateOfficialNameSource(
  name: string,
  source: { source: string; repo?: string; url?: string },
): string | null {
  const normalizedName = name.toLowerCase()

  // 仅验证保留名称
  if (!ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalizedName)) {
    return null // 不是保留名称，无需来源验证
  }

  // 检查 GitHub 来源类型
  if (source.source === 'github') {
    // 验证仓库来自官方组织
    const repo = source.repo || ''
    if (!repo.toLowerCase().startsWith(`${OFFICIAL_GITHUB_ORG}/`)) {
      return `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
    }
    return null // 有效：来自官方 GitHub 来源的保留名称
  }

  // 检查 git URL 来源类型
  if (source.source === 'git' && source.url) {
    const url = source.url.toLowerCase()
    // 检查 HTTPS URL 格式：https://github.com/anthropics/...
    // 或 SSH 格式：git@github.com:anthropics/...
    const isHttpsAnthropics = url.includes('github.com/anthropics/')
    const isSshAnthropics = url.includes('git@github.com:anthropics/')

    if (isHttpsAnthropics || isSshAnthropics) {
      return null // 有效：来自官方 git URL 的保留名称
    }

    return `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
  }

  // 保留名称必须来自 GitHub（'github' 或 'git' 来源）
  return `The name '${name}' is reserved for official Anthropic marketplaces and can only be used with GitHub sources from the '${OFFICIAL_GITHUB_ORG}' organization.`
}

/**
 * 必须以 './' 开头的相对文件路径的 schema
 */
const RelativePath = lazySchema(() => z.string().startsWith('./'))

/**
 * JSON 文件相对路径的 schema
 */
const RelativeJSONPath = lazySchema(() => RelativePath().endsWith('.json'))

/**
 * MCPB（MCP Bundle）文件路径的 schema
 * 支持本地相对路径和远程 URL
 */
const McpbPath = lazySchema(() =>
  z.union([
    RelativePath()
      .refine(path => path.endsWith('.mcpb') || path.endsWith('.dxt'), {
        message: 'MCPB file path must end with .mcpb or .dxt',
      })
      .describe('Path to MCPB file relative to plugin root'),
    z
      .string()
      .url()
      .refine(url => url.endsWith('.mcpb') || url.endsWith('.dxt'), {
        message: 'MCPB URL must end with .mcpb or .dxt',
      })
      .describe('URL to MCPB file'),
  ]),
)

/**
 * Markdown 文件相对路径的 schema
 */
const RelativeMarkdownPath = lazySchema(() => RelativePath().endsWith('.md'))

/**
 * 命令来源相对路径的 schema（markdown 文件或包含 SKILL.md 的目录）
 */
const RelativeCommandPath = lazySchema(() =>
  z.union([
    RelativeMarkdownPath(),
    RelativePath(), // Allow any relative path, including directories
  ]),
)

/**
 * 共享的 marketplace 名称验证。由 PluginMarketplaceSchema
 * （验证获取的 marketplace.json）和 MarketplaceSourceSchema 的
 * settings 分支（验证 settings.json 中的内联名称）共同使用。
 *
 * 两者必须保持同步：loadAndCacheMarketplace 的 case 'settings' 在
 * 写入后的 PluginMarketplaceSchema 验证运行之前写入
 * join(cacheDir, source.name)。任何通过 settings 分支但
 * PluginMarketplaceSchema 失败的名称会在缓存中留下孤立文件
 * （cleanupNeeded=false）。单个共享 schema 使漂移变得不可能。
 */
const MarketplaceNameSchema = lazySchema(() =>
  z
    .string()
    .min(1, 'Marketplace must have a name')
    .refine(name => !name.includes(' '), {
      message:
        'Marketplace name cannot contain spaces. Use kebab-case (e.g., "my-marketplace")',
    })
    .refine(
      name =>
        !name.includes('/') &&
        !name.includes('\\') &&
        !name.includes('..') &&
        name !== '.',
      {
        message:
          'Marketplace name cannot contain path separators (/ or \\), ".." sequences, or be "."',
      },
    )
    .refine(name => !isBlockedOfficialName(name), {
      message:
        'Marketplace name impersonates an official Anthropic/Claude marketplace',
    })
    .refine(name => name.toLowerCase() !== 'inline', {
      message:
        'Marketplace name "inline" is reserved for --plugin-dir session plugins',
    })
    .refine(name => name.toLowerCase() !== 'builtin', {
      message: 'Marketplace name "builtin" is reserved for built-in plugins',
    }),
)

/**
 * 插件作者信息的 schema
 */
export const PluginAuthorSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .min(1, 'Author name cannot be empty')
      .describe('Display name of the plugin author or organization'),
    email: z
      .string()
      .optional()
      .describe('Contact email for support or feedback'),
    url: z
      .string()
      .optional()
      .describe('Website, GitHub profile, or organization URL'),
  }),
)

/**
 * 插件清单文件（plugin.json）的元数据部分
 *
 * 此 schema 验证插件清单的结构，并在从磁盘加载插件时
 * 提供运行时类型检查。
 */
const PluginManifestMetadataSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .min(1, 'Plugin name cannot be empty')
      .refine(name => !name.includes(' '), {
        message:
          'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
      })
      .describe(
        'Unique identifier for the plugin, used for namespacing (prefer kebab-case)',
      ),
    version: z
      .string()
      .optional()
      .describe(
        'Semantic version (e.g., 1.2.3) following semver.org specification',
      ),
    description: z
      .string()
      .optional()
      .describe('Brief, user-facing explanation of what the plugin provides'),
    author: PluginAuthorSchema()
      .optional()
      .describe('Information about the plugin creator or maintainer'),
    homepage: z
      .string()
      .url()
      .optional()
      .describe('Plugin homepage or documentation URL'),
    repository: z.string().optional().describe('Source code repository URL'),
    license: z
      .string()
      .optional()
      .describe('SPDX license identifier (e.g., MIT, Apache-2.0)'),
    keywords: z
      .array(z.string())
      .optional()
      .describe('Tags for plugin discovery and categorization'),
    dependencies: z
      .array(DependencyRefSchema())
      .optional()
      .describe(
        'Plugins that must be enabled for this plugin to function. Bare names (no "@marketplace") are resolved against the declaring plugin\'s own marketplace.',
      ),
  }),
)

/**
 * 插件 hook 配置（hooks.json）的 schema
 *
 * 定义插件可以提供的 hook，用于在各种生命周期事件中
 * 拦截和修改 Claude Code 行为。
 */
export const PluginHooksSchema = lazySchema(() =>
  z.object({
    description: z
      .string()
      .optional()
      .describe('Brief, user-facing explanation of what these hooks provide'),
    hooks: z
      .lazy(() => HooksSchema())
      .describe(
        'The hooks provided by the plugin, in the same format as the one used for settings',
      ),
  }),
)

/**
 * 插件清单中额外 hook 配置的 schema
 *
 * 允许插件以内联方式或通过外部文件指定 hook，
 * 补充标准 hooks/hooks.json 位置定义的任何 hook。
 */
const PluginManifestHooksSchema = lazySchema(() =>
  z.object({
    hooks: z.union([
      RelativeJSONPath().describe(
        'Path to file with additional hooks (in addition to those in hooks/hooks.json, if it exists), relative to the plugin root',
      ),
      z
        .lazy(() => HooksSchema())
        .describe(
          'Additional hooks (in addition to those in hooks/hooks.json, if it exists)',
        ),
      z.array(
        z.union([
          RelativeJSONPath().describe(
            'Path to file with additional hooks (in addition to those in hooks/hooks.json, if it exists), relative to the plugin root',
          ),
          z
            .lazy(() => HooksSchema())
            .describe(
              'Additional hooks (in addition to those in hooks/hooks.json, if it exists)',
            ),
        ]),
      ),
    ]),
  }),
)

/**
 * 使用对象映射格式时命令元数据的 schema
 *
 * 允许 marketplace 条目为命令提供丰富的元数据，包括
 * 自定义描述和 frontmatter 覆盖。
 *
 * 命令可以通过以下方式定义：
 * - source：markdown 文件的路径
 * - content：内联 markdown 内容
 */
export const CommandMetadataSchema = lazySchema(() =>
  z
    .object({
      source: RelativeCommandPath()
        .optional()
        .describe('Path to command markdown file, relative to plugin root'),
      content: z
        .string()
        .optional()
        .describe('Inline markdown content for the command'),
      description: z
        .string()
        .optional()
        .describe('Command description override'),
      argumentHint: z
        .string()
        .optional()
        .describe('Hint for command arguments (e.g., "[file]")'),
      model: z.string().optional().describe('Default model for this command'),
      allowedTools: z
        .array(z.string())
        .optional()
        .describe('Tools allowed when command runs'),
    })
    .refine(
      data => (data.source && !data.content) || (!data.source && data.content),
      {
        message:
          'Command must have either "source" (file path) or "content" (inline markdown), but not both',
      },
    ),
)

/**
 * 插件清单中额外命令定义的 schema
 *
 * 允许插件指定超出标准 commands/ 目录的额外命令文件或
 * skill 目录。
 *
 * 支持三种格式：
 * 1. 单一路径："./README.md"
 * 2. 路径数组：["./README.md", "./docs/guide.md"]
 * 3. 对象映射：{ "about": { "source": "./README.md", "description": "..." } }
 */
const PluginManifestCommandsSchema = lazySchema(() =>
  z.object({
    commands: z.union([
      // TODO（未来工作）：允许通配符？
      RelativeCommandPath().describe(
        'Path to additional command file or skill directory (in addition to those in the commands/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativeCommandPath().describe(
            'Path to additional command file or skill directory (in addition to those in the commands/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe(
          'List of paths to additional command files or skill directories',
        ),
      z
        .record(z.string(), CommandMetadataSchema())
        .describe(
          'Object mapping of command names to their metadata and source files. Command name becomes the slash command name (e.g., "about" → "/plugin:about")',
        ),
    ]),
  }),
)

/**
 * 插件清单中额外 agent 定义的 schema
 *
 * 允许插件指定超出标准 agents/ 目录的额外 agent 文件。
 */
const PluginManifestAgentsSchema = lazySchema(() =>
  z.object({
    agents: z.union([
      // TODO（未来工作）：允许通配符？
      RelativeMarkdownPath().describe(
        'Path to additional agent file (in addition to those in the agents/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativeMarkdownPath().describe(
            'Path to additional agent file (in addition to those in the agents/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe('List of paths to additional agent files'),
    ]),
  }),
)

/**
 * 插件清单中额外 skill 定义的 schema
 *
 * 允许插件指定超出标准 skills/ 目录的额外 skill 目录。
 */
const PluginManifestSkillsSchema = lazySchema(() =>
  z.object({
    skills: z.union([
      RelativePath().describe(
        'Path to additional skill directory (in addition to those in the skills/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativePath().describe(
            'Path to additional skill directory (in addition to those in the skills/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe('List of paths to additional skill directories'),
    ]),
  }),
)

/**
 * 插件清单中额外 output style 定义的 schema
 *
 * 允许插件指定超出标准 output-styles/ 目录的额外 output style 文件或目录。
 */
const PluginManifestOutputStylesSchema = lazySchema(() =>
  z.object({
    outputStyles: z.union([
      RelativePath().describe(
        'Path to additional output styles directory or file (in addition to those in the output-styles/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativePath().describe(
            'Path to additional output styles directory or file (in addition to those in the output-styles/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe(
          'List of paths to additional output styles directories or files',
        ),
    ]),
  }),
)

// LSP 配置的辅助验证器
const nonEmptyString = lazySchema(() => z.string().min(1))
const fileExtension = lazySchema(() =>
  z
    .string()
    .min(2)
    .refine(ext => ext.startsWith('.'), {
      message: 'File extensions must start with dot (e.g., ".ts", not "ts")',
    }),
)

/**
 * 插件清单中 MCP 服务器配置的 schema
 *
 * 允许插件以内联方式或通过外部配置文件提供 MCP 服务器，
 * 补充 .mcp.json 中的任何服务器。
 */
const PluginManifestMcpServerSchema = lazySchema(() =>
  z.object({
    mcpServers: z.union([
      RelativeJSONPath().describe(
        'MCP servers to include in the plugin (in addition to those in the .mcp.json file, if it exists)',
      ),
      McpbPath().describe(
        'Path or URL to MCPB file containing MCP server configuration',
      ),
      z
        .record(z.string(), McpServerConfigSchema())
        .describe('MCP server configurations keyed by server name'),
      z
        .array(
          z.union([
            RelativeJSONPath().describe(
              'Path to MCP servers configuration file',
            ),
            McpbPath().describe('Path or URL to MCPB file'),
            z
              .record(z.string(), McpServerConfigSchema())
              .describe('Inline MCP server configurations'),
          ]),
        )
        .describe(
          'Array of MCP server configurations (paths, MCPB files, or inline definitions)',
        ),
    ]),
  }),
)

/**
 * 插件清单 userConfig 中单个用户可配置选项的 schema。
 *
 * 形状故意与 `@anthropic-ai/mcpb` 中的 `McpbUserConfigurationOption`
 * 匹配，以便解析结果在结构上可赋值给 mcpbHandler.ts 中的
 * `UserConfigSchema` — 这让我们可以重用 `validateUserConfig`
 * 和配置对话框而无需修改。`title` 和 `description` 是必需的
 * （非可选），因为上游类型需要它们且配置对话框会渲染它们。
 *
 * 由顶层 manifest.userConfig 和 per-channel channels[].userConfig
 * （assistant-mode 通道）共同使用。
 */
const PluginUserConfigOptionSchema = lazySchema(() =>
  z
    .object({
      type: z
        .enum(['string', 'number', 'boolean', 'directory', 'file'])
        .describe('Type of the configuration value'),
      title: z
        .string()
        .describe('Human-readable label shown in the config dialog'),
      description: z
        .string()
        .describe('Help text shown beneath the field in the config dialog'),
      required: z
        .boolean()
        .optional()
        .describe('If true, validation fails when this field is empty'),
      default: z
        .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
        .optional()
        .describe('Default value used when the user provides nothing'),
      multiple: z
        .boolean()
        .optional()
        .describe('For string type: allow an array of strings'),
      sensitive: z
        .boolean()
        .optional()
        .describe(
          'If true, masks dialog input and stores value in secure storage (keychain/credentials file) instead of settings.json',
        ),
      min: z.number().optional().describe('Minimum value (number type only)'),
      max: z.number().optional().describe('Maximum value (number type only)'),
    })
    .strict(),
)

/**
 * 插件清单中顶层 userConfig 字段的 schema。
 *
 * 声明插件需要的用户可配置值。用户在启用时收到提示。
 * 非敏感值进入 settings.json pluginConfigs[pluginId].options；
 * 敏感值进入安全存储。值可在 MCP/LSP 服务器配置、hook
 * 命令以及（仅非敏感）skill/agent 内容中作为 ${user_config.KEY} 使用。
 */
const PluginManifestUserConfigSchema = lazySchema(() =>
  z.object({
    userConfig: z
      .record(
        z
          .string()
          .regex(
            /^[A-Za-z_]\w*$/,
            'Option keys must be valid identifiers (letters, digits, underscore; no leading digit) — they become CLAUDE_PLUGIN_OPTION_<KEY> env vars in hooks',
          ),
        PluginUserConfigOptionSchema(),
      )
      .optional()
      .describe(
        'User-configurable values this plugin needs. Prompted at enable time. ' +
          'Non-sensitive values saved to settings.json; sensitive values to secure storage ' +
          // biome-ignore lint/suspicious/noTemplateCurlyInString: ${user_config.KEY} is plugin config syntax documentation, not a JS template literal
          '(macOS keychain or .credentials.json). Available as ${user_config.KEY} in ' +
          'MCP/LSP server config, hook commands, and (non-sensitive only) skill/agent content. ' +
          'Note: sensitive values share a single keychain entry with OAuth tokens — keep ' +
          'secret counts small to stay under the ~2KB stdin-safe limit (see INC-3028).',
      ),
  }),
)

/**
 * 插件清单中 channel 声明的 schema。
 *
 * Channel 是一个 MCP 服务器，用于发出 `notifications/claude/channel`
 * 以将消息注入对话（Telegram、Slack、Discord 等）。在此声明
 * 允许插件在安装时通过 PluginOptionsFlow 提示用户配置
 * （bot token、所有者 ID），而不是要求用户手动编辑 settings.json。
 *
 * `server` 字段必须与插件 `mcpServers` 中的键匹配 — 这在
 * schema 解析时不进行交叉验证（mcpServers 字段可能是
 * 我们尚未读取的 JSON 文件的路径），因此检查在
 * mcpPluginIntegration.ts 的加载时进行。
 */
const PluginManifestChannelsSchema = lazySchema(() =>
  z.object({
    channels: z
      .array(
        z
          .object({
            server: z
              .string()
              .min(1)
              .describe(
                "Name of the MCP server this channel binds to. Must match a key in this plugin's mcpServers.",
              ),
            displayName: z
              .string()
              .optional()
              .describe(
                'Human-readable name shown in the config dialog title (e.g., "Telegram"). Defaults to the server name.',
              ),
            userConfig: z
              .record(z.string(), PluginUserConfigOptionSchema())
              .optional()
              .describe(
                'Fields to prompt the user for when enabling this plugin in assistant mode. ' +
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: ${user_config.KEY} is plugin config syntax documentation, not a JS template literal
                  'Saved values are substituted into ${user_config.KEY} references in the mcpServers env.',
              ),
          })
          .strict(),
      )
      .describe(
        'Channels this plugin provides. Each entry declares an MCP server as a message channel ' +
          'and optionally specifies user configuration to prompt for at enable time.',
      ),
  }),
)

/**
 * 单个 LSP 服务器配置的 schema。
 */
export const LspServerConfigSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .min(1)
      .refine(
        cmd => {
          // 包含空格的命令应使用 args 数组
          if (cmd.includes(' ') && !cmd.startsWith('/')) {
            return false
          }
          return true
        },
        {
          message:
            'Command should not contain spaces. Use args array for arguments.',
        },
      )
      .describe(
        'Command to execute the LSP server (e.g., "typescript-language-server")',
      ),
    args: z
      .array(nonEmptyString())
      .optional()
      .describe('Command-line arguments to pass to the server'),
    extensionToLanguage: z
      .record(fileExtension(), nonEmptyString())
      .refine(record => Object.keys(record).length > 0, {
        message: 'extensionToLanguage must have at least one mapping',
      })
      .describe(
        'Mapping from file extension to LSP language ID. File extensions and languages are derived from this mapping.',
      ),
    transport: z
      .enum(['stdio', 'socket'])
      .default('stdio')
      .describe('Communication transport mechanism'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables to set when starting the server'),
    initializationOptions: z
      .unknown()
      .optional()
      .describe(
        'Initialization options passed to the server during initialization',
      ),
    settings: z
      .unknown()
      .optional()
      .describe(
        'Settings passed to the server via workspace/didChangeConfiguration',
      ),
    workspaceFolder: z
      .string()
      .optional()
      .describe('Workspace folder path to use for the server'),
    startupTimeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum time to wait for server startup (milliseconds)'),
    shutdownTimeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum time to wait for graceful shutdown (milliseconds)'),
    restartOnCrash: z
      .boolean()
      .optional()
      .describe('Whether to restart the server if it crashes'),
    maxRestarts: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Maximum number of restart attempts before giving up'),
  }),
)

/**
 * 插件清单中 LSP 服务器声明的 schema。
 * 支持多种格式：
 * - 字符串：.lsp.json 文件的路径
 * - 对象：内联服务器配置 { "serverName": {...} }
 * - 数组：字符串和对象的混合
 */
const PluginManifestLspServerSchema = lazySchema(() =>
  z.object({
    lspServers: z.union([
      RelativeJSONPath().describe(
        'Path to .lsp.json configuration file relative to plugin root',
      ),
      z
        .record(z.string(), LspServerConfigSchema())
        .describe('LSP server configurations keyed by server name'),
      z
        .array(
          z.union([
            RelativeJSONPath().describe('Path to LSP configuration file'),
            z
              .record(z.string(), LspServerConfigSchema())
              .describe('Inline LSP server configurations'),
          ]),
        )
        .describe(
          'Array of LSP server configurations (paths or inline definitions)',
        ),
    ]),
  }),
)

/**
 * npm 包名称的 schema
 *
 * 验证 npm 包名称，包括作用域包。
 * 通过禁止 '..' 和 '//' 来防止路径遍历攻击。
 *
 * 有效示例：
 * - "express"
 * - "@babel/core"
 * - "lodash.debounce"
 *
 * 无效示例：
 * - "../../../etc/passwd"
 * - "package//name"
 */
const NpmPackageNameSchema = lazySchema(() =>
  z
    .string()
    .refine(
      name => !name.includes('..') && !name.includes('//'),
      'Package name cannot contain path traversal patterns',
    )
    .refine(name => {
      // 允许作用域包（@org/package）和普通包
      const scopedPackageRegex = /^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/
      const regularPackageRegex = /^[a-z0-9][a-z0-9-._]*$/
      return scopedPackageRegex.test(name) || regularPackageRegex.test(name)
    }, 'Invalid npm package name format'),
)

/**
 * 合并到设置级联中的插件设置的 schema。
 * 此处接受任何记录；在 pluginLoader.ts 中通过
 * PluginSettingsSchema（派生自 SettingsSchema）在加载时过滤到白名单键。
 */
const PluginManifestSettingsSchema = lazySchema(() =>
  z.object({
    settings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Settings to merge when plugin is enabled. ' +
          'Only allowlisted keys are kept (currently: agent)',
      ),
  }),
)

/**
 * 插件清单文件（plugin.json）
 *
 * 此 schema 验证插件清单的结构，并在从磁盘加载插件时
 * 提供运行时类型检查。
 *
 * 未知的顶层字段会被静默剥离（zod 默认行为）而非拒绝。
 * 这使插件加载对插件作者可能添加的自定义/未来顶层字段
 * 具有韧性。嵌套配置对象（userConfig 选项、channels、
 * lspServers）保持严格 — 其中的未知键仍然失败，因为那里
 * 的拼写错误更可能是作者的错误而非供应商扩展。类型不匹配
 * 和其他验证错误在所有层级仍然失败。有关未知顶层字段的
 * 开发者反馈，请使用 `claude plugin validate`。
 */
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)

/**
 * marketplace 来源位置的 schema
 *
 * 定义引用 marketplace 清单的各种方式，包括
 * 直接 URL、GitHub 仓库、git URL、npm 包和本地路径。
 */
export const MarketplaceSourceSchema = lazySchema(() =>
  z.discriminatedUnion('source', [
    z.object({
      source: z.literal('url'),
      url: z.string().url().describe('Direct URL to marketplace.json file'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Custom HTTP headers (e.g., for authentication)'),
    }),
    z.object({
      source: z.literal('github'),
      repo: z.string().describe('GitHub repository in owner/repo format'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Path to marketplace.json within repo (defaults to .claude-plugin/marketplace.json)',
        ),
      sparsePaths: z
        .array(z.string())
        .optional()
        .describe(
          'Directories to include via git sparse-checkout (cone mode). ' +
            'Use for monorepos where the marketplace lives in a subdirectory. ' +
            'Example: [".claude-plugin", "plugins"]. ' +
            'If omitted, the full repository is cloned.',
        ),
    }),
    z.object({
      source: z.literal('git'),
      // 此处不使用 .endsWith('.git') — 这是 GitHub/GitLab/Bitbucket
      // 约定，不是 git 要求。Azure DevOps 使用
      // https://dev.azure.com/{org}/{proj}/_git/{repo}，没有后缀，
      // 追加 .git 会使 ADO 查找字面名为 {repo}.git 的仓库
      // （TF401019）。AWS CodeCommit 也省略后缀。如果用户
      // 明确写了 source:'git'，他们知道这是一个 git 仓库；
      // 拼写错误的 URL 无论如何都会在 `git clone` 时失败并
      // 给出更清晰的错误。（gh-31256）
      url: z.string().describe('Full git repository URL'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Path to marketplace.json within repo (defaults to .claude-plugin/marketplace.json)',
        ),
      sparsePaths: z
        .array(z.string())
        .optional()
        .describe(
          'Directories to include via git sparse-checkout (cone mode). ' +
            'Use for monorepos where the marketplace lives in a subdirectory. ' +
            'Example: [".claude-plugin", "plugins"]. ' +
            'If omitted, the full repository is cloned.',
        ),
    }),
    z.object({
      source: z.literal('npm'),
      package: NpmPackageNameSchema().describe(
        'NPM package containing marketplace.json',
      ),
    }),
    z.object({
      source: z.literal('file'),
      path: z.string().describe('Local file path to marketplace.json'),
    }),
    z.object({
      source: z.literal('directory'),
      path: z
        .string()
        .describe('Local directory containing .claude-plugin/marketplace.json'),
    }),
    z.object({
      source: z.literal('hostPattern'),
      hostPattern: z
        .string()
        .describe(
          'Regex pattern to match the host/domain extracted from any marketplace source type. ' +
            'For github sources, matches against "github.com". For git sources (SSH or HTTPS), ' +
            'extracts the hostname from the URL. Use in strictKnownMarketplaces to allow all ' +
            'marketplaces from a specific host (e.g., "^github\\.mycompany\\.com$").',
        ),
    }),
    z.object({
      source: z.literal('pathPattern'),
      pathPattern: z
        .string()
        .describe(
          'Regex pattern matched against the .path field of file and directory sources. ' +
            'Use in strictKnownMarketplaces to allow filesystem-based marketplaces alongside ' +
            'hostPattern restrictions for network sources. Use ".*" to allow all filesystem ' +
            'paths, or a narrower pattern (e.g., "^/opt/approved/") to restrict to specific ' +
            'directories.',
        ),
    }),
    z
      .object({
        source: z.literal('settings'),
        name: MarketplaceNameSchema()
          .refine(
            name => !ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase()),
            {
              message:
                'Reserved official marketplace names cannot be used with settings sources. ' +
                'validateOfficialNameSource only accepts github/git sources from anthropics/* ' +
                'for these names; a settings source would be rejected after ' +
                'loadAndCacheMarketplace has already written to disk with cleanupNeeded=false.',
            },
          )
          .describe(
            'Marketplace name. Must match the extraKnownMarketplaces key (enforced); ' +
              'the synthetic manifest is written under this name. Same validation ' +
              'as PluginMarketplaceSchema plus reserved-name rejection \u2014 ' +
              'validateOfficialNameSource runs after the disk write, too late to clean up.',
          ),
        plugins: z
          .array(SettingsMarketplacePluginSchema())
          .describe('Plugin entries declared inline in settings.json'),
        owner: PluginAuthorSchema().optional(),
      })
      .describe(
        'Inline marketplace manifest defined directly in settings.json. ' +
          'The reconciler writes a synthetic marketplace.json to the cache; ' +
          'diffMarketplaces detects edits via isEqual on the stored source ' +
          '(the plugins array is inside this object, so edits surface as sourceChanged).',
      ),
  ]),
)

export const gitSha = lazySchema(() =>
  z
    .string()
    .length(40)
    .regex(
      /^[a-f0-9]{40}$/,
      'Must be a full 40-character lowercase git commit SHA',
    ),
)

/**
 * 插件来源位置的 schema
 *
 * 定义引用和安装插件的各种方式，包括
 * 本地路径、npm 包、Python 包、git URL 和 GitHub 仓库。
 */
export const PluginSourceSchema = lazySchema(() =>
  z.union([
    RelativePath().describe(
      'Path to the plugin root, relative to the marketplace root (the directory containing .claude-plugin/, not .claude-plugin/ itself)',
    ),
    z
      .object({
        source: z.literal('npm'),
        package: NpmPackageNameSchema()
          .or(z.string()) // 同时允许 URL 和本地路径
          .describe(
            'Package name (or url, or local path, or anything else that can be passed to `npm` as a package)',
          ),
        version: z
          .string()
          .optional()
          .describe('Specific version or version range (e.g., ^1.0.0, ~2.1.0)'),
        registry: z
          .string()
          .url()
          .optional()
          .describe(
            'Custom NPM registry URL (defaults to using system default, likely npmjs.org)',
          ),
      })
      .describe('NPM package as plugin source'),
    z
      .object({
        source: z.literal('pip'),
        package: z
          .string()
          .describe('Python package name as it appears on PyPI'),
        version: z
          .string()
          .optional()
          .describe('Version specifier (e.g., ==1.0.0, >=2.0.0, <3.0.0)'),
        registry: z
          .string()
          .url()
          .optional()
          .describe(
            'Custom PyPI registry URL (defaults to using system default, likely pypi.org)',
          ),
      })
      .describe('Python package as plugin source'),
    z.object({
      source: z.literal('url'),
      // 关于 MarketplaceSourceSchema source:'git' 中 .endsWith('.git') 的说明
      // — 已删除以支持 Azure DevOps / CodeCommit URL（gh-31256）。
      url: z.string().describe('Full git repository URL (https:// or git@)'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      sha: gitSha().optional().describe('Specific commit SHA to use'),
    }),
    z.object({
      source: z.literal('github'),
      repo: z.string().describe('GitHub repository in owner/repo format'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      sha: gitSha().optional().describe('Specific commit SHA to use'),
    }),
    z
      .object({
        source: z.literal('git-subdir'),
        url: z
          .string()
          .describe(
            'Git repository: GitHub owner/repo shorthand, https://, or git@ URL',
          ),
        path: z
          .string()
          .min(1)
          .describe(
            'Subdirectory within the repo containing the plugin (e.g., "tools/claude-plugin"). ' +
              'Cloned sparsely using partial clone (--filter=tree:0) to minimize bandwidth for monorepos.',
          ),
        ref: z
          .string()
          .optional()
          .describe(
            'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
          ),
        sha: gitSha().optional().describe('Specific commit SHA to use'),
      })
      .describe(
        'Plugin located in a subdirectory of a larger repository (monorepo). ' +
          'Only the specified subdirectory is materialized; the rest of the repo is not downloaded.',
      ),
    // TODO（未来工作）gist
    // TODO（未来工作）单文件？
  ]),
)

/**
 * 来源于 settings 的 marketplace 的窄插件条目。
 *
 * 来源于 settings 的 marketplace 指向拥有自己 plugin.json 的
 * 远程插件 — 没有理由在 settings.json 中内联 commands/agents/hooks/mcp/lsp。
 * 此 schema 仅携带 loadPluginFromMarketplaceEntry 读取的内容
 * （name、source、version、strict）加上 description 以便发现。
 *
 * loadAndCacheMarketplace 写入的合成 marketplace.json 通过完整的
 * PluginMarketplaceSchema 重新解析，后者将这些窄条目拓宽回
 * PluginMarketplaceEntry（strict 获得其 .default(true)，其他保持
 * undefined）。所以这种窄度仅限 settings 表面；下游代码看到
 * 的形状与任何稀疏 marketplace.json 条目相同。
 *
 * 保持窄度可防止 PluginManifestSchema().partial() 在
 * settingsTypes.generated.ts 中内联展开 — 该展开每次约 ~870 行，
 * 而 MarketplaceSource 在 settings schema 中出现三次
 * （extraKnownMarketplaces、strictKnownMarketplaces、blockedMarketplaces）。
 */
const SettingsMarketplacePluginSchema = lazySchema(() =>
  z
    .object({
      name: z
        .string()
        .min(1, 'Plugin name cannot be empty')
        .refine(name => !name.includes(' '), {
          message:
            'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
        })
        .describe('Plugin name as it appears in the target repository'),
      source: PluginSourceSchema().describe(
        'Where to fetch the plugin from. Must be a remote source — relative ' +
          'paths have no marketplace repository to resolve against.',
      ),
      description: z.string().optional(),
      version: z.string().optional(),
      strict: z.boolean().optional(),
    })
    .refine(p => typeof p.source !== 'string', {
      message:
        'Plugins in a settings-sourced marketplace must use remote sources ' +
        '(github, git-subdir, npm, url, pip). Relative-path sources like "./foo" ' +
        'have no marketplace repository to resolve against.',
    }),
)

/**
 * 检查插件来源是否为本地路径（存储在 marketplace 目录中）。
 *
 * 本地插件的来源为以 './' 开头的字符串（相对于 marketplace）。
 * 外部插件的来源为对象（npm、pip、git、github 等）。
 *
 * 此函数提供 './' 前缀检查的语义包装，使
 * 意图明确并集中确定插件来源类型的逻辑。
 *
 * @param source 来自 PluginMarketplaceEntry 的插件来源
 * @returns 如果来源是本地路径则返回 true，如果是外部来源则返回 false
 */
export function isLocalPluginSource(source: PluginSource): source is string {
  return typeof source === 'string' && source.startsWith('./')
}

/**
 * marketplace 来源是否指向用户控制的本地文件系统路径。
 *
 * 对于本地来源（`file`/`directory`），`installLocation` 就是用户的路径 —
 * 它位于插件缓存目录之外，对其的 marketplace 操作是只读的。
 * 对于远程来源（`github`/`git`/`url`/`npm`），`installLocation`
 * 是由 Claude Code 管理的缓存目录条目，可以被 rm/重新克隆。
 *
 * 与 isLocalPluginSource 对比，后者操作 PluginSource（marketplace 条目内
 * 的每插件来源）并检查 `./` 前缀。
 */
export function isLocalMarketplaceSource(
  source: MarketplaceSource,
): source is Extract<MarketplaceSource, { source: 'file' | 'directory' }> {
  return source.source === 'file' || source.source === 'directory'
}

/**
 * marketplace 中单个插件条目的 schema
 *
 * 当 strict=true（默认）：需要 Plugin.json，marketplace 字段补充它
 * 当 strict=false：Plugin.json 可选，marketplace 提供完整清单
 *
 * 未知字段会被静默剥离（zod 默认行为）而非拒绝。
 * Marketplace 条目作为数组验证 — 如果一个条目拒绝
 * 未知键，整个 marketplace.json 将无法解析，该 marketplace 中的
 * 所有插件都将不可用。剥离使自定义/未来字段的
 * 影响范围为零。
 */
export const PluginMarketplaceEntrySchema = lazySchema(() =>
  PluginManifestSchema()
    .partial()
    .extend({
      name: z
        .string()
        .min(1, 'Plugin name cannot be empty')
        .refine(name => !name.includes(' '), {
          message:
            'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
        })
        .describe('Unique identifier matching the plugin name'),
      source: PluginSourceSchema().describe('Where to fetch the plugin from'),
      category: z
        .string()
        .optional()
        .describe(
          'Category for organizing plugins (e.g., "productivity", "development")',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe('Tags for searchability and discovery'),
      strict: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Require the plugin manifest to be present in the plugin folder. If false, the marketplace entry provides the manifest.',
        ),
    }),
)

/**
 * 插件 marketplace 配置的 schema
 *
 * 定义可以从中央仓库发现和安装的策划插件集合的结构。
 */
export const PluginMarketplaceSchema = lazySchema(() =>
  z.object({
    name: MarketplaceNameSchema(),
    owner: PluginAuthorSchema().describe(
      'Marketplace maintainer or curator information',
    ),
    plugins: z
      .array(PluginMarketplaceEntrySchema())
      .describe('Collection of available plugins in this marketplace'),
    forceRemoveDeletedPlugins: z
      .boolean()
      .optional()
      .describe(
        'When true, plugins removed from this marketplace will be automatically uninstalled and flagged for users',
      ),
    metadata: z
      .object({
        pluginRoot: z
          .string()
          .optional()
          .describe('Base path for relative plugin sources'),
        version: z.string().optional().describe('Marketplace version'),
        description: z.string().optional().describe('Marketplace description'),
      })
      .optional()
      .describe('Optional marketplace metadata'),
    allowCrossMarketplaceDependenciesOn: z
      .array(z.string())
      .optional()
      .describe(
        "Marketplace names whose plugins may be auto-installed as dependencies. Only the root marketplace's allowlist applies \u2014 no transitive trust.",
      ),
  }),
)

/**
 * 插件 ID 格式的 schema
 *
 * 插件 ID 遵循格式："plugin-name@marketplace-name"
 * 两部分都允许字母数字、连字符、点和下划线。
 *
 * 示例：
 * - "code-formatter@anthropic-tools"
 * - "db_assistant@company-internal"
 * - "my.plugin@personal-marketplace"
 */
export const PluginIdSchema = lazySchema(() =>
  z
    .string()
    .regex(
      /^[a-z0-9][-a-z0-9._]*@[a-z0-9][-a-z0-9._]*$/i,
      'Plugin ID must be in format: plugin@marketplace',
    ),
)

const DEP_REF_REGEX =
  /^[a-z0-9][-a-z0-9._]*(@[a-z0-9][-a-z0-9._]*)?(@\^[^@]*)?$/i

/**
 * 插件 `dependencies` 数组中条目的 schema。
 *
 * 接受三种形式，全部通过 transform 规范化为纯 "name" 或 "name@mkt" 字符串
 * — 下游代码（qualifyDependency、resolveDependencyClosure、
 * verifyAndDemote）永远不会看到版本或对象：
 *
 *   "plugin"                → 裸名，相对于声明插件的 marketplace 解析
 *   "plugin@marketplace"    → 限定名
 *   "plugin@mkt@^1.2"       → 尾部 @^version 被静默剥离（向前兼容）
 *   {name, marketplace?, …} → 对象形式，version 等被剥离（向前兼容）
 *
 * 后两种被允许但被忽略，以便未来添加版本约束的客户端
 * 不会导致旧客户端 schema 验证失败并拒绝整个插件。
 * 参见 CC-993 了解最终的版本范围设计。
 */
export const DependencyRefSchema = lazySchema(() =>
  z.union([
    z
      .string()
      .regex(
        DEP_REF_REGEX,
        'Dependency must be a plugin name, optionally qualified with @marketplace',
      )
      .transform(s => s.replace(/@\^[^@]*$/, '')),
    z
      .object({
        name: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i),
        marketplace: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i)
          .optional(),
      })
      .loose()
      .transform(o => (o.marketplace ? `${o.name}@${o.marketplace}` : o.name)),
  ]),
)

/**
 * settings 中插件引用的 schema（仓库或用户级别）
 *
 * 可以是以下两种：
 * - 简单字符串："plugin-name@marketplace-name"
 * - 带有额外配置的对象
 *
 * 插件来源（npm、git、本地）在 marketplace 条目本身中定义，
 * 而非在插件引用中。
 *
 * 示例：
 * - "code-formatter@anthropic-tools"
 * - "db-assistant@company-internal"
 * - { id: "formatter@tools", version: "^2.0.0", required: true }
 */
export const SettingsPluginEntrySchema = lazySchema(() =>
  z.union([
    // 简单格式："plugin@marketplace"
    PluginIdSchema(),
    // 带有配置的扩展格式
    z.object({
      id: PluginIdSchema().describe(
        'Plugin identifier (e.g., "formatter@tools")',
      ),
      version: z
        .string()
        .optional()
        .describe('Version constraint (e.g., "^2.0.0")'),
      required: z.boolean().optional().describe('If true, cannot be disabled'),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Plugin-specific configuration'),
    }),
  ]),
)

/**
 * 已安装插件元数据的 schema（V1 格式）
 *
 * 跟踪插件的实际安装状态。所有插件都从 marketplace 安装，
 * marketplace 包含实际的来源详细信息（npm、git、本地等）。
 * 插件 ID 是 plugins 记录中的键，因此此处不重复。
 *
 * 键 "code-formatter@anthropic-tools" 的示例条目：
 * {
 *   "version": "1.2.0",
 *   "installedAt": "2024-01-15T10:30:00Z",
 *   "marketplace": "anthropic-tools",
 *   "installPath": "/home/user/.hclaude/plugins/installed/anthropic-tools/code-formatter"
 * }
 */
export const InstalledPluginSchema = lazySchema(() =>
  z.object({
    version: z.string().describe('Currently installed version'),
    installedAt: z.string().describe('ISO 8601 timestamp of installation'),
    lastUpdated: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of last update'),
    installPath: z
      .string()
      .describe('Absolute path to the installed plugin directory'),
    gitCommitSha: z
      .string()
      .optional()
      .describe('Git commit SHA for git-based plugins (for version tracking)'),
  }),
)

/**
 * installed_plugins.json 文件的 schema（V1 格式）
 *
 * 包含版本号和插件 ID 到其安装元数据的映射。
 * 由 Claude Code 自动维护，不由用户编辑。
 *
 * 版本字段跟踪 schema 变更。当版本与当前
 * schema 版本不匹配时，Claude Code 将在下次启动时更新文件。
 *
 * 示例文件：
 * {
 *   "version": 1,
 *   "plugins": {
 *     "code-formatter@anthropic-tools": { ... },
 *     "db-assistant@company-internal": { ... }
 *   }
 * }
 */
export const InstalledPluginsFileSchemaV1 = lazySchema(() =>
  z.object({
    version: z.literal(1).describe('Schema version 1'),
    plugins: z
      .record(
        PluginIdSchema(), // Validated plugin ID key (e.g., "formatter@tools")
        InstalledPluginSchema(),
      )
      .describe('Map of plugin IDs to their installation metadata'),
  }),
)

/**
 * 插件安装的 scope 类型（V2）
 *
 * 插件可以在不同 scope 安装：
 * - managed：企业/系统范围（只读，平台特定路径）
 * - user：用户全局设置（~/.hclaude/settings.json）
 * - project：共享项目设置（$project/.hclaude/settings.json）
 * - local：个人项目覆盖（$project/.hclaude/settings.local.json）
 *
 * 注意：'flag' scope 插件（来自 --settings）仅限会话，
 * 不会持久化到 installed_plugins.json。
 */
export const PluginScopeSchema = lazySchema(() =>
  z.enum(['managed', 'user', 'project', 'local']),
)

/**
 * 单个插件安装条目的 schema（V2）
 *
 * 每个插件可以在不同 scope 有多个安装。
 * 例如，同一插件可以在 user scope 安装 v1.0，
 * 在 project scope 安装 v1.1。
 */
export const PluginInstallationEntrySchema = lazySchema(() =>
  z.object({
    scope: PluginScopeSchema().describe('Installation scope'),
    projectPath: z
      .string()
      .optional()
      .describe('Project path (required for project/local scopes)'),
    installPath: z
      .string()
      .describe('Absolute path to the versioned plugin directory'),
    // 从 V1 保留：
    version: z.string().optional().describe('Currently installed version'),
    installedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of installation'),
    lastUpdated: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of last update'),
    gitCommitSha: z
      .string()
      .optional()
      .describe('Git commit SHA for git-based plugins'),
  }),
)

/**
 * installed_plugins.json 文件的 schema（V2 格式）
 *
 * V2 从 V1 的变更：
 * - 每个插件 ID 映射到安装数组（每个 scope 一个）
 * - 支持多 scope 安装（同一插件在不同 scope/版本）
 *
 * 示例文件：
 * {
 *   "version": 2,
 *   "plugins": {
 *     "code-formatter@anthropic-tools": [
 *       { "scope": "user", "installPath": "...", "version": "1.0.0" },
 *       { "scope": "project", "projectPath": "/path/to/project", "installPath": "...", "version": "1.1.0" }
 *     ]
 *   }
 * }
 */
export const InstalledPluginsFileSchemaV2 = lazySchema(() =>
  z.object({
    version: z.literal(2).describe('Schema version 2'),
    plugins: z
      .record(PluginIdSchema(), z.array(PluginInstallationEntrySchema()))
      .describe('Map of plugin IDs to arrays of installation entries'),
  }),
)

/**
 * 接受 V1 和 V2 两种格式的组合 schema
 * 用于迁移前读取现有文件
 */
export const InstalledPluginsFileSchema = lazySchema(() =>
  z.union([InstalledPluginsFileSchemaV1(), InstalledPluginsFileSchemaV2()]),
)

/**
 * 已知 marketplace 条目的 schema
 *
 * 跟踪用户配置中已注册 marketplace 的元数据。
 * 每个条目包含来源位置、缓存路径和上次更新时间。
 *
 * 示例条目：
 * {
 *   "source": { "source": "github", "repo": "anthropic/claude-plugins" },
 *   "installLocation": "/home/user/.hclaude/plugins/cached/marketplaces/anthropic-tools",
 *   "lastUpdated": "2024-01-15T10:30:00Z"
 * }
 */
export const KnownMarketplaceSchema = lazySchema(() =>
  z.object({
    source: MarketplaceSourceSchema().describe(
      'Where to fetch the marketplace from',
    ),
    installLocation: z
      .string()
      .describe('Local cache path where marketplace manifest is stored'),
    lastUpdated: z
      .string()
      .describe('ISO 8601 timestamp of last marketplace refresh'),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Whether to automatically update this marketplace and its installed plugins on startup',
      ),
  }),
)

/**
 * known_marketplaces.json 文件的 schema
 *
 * 将 marketplace 名称映射到其来源和缓存元数据。
 * 用于跟踪哪些 marketplace 已注册以及在哪里找到它们。
 *
 * 示例文件：
 * {
 *   "anthropic-tools": { "source": { ... }, "installLocation": "...", "lastUpdated": "..." },
 *   "company-internal": { "source": { ... }, "installLocation": "...", "lastUpdated": "..." }
 * }
 */
export const KnownMarketplacesFileSchema = lazySchema(() =>
  z.record(
    z.string(), // Marketplace name as key
    KnownMarketplaceSchema(),
  ),
)

// 从 schema 推断的类型
/**
 * 插件命令定义的元数据。
 *
 * 命令可以通过以下方式定义：
 * - `source`：markdown 文件的路径（例如 "./README.md"）
 * - `content`：内联 markdown 内容字符串
 *
 * 不变量：`source` 或 `content` 必须恰好存在一个。
 * 此不变量由 CommandMetadataSchema 验证在运行时强制执行。
 *
 * 验证发生在插件清单解析时。通过 createPluginFromPath() 后
 * 元数据被假定为有效。
 *
 * @see CommandMetadataSchema 了解运行时验证规则
 */
export type CommandMetadata = z.infer<ReturnType<typeof CommandMetadataSchema>>
export type MarketplaceSource = z.infer<
  ReturnType<typeof MarketplaceSourceSchema>
>
export type PluginAuthor = z.infer<ReturnType<typeof PluginAuthorSchema>>
export type PluginSource = z.infer<ReturnType<typeof PluginSourceSchema>>
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
export type PluginManifestChannel = NonNullable<
  PluginManifest['channels']
>[number]

export type PluginMarketplace = z.infer<
  ReturnType<typeof PluginMarketplaceSchema>
>
export type PluginMarketplaceEntry = z.infer<
  ReturnType<typeof PluginMarketplaceEntrySchema>
>
export type PluginId = z.infer<ReturnType<typeof PluginIdSchema>> // "plugin@marketplace" 格式的字符串
export type InstalledPlugin = z.infer<ReturnType<typeof InstalledPluginSchema>>
export type InstalledPluginsFileV1 = z.infer<
  ReturnType<typeof InstalledPluginsFileSchemaV1>
>
export type InstalledPluginsFileV2 = z.infer<
  ReturnType<typeof InstalledPluginsFileSchemaV2>
>
export type PluginScope = z.infer<ReturnType<typeof PluginScopeSchema>>
export type PluginInstallationEntry = z.infer<
  ReturnType<typeof PluginInstallationEntrySchema>
>
export type KnownMarketplace = z.infer<
  ReturnType<typeof KnownMarketplaceSchema>
>
export type KnownMarketplacesFile = z.infer<
  ReturnType<typeof KnownMarketplacesFileSchema>
> // Record<string, KnownMarketplace> 的简写
