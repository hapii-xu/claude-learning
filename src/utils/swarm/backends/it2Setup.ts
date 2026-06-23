import { homedir } from 'os'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
} from '../../../utils/execFileNoThrow.js'
import { logError } from '../../../utils/log.js'

/**
 * 用于安装 it2 的包管理器类型。
 * 按优先顺序列出。
 */
export type PythonPackageManager = 'uvx' | 'pipx' | 'pip'

/**
 * 尝试安装 it2 的结果。
 */
export type It2InstallResult = {
  success: boolean
  error?: string
  packageManager?: PythonPackageManager
}

/**
 * 验证 it2 设置的结果。
 */
export type It2VerifyResult = {
  success: boolean
  error?: string
  needsPythonApiEnabled?: boolean
}

/**
 * 检测系统上可用的 Python 包管理器。
 * 按优先顺序检查：uvx、pipx、pip。
 *
 * @returns 检测到的包管理器，如果未找到则返回 null
 */
export async function detectPythonPackageManager(): Promise<PythonPackageManager | null> {
  // 首先检查 uv（隔离环境的首选）
  // 我们检查 'uv' 因为 'uv tool install' 是安装命令
  const uvResult = await execFileNoThrow('which', ['uv'])
  if (uvResult.code === 0) {
    logForDebugging('[it2Setup] Found uv (will use uv tool install)')
    return 'uvx' // 保留类型名称以保持兼容性
  }

  // 检查 pipx（适合隔离环境）
  const pipxResult = await execFileNoThrow('which', ['pipx'])
  if (pipxResult.code === 0) {
    logForDebugging('[it2Setup] Found pipx package manager')
    return 'pipx'
  }

  // 检查 pip（备选方案）
  const pipResult = await execFileNoThrow('which', ['pip'])
  if (pipResult.code === 0) {
    logForDebugging('[it2Setup] Found pip package manager')
    return 'pip'
  }

  // 同时检查 pip3
  const pip3Result = await execFileNoThrow('which', ['pip3'])
  if (pip3Result.code === 0) {
    logForDebugging('[it2Setup] Found pip3 package manager')
    return 'pip'
  }

  logForDebugging('[it2Setup] No Python package manager found')
  return null
}

/**
 * 检查 it2 CLI 工具是否已安装并可访问。
 *
 * @returns 如果 it2 可用则返回 true
 */
export async function isIt2CliAvailable(): Promise<boolean> {
  const result = await execFileNoThrow('which', ['it2'])
  return result.code === 0
}

/**
 * 使用检测到的包管理器安装 it2 CLI 工具。
 *
 * @param packageManager - 用于安装的包管理器
 * @returns 指示成功或失败的结果
 */
export async function installIt2(
  packageManager: PythonPackageManager,
): Promise<It2InstallResult> {
  logForDebugging(`[it2Setup] Installing it2 using ${packageManager}`)

  // 从主目录运行以避免读取项目级的 pip.conf/uv.toml
  // 后者可能被恶意构造以重定向到攻击者的 PyPI 服务器
  let result
  switch (packageManager) {
    case 'uvx':
      // uv tool install it2 在隔离环境中全局安装
      // （uvx 用于运行，uv tool install 用于安装）
      result = await execFileNoThrowWithCwd('uv', ['tool', 'install', 'it2'], {
        cwd: homedir(),
      })
      break
    case 'pipx':
      result = await execFileNoThrowWithCwd('pipx', ['install', 'it2'], {
        cwd: homedir(),
      })
      break
    case 'pip':
      // 使用 --user 无需 sudo 即可安装
      result = await execFileNoThrowWithCwd(
        'pip',
        ['install', '--user', 'it2'],
        { cwd: homedir() },
      )
      if (result.code !== 0) {
        // 如果 pip 失败则尝试 pip3
        result = await execFileNoThrowWithCwd(
          'pip3',
          ['install', '--user', 'it2'],
          { cwd: homedir() },
        )
      }
      break
  }

  if (result.code !== 0) {
    const error = result.stderr || 'Unknown installation error'
    logError(new Error(`[it2Setup] Failed to install it2: ${error}`))
    return {
      success: false,
      error,
      packageManager,
    }
  }

  logForDebugging('[it2Setup] it2 installed successfully')
  return {
    success: true,
    packageManager,
  }
}

/**
 * 验证 it2 是否正确配置并能与 iTerm2 通信。
 * 通过运行简单的 it2 命令来测试 Python API 连接。
 *
 * @returns 指示成功或具体失败原因的结果
 */
export async function verifyIt2Setup(): Promise<It2VerifyResult> {
  logForDebugging('[it2Setup] Verifying it2 setup...')

  // 首先检查 it2 是否已安装
  const installed = await isIt2CliAvailable()
  if (!installed) {
    return {
      success: false,
      error: 'it2 CLI is not installed or not in PATH',
    }
  }

  // 尝试列出会话——这测试了 Python API 连接
  const result = await execFileNoThrow('it2', ['session', 'list'])

  if (result.code !== 0) {
    const stderr = result.stderr.toLowerCase()

    // 检查常见的 Python API 错误
    if (
      stderr.includes('api') ||
      stderr.includes('python') ||
      stderr.includes('connection refused') ||
      stderr.includes('not enabled')
    ) {
      logForDebugging('[it2Setup] Python API not enabled in iTerm2')
      return {
        success: false,
        error: 'Python API not enabled in iTerm2 preferences',
        needsPythonApiEnabled: true,
      }
    }

    return {
      success: false,
      error: result.stderr || 'Failed to communicate with iTerm2',
    }
  }

  logForDebugging('[it2Setup] it2 setup verified successfully')
  return {
    success: true,
  }
}

/**
 * 返回在 iTerm2 中启用 Python API 的说明。
 */
export function getPythonApiInstructions(): string[] {
  return [
    'Almost done! Enable the Python API in iTerm2:',
    '',
    '  iTerm2 → Settings → General → Magic → Enable Python API',
    '',
    'After enabling, you may need to restart iTerm2.',
  ]
}

/**
 * 标记 it2 设置已成功完成。
 * 这可以防止再次显示设置提示。
 */
export function markIt2SetupComplete(): void {
  const config = getGlobalConfig()
  if (config.iterm2It2SetupComplete !== true) {
    saveGlobalConfig(current => ({
      ...current,
      iterm2It2SetupComplete: true,
    }))
    logForDebugging('[it2Setup] Marked it2 setup as complete')
  }
}

/**
 * 标记用户更倾向于使用 tmux 而非 iTerm2 分割 pane。
 * 这可以防止在 iTerm2 中显示设置提示。
 */
export function setPreferTmuxOverIterm2(prefer: boolean): void {
  const config = getGlobalConfig()
  if (config.preferTmuxOverIterm2 !== prefer) {
    saveGlobalConfig(current => ({
      ...current,
      preferTmuxOverIterm2: prefer,
    }))
    logForDebugging(`[it2Setup] Set preferTmuxOverIterm2 = ${prefer}`)
  }
}

/**
 * 检查用户是否更倾向于使用 tmux 而非 iTerm2 分割 pane。
 */
export function getPreferTmuxOverIterm2(): boolean {
  return getGlobalConfig().preferTmuxOverIterm2 === true
}
