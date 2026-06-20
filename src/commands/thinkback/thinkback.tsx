import { execa } from 'execa';
import { readFile } from 'fs/promises';
import { join } from 'path';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '@anthropic/ink';
import { Spinner } from '../../components/Spinner.js';
import { Box, Text, instances } from '@anthropic/ink';
import { enablePluginOp } from '../../services/plugins/pluginOperations.js';
import { logForDebugging } from '../../utils/debug.js';
import { isENOENT, toError } from '../../utils/errors.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { pathExists } from '../../utils/file.js';
import { logError } from '../../utils/log.js';
import { getPlatform } from '../../utils/platform.js';
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js';
import { isPluginInstalled } from '../../utils/plugins/installedPluginsManager.js';
import {
  addMarketplaceSource,
  clearMarketplacesCache,
  loadKnownMarketplacesConfig,
  refreshMarketplace,
} from '../../utils/plugins/marketplaceManager.js';
import { OFFICIAL_MARKETPLACE_NAME } from '../../utils/plugins/officialMarketplace.js';
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js';
import { installSelectedPlugins } from '../../utils/plugins/pluginStartupCheck.js';

// Marketplace 和插件标识符 —— 按用户类型不同而变化
const INTERNAL_MARKETPLACE_NAME = 'claude-code-marketplace';
const INTERNAL_MARKETPLACE_REPO = 'anthropics/claude-code-marketplace';
const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official';

function getMarketplaceName(): string {
  return process.env.USER_TYPE === 'ant' ? INTERNAL_MARKETPLACE_NAME : OFFICIAL_MARKETPLACE_NAME;
}

function getMarketplaceRepo(): string {
  return process.env.USER_TYPE === 'ant' ? INTERNAL_MARKETPLACE_REPO : OFFICIAL_MARKETPLACE_REPO;
}

function getPluginId(): string {
  return `thinkback@${getMarketplaceName()}`;
}

const SKILL_NAME = 'thinkback';

/**
 * 从已安装插件的缓存路径中获取 thinkback skill 目录
 */
async function getThinkbackSkillDir(): Promise<string | null> {
  const { enabled } = await loadAllPlugins();
  const thinkbackPlugin = enabled.find(p => p.name === 'thinkback' || (p.source && p.source.includes(getPluginId())));

  if (!thinkbackPlugin) {
    return null;
  }

  const skillDir = join(thinkbackPlugin.path, 'skills', SKILL_NAME);
  if (await pathExists(skillDir)) {
    return skillDir;
  }

  return null;
}

export async function playAnimation(skillDir: string): Promise<{
  success: boolean;
  message: string;
}> {
  const dataPath = join(skillDir, 'year_in_review.js');
  const playerPath = join(skillDir, 'player.js');

  // 这两个文件是 node 子进程的前置依赖。在这里读取（而非在调用点读取），
  // 以确保所有调用方获得一致的错误信息。子进程以 reject: false 方式运行，
  // 因此文件缺失时本会静默返回成功。按 CLAUDE.md 的要求使用 readFile（而非 access）。
  //
  // 非 ENOENT 错误（例如 EACCES）会被记录并以失败返回，而不是抛出 ——
  // 旧的基于 pathExists 的代码从不抛异常，而且其中一个调用方
  // （handleSelect）使用 `void playAnimation().then(...)` 且没有 .catch()。
  try {
    await readFile(dataPath);
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return {
        success: false,
        message: 'No animation found. Run /think-back first to generate one.',
      };
    }
    logError(e);
    return {
      success: false,
      message: `Could not access animation data: ${toError(e).message}`,
    };
  }

  try {
    await readFile(playerPath);
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return {
        success: false,
        message: 'Player script not found. The player.js file is missing from the thinkback skill.',
      };
    }
    logError(e);
    return {
      success: false,
      message: `Could not access player script: ${toError(e).message}`,
    };
  }

  // 获取用于接管终端的 ink 实例
  const inkInstance = instances.get(process.stdout);
  if (!inkInstance) {
    return { success: false, message: 'Failed to access terminal instance' };
  }

  inkInstance.enterAlternateScreen();
  try {
    await execa('node', [playerPath], {
      stdio: 'inherit',
      cwd: skillDir,
      reject: false,
    });
  } catch {
    // 动画可能被中断（例如 Ctrl+C）
  } finally {
    inkInstance.exitAlternateScreen();
  }

  // 在浏览器中打开 HTML 文件以便下载视频
  const htmlPath = join(skillDir, 'year_in_review.html');
  if (await pathExists(htmlPath)) {
    const platform = getPlatform();
    const openCmd = platform === 'macos' ? 'open' : platform === 'windows' ? 'start' : 'xdg-open';
    void execFileNoThrow(openCmd, [htmlPath]);
  }

  return { success: true, message: 'Year in review animation complete!' };
}

