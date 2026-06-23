import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { LocalJSXCommandCall } from '../../../types/command.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

// ── 在任何 import 之前先 mock 模块级副作用 ──
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({
  feature: (_name: string) => true,
}))

// ── 核心依赖 ──
type TeleportResult = { id: string; title: string } | null
const teleportMock = mock(
  (): Promise<TeleportResult> =>
    Promise.resolve({ id: 'session-123', title: 'Autofix PR: acme/myrepo#42' }),
)
mock.module('src/utils/teleport.js', () => ({
  teleportToRemote: teleportMock,
  // 其他导出的 stub —— Bun mock-module 是进程级的，与 teleport-command
  // 测试合并跑时，这些导出若未提供会泄漏成 undefined 然后崩溃。
  // 需与 utils/teleport.tsx 的导出保持同步，以覆盖本进程里其他测试可能
  // 间接 import 的内容。
  teleportResumeCodeSession: mock(() =>
    Promise.resolve({ branch: null, messages: [], error: null }),
  ),
  validateGitState: mock(() => Promise.resolve()),
  validateSessionRepository: mock(() => Promise.resolve({ ok: true })),
  checkOutTeleportedSessionBranch: mock(() =>
    Promise.resolve({ branchName: 'main', branchError: null }),
  ),
  processMessagesForTeleportResume: mock((m: unknown[]) => m),
  teleportFromSessionsAPI: mock(() =>
    Promise.resolve({ branch: null, messages: [], error: null }),
  ),
  teleportToRemoteWithErrorHandling: mock(() => Promise.resolve(null)),
}))

const registerMock = mock(() => ({
  taskId: 'framework-task-id',
  sessionId: 'session-123',
  cleanup: () => {},
}))
const checkEligibilityMock = mock(() =>
  Promise.resolve({ eligible: true as const }),
)
const getSessionUrlMock = mock(
  (id: string) => `https://claude.ai/session/${id}`,
)
const registerCompletionHookMock = mock<
  (taskType: string, hook: (taskId: string, metadata?: unknown) => void) => void
>(() => {})
const registerCompletionCheckerMock = mock<
  (
    taskType: string,
    checker: (metadata?: unknown) => Promise<string | null>,
  ) => void
>(() => {})
const registerContentExtractorMock = mock<
  (taskType: string, extractor: (log: unknown[]) => string | null) => void
>(() => {})

mock.module('src/tasks/RemoteAgentTask/RemoteAgentTask.js', () => ({
  checkRemoteAgentEligibility: checkEligibilityMock,
  registerRemoteAgentTask: registerMock,
  registerCompletionHook: registerCompletionHookMock,
  registerCompletionChecker: registerCompletionCheckerMock,
  registerContentExtractor: registerContentExtractorMock,
  getRemoteTaskSessionUrl: getSessionUrlMock,
  formatPreconditionError: (e: { type: string }) => e.type,
}))

const fetchPrHeadShaMock = mock<
  (owner: string, repo: string, prNumber: number) => Promise<string | null>
>(() => Promise.resolve('sha-baseline-abc123'))

// mock prFetch.ts（gh CLI spawn 层）—— 保持 prOutcomeCheck.ts 中的纯决策矩阵
// 不被 mock，这样该模块的测试不受本文件进程级 mock.module 污染的影响。
mock.module('src/commands/autofix-pr/prFetch.js', () => ({
  fetchPrHeadSha: fetchPrHeadShaMock,
  checkPrAutofixOutcome: mock(() => Promise.resolve({ completed: false })),
}))

const detectRepoMock = mock(() =>
  Promise.resolve({ host: 'github.com', owner: 'acme', name: 'myrepo' }),
)
mock.module('src/utils/detectRepository.js', () => ({
  detectCurrentRepositoryWithHost: detectRepoMock,
}))

const logEventMock = mock(() => {})
mock.module('src/services/analytics/index.js', () => ({
  logEvent: logEventMock,
  logEventAsync: mock(() => Promise.resolve()),
  _resetForTesting: mock(() => {}),
  attachAnalyticsSink: mock(() => {}),
  stripProtoFields: mock((v: unknown) => v),
}))

const noop = () => {}
mock.module('src/bootstrap/state.js', () => ({
  getSessionId: () => 'parent-session-id',
  getParentSessionId: () => undefined,
  // 间接 import（如 cwd.ts、sandbox-adapter.ts）需要的额外导出
  getCwdState: () => '/mock/cwd',
  getOriginalCwd: () => '/mock/cwd',
  getSessionProjectDir: () => null,
  getProjectRoot: () => '/mock/project',
  setCwdState: noop,
  setOriginalCwd: noop,
  setLastAPIRequestMessages: noop,
  getIsNonInteractiveSession: () => false,
  addSlowOperation: noop,
}))

