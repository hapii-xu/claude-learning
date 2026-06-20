import { feature } from 'bun:bundle';
import { appendFileSync } from 'fs';
import React from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import {
  type ChannelEntry,
  getAllowedChannels,
  setAllowedChannels,
  setHasDevChannels,
  setSessionTrustAccepted,
  setStatsStore,
} from './bootstrap/state.js';
import type { Command } from './commands.js';
import { createStatsStore, type StatsStore } from './context/stats.js';
import { getSystemContext } from './context.js';
import { initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { isSynchronizedOutputSupported } from '@anthropic/ink';
import type { RenderOptions, Root, TextProps } from '@anthropic/ink';
import { KeybindingSetup } from './keybindings/KeybindingProviderSetup.js';
import { startDeferredPrefetches } from './main.js';
import { initializeGrowthBook, resetGrowthBook } from './services/analytics/growthbook.js';
import { isQualifiedForGrove } from './services/api/grove.js';
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js';
import { AppStateProvider } from './state/AppState.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { ThemeProvider } from '@anthropic/ink';
import { normalizeApiKeyForConfig } from './utils/authPortable.js';
import {
  getExternalClaudeMdIncludes,
  getMemoryFiles,
  shouldShowClaudeMdExternalIncludesWarning,
} from './utils/claudemd.js';
import {
  checkHasTrustDialogAccepted,
  getCustomApiKeyStatus,
  getGlobalConfig,
  saveGlobalConfig,
} from './utils/config.js';
import { updateDeepLinkTerminalPreference } from './utils/deepLink/terminalPreference.js';
import { isEnvTruthy, isRunningOnHomespace } from './utils/envUtils.js';
import { type FpsMetrics, FpsTracker } from './utils/fpsTracker.js';
import { updateGithubRepoPathMapping } from './utils/githubRepoPathMapping.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import type { PermissionMode } from './utils/permissions/PermissionMode.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js';
import { hasSkipDangerousModePermissionPrompt } from './utils/settings/settings.js';

export function completeOnboarding(): void {
  saveGlobalConfig(current => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
  }));
}
export function showDialog<T = void>(root: Root, renderer: (done: (result: T) => void) => React.ReactNode): Promise<T> {
  return new Promise<T>(resolve => {
    const done = (result: T): void => void resolve(result);
    root.render(renderer(done));
  });
}

/**
 * 通过 Ink 渲染一条错误消息，然后 unmount 并退出。
 * 用于在 Ink root 已创建之后的致命错误 —— console.error 会被 Ink 的
 * patchConsole 吞掉，因此我们改通过 React 树渲染。
 */
export async function exitWithError(root: Root, message: string, beforeExit?: () => Promise<void>): Promise<never> {
  return exitWithMessage(root, message, { color: 'error', beforeExit });
}

/**
 * 通过 Ink 渲染一条消息，然后 unmount 并退出。
 * 用于在 Ink root 已创建之后输出消息 —— console 输出会被 Ink 的
 * patchConsole 吞掉，因此我们改通过 React 树渲染。
 */
export async function exitWithMessage(
  root: Root,
  message: string,
  options?: {
    color?: TextProps['color'];
    exitCode?: number;
    beforeExit?: () => Promise<void>;
  },
): Promise<never> {
  const { Text } = await import('@anthropic/ink');
  const color = options?.color;
  const exitCode = options?.exitCode ?? 1;
  root.render(color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>);
  root.unmount();
  await options?.beforeExit?.();
  // eslint-disable-next-line custom-rules/no-process-exit —— 在 Ink unmount 之后退出
  process.exit(exitCode);
}

/**
 * 展示一个被 AppStateProvider + KeybindingSetup 包裹的 setup 对话框。
 * 在 showSetupScreens() 中每个对话框都需要这些 wrapper，这里用于减少样板代码。
 */
export function showSetupDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
  options?: { onChangeAppState?: typeof onChangeAppState },
): Promise<T> {
  return showDialog<T>(root, done => (
    <ThemeProvider
      initialState={getGlobalConfig().theme}
      onThemeSave={setting => saveGlobalConfig(current => ({ ...current, theme: setting }))}
    >
      <AppStateProvider onChangeAppState={options?.onChangeAppState}>
        <KeybindingSetup>{renderer(done)}</KeybindingSetup>
      </AppStateProvider>
    </ThemeProvider>
  ));
}

/**
 * 将主 UI 渲染到 root 中并等待其退出。
 * 处理通用的收尾流程：启动延迟预取、等待退出、graceful shutdown。
 */
export async function renderAndRun(root: Root, element: React.ReactNode): Promise<void> {
  root.render(element);
  startDeferredPrefetches();
  await root.waitUntilExit();
  await gracefulShutdown(0);
}

