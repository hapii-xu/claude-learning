/**
 * Claude Code Agent SDK 的 sandbox 类型定义
 *
 * 本文件是 sandbox 配置类型的唯一真源。SDK 与 settings 校验都从此处 import。
 */

import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * sandbox 的网络配置 schema。
 */
export const SandboxNetworkConfigSchema = lazySchema(() =>
  z
    .object({
      allowedDomains: z.array(z.string()).optional(),
      allowManagedDomainsOnly: z
        .boolean()
        .optional()
        .describe(
          '为 true 时（且设置在 managed settings 中），仅采纳 managed settings 中的 allowedDomains 与 WebFetch(domain:...) allow 规则。' +
            '会忽略 user、project、local、flag 设置中的域名。来自任意来源的拒绝域名仍然生效。',
        ),
      allowUnixSockets: z
        .array(z.string())
        .optional()
        .describe(
          '仅 macOS：允许的 Unix socket 路径。Linux 上忽略（seccomp 无法按路径过滤）。',
        ),
      allowAllUnixSockets: z
        .boolean()
        .optional()
        .describe('为 true 时允许所有 Unix socket（两个平台都关闭阻断）。'),
      allowLocalBinding: z.boolean().optional(),
      httpProxyPort: z.number().optional(),
      socksProxyPort: z.number().optional(),
    })
    .optional(),
)

/**
 * sandbox 的文件系统配置 schema。
 */
export const SandboxFilesystemConfigSchema = lazySchema(() =>
  z
    .object({
      allowWrite: z
        .array(z.string())
        .optional()
        .describe(
          '在 sandbox 内额外允许写入的路径。' +
            '会与 Edit(...) allow 权限规则中的路径合并。',
        ),
      denyWrite: z
        .array(z.string())
        .optional()
        .describe(
          '在 sandbox 内额外禁止写入的路径。' +
            '会与 Edit(...) deny 权限规则中的路径合并。',
        ),
      denyRead: z
        .array(z.string())
        .optional()
        .describe(
          '在 sandbox 内额外禁止读取的路径。' +
            '会与 Read(...) deny 权限规则中的路径合并。',
        ),
      allowRead: z
        .array(z.string())
        .optional()
        .describe(
          '在 denyRead 范围内重新允许读取的路径。' +
            '对匹配的路径优先于 denyRead 生效。',
        ),
      allowManagedReadPathsOnly: z
        .boolean()
        .optional()
        .describe(
          '为 true 时（设置在 managed settings 中），仅使用 policySettings 中的 allowRead 路径。',
        ),
    })
    .optional(),
)

/**
 * sandbox 设置 schema。
 */
export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      failIfUnavailable: z
        .boolean()
        .optional()
        .describe(
          '当 sandbox.enabled 为 true 但 sandbox 无法启动时（缺失依赖、平台不支持、' +
            '或平台不在 enabledPlatforms 中），在启动时报错退出。' +
            '为 false 时（默认）显示一条警告，命令在无 sandbox 环境下运行。' +
            '面向将 sandbox 作为硬性门槛的 managed-settings 部署场景。',
        ),
      // 注意：enabledPlatforms 是一个未文档化、通过 .passthrough() 读取的设置。
      // 它将 sandbox 限定在特定平台（例如 ["macos"]）。
      //
      // 添加是为了打通 NVIDIA 企业版发布：他们希望启用
      // autoAllowBashIfSandboxed，但起初只在 macOS 上启用，因为 Linux/WSL
      // 上的 sandbox 支持较新、未经充分验证。该字段允许他们设置
      // enabledPlatforms: ["macos"]，在其他平台上暂时关闭 sandbox
      //（以及 auto-allow），直到准备好扩展。
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z
        .boolean()
        .optional()
        .describe(
          '允许命令通过 dangerouslyDisableSandbox 参数在 sandbox 外运行。' +
            '为 false 时，dangerouslyDisableSandbox 参数被完全忽略，所有命令都必须在 sandbox 内运行。' +
            '默认：true。',
        ),
      network: SandboxNetworkConfigSchema(),
      filesystem: SandboxFilesystemConfigSchema(),
      ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
      enableWeakerNestedSandbox: z.boolean().optional(),
      enableWeakerNetworkIsolation: z
        .boolean()
        .optional()
        .describe(
          '仅 macOS：允许在 sandbox 中访问 com.apple.trustd.agent。' +
            '当搭配 httpProxyPort 与 MITM 代理、自定义 CA 时，Go 语言编写的 CLI 工具' +
            '（gh、gcloud、terraform 等）需要此权限来校验 TLS 证书。' +
            '**会降低安全性** —— 通过 trustd 服务打开潜在的数据外泄通道。默认：false',
        ),
      excludedCommands: z.array(z.string()).optional(),
      ripgrep: z
        .object({
          command: z.string(),
          args: z.array(z.string()).optional(),
        })
        .optional()
        .describe('为内置 ripgrep 支持自定义 ripgrep 配置'),
    })
    .passthrough(),
)

// 从 schema 推断出的类型
export type SandboxSettings = z.infer<ReturnType<typeof SandboxSettingsSchema>>
export type SandboxNetworkConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxNetworkConfigSchema>>
>
export type SandboxFilesystemConfig = NonNullable<
  z.infer<ReturnType<typeof SandboxFilesystemConfigSchema>>
>
export type SandboxIgnoreViolations = NonNullable<
  SandboxSettings['ignoreViolations']
>