// mock skillDetect，让 initialMessage 在各 CI 环境下是确定的
// （真实的 existsSync 会依赖工作目录下的 .hclaude/skills/*）。
mock.module('src/commands/autofix-pr/skillDetect.js', () => ({
  detectAutofixSkills: () => [] as string[],
  formatSkillsHint: () => '',
}))

// ── 在 mock 之后 import 被测对象 ──
let callAutofixPr: LocalJSXCommandCall
let clearActiveMonitor: () => void
let getActiveMonitor: () => unknown

beforeAll(async () => {
  const sut = await import('../launchAutofixPr.js')
  callAutofixPr = sut.callAutofixPr
  const state = await import('../monitorState.js')
  clearActiveMonitor = state.clearActiveMonitor
  getActiveMonitor = state.getActiveMonitor
})

// 辅助 context
function makeContext() {
  return { abortController: new AbortController() } as Parameters<
    typeof callAutofixPr
  >[1]
}

const onDone = mock((_result?: string, _opts?: unknown) => {})

beforeEach(() => {
  teleportMock.mockClear()
  registerMock.mockClear()
  detectRepoMock.mockClear()
  checkEligibilityMock.mockClear()
  logEventMock.mockClear()
  onDone.mockClear()
  clearActiveMonitor()
})

afterEach(() => {
  clearActiveMonitor()
})