export async function showSetupScreens(
  root: Root,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  claudeInChrome?: boolean,
  devChannels?: ChannelEntry[],
): Promise<boolean> {
  if (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(false) ||
    process.env.IS_DEMO // demo 模式下跳过 onboarding
  ) {
    return false;
  }

  const config = getGlobalConfig();
  let onboardingShown = false;
  if (
    !config.theme ||
    !config.hasCompletedOnboarding // 至少展示一次 onboarding
  ) {
    onboardingShown = true;
    const { Onboarding } = await import('./components/Onboarding.js');
    await showSetupDialog(
      root,
      done => (
        <Onboarding
          onDone={() => {
            completeOnboarding();
            void done();
          }}
        />
      ),
      { onChangeAppState },
    );
  }

  // 在交互式会话中始终展示 trust 对话框，与权限模式无关。
  // trust 对话框是工作区信任的边界 —— 它会对不受信任的仓库发出警告，
  // 并检查 CLAUDE.md 的 external includes。bypassPermissions 模式
  // 只影响工具执行权限，不影响工作区信任。
  // 注意：非交互式会话（CI/CD 使用 -p）根本不会进入 showSetupScreens。
  // claubbit 下跳过权限检查
  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    // 快路径：当 CWD 已被信任时跳过 TrustDialog 的 import+render。
    // 若它返回 true，则无论安全特性如何，TrustDialog 都会自动 resolve，
    // 因此可以跳过这次动态 import 和渲染周期。
    if (!checkHasTrustDialogAccepted()) {
      const { TrustDialog } = await import('./components/TrustDialog/TrustDialog.js');
      await showSetupDialog(root, done => <TrustDialog commands={commands} onDone={done} />);
    }

    // 标记本会话已完成 trust 校验。
    // GrowthBook 会据此判断是否带上 auth headers。
    setSessionTrustAccepted(true);

    // trust 建立后重置并重新初始化 GrowthBook。
    // 作为 login/logout 的防御性处理：清除之前的 client，以便下一次 init
    // 能拿到最新的 auth headers。
    resetGrowthBook();
    void initializeGrowthBook();

    // trust 建立之后，若系统上下文尚未预取则现在预取
    void getSystemContext();

    // 若 settings 有效，检查是否有 mcp.json 服务器需要审批
    const { errors: allErrors } = getSettingsWithAllErrors();
    if (allErrors.length === 0) {
      await handleMcpjsonServerApprovals(root);
    }

    // 检查需要审批的 claude.md includes
    if (await shouldShowClaudeMdExternalIncludesWarning()) {
      const externalIncludes = getExternalClaudeMdIncludes(await getMemoryFiles(true));
      const { ClaudeMdExternalIncludesDialog } = await import('./components/ClaudeMdExternalIncludesDialog.js');
      await showSetupDialog(root, done => (
        <ClaudeMdExternalIncludesDialog onDone={done} isStandaloneDialog externalIncludes={externalIncludes} />
      ));
    }
  }

  // 跟踪当前仓库路径，供 teleport 目录切换使用（fire-and-forget）
  // 必须在 trust 之后执行，以免不受信任的目录污染映射表
  void updateGithubRepoPathMapping();
  if (feature('LODESTONE')) {
    updateDeepLinkTerminalPreference();
  }

  // 在 trust 对话框被接受之后、或 bypass 模式下，应用完整的环境变量
  // bypass 模式（CI/CD、自动化）下，我们信任环境，因此应用全部变量
  // 正常模式下，此操作发生在 trust 对话框被接受之后
  // 这其中可能包含来自不受信任来源的危险环境变量
  applyConfigEnvironmentVariables();

  // 在环境变量应用之后再初始化 telemetry，以确保 OTEL endpoint 相关的环境变量
  // 以及 otelHeadersHelper（需要 trust 才能执行）都已就绪。
  // 延迟到下一个 tick，让 OTel 的动态 import 在首次渲染之后解析，
  // 而不是在渲染前的微任务队列里完成。
  setImmediate(() => initializeTelemetryAfterTrust());

  if (await isQualifiedForGrove()) {
    const { GroveDialog } = await import('src/components/grove/Grove.js');
    const decision = await showSetupDialog<string>(root, done => (
      <GroveDialog
        showIfAlreadyViewed={false}
        location={onboardingShown ? 'onboarding' : 'policy_update_modal'}
        onDone={done}
      />
    ));
    if (decision === 'escape') {
      logEvent('tengu_grove_policy_exited', {});
      gracefulShutdownSync(0);
      return false;
    }
  }

  // 检查自定义 API key
  // 在 homespace 上，ANTHROPIC_API_KEY 会保留在 process.env 中供子进程使用，
  // 但 Claude Code 自身会忽略它（参见 auth.ts）。
  if (process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()) {
    const customApiKeyTruncated = normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY);
    const keyStatus = getCustomApiKeyStatus(customApiKeyTruncated);
    if (keyStatus === 'new') {
      const { ApproveApiKey } = await import('./components/ApproveApiKey.js');
      await showSetupDialog<boolean>(
        root,
        done => <ApproveApiKey customApiKeyTruncated={customApiKeyTruncated} onDone={done} />,
        { onChangeAppState },
      );
    }
  }

  if (
    (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) &&
    !hasSkipDangerousModePermissionPrompt()
  ) {
    const { BypassPermissionsModeDialog } = await import('./components/BypassPermissionsModeDialog.js');
    await showSetupDialog(root, done => <BypassPermissionsModeDialog onAccept={done} />);
  }

  // --dangerously-load-development-channels 确认。接受后，将这些 dev channels
  // 追加到 main.tsx 中已设置的 --channels 列表。组织策略不会被绕过 ——
  // gateChannelServer() 仍会执行；此 flag 只用于绕过 --channels 的
  // approved-server 白名单。
  if (devChannels && devChannels.length > 0) {
    const { DevChannelsDialog } = await import('./components/DevChannelsDialog.js');
    await showSetupDialog(root, done => (
      <DevChannelsDialog
        channels={devChannels}
        onAccept={() => {
          // 按条目标记 dev 条目，以免在两个 flag 同时传入时，
          // 白名单绕过泄漏到 --channels 条目上。
          setAllowedChannels([...getAllowedChannels(), ...devChannels.map(c => ({ ...c, dev: true }))]);
          setHasDevChannels(true);
          void done();
        }}
      />
    ));
  }

  // 为首次使用 Claude in Chrome 的用户展示 Chrome onboarding
  if (claudeInChrome && !getGlobalConfig().hasCompletedClaudeInChromeOnboarding) {
    const { ClaudeInChromeOnboarding } = await import('./components/ClaudeInChromeOnboarding.js');
    await showSetupDialog(root, done => <ClaudeInChromeOnboarding onDone={done} />);
  }

  return onboardingShown;
}

