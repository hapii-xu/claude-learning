import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { lazySchema } from '../lazySchema.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getTasksDir, notifyTasksUpdated } from '../tasks.js'
import { getAgentName, getTeamName, isTeammate } from '../teammate.js'
import { type BackendType, isPaneBackend } from './backends/types.js'
import { TEAM_LEAD_NAME } from './constants.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['spawnTeam', 'cleanup'])
      .describe(
        'Operation: spawnTeam to create a team, cleanup to remove team and task directories.',
      ),
    agent_type: z
      .string()
      .optional()
      .describe(
        'Type/role of the team lead (e.g., "researcher", "test-runner"). ' +
          'Used for team file and inter-agent coordination.',
      ),
    team_name: z
      .string()
      .optional()
      .describe('Name for the new team to create (required for spawnTeam).'),
    description: z
      .string()
      .optional()
      .describe('Team description/purpose (only used with spawnTeam).'),
  }),
)

// 不同操作的不同输出类型
export type SpawnTeamOutput = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

export type CleanupOutput = {
  success: boolean
  message: string
  team_name?: string
}

export type TeamAllowedPath = {
  path: string // 目录路径（绝对路径）
  toolName: string // 适用的工具（例如 "Edit"、"Write"）
  addedBy: string // 添加此规则的 agent 名称
  addedAt: number // 添加时间戳
}

export type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string // leader 的实际会话 UUID（用于发现）
  hiddenPaneIds?: string[] // 当前从 UI 隐藏的面板 ID
  teamAllowedPaths?: TeamAllowedPath[] // 所有 teammate 无需询问即可编辑的路径
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    planModeRequired?: boolean
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    subscriptions: string[]
    backendType?: BackendType
    isActive?: boolean // 空闲时为 false，undefined/true 时为活动
    mode?: PermissionMode // 此 teammate 当前的权限模式
  }>
}

export type Input = z.infer<ReturnType<typeof inputSchema>>
// 将 SpawnTeamOutput 导出为 Output 以保持向后兼容
export type Output = SpawnTeamOutput

/**
 * 清理名称以用于 tmux 窗口名、worktree 路径和文件路径。
 * 将所有非字母数字字符替换为连字符并转为小写。
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/**
 * 清理 agent 名称以用于确定性 agent ID。
 * 将 @ 替换为 - 以防止 agentName@teamName 格式中的歧义。
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

/** 获取团队目录的路径 */
export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

/** 获取团队 config.json 文件的路径 */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}

/**
 * 按名称读取团队文件（同步，用于 React 渲染路径等同步上下文）
 * @internal 导出用于团队发现 UI
 */
// 同步 IO：从同步上下文调用
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/** 按名称读取团队文件（异步，用于工具处理程序和其他异步上下文） */
export async function readTeamFileAsync(
  teamName: string,
): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/** 写入团队文件（同步，用于同步上下文） */
// 同步 IO：从同步上下文调用
function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const teamDir = getTeamDir(teamName)
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