describe('callAutofixPr', () => {
  test('start with PR number teleports with correct args', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    expect(teleportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'autofix_pr',
        useDefaultEnvironment: true,
        githubPr: { owner: 'acme', repo: 'myrepo', number: 42 },
        branchName: 'refs/pull/42/head',
        skipBundle: true,
      }),
    )
  })

  test('teleport call does NOT pass reuseOutcomeBranch (refs/pull/*/head is not pushable)', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    expect(teleportMock).toHaveBeenCalled()
    expect(teleportMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ reuseOutcomeBranch: expect.anything() }),
    )
  })

  test('start registers remote agent task with correct type', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteTaskType: 'autofix-pr',
        isLongRunning: true,
      }),
    )
  })

  test('cross-repo syntax matching cwd repo is accepted', async () => {
    // detectRepo mock 默认返回 acme/myrepo —— 这里传入匹配的 cross-repo
    // 参数，验证 teleport 被正常调用。
    await callAutofixPr(onDone, makeContext(), 'acme/myrepo#999')
    expect(teleportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        githubPr: { owner: 'acme', repo: 'myrepo', number: 999 },
      }),
    )
  })

  test('cross-repo syntax NOT matching cwd repo is rejected with repo_mismatch', async () => {
    // detectRepo mock 返回 acme/myrepo；传入不匹配的 cross-repo 参数。
    await callAutofixPr(onDone, makeContext(), 'anthropics/claude-code#999')
    expect(teleportMock).not.toHaveBeenCalled()
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Cross-repo autofix is not supported/)
  })

  test('singleton lock blocks second start for different PR', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    onDone.mockClear()
    await callAutofixPr(onDone, makeContext(), '99')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/already monitoring/)
    expect(firstArg).toMatch(/Run \/autofix-pr stop first/)
  })

  test('same PR number while monitoring returns already monitoring message', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    onDone.mockClear()
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Already monitoring/)
  })

  test('stop sub-command clears monitor and calls onDone', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    onDone.mockClear()
    await callAutofixPr(onDone, makeContext(), 'stop')
    expect(getActiveMonitor()).toBeNull()
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Stopped local monitoring/)
  })

  test('stop with no active monitor reports no active monitor', async () => {
    await callAutofixPr(onDone, makeContext(), 'stop')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/No active autofix monitor/)
  })

  test('freeform prompt returns not supported message', async () => {
    await callAutofixPr(onDone, makeContext(), 'please fix the failing test')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/not yet supported/)
  })

  test('teleport failure calls onDone with error', async () => {
    teleportMock.mockImplementationOnce(() => Promise.resolve(null))
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_autofix_pr_result',
      expect.objectContaining({
        result: 'failed',
        error_code: 'session_create_failed',
      }),
    )
  })

  test('repo not on github.com calls onDone with error', async () => {
    detectRepoMock.mockImplementationOnce(() =>
      Promise.resolve({ host: 'bitbucket.org', owner: 'acme', name: 'myrepo' }),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
  })

  test('eligibility check blocks non-no_remote_environment errors', async () => {
    checkEligibilityMock.mockImplementationOnce(() =>
      Promise.resolve({
        eligible: false,
        errors: [{ type: 'not_authenticated' }],
      } as unknown as { eligible: true }),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(teleportMock).not.toHaveBeenCalled()
  })

  test('invalid args → invalid action message (lines 72-78)', async () => {
    // parseAutofixArgs('') 返回 { action: 'invalid', reason: 'empty' }
    await callAutofixPr(onDone, makeContext(), '')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Invalid args/)
    expect(teleportMock).not.toHaveBeenCalled()
  })

  test('cross-repo with pr_number_out_of_range → invalid action (lines 72-78)', async () => {
    // parsePrNumber('0') 返回 null → invalid action
    await callAutofixPr(onDone, makeContext(), 'acme/myrepo#0')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Invalid args/)
  })

  test('detectCurrentRepositoryWithHost throws → session_create_failed (lines 70-76)', async () => {
    detectRepoMock.mockImplementationOnce(() =>
      Promise.reject(new Error('git error: not a repository')),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(teleportMock).not.toHaveBeenCalled()
  })

  test('detectCurrentRepositoryWithHost returns null → session_create_failed (lines 108-115)', async () => {
    detectRepoMock.mockImplementationOnce(() =>
      Promise.resolve(
        null as unknown as { host: string; owner: string; name: string },
      ),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(firstArg).toMatch(/Cannot detect GitHub repo/)
    expect(teleportMock).not.toHaveBeenCalled()
  })

  test('teleportToRemote throws → teleport_failed error (lines 253-259)', async () => {
    teleportMock.mockImplementationOnce(() =>
      Promise.reject(new Error('network timeout')),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(firstArg).toMatch(/teleport failed/)
    // 锁必须被释放
    const { getActiveMonitor } = await import('../monitorState.js')
    expect(getActiveMonitor()).toBeNull()
  })

  test('registerRemoteAgentTask throws → registration_failed error (lines 287-296)', async () => {
    registerMock.mockImplementationOnce(() => {
      throw new Error('registration error: session limit exceeded')
    })
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(firstArg).toMatch(/task registration failed/)
    // 锁必须被释放
    const { getActiveMonitor } = await import('../monitorState.js')
    expect(getActiveMonitor()).toBeNull()
  })

  test('outer catch: checkRemoteAgentEligibility throws → outer catch (lines 315-323)', async () => {
    // checkRemoteAgentEligibility 被 await 时没有内层 try/catch。
    // 它一旦抛错，错误会冒泡到第 315-323 行的最外层 catch。
    checkEligibilityMock.mockImplementationOnce(() =>
      Promise.reject(new Error('unexpected eligibility check error')),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    expect(logEventMock).toHaveBeenCalledWith(
      'tengu_autofix_pr_result',
      expect.objectContaining({ error_code: 'exception' }),
    )
  })

  test('captureFailMsg called via onBundleFail when teleport returns null (line 237)', async () => {
    // 当 teleportToRemote 在返回 null 之前先调用 onBundleFail 时，
    // captureFailMsg 会捕获到消息，并在 !session 分支中使用。
    teleportMock.mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((opts: any) => {
        opts?.onBundleFail?.('bundle creation failed: disk full')
        return Promise.resolve(null)
      }) as unknown as Parameters<
        typeof teleportMock.mockImplementationOnce
      >[0],
    )
    await callAutofixPr(onDone, makeContext(), '42')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix PR failed/)
    // 错误消息里应包含被捕获的文本
    expect(firstArg).toMatch(/bundle creation failed/)
  })

  test('eligibility check passes through no_remote_environment error', async () => {
    checkEligibilityMock.mockImplementationOnce(() =>
      Promise.resolve({
        eligible: false,
        errors: [{ type: 'no_remote_environment' }],
      } as unknown as { eligible: true }),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    // 应当继续往下走 —— no_remote_environment 是被容忍的
    expect(teleportMock).toHaveBeenCalled()
  })
})

// taskId 不一致潜在 bug 的回归测试套件 + completion hook 接入验证。
// 修复之前：createAutofixTeammate 会生成一个 teammate UUID，用这个 UUID 去获取
// 单例 monitor 锁；而 registerRemoteAgentTask 又会生成一个「不同的」框架 taskId。
// 当框架最终在自然完成时调用 clearActiveMonitor(frameworkTaskId) 时，
// 守卫判断失败（active.taskId !== frameworkTaskId），锁一直挂着，
// 阻塞了同一进程内后续的任何 /autofix-pr 调用。
describe('callAutofixPr · completion hook wiring (taskId mismatch regression)', () => {
  test('updateActiveMonitor swaps lock taskId to framework-assigned id after register', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    const monitor = getActiveMonitor() as { taskId: string } | null
    expect(monitor).not.toBeNull()
    // registerMock 返回 'framework-task-id'；修复之前这里会是 teammate 生成的随机 UUID。
    expect(monitor?.taskId).toBe('framework-task-id')
  })

  test('framework hook → clearActiveMonitor releases lock on natural completion', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    expect(getActiveMonitor()).not.toBeNull()

    // 找到模块在 import 时注册的 hook。我们取最后一次调用 ——
    // 跨测试重复 import 不会破坏断言，因为框架实际调用的是最近一次注册的 hook。
    const calls = registerCompletionHookMock.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const lastCall = calls[calls.length - 1]
    expect(lastCall?.[0]).toBe('autofix-pr')
    const hook = lastCall?.[1] as (id: string, metadata?: unknown) => void
    expect(typeof hook).toBe('function')

    // 模拟框架在终态切换后用框架 taskId 调用 hook。
    // 修复之前，这一步对以 teammate UUID 为 key 的锁来说是无操作。
    hook('framework-task-id', { owner: 'acme', repo: 'myrepo', prNumber: 42 })
    expect(getActiveMonitor()).toBeNull()
  })

  test('subsequent /autofix-pr succeeds after framework hook clears the lock', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    // 通过已注册的 hook 模拟自然完成
    const calls = registerCompletionHookMock.mock.calls
    const hook = calls[calls.length - 1]?.[1] as (
      id: string,
      metadata?: unknown,
    ) => void
    hook('framework-task-id', { owner: 'acme', repo: 'myrepo', prNumber: 42 })

    onDone.mockClear()
    await callAutofixPr(onDone, makeContext(), '99')
    const firstArg = onDone.mock.calls[0]?.[0] as string
    // 应当走成功路径，而不是「already monitoring」
    expect(firstArg).not.toMatch(/already monitoring/i)
    expect(firstArg).toMatch(/Autofix launched/)
  })
})

