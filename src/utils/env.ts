import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'
import { fileSuffixForOauthConfig } from '../constants/oauth.js'
import { isRunningWithBun } from './bundledMode.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { findExecutable } from './findExecutable.js'
import { getFsImplementation } from './fsOperations.js'
import { which } from './which.js'

type Platform = 'win32' | 'darwin' | 'linux'

// 配置和数据路径
export const getGlobalClaudeFile = memoize((): string => {
  // 向后兼容的传统回退
  if (
    getFsImplementation().existsSync(
      join(getClaudeConfigHomeDir(), '.config.json'),
    )
  ) {
    return join(getClaudeConfigHomeDir(), '.config.json')
  }

  const filename = `.hclaude${fileSuffixForOauthConfig()}.json`
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), filename)
})

const hasInternetAccess = memoize(async (): Promise<boolean> => {
  try {
    const { default: axiosClient } = await import('axios')
    await axiosClient.head('http://1.1.1.1', {
      signal: AbortSignal.timeout(1000),
    })
    return true
  } catch {
    return false
  }
})

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    // which 不会执行文件
    return !!(await which(command))
  } catch {
    return false
  }
}

const detectPackageManagers = memoize(async (): Promise<string[]> => {
  const packageManagers = []

  if (await isCommandAvailable('npm')) packageManagers.push('npm')
  if (await isCommandAvailable('yarn')) packageManagers.push('yarn')
  if (await isCommandAvailable('pnpm')) packageManagers.push('pnpm')

  return packageManagers
})

const detectRuntimes = memoize(async (): Promise<string[]> => {
  const runtimes = []

  if (await isCommandAvailable('bun')) runtimes.push('bun')
  if (await isCommandAvailable('deno')) runtimes.push('deno')
  if (await isCommandAvailable('node')) runtimes.push('node')

  return runtimes
})

/**
 * 检查是否运行在 WSL 环境中
 * @returns 若运行在 WSL 中则为 true，否则为 false
 */
const isWslEnvironment = memoize((): boolean => {
  try {
    // 检查 WSLInterop 文件，这是 WSL 的可靠指标
    return getFsImplementation().existsSync(
      '/proc/sys/fs/binfmt_misc/WSLInterop',
    )
  } catch (_error) {
    // 若检查出错，假定不是 WSL
    return false
  }
})

/**
 * 检查 npm 可执行文件是否位于 WSL 内的 Windows 文件系统中
 * @returns 若 npm 来自 Windows（以 /mnt/c/ 开头）则为 true，否则为 false
 */
const isNpmFromWindowsPath = memoize((): boolean => {
  try {
    // 仅在 WSL 环境中相关
    if (!isWslEnvironment()) {
      return false
    }

    // 查找实际的 npm 可执行文件路径
    const { cmd } = findExecutable('npm', [])

    // 若 npm 在 Windows 路径中，会以 /mnt/c/ 开头
    return cmd.startsWith('/mnt/c/')
  } catch (_error) {
    // 若出错，假定不是来自 Windows
    return false
  }
})

/**
 * 检查是否通过 Conductor 运行
 * @returns 若通过 Conductor 运行则为 true，否则为 false
 */
function isConductor(): boolean {
  return process.env.__CFBundleIdentifier === 'com.conductor.app'
}

export const JETBRAINS_IDES = [
  'pycharm',
  'intellij',
  'webstorm',
  'phpstorm',
  'rubymine',
  'clion',
  'goland',
  'rider',
  'datagrip',
  'appcode',
  'dataspell',
  'aqua',
  'gateway',
  'fleet',
  'jetbrains',
  'androidstudio',
]

