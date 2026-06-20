import { REMOTE_CONTROL_DISCONNECTED_MSG } from '../bridge/types.js';
import type { Command } from '../commands.js';
import { DIAMOND_OPEN } from '../constants/figures.js';
import { getRemoteSessionUrl } from '../constants/product.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js';
import type { AppState } from '../state/AppStateStore.js';
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  RemoteAgentTask,
  type RemoteAgentTaskState,
  registerRemoteAgentTask,
} from '../tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { LocalJSXCommandCall } from '../types/command.js';
import { logForDebugging } from '../utils/debug.js';
import { errorMessage } from '../utils/errors.js';
import { logError } from '../utils/log.js';
import { enqueuePendingNotification } from '../utils/messageQueueManager.js';
import { updateTaskState } from '../utils/task/framework.js';
import { archiveRemoteSession, teleportToRemote } from '../utils/teleport.js';
import { pollForApprovedExitPlanMode, UltraplanPollError } from '../utils/ultraplan/ccrSession.js';
import {
  getPromptText,
  getDialogConfig,
  getPromptIdentifier,
  type PromptIdentifier,
} from '../utils/ultraplan/prompt.js';
import { registerCleanup } from '../utils/cleanupRegistry.js';

// TODO(prod-hardening): 在 30 分钟轮询期间 OAuth token 可能过期；
// 后续考虑刷新机制。

export const CCR_TERMS_URL = 'https://code.claude.com/docs/en/claude-code-on-the-web';

export function getUltraplanTimeoutMs(): number {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_ultraplan_timeout_seconds', 1800) * 1000;
}

/**
 * 是否启用 ultraplan，默认启用
 *
 * @returns
 */
export function isUltraplanEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE<{ enabled: boolean } | null>('tengu_ultraplan_config', { enabled: true })
      ?.enabled === true
  );
}

// prompt.txt 被包裹在 <system-reminder> 中，让 CCR 浏览器隐藏脚手架文本
// （CLI_BLOCK_TAGS 会被 stripSystemNotifications 剥离），
// 同时模型仍能看到完整文本。
// 措辞上刻意回避功能名，因为远程 CCR CLI 在任何 tag 剥离之前就会
// 对原始输入做关键词检测；如果 prompt 中出现裸的 "ultraplan"，
// 会自触发为 /ultraplan，在 headless 模式下会被当作 "Unknown skill" 过滤掉。
//
// Bundler 把 .txt 内联为字符串；测试运行器会包装为 {default}。
/* eslint-disable @typescript-eslint/no-require-imports */
const _rawPrompt = require('../utils/ultraplan/prompt.txt');
/* eslint-enable @typescript-eslint/no-require-imports */
const DEFAULT_INSTRUCTIONS: string = (typeof _rawPrompt === 'string' ? _rawPrompt : _rawPrompt.default).trimEnd();

/**
 * 组装初始的 CCR user 消息。seedPlan 和 blurb 留在
 * system-reminder 之外以便浏览器渲染；脚手架文本保持隐藏。
 */
export function buildUltraplanPrompt(blurb: string, seedPlan?: string, promptId?: PromptIdentifier): string {
  const parts: string[] = [];
  if (seedPlan) {
    parts.push('Here is a draft plan to refine:', '', seedPlan, '');
  }
  // parts.push(ULTRAPLAN_INSTRUCTIONS)
  parts.push(getPromptText(promptId!));

  if (blurb) {
    parts.push('', blurb);
  }
  return parts.join('\n');
}