type InstallState =
  | { phase: 'checking' }
  | { phase: 'installing-marketplace' }
  | { phase: 'installing-plugin' }
  | { phase: 'enabling-plugin' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string };

function ThinkbackInstaller({
  onReady,
  onError,
}: {
  onReady: () => void;
  onError: (message: string) => void;
}): React.ReactNode {
  const [state, setState] = useState<InstallState>({ phase: 'checking' });
  const [progressMessage, setProgressMessage] = useState('');

  useEffect(() => {
    async function checkAndInstall(): Promise<void> {
      try {
        // 检查 marketplace 是否已安装
        const knownMarketplaces = await loadKnownMarketplacesConfig();
        const marketplaceName = getMarketplaceName();
        const marketplaceRepo = getMarketplaceRepo();
        const pluginId = getPluginId();
        const marketplaceInstalled = marketplaceName in knownMarketplaces;

        // 首先检查插件是否已安装
        const pluginAlreadyInstalled = isPluginInstalled(pluginId);

        if (!marketplaceInstalled) {
          // 安装 marketplace
          setState({ phase: 'installing-marketplace' });
          logForDebugging(`Installing marketplace ${marketplaceRepo}`);

          await addMarketplaceSource({ source: 'github', repo: marketplaceRepo }, message => {
            setProgressMessage(message);
          });
          clearAllCaches();
          logForDebugging(`Marketplace ${marketplaceName} installed`);
        } else if (!pluginAlreadyInstalled) {
          // marketplace 已安装但插件未安装 —— 刷新以获取最新插件
          // 仅在需要时刷新，以避免潜在的破坏性 git 操作
          setState({ phase: 'installing-marketplace' });
          setProgressMessage('Updating marketplace…');
          logForDebugging(`Refreshing marketplace ${marketplaceName}`);

          await refreshMarketplace(marketplaceName, message => {
            setProgressMessage(message);
          });
          clearMarketplacesCache();
          clearAllCaches();
          logForDebugging(`Marketplace ${marketplaceName} refreshed`);
        }

        if (!pluginAlreadyInstalled) {
          // 安装插件
          setState({ phase: 'installing-plugin' });
          logForDebugging(`Installing plugin ${pluginId}`);

          const result = await installSelectedPlugins([pluginId]);

          if (result.failed.length > 0) {
            const errorMsg = result.failed.map(f => `${f.name}: ${f.error}`).join(', ');
            throw new Error(`Failed to install plugin: ${errorMsg}`);
          }

          clearAllCaches();
          logForDebugging(`Plugin ${pluginId} installed`);
        } else {
          // 插件已安装，检查是否已启用
          const { disabled } = await loadAllPlugins();
          const isDisabled = disabled.some(p => p.name === 'thinkback' || p.source?.includes(pluginId));

          if (isDisabled) {
            // 启用插件
            setState({ phase: 'enabling-plugin' });
            logForDebugging(`Enabling plugin ${pluginId}`);

            const enableResult = await enablePluginOp(pluginId);
            if (!enableResult.success) {
              throw new Error(`Failed to enable plugin: ${enableResult.message}`);
            }

            clearAllCaches();
            logForDebugging(`Plugin ${pluginId} enabled`);
          }
        }

        setState({ phase: 'ready' });
        onReady();
      } catch (error) {
        const err = toError(error);
        logError(err);
        setState({ phase: 'error', message: err.message });
        onError(err.message);
      }
    }

    void checkAndInstall();
  }, [onReady, onError]);

  if (state.phase === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="error">Error: {state.message}</Text>
      </Box>
    );
  }

  if (state.phase === 'ready') {
    return null;
  }

  const statusMessage =
    state.phase === 'checking'
      ? 'Checking thinkback installation…'
      : state.phase === 'installing-marketplace'
        ? 'Installing marketplace…'
        : state.phase === 'enabling-plugin'
          ? 'Enabling thinkback plugin…'
          : 'Installing thinkback plugin…';

  return (
    <Box flexDirection="column">
      <Box>
        <Spinner />
        <Text>{progressMessage || statusMessage}</Text>
      </Box>
    </Box>
  );
}

type MenuAction = 'play' | 'edit' | 'fix' | 'regenerate';
type GenerativeAction = Exclude<MenuAction, 'play'>;

