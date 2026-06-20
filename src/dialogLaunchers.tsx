/**
 * 为 main.tsx 中的一次性 dialog JSX 调用点提供的瘦封装启动器。
 * 每个启动器动态 import 其组件，并以与原内联调用点完全一致的方式连接 `done` 回调。
 * 行为零变更。
 *
 * 属于 main.tsx 的 React/JSX 抽取工作的一部分。参见同系列 PR
 * perf/extract-interactive-helpers 和 perf/launch-repl。
 */
import React from 'react';
import type { AssistantSession } from './assistant/sessionDiscovery.js';
import type { StatsStore } from './context/stats.js';
import type { Root } from '@anthropic/ink';
import { renderAndRun, showSetupDialog } from './interactiveHelpers.js';
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js';
import type { AppState } from './state/AppStateStore.js';
import type { AgentMemoryScope } from '@claude-code-best/builtin-tools/tools/AgentTool/agentMemory.js';
import type { TeleportRemoteResponse } from './utils/conversationRecovery.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import type { ValidationError } from './utils/settings/validation.js';

// 通过模块类型仅以类型方式访问 ResumeConversation 的 Props。
// 无运行时开销 —— 编译期被擦除。
type ResumeConversationProps = React.ComponentProps<
  typeof import('./screens/ResumeConversation.js').ResumeConversation
>;

/**
 * 位置约 3173：SnapshotUpdateDialog（agent memory 快照更新提示）。
 * 原回调连接：onComplete={done}、onCancel={() => done('keep')}。
 */
export async function launchSnapshotUpdateDialog(
  root: Root,
  props: {
    agentType: string;
    scope: AgentMemoryScope;
    snapshotTimestamp: string;
  },
): Promise<'merge' | 'keep' | 'replace'> {
  const { SnapshotUpdateDialog } = await import('./components/agents/SnapshotUpdateDialog.js');
  return showSetupDialog<'merge' | 'keep' | 'replace'>(root, done => (
    <SnapshotUpdateDialog
      agentType={props.agentType}
      scope={props.scope}
      snapshotTimestamp={props.snapshotTimestamp}
      onComplete={done}
      onCancel={() => done('keep')} // Esc/取消 → 安全默认值：保留当前 memory
    />
  ));
}

/**
 * 位置约 3250：InvalidSettingsDialog（settings 校验错误）。
 * 原回调连接：onContinue={done}、onExit 由调用方透传。
 */
export async function launchInvalidSettingsDialog(
  root: Root,
  props: {
    settingsErrors: ValidationError[];
    onExit: () => void;
  },
): Promise<void> {
  const { InvalidSettingsDialog } = await import('./components/InvalidSettingsDialog.js');
  return showSetupDialog(root, done => (
    <InvalidSettingsDialog settingsErrors={props.settingsErrors} onContinue={done} onExit={props.onExit} />
  ));
}

/**
 * 位置约 4229：AssistantSessionChooser（选择要 attach 的 bridge 会话）。
 * 原回调连接：onSelect={id => done(id)}、onCancel={() => done(null)}。
 */
export async function launchAssistantSessionChooser(
  root: Root,
  props: { sessions: AssistantSession[] },
): Promise<string | null> {
  const { AssistantSessionChooser } = await import('./assistant/AssistantSessionChooser.js');
  return showSetupDialog<string | null>(root, done => (
    <AssistantSessionChooser
      sessions={props.sessions}
      onSelect={(id: string) => done(id)}
      onCancel={() => done(null)}
    />
  ));
}

/**
 * `claude assistant` 没有发现任何会话 —— 展示与 daemon.json 为空时
 * `/assistant` 相同的安装向导。成功时 resolve 为安装目录，
 * 取消时 resolve 为 null。安装失败时 reject，以便调用方区分错误与用户取消。
 */
export async function launchAssistantInstallWizard(root: Root): Promise<string | null> {
  const { NewInstallWizard, computeDefaultInstallDir } = await import('./commands/assistant/assistant.js');
  const defaultDir = await computeDefaultInstallDir();
  let rejectWithError: (reason: Error) => void;
  const errorPromise = new Promise<never>((_, reject) => {
    rejectWithError = reject;
  });
  const resultPromise = showSetupDialog<string | null>(root, done => (
    <NewInstallWizard
      defaultDir={defaultDir}
      onInstalled={dir => done(dir)}
      onCancel={() => done(null)}
      onError={message => rejectWithError(new Error(`Installation failed: ${message}`))}
    />
  ));
  return Promise.race([resultPromise, errorPromise]);
}

/**
 * 位置约 4549：TeleportResumeWrapper（交互式 teleport 会话选择器）。
 * 原回调连接：onComplete={done}、onCancel={() => done(null)}、source="cliArg"。
 */
export async function launchTeleportResumeWrapper(root: Root): Promise<TeleportRemoteResponse | null> {
  const { TeleportResumeWrapper } = await import('./components/TeleportResumeWrapper.js');
  return showSetupDialog<TeleportRemoteResponse | null>(root, done => (
    <TeleportResumeWrapper onComplete={done} onCancel={() => done(null)} source="cliArg" />
  ));
}

/**
 * 位置约 4597：TeleportRepoMismatchDialog（选择目标仓库的本地 checkout）。
 * 原回调连接：onSelectPath={done}、onCancel={() => done(null)}。
 */
export async function launchTeleportRepoMismatchDialog(
  root: Root,
  props: {
    targetRepo: string;
    initialPaths: string[];
  },
): Promise<string | null> {
  const { TeleportRepoMismatchDialog } = await import('./components/TeleportRepoMismatchDialog.js');
  return showSetupDialog<string | null>(root, done => (
    <TeleportRepoMismatchDialog
      targetRepo={props.targetRepo}
      initialPaths={props.initialPaths}
      onSelectPath={done}
      onCancel={() => done(null)}
    />
  ));
}

/**
 * 位置约 4903：ResumeConversation 挂载点（交互式会话选择器）。
 * 外层包 <App><KeybindingSetup>，并使用 renderAndRun。
 * 保留原有 getWorktreePaths 与各 import 之间的 Promise.all 并行结构。
 */
export async function launchResumeChooser(
  root: Root,
  appProps: {
    getFpsMetrics: () => FpsMetrics | undefined;
    stats: StatsStore;
    initialState: AppState;
  },
  worktreePathsPromise: Promise<string[]>,
  resumeProps: Omit<ResumeConversationProps, 'worktreePaths'>,
): Promise<void> {
  const [worktreePaths, { ResumeConversation }, { App }] = await Promise.all([
    worktreePathsPromise,
    import('./screens/ResumeConversation.js'),
    import('./components/App.js'),
  ]);
  await renderAndRun(
    root,
    <App getFpsMetrics={appProps.getFpsMetrics} stats={appProps.stats} initialState={appProps.initialState}>
      <KeybindingSetup>
        <ResumeConversation {...resumeProps} worktreePaths={worktreePaths} />
      </KeybindingSetup>
    </App>,
  );
}
