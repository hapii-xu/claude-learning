import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import { logForDebugging } from '../../../utils/debug.js'
import { errorMessage } from '../../../utils/errors.js'
import { getPlatform } from '../../../utils/platform.js'
import {
  isInITerm2,
  isInWindowsTerminal,
  isInsideTmux,
  isInsideTmuxSync,
  isIt2CliAvailable,
  isTmuxAvailable,
  isWindowsTerminalAvailable,
} from './detection.js'
import { createInProcessBackend } from './InProcessBackend.js'
import { getPreferTmuxOverIterm2 } from './it2Setup.js'
import { createPaneBackendExecutor } from './PaneBackendExecutor.js'
import { getTeammateModeFromSnapshot } from './teammateModeSnapshot.js'
import type {
  BackendDetectionResult,
  PaneBackend,
  PaneBackendType,
  TeammateExecutor,
} from './types.js'

/**
 * 缓存的 backend 实例。
 * 一旦检测完成，backend 选择在本进程生命周期内固定不变。
 */
let cachedBackend: PaneBackend | null = null

/**
 * 缓存的检测元数据结果（包含 backend 实例 + 附加信息）。
 */
let cachedDetectionResult: BackendDetectionResult | null = null

/**
 * 标记 backend 类是否已完成动态注册。
 */
let backendsRegistered = false

/**
 * 缓存的 in-process backend 实例。
 */
let cachedInProcessBackend: TeammateExecutor | null = null

/**
 * 缓存的 pane backend executor 实例。
 * 对检测到的 PaneBackend 进行包装，对外暴露 TeammateExecutor 统一接口。
 */
let cachedPaneBackendExecutor: TeammateExecutor | null = null

/**
 * 记录 spawn 是否因无可用 pane backend 而回退到 in-process 模式
 * （例如 iTerm2 环境下 it2 / tmux 均未安装）。
 * 一旦置位，isInProcessEnabled() 将持续返回 true，
 * 以便 UI（banner、teams 菜单）反映真实运行状态。
 */
let inProcessFallbackActive = false

/**
 * TmuxBackend 类的占位引用 —— 待 TmuxBackend.ts 动态导入后填充。
 * 保留此占位使 registry 可在 backend 实现尚未加载时仍能编译通过。
 */
let TmuxBackendClass: (new () => PaneBackend) | null = null

/**
 * ITermBackend 类的占位引用 —— 待 ITermBackend.ts 动态导入后填充。
 * 保留此占位使 registry 可在 backend 实现尚未加载时仍能编译通过。
 */
let ITermBackendClass: (new () => PaneBackend) | null = null

/**
 * WindowsTerminalBackend 类的占位引用。
 */
let WindowsTerminalBackendClass: (new () => PaneBackend) | null = null

/**
 * 确保所有 backend 类已完成动态导入注册。
 * 与 detectAndGetBackend() 不同，本函数不会启动任何子进程，
 * 也不会抛异常 —— 仅在只需要类注册信息的轻量场景下使用
 * （例如：通过已存储的 backendType 来 kill 某个 pane）。
 */
export async function ensureBackendsRegistered(): Promise<void> {
  logForDebugging('-------------- ensureBackendsRegistered 开始 -----------', {
    level: 'info',
  })

  if (backendsRegistered) {
    logForDebugging('[ensureBackendsRegistered] 已注册，直接跳过', {
      level: 'debug',
    })
    logForDebugging('-------------- ensureBackendsRegistered 结束 ---------', {
      level: 'info',
    })
    return
  }

  logForDebugging('[ensureBackendsRegistered] 开始动态导入 TmuxBackend...', {
    level: 'debug',
  })
  await import('./TmuxBackend.js')

  logForDebugging('[ensureBackendsRegistered] 开始动态导入 ITermBackend...', {
    level: 'debug',
  })
  await import('./ITermBackend.js')

  logForDebugging(
    '[ensureBackendsRegistered] 开始动态导入 WindowsTerminalBackend...',
    { level: 'debug' },
  )
  await import('./WindowsTerminalBackend.js')

  backendsRegistered = true
  logForDebugging(
    '[ensureBackendsRegistered] 三个 backend 全部注册完成 ' +
      `TmuxBackendClass=${TmuxBackendClass?.name ?? 'null'} ` +
      `ITermBackendClass=${ITermBackendClass?.name ?? 'null'} ` +
      `WindowsTerminalBackendClass=${WindowsTerminalBackendClass?.name ?? 'null'}`,
    { level: 'info' },
  )

  logForDebugging('-------------- ensureBackendsRegistered 结束 ---------', {
    level: 'info',
  })
}

/**
 * 注册 TmuxBackend 类到 registry。
 * 由 TmuxBackend.ts 在模块加载时主动调用，用于规避循环依赖。
 */
