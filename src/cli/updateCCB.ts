/**
 * `ccb update` — 检查并安装最新版本的 claude-code-best。
 *
 * 检测策略：
 *  1. 如果 `bun` 可用且当前安装是通过 bun 进行的 → 使用 `bun update -g`
 *  2. 否则 → 使用 `npm install -g`
 */
import chalk from 'chalk'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { distRoot } from '../utils/distRoot.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { writeToStdout } from '../utils/process.js'

const PACKAGE_NAME = 'claude-code-best'

function getCurrentVersion(): string {
  // 从最近的 package.json 读取版本号（从 dist root 向上查找）
  try {
    const pkgPath = join(distRoot, '..', 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.version) return pkg.version
    }
  } catch {
    // 回退
  }
  return MACRO.VERSION
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * 检测当前安装是否通过 bun 进行。
 * 检查二进制路径是否包含 "bun"，或 bun 的全局安装目录是否包含我们的包。
 */
function isBunInstallation(): boolean {
  // 检查正在运行的二进制是否位于 bun 的全局安装路径下
  const execPath = process.execPath
  if (execPath.includes('bun')) {
    return true
  }

  // 检查 bun 的全局安装目录
  const bunGlobalDir = join(homedir(), '.bun', 'install', 'global')
  if (existsSync(join(bunGlobalDir, 'node_modules', PACKAGE_NAME))) {
    return true
  }

  return false
}

/**
 * 从 npm registry 获取最新版本。
 */
async function getLatestVersion(): Promise<string | null> {
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${PACKAGE_NAME}@latest`, 'version', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(10_000), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view failed: ${result.stderr}`)
    return null
  }
  return result.stdout.trim()
}

/**
 * 比较两个 semver 字符串。当 a >= b 时返回 true。
 */
function gte(a: string, b: string): boolean {
  const parseVer = (v: string) => v.replace(/^\D/, '').split('.').map(Number)
  const pa = parseVer(a)
  const pb = parseVer(b)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return true
}

export async function updateCCB(): Promise<void> {
  const currentVersion = getCurrentVersion()
  writeToStdout(`Current version: ${currentVersion}\n`)

  // 确定包管理器
  const hasBun = isCommandAvailable('bun')
  const useBun = isBunInstallation()
  const pkgManager = useBun && hasBun ? 'bun' : 'npm'

  writeToStdout(`Package manager: ${pkgManager}\n`)
  writeToStdout('Checking for updates...\n')

  // 获取最新版本
  const latestVersion = await getLatestVersion()
  if (!latestVersion) {
    process.stderr.write(chalk.red('Failed to check for updates') + '\n')
    process.stderr.write('Unable to fetch latest version from npm registry.\n')
    await gracefulShutdown(1)
    return
  }

  // 已经是最新版本？
  if (latestVersion === currentVersion || gte(currentVersion, latestVersion)) {
    writeToStdout(chalk.green(`ccb is up to date (${currentVersion})`) + '\n')
    await gracefulShutdown(0)
    return
  }

  writeToStdout(
    `New version available: ${latestVersion} (current: ${currentVersion})\n`,
  )
  writeToStdout(`Installing update via ${pkgManager}...\n`)

  try {
    if (pkgManager === 'bun') {
      execSync(`bun install -g ${PACKAGE_NAME}@latest`, {
        stdio: 'inherit',
        cwd: homedir(),
        timeout: 120_000,
      })
    } else {
      execSync(`npm install -g ${PACKAGE_NAME}@latest`, {
        stdio: 'inherit',
        cwd: homedir(),
        timeout: 120_000,
      })
    }

    writeToStdout(
      chalk.green(
        `Successfully updated from ${currentVersion} to ${latestVersion}`,
      ) + '\n',
    )
  } catch (error) {
    process.stderr.write(chalk.red('Update failed') + '\n')
    process.stderr.write(`${error}\n`)
    process.stderr.write('\n')
    process.stderr.write('Try manually updating with:\n')
    if (pkgManager === 'bun') {
      process.stderr.write(
        chalk.bold(`  bun install -g ${PACKAGE_NAME}@latest`) + '\n',
      )
    } else {
      process.stderr.write(
        chalk.bold(`  npm install -g ${PACKAGE_NAME}@latest`) + '\n',
      )
    }
    await gracefulShutdown(1)
  }

  await gracefulShutdown(0)
}
