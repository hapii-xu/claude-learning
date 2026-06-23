/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { initSkillLearning } from './services/skillLearning/runtimeObserver.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

/**
 * 环境准备函数 —— 在 Commander 默认 action 中、进入 REPL 之前调用。
 *
 * 与 init.ts 的区别：
 *   init() 做"全局、一次性"的初始化（网络、遥测、配置系统），
 *   setup() 做"与当前会话 cwd 相关"的准备（hooks、worktree、插件预取）。
 *
 * 参数：
 *   cwd               —— 当前工作目录
 *   permissionMode    —— 权限模式（auto/ask/bypass...）
 *   allowDangerouslySkipPermissions —— 是否跳过权限检查（需 Docker/sandbox 环境）
 *   worktreeEnabled   —— 是否启用 git worktree 隔离模式
 *   worktreeName      —— worktree 名称（可选，默认使用 plan slug）
 *   tmuxEnabled       —— 是否同时创建 tmux 会话
 *   customSessionId   —— 自定义 session ID（可选）
 *   worktreePRNumber  —— PR 编号（用于命名 worktree，可选）
 *   messagingSocketPath —— UDS 消息服务器 socket 路径（可选）
 *
 * 执行顺序：
 *   1. 检查 Node.js 版本（>= 18）
 *   2. 设置自定义 session ID
 *   3. 启动 UDS 消息服务器（ant-only，用于外部注入消息）
 *   4. 捕获 teammate snapshot（swarm 模式）
 *   5. 恢复终端备份（iTerm2/Terminal.app，swarm 中断后还原）
 *   6. setCwd(cwd) —— 设置当前工作目录（必须在其他依赖 cwd 的操作之前）
 *   7. captureHooksConfigSnapshot() —— 快照 hooks 配置，防止被隐蔽篡改
 *   8. 处理 worktree（创建 git worktree + tmux session）
 *   9. 注册后台任务（SessionMemory、SkillLearning、ContextCollapse）
 *  10. 预取插件 hooks + 命令（与 getCommands 并行）
 *  11. 注册 attribution hooks（commit 归因追踪，ant-only）
 *  12. initSinks() —— 挂载日志/分析接收器
 *  13. 检查 release notes + 上次会话统计
 *  14. 验证 bypassPermissions 的安全环境（非 root、Docker/sandbox、无网络）
 */
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // 检查 Node.js 版本是否 < 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion, 10) < 18) {
    console.error(
      chalk.bold.red(
        'Error: Claude Code requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  // 如果提供了自定义 session ID 则设置
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // --bare / SIMPLE：跳过 UDS 消息服务器和 teammate 快照。
  // 脚本化调用既不会接收注入消息，也不会使用 swarm teammate。
  // 显式传入 --messaging-socket-path 是逃逸出口（参见 #23222 gate 模式）。
  if (!isBareMode() || messagingSocketPath !== undefined) {
    // 启动 UDS 消息服务器（仅限 Mac/Linux）。
    // 对 ant 默认启用 —— 若未传入 --messaging-socket-path，则在 tmpdir 中创建 socket。
    // 这里 await 是为了让服务器完成绑定、导出 $CLAUDE_CODE_MESSAGING_SOCKET 环境变量，
    // 以确保任何 hook（尤其是 SessionStart）spawn 并快照 process.env 之前这些都已就绪。
    if (feature('UDS_INBOX')) {
      const m = await import('./utils/udsMessaging.js')
      await m.startUdsMessaging(
        messagingSocketPath ?? m.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // teammate 快照 —— 仅 SIMPLE 模式启用（无逃逸出口，bare 模式下不使用 swarm）
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // 终端备份恢复 —— 仅交互模式。Print 模式不会触碰终端设置；
  // 下一次交互式会话会检测并恢复任何被中断的设置流程。
  if (!getIsNonInteractiveSession()) {
    // 仅在启用 swarms 时才检查 iTerm2 备份
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        console.log(
          chalk.yellow(
            'Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        console.error(
          chalk.red(
            `Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
          ),
        )
      }
    }

    // 检查并恢复 Terminal.app 备份（如果上次设置被中断）
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        console.log(
          chalk.yellow(
            'Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        console.error(
          chalk.red(
            `Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
          ),
        )
      }
    } catch (error) {
      // 仅记录日志，不因 Terminal.app 备份恢复失败而崩溃
      logError(error)
    }
  }

  // 重要：setCwd() 必须在所有依赖 cwd 的其他代码之前调用
  setCwd(cwd)

  // 捕获 hooks 配置快照，避免被隐蔽的 hook 篡改。
  // 重要：必须在 setCwd() 之后调用，以确保 hooks 从正确的目录加载
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // 初始化 FileChanged hook 监听器 —— 同步操作，读取 hook 配置快照
  initializeFileChangedWatcher(cwd)

  // 如果请求则处理 worktree 创建
  // 重要：必须先于 getCommands() 调用，否则 /eject 不可用。
  if (worktreeEnabled) {
    // 与 bridgeMain.ts 保持一致：通过 hook 配置的会话可以在没有 git 的情况下继续，
    // 因此 createWorktreeForSession() 可以委派给 hook（非 git VCS）。
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
            `Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
        ),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // 只要处于 git 仓库中，Git preamble 就会执行 —— 哪怕配置了 hook ——
    // 这样 --tmux 对同时配置了 WorktreeCreate hook 的 git 用户依然有效。
    // 仅在纯 hook（非 git）模式下才会跳过。
    let tmuxSessionName: string | undefined
    if (inGit) {
      // 解析到主仓库根目录（处理从 worktree 内部被调用的情况）。
      // findCanonicalGitRoot 是同步/仅文件系统/带记忆化的；其底层
      // findGitRoot 缓存已被上面的 getIsGit() 预热，因此这里几乎是零开销。
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `Error: Could not determine the main git repository root.\n`,
          ),
        )
        process.exit(1)
      }

      // 如果当前位于某个 worktree 内部，则切换到主仓库以便创建 worktree
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // 非 git 的 hook 模式：没有 canonical root 可解析，因此以 cwd 命名 tmux 会话 ——
      // generateTmuxSessionName 只取路径的 basename。
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }

    logEvent('tengu_worktree_created', { tmux_enabled: tmuxEnabled })

    // 如果启用则为 worktree 创建 tmux 会话
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        console.log(
          chalk.green(
            `Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        console.error(
          chalk.yellow(
            `Warning: Failed to create tmux session: ${tmuxResult.error}`,
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree 意味着这个 worktree 就是会话的项目根，因此 skills/hooks/
    // cron/etc. 都应在此路径下解析。（会话中途使用 EnterWorktreeTool 并不会
    // 修改 projectRoot —— 那是一次性 worktree，项目根保持稳定。）
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // 由于 originalCwd 已改变，需要清空 memory 文件缓存
    clearMemoryFileCaches()
    // settings 缓存已在 init()（通过 applySafeConfigEnvironmentVariables）中填充，
    // 又在上面的 captureHooksConfigSnapshot() 中再填充一次，这两次都来自
    // 原目录的 .hclaude/settings.json。这里从 worktree 重新读取并重新捕获 hooks 快照。
    updateHooksConfigSnapshot()
  }

  // 后台任务 —— 仅注册那些必须在首次 query 之前完成的关键项
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // 打包的 skills/plugins 在 main.tsx 中、并行的 getCommands() 启动之前注册 ——
  // 详见那里的注释。它们之所以从 setup() 中移出，是因为上面的 await 点
  // （startUdsMessaging 约 20ms）会让 getCommands() 抢跑并记忆化一个空的 bundledSkills 列表。
  if (!isBareMode()) {
    initSessionMemory() // 同步 —— 注册 hook，gate 检查延迟进行
    initSkillLearning() // 同步 —— 注册 hook，gate 检查延迟进行
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // 锁定当前版本，防止被其他进程删除
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  // 预取 promise —— 仅包含渲染前需要的项
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // 当设置了 CLAUDE_CODE_SYNC_PLUGIN_INSTALL 时，跳过所有插件预取。
  // print.ts 中的同步安装路径在安装完成后会调用 refreshPluginState()
  // 来重新加载 commands、hooks 和 agents。在此处预取会与安装过程产生竞态
  // （双方会在相同目录上并发执行 copyPluginToVersionedCache / cachePlugin），
  // 且 hot-reload handler 会在安装过程中因 policySettings 到达而触发 clearPluginCache()。
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() &&
      isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) ||
    // --bare：loadPluginHooks → loadAllPlugins 是文件系统操作，
    // 而 --bare 下 executeHooks 本来就会提前 return，这份工作纯属浪费。
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // 预加载插件 hooks（在渲染前被 processSessionStartHooks 消费）
      m.setupPluginHookHotReload() // 设置插件 hooks 在 settings 变更时的热重载
    }
  })
  // --bare：跳过 attribution hook 安装 + 仓库分类 +
  // session-file-access 分析 + team memory 监视器。这些都是 commit 归因 +
  // 使用量指标相关的后台簿记工作 —— 脚本化调用不会提交代码，
  // 而 attribution hook 的 stat 检查（实测 49ms）纯属开销。
  // 这里不是提前 return：下面的 --dangerously-skip-permissions 安全 gate、
  // tengu_started 信标以及 apiKeyHelper 预取仍然必须执行。
  if (!isBareMode()) {
    if (process.env.USER_TYPE === 'ant') {
      // 为 auto-undercover 模式预热仓库分类缓存。默认是
      // undercover ON，直到被证明是 internal；若解析结果为 internal，
      // 则清空 prompt 缓存让下一轮读取到 OFF 状态。
      void import('./utils/commitAttribution.js').then(async m => {
        if (await m.isInternalModelRepo()) {
          const { clearSystemPromptSections } = await import(
            './constants/systemPromptSections.js'
          )
          clearSystemPromptSections()
        }
      })
    }
    if (feature('COMMIT_ATTRIBUTION')) {
      // 动态 import 以支持死代码消除（该模块包含被排除的字符串）。
      // 延迟到下一个 tick，让 git 子进程 spawn 发生在首次渲染之后，
      // 而不是 setup() 的微任务窗口里。
      setImmediate(() => {
        void import('./utils/attributionHooks.js').then(
          ({ registerAttributionHooks }) => {
            registerAttributionHooks() // 注册 attribution 跟踪 hooks（ant 专属功能）
          },
        )
      })
    }
    void import('./utils/sessionFileAccessHooks.js').then(m =>
      m.registerSessionFileAccessHooks(),
    ) // 注册 session 文件访问分析 hooks
    if (feature('TEAMMEM')) {
      void import('./services/teamMemorySync/watcher.js').then(m =>
        m.startTeamMemoryWatcher(),
      ) // 启动 team memory 同步监视器
    }
  }
  initSinks() // 挂载错误日志 + 分析 sinks，并排空队列中已积累的事件

  // 会话成功率的分母。在 analytics sink 挂载之后立即发射 —— 早于任何
  // 可能抛错的 parsing、fetching 或 I/O。inc-3694（P0 CHANGELOG 崩溃）
  // 就是在下面的 checkForReleaseNotes 处抛出；此点之后的所有事件都丢失了。
  // 此信标是发布健康监控所能依赖的最早一个可靠的"进程已启动"信号。
  logEvent('tengu_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // 安全地预取 —— 仅在 trust 已确认时才会真正执行
  profileCheckpoint('setup_after_prefetch')

  // 为 Logo v2 预取数据 —— await 以保证 logo 渲染前数据已就绪。
  // --bare / SIMPLE：跳过 —— release notes 是交互式 UI 的展示数据，
  // 且 getRecentActivity() 会读取多达 10 个 session JSONL 文件。
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(
      getGlobalConfig().lastReleaseNotesSeen,
    )
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  // 若权限模式设为 bypass，则校验当前处于安全环境中
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // 检查是否以 root/sudo 身份在类 Unix 系统上运行
    // 若处于 sandbox 中则允许 root（例如需要 root 的 TPU devspaces）
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
    ) {
      console.error(
        `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }

    if (
      process.env.USER_TYPE === 'ant' &&
      // 跳过 Desktop 的 local agent 模式 —— 信任模型与 CCR/BYOC 相同
      //（由受信任的 Anthropic 托管启动器刻意预先批准一切）。
      // 先例：permissionSetup.ts:861、applySettingsChange.ts:55（PR #19116）
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&
      // CCD（Desktop 中的 Claude Code）同理 —— apps#29127 会无条件传入
      // 该 flag 以解锁会话中途切换 bypass
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop'
    ) {
      // 仅当权限模式设为 bypass 时才需要 await
      const [isDocker, hasInternet] = await Promise.all([
        envDynamic.getIsDocker(),
        env.hasInternetAccess(),
      ])
      const isBubblewrap = envDynamic.getIsBubblewrapSandbox()
      const isSandbox = process.env.IS_SANDBOX === '1'
      const isSandboxed = isDocker || isBubblewrap || isSandbox
      if (!isSandboxed || hasInternet) {
        console.error(
          `--dangerously-skip-permissions can only be used in Docker/sandbox containers with no internet access but got Docker: ${isDocker}, Bubblewrap: ${isBubblewrap}, IS_SANDBOX: ${isSandbox}, hasInternet: ${hasInternet}`,
        )
        process.exit(1)
      }
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  // 记录上一个会话的 tengu_exit 事件？
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('tengu_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens:
        projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // 注意：我们有意在日志记录后不清除这些值。
    // 恢复会话时它们是成本还原所必需的。
    // 这些值会在下一个会话退出时被覆盖。
  }
}