export function registerTmuxBackend(backendClass: new () => PaneBackend): void {
  logForDebugging('-------------- registerTmuxBackend 开始 -----------', {
    level: 'info',
  })
  logForDebugging(
    `[registerTmuxBackend] 注册 TmuxBackend class=${backendClass?.name || 'undefined'}`,
    { level: 'info' },
  )
  TmuxBackendClass = backendClass
  logForDebugging('-------------- registerTmuxBackend 结束 ---------', {
    level: 'info',
  })
}

/**
 * 注册 ITermBackend 类到 registry。
 * 由 ITermBackend.ts 在模块加载时主动调用，用于规避循环依赖。
 */
export function registerITermBackend(
  backendClass: new () => PaneBackend,
): void {
  logForDebugging('-------------- registerITermBackend 开始 -----------', {
    level: 'info',
  })
  logForDebugging(
    `[registerITermBackend] 注册 ITermBackend class=${backendClass?.name || 'undefined'}`,
    { level: 'info' },
  )
  ITermBackendClass = backendClass
  logForDebugging('-------------- registerITermBackend 结束 ---------', {
    level: 'info',
  })
}

/**
 * 注册 WindowsTerminalBackend 类到 registry。
 * 由 WindowsTerminalBackend.ts 在模块加载时主动调用，用于规避循环依赖。
 */
export function registerWindowsTerminalBackend(
  backendClass: new () => PaneBackend,
): void {
  logForDebugging(
    '-------------- registerWindowsTerminalBackend 开始 -----------',
    { level: 'info' },
  )
  logForDebugging(
    `[registerWindowsTerminalBackend] 注册 WindowsTerminalBackend class=${backendClass?.name || 'undefined'}`,
    { level: 'info' },
  )
  WindowsTerminalBackendClass = backendClass
  logForDebugging(
    '-------------- registerWindowsTerminalBackend 结束 ---------',
    { level: 'info' },
  )
}

/**
 * 创建 TmuxBackend 实例。
 * 若 TmuxBackend 尚未注册，则抛出异常。
 */
function createTmuxBackend(): PaneBackend {
  logForDebugging('-------------- createTmuxBackend 开始 -----------', {
    level: 'info',
  })
  if (!TmuxBackendClass) {
    logForDebugging('[createTmuxBackend] 错误：TmuxBackend 尚未注册！', {
      level: 'error',
    })
    throw new Error(
      'TmuxBackend not registered. Import TmuxBackend.ts before using the registry.',
    )
  }
  const instance = new TmuxBackendClass()
  logForDebugging(
    `[createTmuxBackend] 创建成功 instance=${instance.constructor.name}`,
    { level: 'info' },
  )
  logForDebugging('-------------- createTmuxBackend 结束 ---------', {
    level: 'info',
  })
  return instance
}

/**
 * 创建 ITermBackend 实例。
 * 若 ITermBackend 尚未注册，则抛出异常。
 */
function createITermBackend(): PaneBackend {
  logForDebugging('-------------- createITermBackend 开始 -----------', {
    level: 'info',
  })
  if (!ITermBackendClass) {
    logForDebugging('[createITermBackend] 错误：ITermBackend 尚未注册！', {
      level: 'error',
    })
    throw new Error(
      'ITermBackend not registered. Import ITermBackend.ts before using the registry.',
    )
  }
  const instance = new ITermBackendClass()
  logForDebugging(
    `[createITermBackend] 创建成功 instance=${instance.constructor.name}`,
    { level: 'info' },
  )
  logForDebugging('-------------- createITermBackend 结束 ---------', {
    level: 'info',
  })
  return instance
}

/**
 * 创建 WindowsTerminalBackend 实例。
 * 若 WindowsTerminalBackend 尚未注册，则抛出异常。
 */
function createWindowsTerminalBackend(): PaneBackend {
  logForDebugging(
    '-------------- createWindowsTerminalBackend 开始 -----------',
    { level: 'info' },
  )
  if (!WindowsTerminalBackendClass) {
    logForDebugging(
      '[createWindowsTerminalBackend] 错误：WindowsTerminalBackend 尚未注册！',
      { level: 'error' },
    )
    throw new Error(
      'WindowsTerminalBackend not registered. Import WindowsTerminalBackend.ts before using the registry.',
    )
  }
  const instance = new WindowsTerminalBackendClass()
  logForDebugging(
    `[createWindowsTerminalBackend] 创建成功 instance=${instance.constructor.name}`,
    { level: 'info' },
  )
  logForDebugging(
    '-------------- createWindowsTerminalBackend 结束 ---------',
    { level: 'info' },
  )
  return instance
}

