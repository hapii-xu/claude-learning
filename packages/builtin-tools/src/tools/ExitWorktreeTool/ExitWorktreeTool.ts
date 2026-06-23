import { z } from 'zod/v4'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from 'src/bootstrap/state.js'
import { clearSystemPromptSections } from 'src/constants/systemPromptSections.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { Tool } from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import { count } from 'src/utils/array.js'
import { clearMemoryFileCaches } from 'src/utils/claudemd.js'
import { execFileNoThrow } from 'src/utils/execFileNoThrow.js'
import { updateHooksConfigSnapshot } from 'src/utils/hooks/hooksConfigSnapshot.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { getPlansDirectory } from 'src/utils/plans.js'
import { setCwd } from 'src/utils/Shell.js'
import { saveWorktreeState } from 'src/utils/sessionStorage.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  killTmuxSession,
} from 'src/utils/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['keep', 'remove'])
      .describe(
        '"keep" 在磁盘上保留 worktree 和分支；"remove" 删除两者。',
      ),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        '当 action 为 "remove" 且 worktree 有未提交文件或未合并提交时，必须为 true。否则工具会拒绝并列出这些更改。',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['keep', 'remove']),
    originalCwd: z.string(),
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    tmuxSessionName: z.string().optional(),
    discardedFiles: z.number().optional(),
    discardedCommits: z.number().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type ChangeSummary = {
  changedFiles: number
  commits: number
}

/**
 * 当无法可靠确定状态时返回 null — 将此用作安全门控的调用方
 * 必须将 null 视为"未知，假设不安全"（失败即关闭）。
 * 静默的 0/0 会让 cleanupWorktree 销毁真实工作。
 *
 * 在以下情况返回 null：
 * - git status 或 rev-list 非零退出（锁文件、损坏的索引、错误的 ref）
 * - originalHeadCommit 为 undefined 但 git status 成功 — 这是
 *   基于 hook 的 worktree 包装 git 的情况（worktree.ts:525-532 未设置
 *   originalHeadCommit）。我们可以看到工作树是 git，但没有基线
 *   无法计算提交，因此无法证明分支是干净的。
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  const status = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain',
  ])
  if (status.code !== 0) {
    return null
  }
  const changedFiles = count(status.stdout.split('\n'), l => l.trim() !== '')

  if (!originalHeadCommit) {
    // git status 成功 → 这是一个 git 仓库，但没有基线
    // 提交，我们无法计算提交数。保守失败而不是声称 0。
    return null
  }

  const revList = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    `${originalHeadCommit}..HEAD`,
  ])
  if (revList.code !== 0) {
    return null
  }
  const commits = parseInt(revList.stdout.trim(), 10) || 0

  return { changedFiles, commits }
}

/**
 * 恢复会话状态以反映原始目录。
 * 这是 EnterWorktreeTool.call() 中会话级变更的逆操作。
 *
 * keepWorktree()/cleanupWorktree() 处理 process.chdir 和 currentWorktreeSession；
 * 这个函数处理 worktree 工具层之上的所有内容。
 */
function restoreSessionToOriginalCwd(
  originalCwd: string,
  projectRootIsWorktree: boolean,
): void {
  setCwd(originalCwd)
  // EnterWorktree 将 originalCwd 设置为 *worktree* 路径（有意为之——
  // 参见 state.ts getProjectRoot 注释）。重置为真正的原始路径。
  setOriginalCwd(originalCwd)
  // --worktree 启动时将 projectRoot 设置为 worktree；会话中期的
  // EnterWorktreeTool 则不会。仅在实际更改时才恢复——
  // 否则我们会将 projectRoot 移动到用户进入 worktree 之前
  // cd 到的任何位置（session.originalCwd），破坏"稳定项目
  // 身份"契约。
  if (projectRootIsWorktree) {
    setProjectRoot(originalCwd)
    // setup.ts 的 --worktree 块调用了 updateHooksConfigSnapshot() 以从
    // worktree 重新读取 hooks。对称地恢复。（会话中期的
    // EnterWorktreeTool 从未触及快照，因此在那里是空操作。）
    updateHooksConfigSnapshot()
  }
  saveWorktreeState(null)
  clearSystemPromptSections()
  clearMemoryFileCaches()
  getPlansDirectory.cache.clear?.()
}

