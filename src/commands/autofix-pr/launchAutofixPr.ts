// NOTE：这里没有实现 subscribePR（KAIROS_GITHUB_WEBHOOKS feature）。
// 本仓库中 kairos client 尚未完全可用。这个 feature-gated 调用属于锦上添花、
// 可以安全跳过 —— teleport + registerRemoteAgentTask 已经足以支撑核心 autofix 流程。

import React from 'react'
import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  getRemoteTaskSessionUrl,
  registerCompletionChecker,
  registerCompletionHook,
  registerContentExtractor,
  registerRemoteAgentTask,
  type AutofixPrRemoteTaskMetadata,
  type BackgroundRemoteSessionPrecondition,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { detectCurrentRepositoryWithHost } from '../../utils/detectRepository.js'
import { teleportToRemote } from '../../utils/teleport.js'
import { AutofixProgress } from './AutofixProgress.js'
import { createAutofixTeammate } from './inProcessAgent.js'
import {
  clearActiveMonitor,
  getActiveMonitor,
  isMonitoring,
  trySetActiveMonitor,
  updateActiveMonitor,
} from './monitorState.js'
import { extractAutofixResultFromLog } from './extractAutofixResult.js'
import { parseAutofixArgs } from './parseArgs.js'
import { checkPrAutofixOutcome, fetchPrHeadSha } from './prFetch.js'
import { detectAutofixSkills, formatSkillsHint } from './skillDetect.js'

// completionChecker 的限流 map：无论框架 1s 一次的轮询节奏如何，
// 每个 PR 在 CHECK_INTERVAL_MS 内最多调用一次 gh CLI。
// Key 为 `${owner}/${repo}#${prNumber}`。completion hook 触发时清理，
// 这样重新启动的 monitor 会拿到全新的预算。
const lastCheckAt = new Map<string, number>()
const CHECK_INTERVAL_MS = 5_000

function throttleKey(meta: AutofixPrRemoteTaskMetadata): string {
  return `${meta.owner}/${meta.repo}#${meta.prNumber}`
}

// 在模块加载时一次性注册 completionChecker。框架会在每次 poll tick
// 时对所有 remoteTaskType==='autofix-pr' 的任务调用它；内部限流，
// 避免每分钟触发 60 次 gh CLI。完成时返回摘要字符串
// （作为 task-notification 的正文），返回 null 表示继续轮询。
registerCompletionChecker('autofix-pr', async metadata => {
  const meta = metadata as AutofixPrRemoteTaskMetadata | undefined
  if (!meta) return null

  const key = throttleKey(meta)
  const now = Date.now()
  if (now - (lastCheckAt.get(key) ?? 0) < CHECK_INTERVAL_MS) return null
  lastCheckAt.set(key, now)

  const result = await checkPrAutofixOutcome({
    owner: meta.owner,
    repo: meta.repo,
    prNumber: meta.prNumber,
    initialHeadSha: meta.initialHeadSha,
  })
  return result.completed ? result.summary : null
})

// 当框架把 autofix 任务切换到终态时，释放单例 monitor 锁。
// 若不释放，这把锁（key 是框架分配的 taskId，即 callAutofixPr 中
// updateActiveMonitor 替换后的值）会一直挂到自然完成，阻塞后续的
// /autofix-pr 调用，直到进程重启。在模块加载时注册；
// 框架的 runCompletionHook 在每次终态切换时调用它一次。
// 同时清理该 PR 的限流条目，让重新启动从零开始。
registerCompletionHook('autofix-pr', (taskId, metadata) => {
  clearActiveMonitor(taskId)
  const meta = metadata as AutofixPrRemoteTaskMetadata | undefined
  if (meta) lastCheckAt.delete(throttleKey(meta))
})