/**
 * 检测当前环境并返回最合适的 backend。
 *
 * 检测优先级流程：
 * 1. 若当前处于 tmux 会话中，则始终使用 tmux（即使同时位于 iTerm2 内）
 * 2. 若处于 iTerm2 且 it2 CLI 可用，则使用 iTerm2 backend
 * 3. 若处于 iTerm2 但 it2 CLI 不可用，则返回结果提示需要安装 it2
 * 4. 若 tmux 可用，则使用 tmux（创建外部会话）
 * 5. 否则抛出异常，并附带安装指引
 */
export async function detectAndGetBackend(): Promise<BackendDetectionResult> {
  logForDebugging('-------------- detectAndGetBackend 开始 -----------', {
    level: 'info',
  })

  // 在进行检测之前，先确保 backend 类已完成动态注册
  logForDebugging('[detectAndGetBackend] 第 0 步：确保 backend 类已注册', {
    level: 'debug',
  })
  await ensureBackendsRegistered()

  // 如果已有缓存结果，直接返回，避免重复检测
  if (cachedDetectionResult) {
    logForDebugging(
      `[detectAndGetBackend] 命中缓存，直接返回 backend.type=${cachedDetectionResult.backend.type} ` +
        `isNative=${cachedDetectionResult.isNative} needsIt2Setup=${cachedDetectionResult.needsIt2Setup}`,
      { level: 'info' },
    )
    logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
      level: 'info',
    })
    return cachedDetectionResult
  }

  logForDebugging('[detectAndGetBackend] 无缓存，开始完整环境检测...', {
    level: 'info',
  })

  // 一次性收集所有环境条件，用于后续分支判断和日志记录
  const insideTmux = await isInsideTmux()
  const inITerm2 = isInITerm2()
  const inWindowsTerminal = isInWindowsTerminal()
  const platform = getPlatform()

  logForDebugging(
    `[detectAndGetBackend] 环境探测结果: ` +
      `platform=${platform} insideTmux=${insideTmux} inITerm2=${inITerm2} inWindowsTerminal=${inWindowsTerminal}`,
    { level: 'info' },
  )

  // 显式指定 windows-terminal 模式：强制使用 Windows Terminal backend
  const teammateMode = getTeammateMode()
  logForDebugging(`[detectAndGetBackend] 当前 teammateMode=${teammateMode}`, {
    level: 'debug',
  })

  if (teammateMode === 'windows-terminal') {
    logForDebugging(
      '[detectAndGetBackend] 用户显式指定 windows-terminal 模式',
      { level: 'info' },
    )
    if (platform !== 'windows') {
      logForDebugging(
        `[detectAndGetBackend] 错误：当前 platform=${platform}，非 windows，无法使用 Windows Terminal 模式`,
        { level: 'error' },
      )
      throw new Error(
        'Windows Terminal teammate mode is only available on Windows',
      )
    }
    const wtAvailable = await isWindowsTerminalAvailable()
    logForDebugging(`[detectAndGetBackend] wt.exe 可用性: ${wtAvailable}`, {
      level: 'debug',
    })
    if (!wtAvailable) {
      logForDebugging('[detectAndGetBackend] 错误：wt.exe 不在 PATH 中', {
        level: 'error',
      })
      throw new Error('Windows Terminal teammate mode requires wt.exe in PATH')
    }
    const backend = createWindowsTerminalBackend()
    cachedBackend = backend
    cachedDetectionResult = {
      backend,
      isNative: inWindowsTerminal,
      needsIt2Setup: false,
    }
    logForDebugging(
      `[detectAndGetBackend] 选定 Windows Terminal backend, isNative=${inWindowsTerminal}`,
      { level: 'info' },
    )
    logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
      level: 'info',
    })
    return cachedDetectionResult
  }

  // 优先级 1：若当前处于 tmux 会话内，则始终使用 tmux（无论是否同时在 iTerm2 中）
  if (insideTmux) {
    logForDebugging(
      '[detectAndGetBackend] 优先级 1 命中：当前已在 tmux 会话中，选定 TmuxBackend',
      { level: 'info' },
    )
    const backend = createTmuxBackend()
    cachedBackend = backend
    cachedDetectionResult = {
      backend,
      isNative: true,
      needsIt2Setup: false,
    }
    logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
      level: 'info',
    })
    return cachedDetectionResult
  }

  // 优先级 2：若处于 iTerm2 中，优先尝试使用 iTerm2 原生 pane
  if (inITerm2) {
    logForDebugging(
      '[detectAndGetBackend] 优先级 2：检测到 iTerm2 环境，进入 iTerm2 分支',
      { level: 'info' },
    )

    // 检查用户是否曾选择"优先使用 tmux 而非 iTerm2"
    const preferTmux = getPreferTmuxOverIterm2()
    logForDebugging(
      `[detectAndGetBackend] 用户偏好检查: preferTmuxOverIterm2=${preferTmux}`,
      { level: 'debug' },
    )

    if (preferTmux) {
      logForDebugging(
        '[detectAndGetBackend] 用户偏好 tmux，跳过 iTerm2 检测，转入 tmux 回退逻辑',
        { level: 'info' },
      )
    } else {
      const it2Available = await isIt2CliAvailable()
      logForDebugging(
        `[detectAndGetBackend] iTerm2 环境中 it2 CLI 可用性: ${it2Available}`,
        { level: 'info' },
      )

      if (it2Available) {
        logForDebugging(
          '[detectAndGetBackend] 优先级 2 命中：iTerm2 + it2 CLI 均可用，选定 ITermBackend',
          { level: 'info' },
        )
        const backend = createITermBackend()
        cachedBackend = backend
        cachedDetectionResult = {
          backend,
          isNative: true,
          needsIt2Setup: false,
        }
        logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
          level: 'info',
        })
        return cachedDetectionResult
      }
    }

    // iTerm2 环境但 it2 CLI 不可用 —— 尝试 tmux 作为回退
    const tmuxAvailable = await isTmuxAvailable()
    logForDebugging(
      `[detectAndGetBackend] iTerm2 但 it2 不可用，检查 tmux 可用性: ${tmuxAvailable}`,
      { level: 'info' },
    )

    if (tmuxAvailable) {
      // 只有当用户尚未主动选择"优先 tmux"时，才标记需要 it2 安装提示
      // 否则每次 spawn 都会重复提示
      const needsIt2Setup = !preferTmux
      logForDebugging(
        `[detectAndGetBackend] 优先级 2 回退：选定 TmuxBackend（iTerm2 回退模式）needsIt2Setup=${needsIt2Setup}`,
        { level: 'info' },
      )
      const backend = createTmuxBackend()
      cachedBackend = backend
      cachedDetectionResult = {
        backend,
        isNative: false,
        needsIt2Setup,
      }
      logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
        level: 'info',
      })
      return cachedDetectionResult
    }

    // iTerm2 环境，it2 和 tmux 均不可用 —— 必须安装 it2
    logForDebugging(
      '[detectAndGetBackend] 错误：iTerm2 环境但 it2 CLI 和 tmux 均不可用，无法继续',
      { level: 'error' },
    )
    throw new Error(
      'iTerm2 detected but it2 CLI not installed. Install it2 with: pip install it2',
    )
  }

  // 优先级 3：原生 Windows Terminal 环境
  // 仅在确实运行于 Windows Terminal 内部时启用（不包含 VS Code 集成终端等非 WT 环境）
  // 非 WT 环境将 fall through 到 in-process 模式，避免意外打开外部 WT 窗口
  if (platform === 'windows' && inWindowsTerminal) {
    logForDebugging(
      '[detectAndGetBackend] 优先级 3：Windows + Windows Terminal 环境，进入 WT 分支',
      { level: 'info' },
    )
    const wtAvailable = await isWindowsTerminalAvailable()
    logForDebugging(`[detectAndGetBackend] wt.exe 可用性: ${wtAvailable}`, {
      level: 'debug',
    })

    if (wtAvailable) {
      logForDebugging(
        '[detectAndGetBackend] 优先级 3 命中：选定 WindowsTerminalBackend (wt.exe)',
        { level: 'info' },
      )
      const backend = createWindowsTerminalBackend()
      cachedBackend = backend
      cachedDetectionResult = {
        backend,
        isNative: true,
        needsIt2Setup: false,
      }
      logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
        level: 'info',
      })
      return cachedDetectionResult
    }
    logForDebugging(
      '[detectAndGetBackend] Windows Terminal 环境但 wt.exe 不可用，继续 fall through',
      { level: 'warn' },
    )
  }

  // 优先级 4：回退到 tmux 外部会话模式（创建新 tmux session）
  const tmuxAvailable = await isTmuxAvailable()
  logForDebugging(
    `[detectAndGetBackend] 优先级 4：无特殊环境，检查 tmux 全局可用性: ${tmuxAvailable}`,
    { level: 'info' },
  )

  if (tmuxAvailable) {
    logForDebugging(
      '[detectAndGetBackend] 优先级 4 命中：选定 TmuxBackend（外部会话模式）',
      { level: 'info' },
    )
    const backend = createTmuxBackend()
    cachedBackend = backend
    cachedDetectionResult = {
      backend,
      isNative: false,
      needsIt2Setup: false,
    }
    logForDebugging('-------------- detectAndGetBackend 结束 ---------', {
      level: 'info',
    })
    return cachedDetectionResult
  }

  // 所有 backend 均不可用 —— 系统未安装 tmux，抛出安装指引
  logForDebugging(
    '[detectAndGetBackend] 错误：无任何可用 pane backend（tmux 未安装）',
    { level: 'error' },
  )
  throw new Error(getTmuxInstallInstructions())
}