function ThinkbackMenu({
  onDone,
  onAction,
  skillDir,
  hasGenerated,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay; shouldQuery?: boolean }) => void;
  onAction: (action: GenerativeAction) => void;
  skillDir: string;
  hasGenerated: boolean;
}): React.ReactNode {
  const [hasSelected, setHasSelected] = useState(false);

  const options = hasGenerated
    ? [
        {
          label: 'Play animation',
          value: 'play' as const,
          description: 'Watch your year in review',
        },
        {
          label: 'Edit content',
          value: 'edit' as const,
          description: 'Modify the animation',
        },
        {
          label: 'Fix errors',
          value: 'fix' as const,
          description: 'Fix validation or rendering issues',
        },
        {
          label: 'Regenerate',
          value: 'regenerate' as const,
          description: 'Create a new animation from scratch',
        },
      ]
    : [
        {
          label: "Let's go!",
          value: 'regenerate' as const,
          description: 'Generate your personalized animation',
        },
      ];

  function handleSelect(value: MenuAction): void {
    setHasSelected(true);
    if (value === 'play') {
      // 播放会运行接管终端的动画，随后以 skip 方式通知完成
      void playAnimation(skillDir).then(() => {
        onDone(undefined, { display: 'skip' });
      });
    } else {
      onAction(value);
    }
  }

  function handleCancel(): void {
    onDone(undefined, { display: 'skip' });
  }

  if (hasSelected) {
    return null;
  }

  return (
    <Dialog
      title="Think Back on 2025 with Claude Code"
      subtitle="Generate your 2025 Claude Code Think Back (takes a few minutes to run)"
      onCancel={handleCancel}
      color="claude"
    >
      <Box flexDirection="column" gap={1}>
        {/* 面向首次使用用户的描述 */}
        {!hasGenerated && (
          <Box flexDirection="column">
            <Text>Relive your year of coding with Claude.</Text>
            <Text dimColor>{"We'll create a personalized ASCII animation celebrating your journey."}</Text>
          </Box>
        )}

        {/* 菜单 */}
        <Select options={options} onChange={handleSelect} visibleOptionCount={5} />
      </Box>
    </Dialog>
  );
}

const EDIT_PROMPT =
  'Use the Skill tool to invoke the "thinkback" skill with mode=edit to modify my existing Claude Code year in review animation. Ask me what I want to change. When the animation is ready, tell the user to run /think-back again to play it.';

const FIX_PROMPT =
  'Use the Skill tool to invoke the "thinkback" skill with mode=fix to fix validation or rendering errors in my existing Claude Code year in review animation. Run the validator, identify errors, and fix them. When the animation is ready, tell the user to run /think-back again to play it.';

const REGENERATE_PROMPT =
  'Use the Skill tool to invoke the "thinkback" skill with mode=regenerate to create a completely new Claude Code year in review animation from scratch. Delete the existing animation and start fresh. When the animation is ready, tell the user to run /think-back again to play it.';

function ThinkbackFlow({
  onDone,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay; shouldQuery?: boolean }) => void;
}): React.ReactNode {
  const [installComplete, setInstallComplete] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [skillDir, setSkillDir] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState<boolean | null>(null);

  function handleReady(): void {
    setInstallComplete(true);
  }

  const handleError = useCallback(
    (message: string): void => {
      setInstallError(message);
      // 调用 onDone 并附带错误消息，以便模型可以继续处理
      onDone(`Error with thinkback: ${message}. Try running /plugin to manually install the think-back plugin.`, {
        display: 'system',
      });
    },
    [onDone],
  );

  useEffect(() => {
    if (installComplete && !skillDir && !installError) {
      // 安装完成后获取 skill 目录
      void getThinkbackSkillDir().then(dir => {
        if (dir) {
          logForDebugging(`Thinkback skill directory: ${dir}`);
          setSkillDir(dir);
        } else {
          handleError('Could not find thinkback skill directory');
        }
      });
    }
  }, [installComplete, skillDir, installError, handleError]);

  // 一旦拿到 skillDir，就检查生成文件是否存在
  useEffect(() => {
    if (!skillDir) {
      return;
    }

    const dataPath = join(skillDir, 'year_in_review.js');
    void pathExists(dataPath).then(exists => {
      logForDebugging(`Checking for ${dataPath}: ${exists ? 'found' : 'not found'}`);
      setHasGenerated(exists);
    });
  }, [skillDir]);

  function handleAction(action: GenerativeAction): void {
    // 根据动作向模型发送对应的 prompt
    const prompts: Record<GenerativeAction, string> = {
      edit: EDIT_PROMPT,
      fix: FIX_PROMPT,
      regenerate: REGENERATE_PROMPT,
    };
    onDone(prompts[action], { display: 'user', shouldQuery: true });
  }

  if (installError) {
    return (
      <Box flexDirection="column">
        <Text color="error">Error: {installError}</Text>
        <Text dimColor>Try running /plugin to manually install the think-back plugin.</Text>
      </Box>
    );
  }

  if (!installComplete) {
    return <ThinkbackInstaller onReady={handleReady} onError={handleError} />;
  }

  if (!skillDir || hasGenerated === null) {
    return (
      <Box>
        <Spinner />
        <Text>Loading thinkback skill…</Text>
      </Box>
    );
  }

  return <ThinkbackMenu onDone={onDone} onAction={handleAction} skillDir={skillDir} hasGenerated={hasGenerated} />;
}

export async function call(
  onDone: (result?: string, options?: { display?: CommandResultDisplay; shouldQuery?: boolean }) => void,
): Promise<React.ReactNode> {
  return <ThinkbackFlow onDone={onDone} />;
}