// Phase 2：completionChecker 接入 + initialHeadSha 抓取
describe('callAutofixPr · Phase 2 completionChecker integration', () => {
  test('completionChecker is registered at module load with autofix-pr type', () => {
    // 注册发生在 beforeAll 的动态 import 期间；这里只验证 mock 记录到了调用。
    // 按任务类型过滤，未来其他地方的额外注册不会破坏此断言。
    const calls = registerCompletionCheckerMock.mock.calls.filter(
      c => c[0] === 'autofix-pr',
    )
    expect(calls.length).toBeGreaterThan(0)
    const hook = calls[calls.length - 1]?.[1]
    expect(typeof hook).toBe('function')
  })

  test('callAutofixPr captures initialHeadSha via fetchPrHeadSha', async () => {
    fetchPrHeadShaMock.mockClear()
    await callAutofixPr(onDone, makeContext(), '42')
    expect(fetchPrHeadShaMock).toHaveBeenCalledWith('acme', 'myrepo', 42)
  })

  test('initialHeadSha is passed into remoteTaskMetadata on register', async () => {
    fetchPrHeadShaMock.mockImplementationOnce(() =>
      Promise.resolve('sha-from-launch'),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteTaskMetadata: expect.objectContaining({
          owner: 'acme',
          repo: 'myrepo',
          prNumber: 42,
          initialHeadSha: 'sha-from-launch',
        }),
      }),
    )
  })

  test('fetchPrHeadSha failure → metadata initialHeadSha undefined, launch still succeeds', async () => {
    fetchPrHeadShaMock.mockImplementationOnce(() =>
      Promise.reject(new Error('gh not installed')),
    )
    await callAutofixPr(onDone, makeContext(), '42')
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteTaskMetadata: expect.objectContaining({
          owner: 'acme',
          repo: 'myrepo',
          prNumber: 42,
          initialHeadSha: undefined,
        }),
      }),
    )
    // 启动绝不能仅因为 SHA 抓取失败就失败
    const firstArg = onDone.mock.calls[0]?.[0] as string
    expect(firstArg).toMatch(/Autofix launched/)
  })

  test('fetchPrHeadSha returning null → metadata initialHeadSha undefined', async () => {
    fetchPrHeadShaMock.mockImplementationOnce(() => Promise.resolve(null))
    await callAutofixPr(onDone, makeContext(), '42')
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteTaskMetadata: expect.objectContaining({
          initialHeadSha: undefined,
        }),
      }),
    )
  })
})