/**
 * 根据当前操作系统平台，返回对应的 tmux 安装指引文本。
 */
function getTmuxInstallInstructions(): string {
  logForDebugging(
    '-------------- getTmuxInstallInstructions 开始 -----------',
    { level: 'info' },
  )
  const platform = getPlatform()
  logForDebugging(`[getTmuxInstallInstructions] 当前 platform=${platform}`, {
    level: 'debug',
  })

  let instructions: string
  switch (platform) {
    case 'macos':
      instructions = `To use agent swarms, install tmux:
  brew install tmux
Then start a tmux session with: tmux new-session -s claude`
      break

    case 'linux':
    case 'wsl':
      instructions = `To use agent swarms, install tmux:
  sudo apt install tmux    # Ubuntu/Debian
  sudo dnf install tmux    # Fedora/RHEL
Then start a tmux session with: tmux new-session -s claude`
      break

    case 'windows':
      instructions = `To use agent swarms, you need tmux which requires WSL (Windows Subsystem for Linux).
Install WSL first, then inside WSL run:
  sudo apt install tmux
Then start a tmux session with: tmux new-session -s claude`
      break

    default:
      instructions = `To use agent swarms, install tmux using your system's package manager.
Then start a tmux session with: tmux new-session -s claude`
      break
  }

  logForDebugging('-------------- getTmuxInstallInstructions 结束 ---------', {
    level: 'info',
  })
  return instructions
}