function startDetachedPoll(
  taskId: string,
  sessionId: string,
  url: string,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const started = Date.now();
  let failed = false;
  void (async () => {
    try {
      const { plan, rejectCount, executionTarget } = await pollForApprovedExitPlanMode(
        sessionId,
        getUltraplanTimeoutMs(),
        phase => {
          if (phase === 'needs_input') logEvent('tengu_ultraplan_awaiting_input', {});
          updateTaskState<RemoteAgentTaskState>(taskId, setAppState, t => {
            if (t.status !== 'running') return t;
            const next = phase === 'running' ? undefined : phase;
            return t.ultraplanPhase === next ? t : { ...t, ultraplanPhase: next };
          });
        },
        () => getAppState().tasks?.[taskId]?.status !== 'running',
      );
      logEvent('tengu_ultraplan_approved', {
        duration_ms: Date.now() - started,
        plan_length: plan.length,
        reject_count: rejectCount,
        execution_target: executionTarget as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      if (executionTarget === 'remote') {
        // 用户在浏览器 PlanModal 中选择了「在 CCR 中执行」—— 远程会话
        // 已开始编码。跳过 archive（ARCHIVE 不检查运行状态，会中途打断执行）
        // 并跳过选择对话框（已经选过了）。
        // 通过任务状态做保护，避免轮询在 stopUltraplan 之后 resolve
        // 时为已终止的会话发出通知。
        const task = getAppState().tasks?.[taskId];
        if (task?.status !== 'running') return;
        updateTaskState<RemoteAgentTaskState>(taskId, setAppState, t =>
          t.status !== 'running' ? t : { ...t, status: 'completed', endTime: Date.now() },
        );
        setAppState(prev => (prev.ultraplanSessionUrl === url ? { ...prev, ultraplanSessionUrl: undefined } : prev));
        enqueuePendingNotification({
          value: [
            `Ultraplan approved — executing in Claude Code on the web. Follow along at: ${url}`,
            '',
            'Results will land as a pull request when the remote session finishes. There is nothing to do here.',
          ].join('\n'),
          mode: 'task-notification',
        });
      } else {
        // Teleport：设置 pendingChoice 让 REPL 挂载 UltraplanChoiceDialog。
        // 该对话框负责选择后的 archive + URL 清理。通过任务状态保护，
        // 避免轮询在 stopUltraplan 之后 resolve 时为已终止的会话重新弹出对话框。
        setAppState(prev => {
          const task = prev.tasks?.[taskId];
          if (!task || task.status !== 'running') return prev;
          return {
            ...prev,
            ultraplanPendingChoice: { plan, sessionId, taskId },
          };
        });
      }
    } catch (e) {
      // 如果任务已被停止（stopUltraplan 将 status 置为 killed），轮询报错是
      // 预期行为 —— 跳过失败通知与清理（kill() 已归档；stopUltraplan 已清 URL）。
      const task = getAppState().tasks?.[taskId];
      if (task?.status !== 'running') return;
      failed = true;
      logEvent('tengu_ultraplan_failed', {
        duration_ms: Date.now() - started,
        reason: (e instanceof UltraplanPollError
          ? e.reason
          : 'network_or_unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        reject_count: e instanceof UltraplanPollError ? e.rejectCount : undefined,
      });
      enqueuePendingNotification({
        value: `Ultraplan failed: ${errorMessage(e)}\n\nSession: ${url}`,
        mode: 'task-notification',
      });
      // 错误路径负责清理；teleport 路径交给对话框处理；remote 路径在上面已自行清理。
      void archiveRemoteSession(sessionId).catch(e => logForDebugging(`ultraplan archive failed: ${String(e)}`));
      setAppState(prev =>
        // 与本次轮询的 URL 做比较，避免过期的轮询报错清掉新会话的 URL。
        prev.ultraplanSessionUrl === url ? { ...prev, ultraplanSessionUrl: undefined } : prev,
      );
    } finally {
      // Remote 路径已在上方将 status 置为 completed；teleport 路径保持 status=running，
      // 这样胶囊按钮能展示 ultraplanPhase 状态，直到用户在 UltraplanChoiceDialog
      // 做出选择后由该对话框完成任务。若在此处置为 completed，会在胶囊渲染阶段状态前
      // 就被 isBackgroundTask 过滤掉。失败路径没有对话框，因此在此处自行做状态转换。
      if (failed) {
        updateTaskState<RemoteAgentTaskState>(taskId, setAppState, t =>
          t.status !== 'running' ? t : { ...t, status: 'failed', endTime: Date.now() },
        );
      }
    }
  })();
}

// 立即渲染，避免在 teleportToRemote 数秒往返过程中终端看起来卡住。
function buildLaunchMessage(disconnectedBridge?: boolean): string {
  const prefix = disconnectedBridge ? `${REMOTE_CONTROL_DISCONNECTED_MSG} ` : '';
  return `${DIAMOND_OPEN} ultraplan\n${prefix}Starting Claude Code on the web…`;
}

function buildSessionReadyMessage(url: string): string {
  return `${DIAMOND_OPEN} ultraplan · Monitor progress in Claude Code on the web ${url}\nYou can continue working — when the ${DIAMOND_OPEN} fills, press ↓ to view results`;
}

function buildAlreadyActiveMessage(url: string | undefined): string {
  return url
    ? `ultraplan: already polling. Open ${url} to check status, or wait for the plan to land here.`
    : 'ultraplan: already launching. Please wait for the session to start.';
}

/**
 * 停止运行中的 ultraplan：归档远程会话（停止运行但 URL 仍可查看），
 * 终结本地任务条目（清掉胶囊），并清除 ultraplanSessionUrl（重新武装关键词触发）。
 * startDetachedPoll 的 shouldStop 回调会在下次 tick 看到已终止的状态并抛错；
 * catch 分支在 status !== 'running' 时提前返回。
 */
export async function stopUltraplan(
  taskId: string,
  sessionId: string,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<void> {
  // RemoteAgentTask.kill 会归档会话（带 .catch）—— 此处不需要单独调用 archive。
  await RemoteAgentTask.kill(taskId, setAppState);
  setAppState(prev =>
    prev.ultraplanSessionUrl || prev.ultraplanPendingChoice || prev.ultraplanLaunching
      ? {
          ...prev,
          ultraplanSessionUrl: undefined,
          ultraplanPendingChoice: undefined,
          ultraplanLaunching: undefined,
        }
      : prev,
  );
  const url = getRemoteSessionUrl(sessionId, process.env.SESSION_INGRESS_URL);
  enqueuePendingNotification({
    value: `Ultraplan stopped.\n\nSession: ${url}`,
    mode: 'task-notification',
  });
  enqueuePendingNotification({
    value:
      'The user stopped the ultraplan session above. Do not respond to the stop notification — wait for their next message.',
    mode: 'task-notification',
    isMeta: true,
  });
}

/**
 * 斜杠命令、关键词触发、以及 plan-approval 对话框中「Ultraplan」按钮的共享入口。
 * 当 seedPlan 存在（对话框路径）时，会作为待细化的草稿前置拼接；这种情况下 blurb 可为空。
 *
 * 立即 resolve 返回给用户的消息。资格校验、会话创建与任务注册都以后台 detached 方式运行，
 * 失败通过 enqueuePendingNotification 暴露。
 */
export async function launchUltraplan(opts: {
  blurb: string;
  seedPlan?: string;
  promptIdentifier?: PromptIdentifier;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  signal: AbortSignal;
  /** 调用方在启动前已断开 Remote Control 时为 true。 */
  disconnectedBridge?: boolean;
  /**
   * 在 teleportToRemote resolve 出会话 URL 时调用一次。持有 setMessages 的
   * 调用方（REPL）会把它作为第二条 transcript 消息追加，这样无需展开 ↓ 详情也能看到 URL。
   * 没有 transcript 访问权的调用方（ExitPlanModePermissionRequest）可省略 ——
   * 胶囊按钮仍会展示实时状态。
   */
  onSessionReady?: (msg: string) => void;
}): Promise<string> {
  const { blurb, seedPlan, promptIdentifier, getAppState, setAppState, signal, disconnectedBridge, onSessionReady } =
    opts;

  const { ultraplanSessionUrl: active, ultraplanLaunching } = getAppState();
  if (active || ultraplanLaunching) {
    logEvent('tengu_ultraplan_create_failed', {
      reason: (active
        ? 'already_polling'
        : 'already_launching') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    return buildAlreadyActiveMessage(active);
  }

  if (!blurb && !seedPlan) {
    // 不打点 —— 裸的 /ultraplan 是用法查询，不是一次尝试。
    return [
      // 通过 <Markdown> 渲染；裸的 <message> 会被当作 HTML 分词并丢弃。
      // 用反斜杠转义尖括号。
      'Usage: /ultraplan \\<prompt\\>, or include "ultraplan" anywhere',
      'in your prompt',
      '',
      // 'Advanced multi-agent plan mode with our most powerful model',
      // '(Opus). Runs in Claude Code on the web. When the plan is ready,',
      // 'you can execute it in the web session or send it back here.',
      // 'Terminal stays free while the remote plans.',
      // 'Requires /login.',
      ...getDialogConfig().usageBlurb,
      '',
      `Terms: ${CCR_TERMS_URL}`,
    ].join('\n');
  }

  // 在 detached 流程之前同步置位，避免 teleportToRemote 期间出现重复启动。
  setAppState(prev => (prev.ultraplanLaunching ? prev : { ...prev, ultraplanLaunching: true }));
  void launchDetached({
    blurb,
    seedPlan,
    promptIdentifier,
    getAppState,
    setAppState,
    signal,
    onSessionReady,
  });
  return buildLaunchMessage(disconnectedBridge);
}

async function launchDetached(opts: {
  blurb: string;
  seedPlan?: string;
  promptIdentifier?: PromptIdentifier;
  getAppState: () => AppState;
  setAppState: (f: (prev: AppState) => AppState) => void;
  signal: AbortSignal;
  onSessionReady?: (msg: string) => void;
}): Promise<void> {
  const {
    blurb,
    seedPlan,
    promptIdentifier = getPromptIdentifier(),
    getAppState,
    setAppState,
    signal,
    onSessionReady,
  } = opts;
  // 提升到外层，便于 catch 分支在 teleportToRemote 成功后发生错误时归档远程会话
  // （避免出现 30 分钟孤儿会话）。
  let sessionId: string | undefined;
  try {
    // const model = getUltraplanModel()

    const eligibility = await checkRemoteAgentEligibility();
    if (!eligibility.eligible) {
      logEvent('tengu_ultraplan_create_failed', {
        reason: 'precondition' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        precondition_errors: eligibility.errors
          .map(e => e.type)
          .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      const reasons = eligibility.errors.map(formatPreconditionError).join('\n');
      enqueuePendingNotification({
        value: `ultraplan: cannot launch remote session —\n${reasons}`,
        mode: 'task-notification',
      });
      return;
    }

    const prompt = buildUltraplanPrompt(blurb, seedPlan, promptIdentifier);
    let bundleFailMsg: string | undefined;
    let createFailMsg: string | undefined;
    const session = await teleportToRemote({
      initialMessage: prompt,
      description: blurb || 'Refine local plan',
      // model,
      permissionMode: 'plan',
      ultraplan: true,
      signal,
      useDefaultEnvironment: true,
      onBundleFail: msg => {
        bundleFailMsg = msg;
      },
      onCreateFail: msg => {
        createFailMsg = msg;
      },
    });
    if (!session) {
      let failMsg = bundleFailMsg ?? createFailMsg;
      logEvent('tengu_ultraplan_create_failed', {
        reason: (bundleFailMsg
          ? 'bundle_fail'
          : createFailMsg
            ? 'create_api_fail'
            : 'teleport_null') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      enqueuePendingNotification({
        value: `ultraplan: session creation failed${failMsg ? ` — ${failMsg}` : ''}. See --debug for details.`,
        mode: 'task-notification',
      });
      return;
    }
    sessionId = session.id;

    const url = getRemoteSessionUrl(session.id, process.env.SESSION_INGRESS_URL);
    setAppState(prev => ({
      ...prev,
      ultraplanSessionUrl: url,
      ultraplanLaunching: undefined,
    }));
    onSessionReady?.(buildSessionReadyMessage(url));
    logEvent('tengu_ultraplan_launched', {
      has_seed_plan: Boolean(seedPlan),
      prompt_identifier: promptIdentifier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    // TODO(#23985): 用 startRemoteSessionPolling 内部的
    // ExitPlanModeScanner 替换 registerRemoteAgentTask + startDetachedPoll。
    const { taskId } = registerRemoteAgentTask({
      remoteTaskType: 'ultraplan',
      session: { id: session.id, title: blurb || 'Ultraplan' },
      command: blurb,
      context: {
        abortController: new AbortController(),
        getAppState,
        setAppState,
      },
      isUltraplan: true,
    });
    startDetachedPoll(taskId, session.id, url, getAppState, setAppState);
    registerCleanup(async () => {
      if (getAppState().ultraplanSessionUrl === url) {
        await archiveRemoteSession(session.id, 1500);
      }
    });
  } catch (e) {
    logError(e);
    logEvent('tengu_ultraplan_create_failed', {
      reason: 'unexpected_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    enqueuePendingNotification({
      value: `ultraplan: unexpected error — ${errorMessage(e)}`,
      mode: 'task-notification',
    });

    enqueuePendingNotification({
      value: `Ultraplan hit an unexpected error during launch. Wait for the user's next instructions.`,
      mode: 'task-notification',
      isMeta: true,
    });

    if (sessionId) {
      // teleport 成功后出错 —— 归档远程会话，避免它挂着运行 30 分钟却没人轮询。
      void archiveRemoteSession(sessionId).catch(err =>
        logForDebugging('ultraplan: failed to archive orphaned session', err),
      );
      // ultraplanSessionUrl 可能在抛错前已被设置；清除它，避免「already polling」守卫
      // 阻挡后续启动。
      setAppState(prev => (prev.ultraplanSessionUrl ? { ...prev, ultraplanSessionUrl: undefined } : prev));
    }
  } finally {
    // 成功路径下为 no-op：设置 URL 的 setAppState 已经清掉了该字段。
    setAppState(prev => (prev.ultraplanLaunching ? { ...prev, ultraplanLaunching: undefined } : prev));
  }
}

const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const blurb = args.trim();

  // 裸 /ultraplan（无参数、无 seed plan）只展示用法 —— 不弹对话框。
  if (!blurb) {
    const msg = await launchUltraplan({
      blurb,
      getAppState: context.getAppState,
      setAppState: context.setAppState,
      signal: context.abortController.signal,
    });
    onDone(msg, { display: 'system' });
    return null;
  }

  // 与 launchUltraplan 内部的检查一致 —— 如果会话已激活或正在启动就弹对话框，
  // 既浪费用户的点击，又会在启动失败前就把 hasSeenUltraplanTerms 置位。
  const { ultraplanSessionUrl: active, ultraplanLaunching } = context.getAppState();
  if (active || ultraplanLaunching) {
    logEvent('tengu_ultraplan_create_failed', {
      reason: (active
        ? 'already_polling'
        : 'already_launching') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(buildAlreadyActiveMessage(active), { display: 'system' });
    return null;
  }

  // 通过 focusedInputDialog 挂载启动前对话框（底部区域，与权限对话框相同），
  // 而不是返回 JSX（transcript 区域，锚定在回滚顶部）。REPL.tsx 负责选择后的启动/清除/取消。
  context.setAppState(prev => ({ ...prev, ultraplanLaunchPending: { blurb } }));
  // 'skip' 抑制（空内容的）回显 —— 对话框的选择处理器会补上真正的 /ultraplan 回显和启动确认。
  onDone(undefined, { display: 'skip' });
  return null;
};

export default {
  type: 'local-jsx',
  name: 'ultraplan',
  description: `~10–30 min · Claude Code on the web drafts an advanced plan you can edit and approve. See ${CCR_TERMS_URL}`,
  argumentHint: '<prompt>',
  // isEnabled: () => process.env.USER_TYPE === 'ant',
  isEnabled: () => isUltraplanEnabled(),
  load: () => Promise.resolve({ call }),
} satisfies Command;
