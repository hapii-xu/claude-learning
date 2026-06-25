import * as React from 'react';
import { useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { Text } from '@anthropic/ink';
import {
  type AutoUpdaterResult,
  getLatestVersionFromGcs,
  getMaxVersion,
  shouldSkipVersion,
} from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { getPackageManager, type PackageManager } from '../utils/nativeInstaller/packageManagers.js';
import { gt, gte } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};

export function PackageManagerAutoUpdater({ verbose }: Props): React.ReactNode {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [packageManager, setPackageManager] = useState<PackageManager>('unknown');

  const checkForUpdates = React.useCallback(async () => {
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      return;
    }

    if (isAutoUpdaterDisabled()) {
      return;
    }

    const [channel, pm] = await Promise.all([
      Promise.resolve(getInitialSettings()?.autoUpdatesChannel ?? 'latest'),
      getPackageManager(),
    ]);
    setPackageManager(pm);

    let latest = await getLatestVersionFromGcs(channel);

    // 检查是否设置了最大版本（服务端用于禁用自动更新的 kill switch）
    const maxVersion = await getMaxVersion();

    if (maxVersion && latest && gt(latest, maxVersion)) {
      logForDebugging(
        `PackageManagerAutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latest} to ${maxVersion}`,
      );
      if (gte(MACRO.VERSION, maxVersion)) {
        logForDebugging(
          `PackageManagerAutoUpdater: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`,
        );
        setUpdateAvailable(false);
        return;
      }
      latest = maxVersion;
    }

    const hasUpdate = latest && !gte(MACRO.VERSION, latest) && !shouldSkipVersion(latest);

    setUpdateAvailable(!!hasUpdate);

    if (hasUpdate) {
      logForDebugging(`PackageManagerAutoUpdater: Update available ${MACRO.VERSION} -> ${latest}`);
    }
  }, []);

  // 初始检查
  React.useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // 每 30 分钟检查一次
  useInterval(checkForUpdates, 30 * 60 * 1000);

  if (!updateAvailable) {
    return null;
  }

  // pacman、deb 和 rpm 没有指定具体命令，因为它们各自都有
  // 多种前端（pacman: yay/paru/makepkg，deb: apt/apt-get/aptitude/nala，
  // rpm: dnf/yum/zypper）
  const updateCommand =
    packageManager === 'homebrew'
      ? 'brew upgrade claude-code'
      : packageManager === 'winget'
        ? 'winget upgrade Anthropic.ClaudeCode'
        : packageManager === 'apk'
          ? 'apk upgrade claude-code'
          : '你的包管理器更新命令';

  return (
    <>
      {verbose && (
        <Text dimColor wrap="truncate">
          当前版本: {MACRO.VERSION}
        </Text>
      )}
      <Text color="warning" wrap="truncate">
        有可用更新！请运行：<Text bold>{updateCommand}</Text>
      </Text>
    </>
  );
}
