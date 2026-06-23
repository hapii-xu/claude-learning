/**
 * 危险 shell 工具允许规则前缀的模式列表。
 *
 * 像 `Bash(python:*)` 或 `PowerShell(node:*)` 这样的允许规则会让模型
 * 通过该解释器运行任意代码，从而绕过 auto mode 分类器。
 * 这些列表为 permissionSetup.ts 中的 isDangerous{Bash,PowerShell}Permission
 * 谓词提供数据，这些谓词在 auto mode 进入时会剥离此类规则。
 *
 * 每个谓词中的匹配器处理规则形状变体（精确匹配、`:*`、
 * 尾部 `*`、` *`、` -…*`）。PowerShell 特有的 cmdlet 字符串位于
 * isDangerousPowerShellPermission（permissionSetup.ts）。
 */

/**
 * 跨平台代码执行入口，同时存在于 Unix 和 Windows 上。
 * 共享以防止两个列表在添加解释器时出现不一致。
 */
export const CROSS_PLATFORM_CODE_EXEC = [
  // 解释器
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  // 包运行器
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  // 可从两端访问的 Shell（Windows 上的 Git Bash / WSL，Unix 上的原生 Shell）
  'bash',
  'sh',
  // 远程任意命令执行包装器（Win10+ 原生 OpenSSH）
  'ssh',
] as const

export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  'zsh',
  'fish',
  'eval',
  'exec',
  'env',
  'xargs',
  'sudo',
  // Anthropic 内部：仅限 ant 的工具以及 ant 沙箱
  // dotfile 数据显示经常被过度允许为宽泛前缀的通用工具。
  // 这些保持仅限 ant — 外部用户没有 coo，其余是基于
  // ant 沙箱数据的经验风险判断，而非"此工具不安全"的普遍
  // 判断。PS 在有使用数据后可能需要这些。
  ...(process.env.USER_TYPE === 'ant'
    ? [
        'fa run',
        // 集群代码启动器 — 在集群上运行任意代码
        'coo',
        // 网络/数据泄露：gh gist create --public、gh api 任意 HTTP、
        // curl/wget POST。gh api 需要单独条目 — 匹配器是
        // 精确形状而非前缀，因此单独的模式 'gh' 无法捕获
        // 规则 'gh api:*'（与 'npm run' 和 'npm' 分开的原因相同）。
        'gh',
        'gh api',
        'curl',
        'wget',
        // git config core.sshCommand / hooks install = 任意代码执行
        'git',
        // 云资源写入（s3 公开桶、k8s 变更）
        'kubectl',
        'aws',
        'gcloud',
        'gsutil',
      ]
    : []),
]