/**
 * 根据指定的 backend 类型获取对应实例。
 * 适用于测试场景或用户有明确偏好时使用。
 *
 * @param type - 要获取的 backend 类型
 * @returns 对应的 backend 实例
 * @throws 当请求的 backend 类型未注册时抛出异常
 */
export function getBackendByType(type: PaneBackendType): PaneBackend {
  logForDebugging(
    `-------------- getBackendByType 开始 ----------- type=${type}`,
    { level: 'info' },
  )
  let backend: PaneBackend
  switch (type) {
    case 'tmux':
      backend = createTmuxBackend()
      break
    case 'iterm2':
      backend = createITermBackend()
      break
    case 'windows-terminal':
      backend = createWindowsTerminalBackend()
      break
  }
  logForDebugging(
    `[getBackendByType] 创建成功 type=${type} instance=${backend.constructor.name}`,
    { level: 'info' },
  )
  logForDebugging('-------------- getBackendByType 结束 ---------', {
    level: 'info',
  })
  return backend
}

/**
 * 获取当前已缓存的 backend 实例（若有）。
 * 若尚未完成检测，则返回 null。
 */
export function getCachedBackend(): PaneBackend | null {
  logForDebugging(
    `[getCachedBackend] cachedBackend=${cachedBackend?.constructor.name ?? 'null'}`,
    { level: 'debug' },
  )
  return cachedBackend
}

/**
 * 获取已缓存的 backend 检测结果（若有）。
 * 若尚未执行过检测，则返回 null。
 * 可通过 `isNative` 字段判断 teammates 是否在原生 pane 中可见。
 */
export function getCachedDetectionResult(): BackendDetectionResult | null {
  logForDebugging(
    `[getCachedDetectionResult] cachedDetectionResult=${cachedDetectionResult ? `{ type=${cachedDetectionResult.backend.type}, isNative=${cachedDetectionResult.isNative}, needsIt2Setup=${cachedDetectionResult.needsIt2Setup} }` : 'null'}`,
    { level: 'debug' },
  )
  return cachedDetectionResult
}

/**
 * 记录本次 spawn 因无可用 pane backend 而回退到 in-process 模式。
 * 调用后 isInProcessEnabled() 将持续返回 true。
 * 后续 spawn 将直接走 in-process 路径（环境在会话中途不会变化）。
 */
export function markInProcessFallback(): void {
  logForDebugging('-------------- markInProcessFallback 开始 -----------', {
    level: 'info',
  })
  logForDebugging(
    '[markInProcessFallback] 标记 in-process 回退为激活状态。后续所有 spawn 将使用 in-process 模式。',
    { level: 'info' },
  )
  inProcessFallbackActive = true
  logForDebugging('-------------- markInProcessFallback 结束 ---------', {
    level: 'info',
  })
}

/**
 * 获取本次会话的 teammate 模式。
 * 返回启动时捕获的会话快照值，忽略运行时的配置变更。
 */
function getTeammateMode():
  | 'auto'
  | 'tmux'
  | 'windows-terminal'
  | 'in-process' {
  const mode = getTeammateModeFromSnapshot()
  logForDebugging(`[getTeammateMode] 返回会话快照 mode=${mode}`, {
    level: 'debug',
  })
  return mode
}

