import { realpath, stat } from 'fs/promises'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'

async function probePath(p: string): Promise<string | null> {
  try {
    return (await stat(p)).isFile() ? p : null
  } catch {
    return null
  }
}

/**
 * 尝试通过 PATH 在系统中查找 PowerShell。
 * 优先返回 pwsh（PowerShell Core 7+），找不到则回退到 powershell（5.1）。
 *
 * 在 Linux 上，如果 PATH 解析到 snap 启动器（/snap/…）— 无论是直接命中
 * 还是通过符号链接链（如 /usr/bin/pwsh → /snap/bin/pwsh）— 都改去探测
 * 已知的 apt/rpm 安装位置：snap 启动器在 snapd 初始化 confinement 时
 * 可能会在子进程中挂起，而 /opt/microsoft/powershell/7/pwsh 下的真实
 * 二进制是可靠的。在 Windows/macOS 上，PATH 已经足够。
 */
export async function findPowerShell(): Promise<string | null> {
  const pwshPath = await which('pwsh')
  if (pwshPath) {
    // snap 启动器在子进程中会挂起。优先使用真实二进制。
    // 同时检查 PATH 项及其符号链接目标：在某些发行版上 /usr/bin/pwsh
    // 是指向 /snap/bin/pwsh 的符号链接，仅对 which() 的结果做
    // startsWith('/snap/') 判断会漏掉这种情况。
    if (getPlatform() === 'linux') {
      const resolved = await realpath(pwshPath).catch(() => pwshPath)
      if (pwshPath.startsWith('/snap/') || resolved.startsWith('/snap/')) {
        const direct =
          (await probePath('/opt/microsoft/powershell/7/pwsh')) ??
          (await probePath('/usr/bin/pwsh'))
        if (direct) {
          const directResolved = await realpath(direct).catch(() => direct)
          if (
            !direct.startsWith('/snap/') &&
            !directResolved.startsWith('/snap/')
          ) {
            return direct
          }
        }
      }
    }
    return pwshPath
  }

  const powershellPath = await which('powershell')
  if (powershellPath) {
    return powershellPath
  }

  return null
}

let cachedPowerShellPath: Promise<string | null> | null = null

/**
 * 获取已缓存的 PowerShell 路径。返回一个 memoized 的 promise，
 * resolve 为 PowerShell 可执行文件路径或 null。
 */
export function getCachedPowerShellPath(): Promise<string | null> {
  if (!cachedPowerShellPath) {
    cachedPowerShellPath = findPowerShell()
  }
  return cachedPowerShellPath
}

export type PowerShellEdition = 'core' | 'desktop'

/**
 * 根据二进制文件名推断 PowerShell 版本（无需 spawn 子进程）。
 * - `pwsh` / `pwsh.exe` → 'core'（PowerShell 7+：支持 `&&`、`||`、`?:`、`??`）
 * - `powershell` / `powershell.exe` → 'desktop'（Windows PowerShell 5.1：
 *   不支持管道链操作符、存在 stderr-sets-$? bug、默认 UTF-16 编码）
 *
 * PowerShell 6（同样使用 `pwsh`，但不支持 `&&`）已于 2020 年 EOL，
 * 不再是现实的安装目标，因此 'core' 可以安全地等同于 7+ 语义。
 *
 * 工具 prompt 使用该结果给出与版本匹配的语法指引，避免模型在 5.1 上
 * 输出 `cmd1 && cmd2`（解析错误），或在 7+ 上反而回避 `&&`（本应是
 * 正确的短路操作符）。
 */
export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  const p = await getCachedPowerShellPath()
  if (!p) return null
  // 取 basename 并去掉扩展名，不区分大小写。覆盖以下场景：
  //   C:\Program Files\PowerShell\7\pwsh.exe
  //   /opt/microsoft/powershell/7/pwsh
  //   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  const base = p
    .split(/[/\\]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
  return base === 'pwsh' ? 'core' : 'desktop'
}

/**
 * 重置已缓存的 PowerShell 路径。仅用于测试。
 */
export function resetPowerShellCache(): void {
  cachedPowerShellPath = null
}