/** 写入团队文件（异步，用于工具处理程序） */
export async function writeTeamFileAsync(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  const teamDir = getTeamDir(teamName)
  await mkdir(teamDir, { recursive: true })
  await writeFile(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

/**
 * 通过 agent ID 或名称从团队文件中移除 teammate。
 * 由 leader 在处理关闭批准时调用。
 */
export function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): boolean {
  const identifierStr = identifier.agentId || identifier.name
  if (!identifierStr) {
    logForDebugging(
      '[TeammateTool] removeTeammateFromTeamFile called with no identifier',
    )
    return false
  }

  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logForDebugging(
      `[TeammateTool] Cannot remove teammate ${identifierStr}: failed to read team file for "${teamName}"`,
    )
    return false
  }

  const originalLength = teamFile.members.length
  teamFile.members = teamFile.members.filter(m => {
    if (identifier.agentId && m.agentId === identifier.agentId) return false
    if (identifier.name && m.name === identifier.name) return false
    return true
  })

  if (teamFile.members.length === originalLength) {
    logForDebugging(
      `[TeammateTool] Teammate ${identifierStr} not found in team file for "${teamName}"`,
    )
    return false
  }

  writeTeamFile(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Removed teammate from team file: ${identifierStr}`,
  )
  return true
}

/**
 * 将面板 ID 添加到团队文件的隐藏面板列表中。
 * @param teamName - 团队名称
 * @param paneId - 要隐藏的面板 ID
 * @returns 如果面板被添加到隐藏列表则返回 true，团队不存在则返回 false
 */
export function addHiddenPaneId(teamName: string, paneId: string): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
  if (!hiddenPaneIds.includes(paneId)) {
    hiddenPaneIds.push(paneId)
    teamFile.hiddenPaneIds = hiddenPaneIds
    writeTeamFile(teamName, teamFile)
    logForDebugging(
      `[TeammateTool] Added ${paneId} to hidden panes for team ${teamName}`,
    )
  }
  return true
}

/**
 * 从团队文件的隐藏面板列表中移除面板 ID。
 * @param teamName - 团队名称
 * @param paneId - 要显示的面板 ID（从隐藏列表中移除）
 * @returns 如果面板从隐藏列表中移除则返回 true，团队不存在则返回 false
 */
export function removeHiddenPaneId(teamName: string, paneId: string): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
  const index = hiddenPaneIds.indexOf(paneId)
  if (index !== -1) {
    hiddenPaneIds.splice(index, 1)
    teamFile.hiddenPaneIds = hiddenPaneIds
    writeTeamFile(teamName, teamFile)
    logForDebugging(
      `[TeammateTool] Removed ${paneId} from hidden panes for team ${teamName}`,
    )
  }
  return true
}

/**
 * 通过面板 ID 从团队配置文件中移除 teammate。
 * 如果存在，也会从 hiddenPaneIds 中移除。
 * @param teamName - 团队名称
 * @param tmuxPaneId - 要移除的 teammate 的面板 ID
 * @returns 如果成员被移除则返回 true，团队或成员不存在则返回 false
 */
export function removeMemberFromTeam(
  teamName: string,
  tmuxPaneId: string,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const memberIndex = teamFile.members.findIndex(
    m => m.tmuxPaneId === tmuxPaneId,
  )
  if (memberIndex === -1) {
    return false
  }

  // 从 members 数组中移除
  teamFile.members.splice(memberIndex, 1)

  // 如果存在也从 hiddenPaneIds 中移除
  if (teamFile.hiddenPaneIds) {
    const hiddenIndex = teamFile.hiddenPaneIds.indexOf(tmuxPaneId)
    if (hiddenIndex !== -1) {
      teamFile.hiddenPaneIds.splice(hiddenIndex, 1)
    }
  }

  writeTeamFile(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Removed member with pane ${tmuxPaneId} from team ${teamName}`,
  )
  return true
}

/**
 * 通过 agent ID 从团队的成员列表中移除 teammate。
 * 用于所有共享同一 tmuxPaneId 的进程内 teammate。
 * @param teamName - 团队名称
 * @param agentId - 要移除的 teammate 的 agent ID（例如 "researcher@my-team"）
 * @returns 如果成员被移除则返回 true，团队或成员不存在则返回 false
 */
