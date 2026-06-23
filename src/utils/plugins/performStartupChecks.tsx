import { performBackgroundPluginInstallations } from '../../services/plugins/PluginInstallationManager.js';
import type { AppState } from '../../state/AppState.js';
import { checkHasTrustDialogAccepted } from '../config.js';
import { logForDebugging } from '../debug.js';
import { clearMarketplacesCache, registerSeedMarketplaces } from './marketplaceManager.js';
import { clearPluginCache } from './pluginLoader.js';

type SetAppState = (f: (prevState: AppState) => AppState) => void;

/**
 * 执行插件启动检查并启动后台安装
 *
 * 此函数从受信任来源（仓库和用户设置）启动 marketplace 和插件的后台安装，
 * 而不阻塞启动过程。安装进度和错误通过 AppState 跟踪并通过通知显示。
 *
 * 安全性：此函数仅在 REPL.tsx 中"信任此目录"对话框被确认后调用。
 * cli.tsx 中的信任对话框会阻塞所有执行，直到用户显式信任当前工作目录，
 * 确保插件安装仅在用户同意下进行。这防止了恶意仓库在未经用户批准的情况下
 * 自动安装插件。
 *
 * @param setAppState 用于使用安装进度更新应用状态的函数
 */
export async function performStartupChecks(setAppState: SetAppState): Promise<void> {
  logForDebugging('performStartupChecks called');

  // 检查当前目录是否已被信任
  if (!checkHasTrustDialogAccepted()) {
    logForDebugging('Trust not accepted for current directory - skipping plugin installations');
    return;
  }

  try {
    logForDebugging('Starting background plugin installations');

    // 在 diff 前注册种子 marketplace（CLAUDE_CODE_PLUGIN_SEED_DIR）。
    // 幂等操作；若未配置种子则无操作。若不这样做，后台安装
    // 会认为种子 marketplace 缺失 → 克隆 → 违背了种子的目的。
    //
    // 若注册改变了状态，清除缓存，以便更早的插件加载流程
    //（例如 REPL 初始化期间的 getAllMcpConfigs）不会保留过时的
    // "marketplace 未找到"结果。
    const seedChanged = await registerSeedMarketplaces();
    if (seedChanged) {
      clearMarketplacesCache();
      clearPluginCache('performStartupChecks: seed marketplaces changed');
      // 设置 needsRefresh 以便 useManagePlugins 通知用户运行
      // /reload-plugins。若无此信号，初始插件加载
      //（因竞争而缓存了"marketplace 未找到"）将持续存在
      // 直到用户手动重新加载。
      setAppState(prev => {
        if (prev.plugins.needsRefresh) return prev;
        return {
          ...prev,
          plugins: { ...prev.plugins, needsRefresh: true },
        };
      });
    }

    // 启动后台安装而不等待
    // 这将在安装进行时更新 AppState
    await performBackgroundPluginInstallations(setAppState);
  } catch (error) {
    // 即使某处失败，也不要阻塞启动
    logForDebugging(`Error initiating background plugin installations: ${error}`);
  }
}