export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
} {
  let lastFlickerTime = 0;
  const baseOptions = getBaseRenderOptions(exitOnCtrlC);

  // 当 stdin override 生效时记录分析事件
  if (baseOptions.stdin) {
    logEvent('tengu_stdin_interactive', {});
  }

  const fpsTracker = new FpsTracker();
  const stats = createStatsStore();
  setStatsStore(stats);

  // Bench 模式：设置该环境变量后，将每帧的阶段耗时以 JSONL 形式追加，
  // 供 bench/repl-scroll.ts 做离线分析。捕获完整的 TUI 渲染流水线
  //（yoga → screen buffer → diff → optimize → stdout），以便对任意阶段的
  // 性能优化都能基于真实用户流程进行验证。
  const frameTimingLogPath = process.env.CLAUDE_CODE_FRAME_TIMING_LOG;
  return {
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      onFrame: event => {
        fpsTracker.record(event.durationMs);
        stats.observe('frame_duration_ms', event.durationMs);
        if (frameTimingLogPath && event.phases) {
          // 仅 bench 使用、由环境变量门控的路径：同步写入，以免异常退出时丢帧。
          // 在 ≤60fps 下约 100 字节，开销可忽略。rss/cpu 都是单次系统调用；
          // cpu 是累计值 —— 由 bench 侧计算差值。
          const line =
            // eslint-disable-next-line custom-rules/no-direct-json-operations —— 小对象，热点 bench 路径
            JSON.stringify({
              total: event.durationMs,
              ...event.phases,
              rss: process.memoryUsage.rss(),
              cpu: process.cpuUsage(),
            }) + '\n';
          // eslint-disable-next-line custom-rules/no-sync-fs —— 仅 bench 使用，同步写入以免退出时丢帧
          appendFileSync(frameTimingLogPath, line);
        }
        // 对支持同步输出的终端跳过 flicker 上报 ——
        // DEC 2026 在 BSU/ESU 之间缓冲，clear+redraw 是原子的。
        if (isSynchronizedOutputSupported()) {
          return;
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue;
          }
          const now = Date.now();
          if (now - lastFlickerTime < 1000) {
            logEvent('tengu_flicker', {
              desiredHeight: flicker.desiredHeight,
              actualHeight: flicker.availableHeight,
              reason: flicker.reason,
            } as unknown as Record<string, boolean | number | undefined>);
          }
          lastFlickerTime = now;
        }
      },
    },
  };
}