export function removeMemberByAgentId(
  teamName: string,
  agentId: string,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const memberIndex = teamFile.members.findIndex(m => m.agentId === agentId)
  if (memberIndex === -1) {
    return false
  }

  // 从 members 数组中移除
  teamFile.members.splice(memberIndex, 1)

  writeTeamFile(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Removed member ${agentId} from team ${teamName}`,
  )
  return true
}

/**
 * 设置团队成员的权限模式。
 * 当团队 leader 通过 TeamsDialog 更改 teammate 的模式时调用。
 * @param teamName - 团队名称
 * @param memberName - 要更新的成员名称
 * @param mode - 新的权限模式
 */
export function setMemberMode(
  teamName: string,
  memberName: string,
  mode: PermissionMode,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const member = teamFile.members.find(m => m.name === memberName)
  if (!member) {
    logForDebugging(
      `[TeammateTool] Cannot set member mode: member ${memberName} not found in team ${teamName}`,
    )
    return false
  }

  // 仅在值实际变化时才写入
  if (member.mode === mode) {
    return true
  }

  // 以不可变方式创建更新后的 members 数组
  const updatedMembers = teamFile.members.map(m =>
    m.name === memberName ? { ...m, mode } : m,
  )
  writeTeamFile(teamName, { ...teamFile, members: updatedMembers })
  logForDebugging(
    `[TeammateTool] Set member ${memberName} in team ${teamName} to mode: ${mode}`,
  )
  return true
}

/**
 * 将当前 teammate 的模式同步到 config.json 以便 team lead 可见。
 * 如果不是以 teammate 身份运行则无操作。
 * @param mode - 要同步的权限模式
 * @param teamNameOverride - 可选的团队名称覆盖（未提供时使用环境变量）
 */
export function syncTeammateMode(
  mode: PermissionMode,
  teamNameOverride?: string,
): void {
  if (!isTeammate()) return
  const teamName = teamNameOverride ?? getTeamName()
  const agentName = getAgentName()
  if (teamName && agentName) {
    setMemberMode(teamName, agentName, mode)
  }
}

/**
 * 在单个原子操作中设置多个团队成员的权限模式。
 * 避免同时更新多个 teammate 时的竞态条件。
 * @param teamName - 团队名称
 * @param modeUpdates - 要更新的 {memberName, mode} 数组
 */
export function setMultipleMemberModes(
  teamName: string,
  modeUpdates: Array<{ memberName: string; mode: PermissionMode }>,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  // 构建更新映射以便高效查找
  const updateMap = new Map(modeUpdates.map(u => [u.memberName, u.mode]))

  // 以不可变方式创建更新后的 members 数组
  let anyChanged = false
  const updatedMembers = teamFile.members.map(member => {
    const newMode = updateMap.get(member.name)
    if (newMode !== undefined && member.mode !== newMode) {
      anyChanged = true
      return { ...member, mode: newMode }
    }
    return member
  })

  if (anyChanged) {
    writeTeamFile(teamName, { ...teamFile, members: updatedMembers })
    logForDebugging(
      `[TeammateTool] Set ${modeUpdates.length} member modes in team ${teamName}`,
    )
  }
  return true
}

/**
 * 设置团队成员的活动状态。
 * 当 teammate 变为空闲（isActive=false）或开始新轮次（isActive=true）时调用。
 * @param teamName - 团队名称
 * @param memberName - 要更新的成员名称
 * @param isActive - 成员是否活动（true 为活动，false 为空闲）
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    logForDebugging(
      `[TeammateTool] Cannot set member active: team ${teamName} not found`,
    )
    return
  }

  const member = teamFile.members.find(m => m.name === memberName)
  if (!member) {
    logForDebugging(
      `[TeammateTool] Cannot set member active: member ${memberName} not found in team ${teamName}`,
    )
    return
  }

  // 仅在值实际变化时才写入
  if (member.isActive === isActive) {
    return
  }

  member.isActive = isActive
  await writeTeamFileAsync(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Set member ${memberName} in team ${teamName} to ${isActive ? 'active' : 'idle'}`,
  )
}

/**
 * 销毁给定路径的 git worktree。
 * 首先尝试使用 `git worktree remove`，然后回退到 rm -rf。
 * 对不存在的路径调用是安全的。
 */
async function destroyWorktree(worktreePath: string): Promise<void> {
  // 读取 worktree 中的 .git 文件以找到主仓库
  const gitFilePath = join(worktreePath, '.git')
  let mainRepoPath: string | null = null

  try {
    const gitFileContent = (await readFile(gitFilePath, 'utf-8')).trim()
    // .git 文件包含类似：gitdir: /path/to/repo/.git/worktrees/worktree-name
    const match = gitFileContent.match(/^gitdir:\s*(.+)$/)
    if (match && match[1]) {
      // 提取主仓库的 .git 目录（从 .git/worktrees/name 向上到 .git）
      const worktreeGitDir = match[1]
      // 从 .git/worktrees/name 向上 2 级到 .git，然后获取父目录作为仓库根
      const mainGitDir = join(worktreeGitDir, '..', '..')
      mainRepoPath = join(mainGitDir, '..')
    }
  } catch {
    // 忽略读取 .git 文件的错误（路径不存在、不是文件等）
  }

  // 尝试使用 git worktree remove 命令移除
  if (mainRepoPath) {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: mainRepoPath },
    )

    if (result.code === 0) {
      logForDebugging(
        `[TeammateTool] Removed worktree via git: ${worktreePath}`,
      )
      return
    }

    // 检查错误是否为 "not a working tree"（已移除）
    if (result.stderr?.includes('not a working tree')) {
      logForDebugging(
        `[TeammateTool] Worktree already removed: ${worktreePath}`,
      )
      return
    }

    logForDebugging(
      `[TeammateTool] git worktree remove failed, falling back to rm: ${result.stderr}`,
    )
  }

  // 回退：手动移除目录
  try {
    await rm(worktreePath, { recursive: true, force: true })
    logForDebugging(
      `[TeammateTool] Removed worktree directory manually: ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to remove worktree ${worktreePath}: ${errorMessage(error)}`,
    )
  }
}