/**
 * 判断当前是否启用了 in-process 模式的 teammate 执行。
 *
 * 判断逻辑：
 * - 若 teammateMode 为 'in-process'：始终启用
 * - 若 teammateMode 为 'tmux'：始终禁用（使用 pane backend）
 * - 若 teammateMode 为 'auto'（默认值）：根据环境判断：
 *   - 若处于 tmux 会话内：使用 pane backend（返回 false）
 *   - 若处于 iTerm2 内：使用 pane backend（返回 false）
 *     —— detectAndGetBackend() 会在 it2 可用时选 ITermBackend，否则回退到 tmux
 *   - 若处于 Windows Terminal 内：使用 pane backend（返回 false）
 *   - 否则：使用 in-process（返回 true）
 */
export function isInProcessEnabled(): boolean {
  logForDebugging('-------------- isInProcessEnabled 开始 -----------', {
    level: 'info',
  })

  // 非交互式会话（-p 管道模式）强制使用 in-process 模式
  // 因为 tmux 类 backend 依赖终端 UI，在无 UI 的管道模式下无意义
  const isNonInteractive = getIsNonInteractiveSession()
  logForDebugging(
    `[isInProcessEnabled] getIsNonInteractiveSession()=${isNonInteractive}`,
    { level: 'debug' },
  )
  if (isNonInteractive) {
    logForDebugging(
      '[isInProcessEnabled] 结果: true（非交互式会话，强制 in-process）',
      { level: 'info' },
    )
    logForDebugging('-------------- isInProcessEnabled 结束 ---------', {
      level: 'info',
    })
    return true
  }

  const mode = getTeammateMode()
  logForDebugging(`[isInProcessEnabled] getTeammateMode()=${mode}`, {
    level: 'debug',
  })

  let enabled: boolean
  if (mode === 'in-process') {
    // 显式指定 in-process 模式
    enabled = true
    logForDebugging(
      '[isInProcessEnabled] 分支: mode=in-process, enabled=true',
      { level: 'debug' },
    )
  } else if (mode === 'tmux' || mode === 'windows-terminal') {
    // 显式指定 pane backend 模式，禁用 in-process
    enabled = false
    logForDebugging(`[isInProcessEnabled] 分支: mode=${mode}, enabled=false`, {
      level: 'debug',
    })
  } else {
    // 'auto' 模式：根据实际环境动态判断

    // 如果之前的 spawn 已因无 pane backend 而回退到 in-process，
    // 则本次继续维持 in-process（仅对 auto 模式生效，
    // 这样用户在 Settings 中手动切换到 'tmux' 仍可生效）
    if (inProcessFallbackActive) {
      logForDebugging(
        '[isInProcessEnabled] auto 模式下 inProcessFallbackActive=true，直接返回 true',
        { level: 'info' },
      )
      logForDebugging('-------------- isInProcessEnabled 结束 ---------', {
        level: 'info',
      })
      return true
    }

    // 同步检测当前所处的终端环境
    const insideTmux = isInsideTmuxSync()
    const inITerm2 = isInITerm2()
    const inWindowsTerminal = isInWindowsTerminal()
    const platform = getPlatform()

    logForDebugging(
      `[isInProcessEnabled] auto 模式环境探测: insideTmux=${insideTmux} inITerm2=${inITerm2} inWindowsTerminal=${inWindowsTerminal} platform=${platform}`,
      { level: 'info' },
    )

    if (
      !insideTmux &&
      !inITerm2 &&
      !inWindowsTerminal &&
      platform === 'windows'
    ) {
      // Windows 平台特殊处理：即使不在 Windows Terminal 内
      // （例如 VS Code 集成终端、cmd.exe 等），wt.exe 仍可能可用。
      // 此处保守地返回 false，交由 detectAndGetBackend() 做完整异步检测。
      enabled = false
      logForDebugging(
        '[isInProcessEnabled] Windows 特殊分支：无 pane 环境但 platform=windows，保守返回 false（交由 detectAndGetBackend 异步判断）',
        { level: 'info' },
      )
    } else {
      // 通用逻辑：只要处于任一 pane 环境中，就使用 pane backend
      enabled = !insideTmux && !inITerm2 && !inWindowsTerminal
      logForDebugging(`[isInProcessEnabled] 通用分支: enabled=${enabled}`, {
        level: 'debug',
      })
    }
  }

  logForDebugging(
    `[isInProcessEnabled] 最终结果: enabled=${enabled} (mode=${mode})`,
    { level: 'info' },
  )
  logForDebugging('-------------- isInProcessEnabled 结束 ---------', {
    level: 'info',
  })
  return enabled
}

/**
 * 返回本次会话解析后的实际 teammate 执行模式。
 * 与 getTeammateModeFromSnapshot 不同，后者可能返回 'auto'；
 * 本函数会将 'auto' 根据当前环境实际解析为具体模式。
 */