// Phase 2（续）：直接执行已注册的 completionChecker 箭头函数体。
// 前面的套件只验证它被注册，并不真正调用箭头函数本身，
// 导致 throttle / metadata 守卫 / gh CLI 分发等分支覆盖不到。
describe('callAutofixPr · Phase 2 completionChecker arrow body', () => {
  // 取最近一次注册的 checker —— beforeAll 在模块加载时注册一次；
  // 本文件其他测试不会再触发注册。
  function getChecker(): (metadata?: unknown) => Promise<string | null> {
    const calls = registerCompletionCheckerMock.mock.calls.filter(
      c => c[0] === 'autofix-pr',
    )
    const fn = calls[calls.length - 1]?.[1]
    if (typeof fn !== 'function') {
      throw new Error('completionChecker not registered')
    }
    return fn
  }

  test('returns null when metadata is undefined (early guard)', async () => {
    const checker = getChecker()
    expect(await checker(undefined)).toBeNull()
  })

  test('returns null when checkPrAutofixOutcome reports not completed', async () => {
    const { checkPrAutofixOutcome } = await import('../prFetch.js')
    ;(checkPrAutofixOutcome as ReturnType<typeof mock>).mockImplementationOnce(
      () => Promise.resolve({ completed: false }),
    )
    const checker = getChecker()
    // 使用不同的 PR 编号，避开前面测试遗留的进程内 throttle map。
    const result = await checker({
      owner: 'acme',
      repo: 'myrepo',
      prNumber: 1001,
    })
    expect(result).toBeNull()
  })

  test('returns the summary string when checkPrAutofixOutcome reports completed', async () => {
    const { checkPrAutofixOutcome } = await import('../prFetch.js')
    ;(checkPrAutofixOutcome as ReturnType<typeof mock>).mockImplementationOnce(
      () =>
        Promise.resolve({
          completed: true,
          summary: 'acme/myrepo#1002 merged. Autofix monitoring complete.',
        }),
    )
    const checker = getChecker()
    const result = await checker({
      owner: 'acme',
      repo: 'myrepo',
      prNumber: 1002,
    })
    expect(result).toBe('acme/myrepo#1002 merged. Autofix monitoring complete.')
  })

  test('passes initialHeadSha through to checkPrAutofixOutcome', async () => {
    const { checkPrAutofixOutcome } = await import('../prFetch.js')
    const checkMock = checkPrAutofixOutcome as ReturnType<typeof mock>
    checkMock.mockClear()
    checkMock.mockImplementationOnce(() =>
      Promise.resolve({ completed: false }),
    )
    const checker = getChecker()
    await checker({
      owner: 'acme',
      repo: 'myrepo',
      prNumber: 1003,
      initialHeadSha: 'sha-baseline-xyz',
    })
    expect(checkMock).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'myrepo',
      prNumber: 1003,
      initialHeadSha: 'sha-baseline-xyz',
    })
  })

  test('throttles back-to-back calls for the same PR within CHECK_INTERVAL_MS', async () => {
    const { checkPrAutofixOutcome } = await import('../prFetch.js')
    const checkMock = checkPrAutofixOutcome as ReturnType<typeof mock>
    checkMock.mockClear()
    checkMock.mockImplementation(() => Promise.resolve({ completed: false }))
    const checker = getChecker()
    const meta = { owner: 'acme', repo: 'myrepo', prNumber: 1004 }
    await checker(meta)
    // 在 5s throttle 窗口内的第二次调用必须短路返回 null，
    // 不再触发 gh CLI 层。
    const callCountAfterFirst = checkMock.mock.calls.length
    const result = await checker(meta)
    expect(result).toBeNull()
    expect(checkMock.mock.calls.length).toBe(callCountAfterFirst)
  })

  test('completionHook with metadata clears the throttle entry (re-launch can re-check immediately)', async () => {
    const { checkPrAutofixOutcome } = await import('../prFetch.js')
    const checkMock = checkPrAutofixOutcome as ReturnType<typeof mock>
    checkMock.mockClear()
    checkMock.mockImplementation(() => Promise.resolve({ completed: false }))
    const checker = getChecker()
    const meta = { owner: 'acme', repo: 'myrepo', prNumber: 1005 }
    await checker(meta) // populate throttle map

    // 用同样的 metadata 调用已注册的 completion hook，从而清掉 throttle 条目，
    // 然后验证下一次 checker 调用会再次分发 gh CLI 而不是短路返回。
    const hookCalls = registerCompletionHookMock.mock.calls.filter(
      c => c[0] === 'autofix-pr',
    )
    const hook = hookCalls[hookCalls.length - 1]?.[1] as (
      id: string,
      metadata?: unknown,
    ) => void
    hook('any-task-id', meta)

    const callCountBefore = checkMock.mock.calls.length
    await checker(meta)
    expect(checkMock.mock.calls.length).toBe(callCountBefore + 1)
  })

  test('completionHook without metadata still clears the active monitor lock', async () => {
    // 锁由 callAutofixPr 设置；随后用 undefined 的 metadata 调用 hook，
    // 以覆盖 `if (meta)` 短路分支（清锁那一半无论是否有 metadata 都必须执行）。
    await callAutofixPr(onDone, makeContext(), '42')
    expect(getActiveMonitor()).not.toBeNull()
    const hookCalls = registerCompletionHookMock.mock.calls.filter(
      c => c[0] === 'autofix-pr',
    )
    const hook = hookCalls[hookCalls.length - 1]?.[1] as (
      id: string,
      metadata?: unknown,
    ) => void
    hook('framework-task-id', undefined)
    expect(getActiveMonitor()).toBeNull()
  })
})