// 检测终端类型，包含所有平台的回退
function detectTerminal(): string | null {
  if (process.env.CURSOR_TRACE_ID) return 'cursor'
  // WSL 下的 Cursor 和 Windsurf 的 TERM_PROGRAM=vscode
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('cursor')) {
    return 'cursor'
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('windsurf')) {
    return 'windsurf'
  }
  if (process.env.VSCODE_GIT_ASKPASS_MAIN?.includes('antigravity')) {
    return 'antigravity'
  }
  const bundleId = process.env.__CFBundleIdentifier?.toLowerCase()
  if (bundleId?.includes('vscodium')) return 'codium'
  if (bundleId?.includes('windsurf')) return 'windsurf'
  if (bundleId?.includes('com.google.android.studio')) return 'androidstudio'
  // 在 bundle ID 中检查 JetBrains IDE
  if (bundleId) {
    for (const ide of JETBRAINS_IDES) {
      if (bundleId.includes(ide)) return ide
    }
  }

  if (process.env.VisualStudioVersion) {
    // 这是桌面版 Visual Studio，不是 VS Code
    return 'visualstudio'
  }

  // 在 Linux/Windows 上检查 JetBrains 终端
  if (process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm') {
    // macOS 上，上方的 bundle ID 检测已处理 JetBrains IDE
    if (process.platform === 'darwin') return 'pycharm'

    // Linux/Windows 上的精细检测使用 envDynamic.getTerminalWithJetBrainsDetection()
    return 'pycharm'
  }

  // 在 TERM_PROGRAM 之前按 TERM 检查特定终端
  // 这处理 TERM 和 TERM_PROGRAM 可能不一致的情况
  if (process.env.TERM === 'xterm-ghostty') {
    return 'ghostty'
  }
  if (process.env.TERM?.includes('kitty')) {
    return 'kitty'
  }

  if (process.env.TERM_PROGRAM) {
    return process.env.TERM_PROGRAM
  }

  if (process.env.TMUX) return 'tmux'
  if (process.env.STY) return 'screen'

  // 检查终端特定的环境变量（Linux 上常见）
  if (process.env.KONSOLE_VERSION) return 'konsole'
  if (process.env.GNOME_TERMINAL_SERVICE) return 'gnome-terminal'
  if (process.env.XTERM_VERSION) return 'xterm'
  if (process.env.VTE_VERSION) return 'vte-based'
  if (process.env.TERMINATOR_UUID) return 'terminator'
  if (process.env.KITTY_WINDOW_ID) {
    return 'kitty'
  }
  if (process.env.ALACRITTY_LOG) return 'alacritty'
  if (process.env.TILIX_ID) return 'tilix'

  // Windows 特定检测
  if (process.env.WT_SESSION) return 'windows-terminal'
  if (process.env.SESSIONNAME && process.env.TERM === 'cygwin') return 'cygwin'
  if (process.env.MSYSTEM) return process.env.MSYSTEM.toLowerCase() // MINGW64、MSYS2 等
  if (
    process.env.ConEmuANSI ||
    process.env.ConEmuPID ||
    process.env.ConEmuTask
  ) {
    return 'conemu'
  }

  // WSL 检测
  if (process.env.WSL_DISTRO_NAME) return `wsl-${process.env.WSL_DISTRO_NAME}`

  // SSH 会话检测
  if (isSSHSession()) {
    return 'ssh-session'
  }

  // 回退到更通用的 TERM
  // TERM 中常见终端标识符的特殊处理
  if (process.env.TERM) {
    const term = process.env.TERM
    if (term.includes('alacritty')) return 'alacritty'
    if (term.includes('rxvt')) return 'rxvt'
    if (term.includes('termite')) return 'termite'
    return process.env.TERM
  }

  // 检测非交互环境
  if (!process.stdout.isTTY) return 'non-interactive'

  return null
}

/**
 * 基于环境变量检测部署环境/平台
 * @returns 部署平台名，若未检测到则为 'unknown'
 */