export function getResolvedTeammateMode():
  | 'in-process'
  | 'tmux'
  | 'windows-terminal' {
  logForDebugging('-------------- getResolvedTeammateMode 开始 -----------', {
    level: 'info',
  })

  const inProcessEnabled_ = isInProcessEnabled()
  logForDebugging(
    `[getResolvedTeammateMode] isInProcessEnabled()=${inProcessEnabled_}`,
    { level: 'debug' },
  )

  let result: 'in-process' | 'tmux' | 'windows-terminal'
  if (inProcessEnabled_) {
    result = 'in-process'
  } else {
    const mode = getTeammateMode()
    logForDebugging(
      `[getResolvedTeammateMode] mode=${mode} platform=${getPlatform()}`,
      { level: 'debug' },
    )
    if (mode === 'windows-terminal') {
      result = 'windows-terminal'
    } else if (mode === 'auto' && getPlatform() === 'windows') {
      // auto 模式下，Windows 平台默认解析为 windows-terminal
      result = 'windows-terminal'
    } else {
      result = 'tmux'
    }
  }

  logForDebugging(`[getResolvedTeammateMode] 最终解析结果: ${result}`, {
    level: 'info',
  })
  logForDebugging('-------------- getResolvedTeammateMode 结束 ---------', {
    level: 'info',
  })
  return result
}

/**
 * 获取 InProcessBackend 实例。
 * 首次调用时创建并缓存，后续调用直接返回缓存实例。
 */
export function getInProcessBackend(): TeammateExecutor {
  logForDebugging('-------------- getInProcessBackend 开始 -----------', {
    level: 'info',
  })
  if (!cachedInProcessBackend) {
    logForDebugging(
      '[getInProcessBackend] 缓存未命中，调用 createInProcessBackend() 创建新实例',
      { level: 'info' },
    )
    cachedInProcessBackend = createInProcessBackend()
    logForDebugging(
      `[getInProcessBackend] 新实例创建完成: ${cachedInProcessBackend.constructor?.name ?? 'unknown'}`,
      { level: 'info' },
    )
  } else {
    logForDebugging(
      `[getInProcessBackend] 缓存命中: ${cachedInProcessBackend.constructor?.name ?? 'unknown'}`,
      { level: 'debug' },
    )
  }
  logForDebugging('-------------- getInProcessBackend 结束 ---------', {
    level: 'info',
  })
  return cachedInProcessBackend
}

/**
 * 获取用于 spawn teammate 的 TeammateExecutor 实例。
 *
 * 返回策略：
 * - 当 preferInProcess 为 true 且 in-process 模式已启用时，返回 InProcessBackend
 * - 否则返回 PaneBackendExecutor（包装检测到的 pane backend）
 *
 * 本函数对外提供统一的 TeammateExecutor 接口，
 * 调用方无需关心底层是 in-process 还是 pane backend 执行。
 *
 * @param preferInProcess - 若为 true 且 in-process 已启用，则返回 InProcessBackend；否则返回 PaneBackendExecutor
 * @param options - 可选配置，包含 it2 安装提示回调
 * @returns TeammateExecutor 实例
 */
export async function getTeammateExecutor(
  preferInProcess: boolean = false,
  options?: {
    onNeedsIt2Setup?: (
      tmuxAvailable: boolean,
    ) => Promise<'installed' | 'use-tmux' | 'cancelled'>
  },
): Promise<TeammateExecutor> {
  logForDebugging(
    `-------------- getTeammateExecutor 开始 ----------- preferInProcess=${preferInProcess}`,
    { level: 'info' },
  )

  if (preferInProcess && isInProcessEnabled()) {
    logForDebugging(
      '[getTeammateExecutor] preferInProcess=true 且 in-process 已启用，返回 InProcessBackend',
      { level: 'info' },
    )
    const executor = getInProcessBackend()
    logForDebugging('-------------- getTeammateExecutor 结束 ---------', {
      level: 'info',
    })
    return executor
  }

  try {
    logForDebugging('[getTeammateExecutor] 尝试获取 PaneBackendExecutor...', {
      level: 'info',
    })
    const executor = await getPaneBackendExecutor(options)
    logForDebugging('[getTeammateExecutor] PaneBackendExecutor 获取成功', {
      level: 'info',
    })
    logForDebugging('-------------- getTeammateExecutor 结束 ---------', {
      level: 'info',
    })
    return executor
  } catch (error) {
    const errMsg = errorMessage(error)
    logForDebugging(
      `[getTeammateExecutor] PaneBackendExecutor 获取失败: ${errMsg}`,
      { level: 'warn' },
    )

    // 仅在 auto 模式下允许回退到 in-process；显式模式直接向上抛出异常
    const currentMode = getTeammateModeFromSnapshot()
    if (currentMode !== 'auto') {
      logForDebugging(
        `[getTeammateExecutor] 当前 mode=${currentMode}（非 auto），直接抛出异常，不进行回退`,
        { level: 'error' },
      )
      throw error
    }

    logForDebugging(
      `[getTeammateExecutor] auto 模式下 pane backend 不可用，回退到 in-process 模式`,
      { level: 'info' },
    )
    markInProcessFallback()
    const executor = getInProcessBackend()
    logForDebugging('-------------- getTeammateExecutor 结束 ---------', {
      level: 'info',
    })
    return executor
  }
}