// Phase 3：content extractor 接入 + initialMessage 中的标签指令
describe('callAutofixPr · Phase 3 content extractor integration', () => {
  test('registerContentExtractor is called at module load with autofix-pr type', () => {
    const calls = registerContentExtractorMock.mock.calls.filter(
      c => c[0] === 'autofix-pr',
    )
    expect(calls.length).toBeGreaterThan(0)
    const extractor = calls[calls.length - 1]?.[1]
    expect(typeof extractor).toBe('function')
  })

  test('initialMessage instructs the remote agent to emit an <autofix-result> tag', async () => {
    await callAutofixPr(onDone, makeContext(), '42')
    // teleportMock 的类型签名没有参数，calls[0] 是长度为零的 tuple。
    // 我们知道 teleportToRemote 实际上只接收一个 options 对象，
    // 因此通过 unknown 双重断言来读取参数。
    const calls = teleportMock.mock.calls as unknown as Array<
      [{ initialMessage?: string }]
    >
    const teleportArgs = calls[0]?.[0]
    expect(teleportArgs?.initialMessage).toContain('<autofix-result>')
    expect(teleportArgs?.initialMessage).toContain('</autofix-result>')
    expect(teleportArgs?.initialMessage).toContain('<ci-status>')
    expect(teleportArgs?.initialMessage).toContain('<summary>')
  })

  test('registered extractor returns string for valid log and null for empty', () => {
    const calls = registerContentExtractorMock.mock.calls.filter(
      c => c[0] === 'autofix-pr',
    )
    const extractor = calls[calls.length - 1]?.[1] as
      | ((log: unknown[]) => string | null)
      | undefined
    expect(extractor).toBeDefined()
    // 空 log → null
    expect(extractor?.([])).toBeNull()
    // 含标签的 assistant 文本 → 返回该标签
    const logWithTag = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'done\n<autofix-result><summary>x</summary></autofix-result>',
            },
          ],
        },
      },
    ]
    expect(extractor?.(logWithTag)).toContain('<autofix-result>')
  })
})

// 覆盖 ../index.ts 的 load() —— 放在本测试文件里，这样 load() 动态
// import launchAutofixPr.js 时所有重型 mock（teleport / detectRepository /
// RemoteAgentTask / bootstrap-state / analytics / skillDetect）都已经注册好。
// 若在 autofix-pr/__tests__/index.test.ts 里做，会通过跨文件 ESM 符号绑定
// 污染本文件的 mock。
describe('autofix-pr/index.ts load()', () => {
  test('load() resolves and exposes call function', async () => {
    const { default: cmd } = await import('../index.js')
    const loaded = await (
      cmd as unknown as { load: () => Promise<{ call: unknown }> }
    ).load()
    expect(loaded.call).toBeDefined()
    expect(typeof loaded.call).toBe('function')
  })
})