export const detectDeploymentEnvironment = memoize((): string => {
  // 云开发环境
  if (isEnvTruthy(process.env.CODESPACES)) return 'codespaces'
  if (process.env.GITPOD_WORKSPACE_ID) return 'gitpod'
  if (process.env.REPL_ID || process.env.REPL_SLUG) return 'replit'
  if (process.env.PROJECT_DOMAIN) return 'glitch'

  // 云平台
  if (isEnvTruthy(process.env.VERCEL)) return 'vercel'
  if (
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_SERVICE_NAME
  ) {
    return 'railway'
  }
  if (isEnvTruthy(process.env.RENDER)) return 'render'
  if (isEnvTruthy(process.env.NETLIFY)) return 'netlify'
  if (process.env.DYNO) return 'heroku'
  if (process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID) return 'fly.io'
  if (isEnvTruthy(process.env.CF_PAGES)) return 'cloudflare-pages'
  if (process.env.DENO_DEPLOYMENT_ID) return 'deno-deploy'
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'aws-lambda'
  if (process.env.AWS_EXECUTION_ENV === 'AWS_ECS_FARGATE') return 'aws-fargate'
  if (process.env.AWS_EXECUTION_ENV === 'AWS_ECS_EC2') return 'aws-ecs'
  // 通过 hypervisor UUID 检查 EC2
  try {
    const uuid = getFsImplementation()
      .readFileSync('/sys/hypervisor/uuid', { encoding: 'utf8' })
      .trim()
      .toLowerCase()
    if (uuid.startsWith('ec2')) return 'aws-ec2'
  } catch {
    // 忽略读取 hypervisor UUID 的错误（非 EC2 上的 ENOENT 等）
  }
  if (process.env.K_SERVICE) return 'gcp-cloud-run'
  if (process.env.GOOGLE_CLOUD_PROJECT) return 'gcp'
  if (process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_SKU)
    return 'azure-app-service'
  if (process.env.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions'
  if (process.env.APP_URL?.includes('ondigitalocean.app')) {
    return 'digitalocean-app-platform'
  }
  if (process.env.SPACE_CREATOR_USER_ID) return 'huggingface-spaces'

  // CI/CD 平台
  if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-actions'
  if (isEnvTruthy(process.env.GITLAB_CI)) return 'gitlab-ci'
  if (process.env.CIRCLECI) return 'circleci'
  if (process.env.BUILDKITE) return 'buildkite'
  if (isEnvTruthy(process.env.CI)) return 'ci'

  // 容器编排
  if (process.env.KUBERNETES_SERVICE_HOST) return 'kubernetes'
  try {
    if (getFsImplementation().existsSync('/.dockerenv')) return 'docker'
  } catch {
    // 忽略检查 Docker 的错误
  }

  // 未检测到的环境的平台特定回退
  if (env.platform === 'darwin') return 'unknown-darwin'
  if (env.platform === 'linux') return 'unknown-linux'
  if (env.platform === 'win32') return 'unknown-win32'

  return 'unknown'
})

// 所有这些应该是不可变的
function isSSHSession(): boolean {
  return !!(
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY
  )
}

export const env = {
  hasInternetAccess,
  isCI: isEnvTruthy(process.env.CI),
  platform: (['win32', 'darwin'].includes(process.platform)
    ? process.platform
    : 'linux') as Platform,
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isSSH: isSSHSession,
  getPackageManagers: detectPackageManagers,
  getRuntimes: detectRuntimes,
  isRunningWithBun: memoize(isRunningWithBun),
  isWslEnvironment,
  isNpmFromWindowsPath,
  isConductor,
  detectDeploymentEnvironment,
}

/**
 * 返回用于分析报告的主机平台。
 * 若 CLAUDE_CODE_HOST_PLATFORM 设置为有效的平台值，则覆盖
 * 检测到的平台。这对容器/远程环境很有用，其中
 * process.platform 报告的是容器 OS 而实际主机平台不同。
 */
export function getHostPlatformForAnalytics(): Platform {
  const override = process.env.CLAUDE_CODE_HOST_PLATFORM
  if (override === 'win32' || override === 'darwin' || override === 'linux') {
    return override
  }
  return env.platform
}