/**
 * 获取 PaneBackendExecutor 实例。
 * 首次调用时检测合适的 pane backend，创建并缓存实例；后续调用直接返回缓存。
 */
async function getPaneBackendExecutor(options?: {
  onNeedsIt2Setup?: (
    tmuxAvailable: boolean,
  ) => Promise<'installed' | 'use-tmux' | 'cancelled'>
}): Promise<TeammateExecutor> {
  logForDebugging('-------------- getPaneBackendExecutor 开始 -----------', {
    level: 'info',
  })

  if (!cachedPaneBackendExecutor) {
    logForDebugging(
      '[getPaneBackendExecutor] 缓存未命中，开始检测 pane backend...',
      { level: 'info' },
    )
    const detection = await detectAndGetBackend()
    logForDebugging(
      `[getPaneBackendExecutor] 检测结果: backend.type=${detection.backend.type} isNative=${detection.isNative} needsIt2Setup=${detection.needsIt2Setup}`,
      { level: 'info' },
    )

    if (detection.needsIt2Setup && options?.onNeedsIt2Setup) {
      logForDebugging(
        '[getPaneBackendExecutor] needsIt2Setup=true，触发 onNeedsIt2Setup 回调...',
        { level: 'info' },
      )
      const tmuxAvailable = await isTmuxAvailable()
      logForDebugging(
        `[getPaneBackendExecutor] onNeedsIt2Setup 回调中 tmuxAvailable=${tmuxAvailable}`,
        { level: 'debug' },
      )
      const setupResult = await options.onNeedsIt2Setup(tmuxAvailable)
      logForDebugging(
        `[getPaneBackendExecutor] onNeedsIt2Setup 回调结果: ${setupResult}`,
        { level: 'info' },
      )

      if (setupResult === 'cancelled') {
        logForDebugging(
          '[getPaneBackendExecutor] 用户取消了 it2 安装，抛出异常',
          { level: 'warn' },
        )
        throw new Error('Teammate spawn cancelled - iTerm2 setup required')
      }

      // 用户选择了 'installed' 或 'use-tmux'，重置检测缓存并重新获取
      logForDebugging(
        `[getPaneBackendExecutor] 用户选择 ${setupResult}，重置 backend 检测缓存后重试`,
        { level: 'info' },
      )
      resetBackendDetection()
      const executor = await getPaneBackendExecutor(options)
      logForDebugging('-------------- getPaneBackendExecutor 结束 ---------', {
        level: 'info',
      })
      return executor
    }

    cachedPaneBackendExecutor = createPaneBackendExecutor(detection.backend)
    logForDebugging(
      `[getPaneBackendExecutor] 创建 PaneBackendExecutor 成功，包装 backend.type=${detection.backend.type}`,
      { level: 'info' },
    )
  } else {
    logForDebugging(
      '[getPaneBackendExecutor] 缓存命中，直接返回已缓存的 PaneBackendExecutor',
      { level: 'debug' },
    )
  }

  logForDebugging('-------------- getPaneBackendExecutor 结束 ---------', {
    level: 'info',
  })
  return cachedPaneBackendExecutor
}

/**
 * 重置 backend 检测缓存。
 * 主要用于测试场景，允许重新执行完整的环境检测流程。
 */
export function resetBackendDetection(): void {
  logForDebugging('-------------- resetBackendDetection 开始 -----------', {
    level: 'info',
  })
  logForDebugging(
    `[resetBackendDetection] 重置前状态: ` +
      `cachedBackend=${cachedBackend?.constructor.name ?? 'null'} ` +
      `cachedDetectionResult=${cachedDetectionResult?.backend.type ?? 'null'} ` +
      `cachedInProcessBackend=${cachedInProcessBackend?.constructor?.name ?? 'null'} ` +
      `cachedPaneBackendExecutor=${cachedPaneBackendExecutor ? '存在' : 'null'} ` +
      `backendsRegistered=${backendsRegistered} ` +
      `inProcessFallbackActive=${inProcessFallbackActive}`,
    { level: 'info' },
  )

  cachedBackend = null
  cachedDetectionResult = null
  cachedInProcessBackend = null
  cachedPaneBackendExecutor = null
  backendsRegistered = false
  inProcessFallbackActive = false

  logForDebugging('[resetBackendDetection] 所有缓存和标记已重置', {
    level: 'info',
  })
  logForDebugging('-------------- resetBackendDetection 结束 ---------', {
    level: 'info',
  })
}