export const ExitWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  searchHint: '退出 worktree 会话并返回原始目录',
  maxResultSizeChars: 100_000,
  async description() {
    return '退出由 EnterWorktree 创建的 worktree 会话，并恢复原始工作目录'
  },
  async prompt() {
    return getExitWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return '退出 worktree'
  },
  shouldDefer: true,
  isDestructive(input) {
    return input.action === 'remove'
  },
  toAutoClassifierInput(input) {
    return input.action
  },
  async validateInput(input) {
    // 范围守卫：除非 EnterWorktree（特别是 createWorktreeForSession）
    // 在*此*会话中运行，否则 getCurrentWorktreeSession() 为 null。
    // 由 `git worktree add` 或先前会话中的 EnterWorktree 创建的
    // worktree 不会填充它。这是唯一的入口门控——此点之后的所有内容
    // 都在 EnterWorktree 创建的路径上运行。
    const session = getCurrentWorktreeSession()
    if (!session) {
      return {
        result: false,
        message:
          '空操作：没有活动的 EnterWorktree 会话可以退出。此工具仅操作当前会话中由 EnterWorktree 创建的 worktree — 它不会触及手动创建或先前会话中创建的 worktree。未进行任何文件系统更改。',
        errorCode: 1,
      }
    }

    if (input.action === 'remove' && !input.discard_changes) {
      const summary = await countWorktreeChanges(
        session.worktreePath,
        session.originalHeadCommit,
      )
      if (summary === null) {
        return {
          result: false,
          message: `无法验证 ${session.worktreePath} 处的 worktree 状态。未经明确确认拒绝删除。用 discard_changes: true 重新调用以继续 — 或使用 action: "keep" 保留 worktree。`,
          errorCode: 3,
        }
      }
      const { changedFiles, commits } = summary
      if (changedFiles > 0 || commits > 0) {
        const parts: string[] = []
        if (changedFiles > 0) {
          parts.push(
            `${changedFiles} 个未提交${changedFiles === 1 ? '文件' : '文件'}`,
          )
        }
        if (commits > 0) {
          parts.push(
            `${session.worktreeBranch ?? 'worktree 分支'}上的 ${commits} 个提交`,
          )
        }
        return {
          result: false,
          message: `Worktree 有${parts.join('和')}。删除将永久丢弃此工作。与用户确认，然后用 discard_changes: true 重新调用 — 或使用 action: "keep" 保留 worktree。`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      // validateInput 对此进行了保护，但会话是模块级可变
      // 状态——防御验证和执行之间的竞态。
      throw new Error('不在 worktree 会话中')
    }

    // 在 keepWorktree/cleanupWorktree 将 currentWorktreeSession 置空之前捕获。
    const {
      originalCwd,
      worktreePath,
      worktreeBranch,
      tmuxSessionName,
      originalHeadCommit,
    } = session

    // --worktree 启动时在 setCwd(worktreePath) 之后背靠背调用
    // setOriginalCwd(getCwd()) 和 setProjectRoot(getCwd())
    // （setup.ts:235/239），因此两者都保存相同的 realpath'd 值，
    // BashTool cd 永远不会触及它们。会话中期的 EnterWorktreeTool
    // 设置 originalCwd 但不设置 projectRoot。（不能使用 getCwd()——
    // BashTool 在每次 cd 时都会改变它。不能使用 session.worktreePath——
    // 它是 join()'d，不是 realpath'd。）
    const projectRootIsWorktree = getProjectRoot() === getOriginalCwd()

    // 在执行时重新计数以获得准确的分析数据和输出——
    // validateInput 时的 worktree 状态现在可能不匹配。
    // Null（git 失败）回退到 0/0；安全门控已经在
    // validateInput 中发生，所以这只影响分析数据+消息传递。
    const { changedFiles, commits } = (await countWorktreeChanges(
      worktreePath,
      originalHeadCommit,
    )) ?? { changedFiles: 0, commits: 0 }

    if (input.action === 'keep') {
      await keepWorktree()
      restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

      logEvent('tengu_worktree_kept', {
        mid_session: true,
        commits,
        changed_files: changedFiles,
      })

      const tmuxNote = tmuxSessionName
        ? ` Tmux 会话 ${tmuxSessionName} 仍在运行；用以下命令重新附加：tmux attach -t ${tmuxSessionName}`
        : ''
      return {
        data: {
          action: 'keep' as const,
          originalCwd,
          worktreePath,
          worktreeBranch,
          tmuxSessionName,
          message: `已退出 worktree。你的工作保留在 ${worktreePath}${worktreeBranch ? ` 的 ${worktreeBranch} 分支上` : ''}。会话现在回到了 ${originalCwd}。${tmuxNote}`,
        },
      }
    }

    // action === 'remove'
    if (tmuxSessionName) {
      await killTmuxSession(tmuxSessionName)
    }
    await cleanupWorktree()
    restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

    logEvent('tengu_worktree_removed', {
      mid_session: true,
      commits,
      changed_files: changedFiles,
    })

    const discardParts: string[] = []
    if (commits > 0) {
      discardParts.push(`${commits} 个提交`)
    }
    if (changedFiles > 0) {
      discardParts.push(
        `${changedFiles} 个未提交文件`,
      )
    }
    const discardNote =
      discardParts.length > 0 ? ` 已丢弃${discardParts.join('和')}。` : ''
    return {
      data: {
        action: 'remove' as const,
        originalCwd,
        worktreePath,
        worktreeBranch,
        discardedFiles: changedFiles,
        discardedCommits: commits,
        message: `已退出并删除 ${worktreePath} 处的 worktree。${discardNote} 会话现在回到了 ${originalCwd}。`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
