#!/usr/bin/env bun
// 性能 shim 必须作为第一个 import —— 它会在 React/OTel 捕获原生引用之前
// 将 globalThis.performance 替换为 JS 实现。
// 否则，JSC 的 C++ Vector 在长时间运行的会话中会无限增长。
import '../utils/performanceShim.js';
import { feature } from 'bun:bundle';
import { isEnvTruthy } from '../utils/envUtils.js';

// 当未由 build/dev defines 注入时，MACRO.* 的运行时回退。
// 这种情况发生在直接运行 cli.tsx 时（不通过 `bun run dev` 或构建产物 dist/）。
if (typeof globalThis.MACRO === 'undefined') {
  (globalThis as any).MACRO = {
    VERSION: process.env.CLAUDE_CODE_VERSION || '2.1.888',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '',
    VERSION_CHANGELOG: '',
  };
}

if (isEnvTruthy(process.env.CLAUDE_CODE_FORCE_INTERACTIVE)) {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    if (!stream.isTTY) {
      try {
        Object.defineProperty(stream, 'isTTY', {
          value: true,
          configurable: true,
        });
      } catch {
        // 尽力而为的开发环境覆盖，用于 Windows 上的嵌套 bun 启动。
      }
    }
  }
}

// 修复 corepack 自动 pin 的问题，该问题会给用户的 package.json 添加 yarnpkg
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 在 CCR 环境下为子进程设置最大堆大小（容器有 16GB）
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// Harness-science L0 消融基线。这里内联（而非放在 init.ts）是因为
// BashTool/AgentTool/PowerShellTool 在 import 时就把 DISABLE_BACKGROUND_TASKS
// 捕获到模块级常量 —— init() 运行时已太晚。feature() 开关会在外部构建中
// 通过 DCE（死代码消除）移除整段代码块。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_DISABLE_THINKING',
    'DISABLE_INTERLEAVED_THINKING',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  ]) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * 引导入口点 —— 在加载完整 CLI 之前检查特殊标志。
 *
 * 所有 import 均为动态导入，以最小化快速路径的模块加载开销。
 *
 * --version 快速路径：除本文件外不加载任何模块，实现最快启动。
 *
 * 整体设计思路：
 *   本函数是一个"分流器"，按优先级依次检查命令行参数，
 *   匹配到哪个快速路径就动态导入对应模块并提前 return，
 *   只有默认路径才会加载完整的 main.tsx（即完整 CLI 应用）。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── 快速路径 1：打印版本号，零模块加载 ──────────────────────────────────────
  // --version/-v 快速路径：无需加载任何模块
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在构建时被内联
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // 其他所有路径：加载启动性能分析器
  const { profileCheckpoint } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // ── 快速路径 2：输出系统 prompt 后退出（仅用于 prompt 敏感度评估，Anthropic 内部功能）──
  // --dump-system-prompt 快速路径：输出渲染后的系统 prompt 并退出。
  // 用于 prompt 敏感度评估，在特定 commit 处提取系统 prompt。
  // 仅限 Ant 内部：通过 feature flag 从外部构建中移除。
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { getMainLoopModel } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel();
    const { getSystemPrompt } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    console.log(prompt.join('\n'));
    return;
  }

  // ── 快速路径 3：Chrome 浏览器集成 MCP 模式 ─────────────────────────────────
  // --claude-in-chrome-mcp: 启动 Claude-in-Chrome MCP 服务器
  // --chrome-native-host: 启动 Chrome Native Messaging Host（浏览器扩展通信）
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const { runClaudeInChromeMcpServer } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const { runChromeNativeHost } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
    // --computer-use-mcp: 启动 Computer Use MCP 服务器（截图/键鼠控制，需 CHICAGO_MCP feature）
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const { runComputerUseMcpServer } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // ── 快速路径 4：ACP（Agent Client Protocol）模式，通过 stdio 通信 ──────────
  // `--acp` 快速路径 —— 通过 stdio 通信的 ACP（Agent Client Protocol）agent 模式。
  if (feature('ACP') && process.argv[2] === '--acp') {
    profileCheckpoint('cli_acp_path');
    const { runAcpAgent } = await import('../services/acp/entry.js');
    await runAcpAgent();
    return;
  }

  // ── 快速路径 5：微信集成（weixin CLI 子命令）─────────────────────────────────
  if (args[0] === 'weixin') {
    profileCheckpoint('cli_weixin_path');
    const { handleWeixinCli } = await import('@claude-code-best/weixin');
    const { enableConfigs } = await import('../utils/config.js');
    const { initializeAnalyticsSink } = await import('../services/analytics/sink.js');
    const { shutdownDatadog } = await import('../services/analytics/datadog.js');
    const { shutdown1PEventLogging } = await import('../services/analytics/firstPartyEventLogger.js');
    const { logForDebugging } = await import('../utils/debug.js');
    const { ChannelPermissionRequestNotificationSchema } = await import('../services/mcp/channelNotification.js');
    await handleWeixinCli(
      args.slice(1),
      {
        enableConfigs,
        initializeAnalyticsSink,
        shutdownDatadog,
        shutdown1PEventLogging,
        logForDebugging,
        registerPermissionHandler(server, handler) {
          server.setNotificationHandler(ChannelPermissionRequestNotificationSchema(), async notification =>
            handler(notification.params),
          );
        },
      },
      MACRO.VERSION,
    );
    return;
  }

  // ── 快速路径 6：daemon worker 模式（supervisor 内部派生，高性能敏感）────────
  // `--daemon-worker=<kind>` 快速路径（内部使用 —— 由 supervisor 派生）。
  // 必须放在 daemon 子命令检查之前：每个 worker 单独派生，性能敏感。
  // 这一层级不调用 enableConfigs()，也没有 analytics sink —— worker 保持精简。
  // 如果某个 worker 类型需要配置/认证（assistant 会需要），
  // 在它自己的 run() 函数内部调用。
  if (args[0] === '--daemon-worker' || args[0]?.startsWith('--daemon-worker=')) {
    if (!feature('DAEMON')) {
      console.error(
        '错误：--daemon-worker 需要启用 DAEMON feature。请设置 FEATURE_DAEMON=1 或将 DAEMON 加入 DEFAULT_BUILD_FEATURES。',
      );
      process.exitCode = 1;
      return;
    }
    const kind = args[0] === '--daemon-worker' ? args[1] : args[0].split('=')[1];
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(kind);
    return;
  }

  // ── 快速路径 7：远程控制/Bridge 模式（claude remote-control / rc / remote / sync / bridge）──
  // `claude remote-control` 快速路径（也兼容旧版 `claude remote` / `claude sync` / `claude bridge`）：
  // 将本机作为 bridge 环境提供服务。
  // feature() 必须保持内联以支持构建时的死代码消除（DCE）；
  // isBridgeEnabled() 检查运行时的 GrowthBook 开关。
  if (
    feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' ||
      args[0] === 'rc' ||
      args[0] === 'remote' ||
      args[0] === 'sync' ||
      args[0] === 'bridge')
  ) {
    profileCheckpoint('cli_bridge_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();

    const { getBridgeDisabledReason, checkBridgeMinVersion } = await import('../bridge/bridgeEnabled.js');
    const { BRIDGE_LOGIN_ERROR } = await import('../bridge/types.js');
    const { bridgeMain } = await import('../bridge/bridgeMain.js');
    const { exitWithError } = await import('../utils/process.js');

    // 认证检查必须在 GrowthBook 开关检查之前 —— 没有认证，
    // GrowthBook 就没有用户上下文，会返回过期/默认的 false。
    // getBridgeDisabledReason 会等待 GB 初始化完成，因此返回值是新鲜的
    // （不是过期的磁盘缓存），但初始化仍然需要认证头才能工作。
    const { getClaudeAIOAuthTokens } = await import('../utils/auth.js');
    const { getBridgeAccessToken } = await import('../bridge/bridgeConfig.js');
    if (!getClaudeAIOAuthTokens()?.accessToken && !getBridgeAccessToken()) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // Bridge 是远程控制功能 —— 检查策略限制
    const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError('错误：Remote Control 已被您的组织策略禁用。');
    }

    await bridgeMain(args.slice(1));
    return;
  }

  // ── 快速路径 8：daemon 模式（长驻 supervisor，管理后台 worker）─────────────
  // `claude daemon [subcommand]` 快速路径：统一的 daemon + 会话管理。
  // 在同一命名空间下处理 supervisor（start/stop）和后台会话（bg/attach/logs/kill）
  // 子命令。
  if ((feature('DAEMON') || feature('BG_SESSIONS')) && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // ── 快速路径 9：autonomy 状态查询命令（无需完整 CLI 启动）─────────────────
  // `claude autonomy ...` 快速路径：状态检查/管理命令
  // 不需要完整的交互式 CLI 引导。完整的 Commander 路径会
  // 导入 main.tsx 并在 autonomy action 之前运行根 preAction 初始化；
  // 在覆盖率/CI 环境下，这会在简单的仅状态子进程调用周围留下无关的句柄。
  if (args[0] === 'autonomy') {
    profileCheckpoint('cli_autonomy_path');
    const { getAutonomyCommandText } = await import('../cli/handlers/autonomy.js');
    const text = await getAutonomyCommandText(args.slice(1).join(' '));
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  }

  // ── 快速路径 10：--bg / --background 快捷方式（启动后台会话）────────────────
  // `--bg`/`--background` 快捷方式快速路径 → daemon bg。
  if (feature('BG_SESSIONS') && (args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const bg = await import('../cli/bg.js');
    await bg.handleBgStart(args.filter(a => a !== '--bg' && a !== '--background'));
    return;
  }

  // ── 向后兼容：ps/logs/attach/kill → 转发给 daemon <sub>（已废弃）──────────
  // 向后兼容：ps/logs/attach/kill → daemon <sub>（已废弃）
  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill')
  ) {
    const mapped = args[0] === 'ps' ? 'status' : args[0];
    console.error(`[已废弃] 请使用：claude daemon ${mapped}${args[1] ? ' ' + args[1] : ''}`);
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain([args[0] === 'ps' ? 'status' : args[0]!, ...args.slice(1)]);
    return;
  }

  // ── 快速路径 11：模板任务命令（claude job new/list/reply）─────────────────
  // `claude job <subcommand>` 快速路径：模板任务。
  if (feature('TEMPLATES') && args[0] === 'job') {
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args.slice(1));
    // 使用 process.exit（而非 return）—— mountFleetView 的 Ink TUI 可能留下
    // 阻止自然退出的事件循环句柄。
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // 向后兼容：new/list/reply → job <sub>（已废弃）
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    console.error(`[已废弃] 请使用：claude job ${args[0]} ${args.slice(1).join(' ')}`.trim());
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // ── 快速路径 12：BYOC 环境运行器（无头模式，用于云端构建环境）────────────────
  // `claude environment-runner` 快速路径：无头 BYOC 运行器。
  // feature() 必须保持内联以支持构建时的死代码消除（DCE）。
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const { environmentRunnerMain } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // ── 快速路径 13：自托管运行器（轮询心跳模式）────────────────────────────────
  // `claude self-hosted-runner` 快速路径：无头自托管运行器，
  // 对接 SelfHostedRunnerWorkerService API（注册 + 轮询；轮询即心跳）。
  // feature() 必须保持内联以支持构建时的死代码消除（DCE）。
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const { selfHostedRunnerMain } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // ── 快速路径 14：--worktree --tmux 组合（在 tmux 中启动隔离工作区）──────────
  // --worktree --tmux 快速路径：在加载完整 CLI 之前 exec 进入 tmux
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (
    hasTmuxFlag &&
    (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { isWorktreeModeEnabled } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const { execIntoTmuxWorktree } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // 未处理（例如出错）时，fall through 到正常 CLI 流程
      if (result.error) {
        const { exitWithError } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // 将常见的 update 标志误用重定向到 update 子命令
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare：提前设置 SIMPLE，使得相关 gate 在模块求值 / commander
  // option 构建期间就触发（而不仅仅在 action handler 内部）。
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // ── 默认路径：没有匹配到任何快速路径，加载完整 CLI 应用 ─────────────────────
  // 未检测到特殊标志，加载并运行完整 CLI
  // 动态导入 main.tsx（包含 Commander.js 定义和所有子命令），然后执行 cliMain()
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const { main: cliMain } = await import('../main.jsx');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
await main();