/**
 * 将团队标记为本会话创建，以便退出时清理。
 * 在初始 writeTeamFile 之后立即调用。TeamDelete 应
 * 调用 unregisterTeamForSessionCleanup 以防止重复清理。
 * 底层 Set 位于 bootstrap/state.ts 中，以便 resetStateForTests()
 * 在测试之间清除它（避免 PR #17615 跨分片泄漏类问题）。
 */
export function registerTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().add(teamName)
}

/**
 * 从会话清理跟踪中移除团队（例如，在显式 TeamDelete 之后
 * 已经清理过了，关闭时不再尝试）。
 */
export function unregisterTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().delete(teamName)
}

/**
 * 清除此会话中创建但未被显式删除的所有团队。
 * 通过 init.ts 中的 gracefulShutdown 注册。
 */
export async function cleanupSessionTeams(): Promise<void> {
  const sessionCreatedTeams = getSessionCreatedTeams()
  if (sessionCreatedTeams.size === 0) return
  const teams = Array.from(sessionCreatedTeams)
  logForDebugging(
    `cleanupSessionTeams: removing ${teams.length} orphan team dir(s): ${teams.join(', ')}`,
  )
  // 先杀死面板 — 在 SIGINT 时 teammate 进程仍在运行；
  // 仅删除目录会使它们成为开放 tmux/iTerm2 面板中的孤儿进程。
  // （TeamDeleteTool 的路径不需要这样做 — 那时 teammate 已经
  // 优雅退出且 useInboxPoller 已经关闭了它们的面板。）
  await Promise.allSettled(teams.map(name => killOrphanedTeammatePanes(name)))
  await Promise.allSettled(teams.map(name => cleanupTeamDirectories(name)))
  sessionCreatedTeams.clear()
}

/**
 * 尽力杀死团队的所有面板支持的 teammate 面板。
 * 从 cleanupSessionTeams 在 leader 非优雅退出（SIGINT/SIGTERM）时调用。
 * 动态导入避免将 registry/detection 添加到此模块的静态
 * 依赖图 — 这仅在关闭时运行，因此导入成本无关紧要。
 */
async function killOrphanedTeammatePanes(teamName: string): Promise<void> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return

  const paneMembers = teamFile.members.filter(
    m =>
      m.name !== TEAM_LEAD_NAME &&
      m.tmuxPaneId &&
      m.backendType &&
      isPaneBackend(m.backendType),
  )
  if (paneMembers.length === 0) return

  const [{ ensureBackendsRegistered, getBackendByType }, { isInsideTmux }] =
    await Promise.all([
      import('./backends/registry.js'),
      import('./backends/detection.js'),
    ])
  await ensureBackendsRegistered()
  const useExternalSession = !(await isInsideTmux())

  await Promise.allSettled(
    paneMembers.map(async m => {
      // 上面的 filter 保证了这些；为类型系统收窄
      if (!m.tmuxPaneId || !m.backendType || !isPaneBackend(m.backendType)) {
        return
      }
      const ok = await getBackendByType(m.backendType).killPane(
        m.tmuxPaneId,
        useExternalSession,
      )
      logForDebugging(
        `cleanupSessionTeams: killPane ${m.name} (${m.backendType} ${m.tmuxPaneId}) → ${ok}`,
      )
    }),
  )
}

/**
 * 清理给定团队名称的团队和任务目录。
 * 同时清理为 teammate 创建的 git worktree。
 * 在 swarm 会话终止时调用。
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const sanitizedName = sanitizeName(teamName)

  // 在删除团队目录之前读取团队文件以获取 worktree 路径
  const teamFile = readTeamFile(teamName)
  const worktreePaths: string[] = []
  if (teamFile) {
    for (const member of teamFile.members) {
      if (member.worktreePath) {
        worktreePaths.push(member.worktreePath)
      }
    }
  }

  // 先清理 worktree
  for (const worktreePath of worktreePaths) {
    await destroyWorktree(worktreePath)
  }

  // 清理团队目录（~/.claude/teams/{team-name}/）
  const teamDir = getTeamDir(teamName)
  try {
    await rm(teamDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up team directory: ${teamDir}`)
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up team directory ${teamDir}: ${errorMessage(error)}`,
    )
  }

  // 清理任务目录（~/.claude/tasks/{taskListId}/）
  // leader 和 teammate 都在清理后的团队名称下存储任务。
  const tasksDir = getTasksDir(sanitizedName)
  try {
    await rm(tasksDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up tasks directory: ${tasksDir}`)
    notifyTasksUpdated()
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up tasks directory ${tasksDir}: ${errorMessage(error)}`,
    )
  }
}