// Phase 3 内容返回：从会话日志中提取 <autofix-result> 标签，
// 让本地模型在完成任务的 task-notification 里直接看到 agent 的结构化结果
// （push 的 commit、改动的文件、CI 状态），而不只是一个文件路径指针。
// 提取返回 null 时框架回退到通用通知。
registerContentExtractor('autofix-pr', log => extractAutofixResultFromLog(log))

function makeErrorText(message: string, code: string): string {
  logEvent('tengu_autofix_pr_result', {
    result:
      'failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error_code:
      code as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return `Autofix PR failed: ${message}`
}

export const callAutofixPr: LocalJSXCommandCall = async (
  onDone,
  context,
  args,
) => {
  try {
    const parsed = parseAutofixArgs(args)

    // 1. stop 子命令
    if (parsed.action === 'stop') {
      const m = getActiveMonitor()
      if (!m) {
        onDone('No active autofix monitor.', { display: 'system' })
        return null
      }
      clearActiveMonitor()
      // 诚实的措辞：本地锁已释放，进行中的 teleport 请求也被中止，
      // 但已经启动并跑在云端的 CCR 会话会继续运行，直到它自行完成或被
      // 用户在 claude.ai/code 上取消。
      onDone(
        `Stopped local monitoring of ${m.repo}#${m.prNumber}. Any already-running remote session continues until it finishes or is cancelled from claude.ai/code.`,
        { display: 'system' },
      )
      return null
    }

    // 2. 参数非法
    if (parsed.action === 'invalid') {
      onDone(
        `Invalid args: ${parsed.reason}. Use /autofix-pr <pr-number> | stop | <owner>/<repo>#<n>`,
        {
          display: 'system',
        },
      )
      return null
    }

    // 3. freeform —— 暂不支持
    if (parsed.action === 'freeform') {
      onDone(
        'Freeform prompt mode not yet supported. Use /autofix-pr <pr-number>.',
        {
          display: 'system',
        },
      )
      return null
    }

    // 4. 启动。has_repo_path 标记用户是否通过 cross-repo 语法显式提供了
    // owner/repo（相对依赖目录自动探测而言）。
    logEvent('tengu_autofix_pr_started', {
      action:
        'start' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      has_pr_number:
        'true' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      has_repo_path: String(
        !!(parsed.owner && parsed.repo),
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 4.1 解析 owner/repo。始终先探测 cwd 仓库，因为 teleport 会从
    // 工作目录取 git source；如果 cross-repo 参数与 cwd 不匹配，
    // 会静默地跑到错误的仓库上。
    let detected: { host: string; owner: string; name: string } | null
    try {
      detected = await detectCurrentRepositoryWithHost()
    } catch {
      onDone(
        makeErrorText(
          'Cannot detect GitHub repo from current directory.',
          'session_create_failed',
        ),
        { display: 'system' },
      )
      return null
    }
    if (!detected || detected.host !== 'github.com') {
      onDone(
        makeErrorText(
          'Cannot detect GitHub repo from current directory.',
          'session_create_failed',
        ),
        { display: 'system' },
      )
      return null
    }

    // cross-repo 参数（owner/repo#n）必须与当前工作目录匹配；
    // teleport 的 git source 取自 cwd，不匹配会针对错误仓库创建会话。
    // 这里同时接受两者是安全校验，而不是真正的 cross-repo 能力 ——
    // 真正的 cross-repo 支持需要独立的 clone 路径，本仓库尚未实现。
    if (
      (parsed.owner && parsed.owner !== detected.owner) ||
      (parsed.repo && parsed.repo !== detected.name)
    ) {
      onDone(
        makeErrorText(
          `Cross-repo autofix is not supported from this directory. Run from ${detected.owner}/${detected.name} or pass only the PR number.`,
          'repo_mismatch',
        ),
        { display: 'system' },
      )
      return null
    }
    const owner = detected.owner
    const repo = detected.name

    const { prNumber } = parsed

    // 4.2 单例锁 —— 已在监控这个具体 PR
    if (isMonitoring(owner, repo, prNumber)) {
      logEvent('tengu_autofix_pr_result', {
        result:
          'success_rc' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      onDone(`Already monitoring ${repo}#${prNumber} in background.`, {
        display: 'system',
      })
      return null
    }

    // 4.2b 说明：已存在的「另一个 PR」检查被合并到下面的 trySetActiveMonitor 调用里。
    // 在那里原子地完成「检查 + 设置」，避免在并发调用下产生读写之间的
    // TOCTOU 窗口。

    // 4.3 资格检查（容忍 no_remote_environment，暴露真实原因）。
    // skipBundle:true 与下方 teleport 调用保持一致 —— autofix 需要回推到 GitHub，
    // 而 git bundle 做不到这件事。
    const eligibility = await checkRemoteAgentEligibility({ skipBundle: true })
    if (!eligibility.eligible) {
      // 可辨识联合：TypeScript 在此收窄 `eligibility`，无需强转。
      const blockers = eligibility.errors.filter(
        (e: BackgroundRemoteSessionPrecondition) =>
          e.type !== 'no_remote_environment',
      )
      if (blockers.length > 0) {
        const reasons = blockers.map(formatPreconditionError).join('\n')
        onDone(
          makeErrorText(
            `Remote agent not available:\n${reasons}`,
            'session_create_failed',
          ),
          { display: 'system' },
        )
        return null
      }
    }

    // 4.4 探测 skill
    const skills = detectAutofixSkills(process.cwd())
    const skillsHint = formatSkillsHint(skills)

    // 4.5 拼装消息
    const target = `${owner}/${repo}#${prNumber}`
    const branchName = `refs/pull/${prNumber}/head`
    const initialMessage = `Auto-fix failing CI checks on PR #${prNumber} in ${owner}/${repo}.${skillsHint}

When you finish (or hit a blocker you can't recover from), output the following XML tag as your final message so the local user gets a structured summary:

<autofix-result>
  <pr-number>${prNumber}</pr-number>
  <commits-pushed>
    <commit sha="...">commit message</commit>
  </commits-pushed>
  <files-changed>
    <file path="...">N changes</file>
  </files-changed>
  <ci-status>green | red | pending | unknown</ci-status>
  <summary>One-sentence summary of what was fixed or why it could not be fixed.</summary>
</autofix-result>

If no fix was needed, omit <commits-pushed> and <files-changed> and explain in <summary>. If you only attempted partial work, list the commits you did push and explain the remainder in <summary>.`

    // 4.6 进程内 teammate
    const teammate = createAutofixTeammate(initialMessage, target)

    // 4.7 在任何 await 之前原子地获取锁。这消除了一个 TOCTOU 竞态：
    // 两个并发调用同时看到 active=null，然后都尝试创建远程会话。
    const lockAcquired = trySetActiveMonitor({
      taskId: teammate.taskId,
      owner,
      repo,
      prNumber,
      abortController: teammate.abortController,
      startedAt: Date.now(),
    })
    if (!lockAcquired) {
      const existing = getActiveMonitor()
      onDone(
        makeErrorText(
          `already monitoring ${existing?.repo}#${existing?.prNumber}. Run /autofix-pr stop first.`,
          'rc_already_monitoring_other',
        ),
        { display: 'system' },
      )
      return null
    }

    // 4.8 teleport —— 同时接入 onBundleFail 和 onCreateFail，让 HTTP 层的失败
    // （4xx/5xx、token 过期、无效的 PR ref）能带着上游消息反馈给用户，
    // 而不是给出通用回退。autofix 必须传 skipBundle:true：
    // 远程容器需要回推到 GitHub，而 bundle clone 出来的源做不到
    // （teleport.tsx 中对此有说明）。
    // 注意：refs/pull/<n>/head 不是可 push 的 ref。我们「不」传
    // reuseOutcomeBranch —— orchestrator 会生成一个 claude/* 分支，
    // 用户从 claude.ai/code 上做 push / 发 PR。
    let teleportFailMsg: string | undefined
    const captureFailMsg = (msg: string) => {
      teleportFailMsg = msg
    }
    let session: { id: string; title: string } | null = null
    try {
      session = await teleportToRemote({
        initialMessage,
        source: 'autofix_pr',
        branchName,
        skipBundle: true,
        title: `Autofix PR: ${target}`,
        useDefaultEnvironment: true,
        signal: teammate.abortController.signal,
        githubPr: { owner, repo, number: prNumber },
        onBundleFail: captureFailMsg,
        onCreateFail: captureFailMsg,
      })
    } catch (teleErr: unknown) {
      clearActiveMonitor(teammate.taskId)
      const teleMsg =
        teleErr instanceof Error ? teleErr.message : String(teleErr)
      onDone(makeErrorText(`teleport failed: ${teleMsg}`, 'teleport_failed'), {
        display: 'system',
      })
      return null
    }

    if (!session) {
      clearActiveMonitor(teammate.taskId)
      onDone(
        makeErrorText(
          teleportFailMsg ?? 'remote session creation failed.',
          'session_create_failed',
        ),
        { display: 'system' },
      )
      return null
    }

    // 4.8b 在注册之前抓取 PR head SHA，这样 completionChecker 才能检测到
    // agent 是否 push 了新 commit。尽力而为 —— 如果 gh 不可用或调用失败，
    // 就让 initialHeadSha 保持 undefined，checker 回退到只看终态
    // （closed / merged）的完成判定。不要在这里阻塞；teleport 已经成功了。
    const initialHeadSha =
      (await fetchPrHeadSha(owner, repo, prNumber).catch(() => null)) ??
      undefined

    // 4.9 注册任务。若抛错，释放锁让用户可以重试 —— 远程 CCR 会话已创建，
    // 因此对外暴露一个专门的错误码。
    //
    // 注册成功后，把锁的 taskId 从暂行 teammate UUID（teleport 前用于原子
    // 获取锁）替换为框架分配的 taskId。不做这次替换，框架自己的清理路径
    // （自然完成时调用 clearActiveMonitor(frameworkTaskId)）会对以
    // teammate.taskId 为 key 的锁无操作，导致单例锁悬挂，阻塞后续 /autofix-pr。
    try {
      const { taskId: frameworkTaskId } = registerRemoteAgentTask({
        remoteTaskType: 'autofix-pr',
        session,
        command: `/autofix-pr ${prNumber}`,
        context,
        isLongRunning: true,
        remoteTaskMetadata: { owner, repo, prNumber, initialHeadSha },
      })
      updateActiveMonitor({ taskId: frameworkTaskId })
    } catch (regErr: unknown) {
      clearActiveMonitor(teammate.taskId)
      const regMsg = regErr instanceof Error ? regErr.message : String(regErr)
      onDone(
        makeErrorText(
          `task registration failed: ${regMsg}`,
          'registration_failed',
        ),
        { display: 'system' },
      )
      return null
    }

    // 4.10 PR webhook 订阅（feature-gated，非致命）
    if (feature('KAIROS_GITHUB_WEBHOOKS')) {
      // 本仓库中 kairos client 不可用 —— 静默跳过
    }

    // 4.11 成功
    const sessionUrl = getRemoteTaskSessionUrl(session.id)
    logEvent('tengu_autofix_pr_result', {
      result:
        'success_rc' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    // 同时调用 onDone，让监听回调的调用方收到通知。
    onDone(`Autofix launched for ${target}. Track: ${sessionUrl}`, {
      display: 'system',
    })
    // 返回展示已完成管线的 React 进度 UI。
    // REPL 会把返回的 React 元素与文本一起内联渲染。
    return React.createElement(AutofixProgress, {
      phase: 'done',
      target,
      sessionUrl,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logEvent('tengu_autofix_pr_result', {
      result:
        'failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_code:
        'exception' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    onDone(`Autofix PR failed: ${msg}`, { display: 'system' })
    return null
  }
}
