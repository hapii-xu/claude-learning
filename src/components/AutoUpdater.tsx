import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '@anthropic/ink';
import {
  type AutoUpdaterResult,
  getLatestVersion,
  getMaxVersion,
  type InstallStatus,
  installGlobalPackage,
  shouldSkipVersion,
} from '../utils/autoUpdater.js';
import { getGlobalConfig, isAutoUpdaterDisabled } from '../utils/config.js';
import { logForDebugging } from '../utils/debug.js';
import { getCurrentInstallationType } from '../utils/doctorDiagnostic.js';
import { installOrUpdateClaudePackage, localInstallationExists } from '../utils/localInstaller.js';
import { removeInstalledSymlink } from '../utils/nativeInstaller/index.js';
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

export function AutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose,
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    global?: string | null;
    latest?: string | null;
  }>({});
  const [hasLocalInstall, setHasLocalInstall] = useState(false);
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);

  useEffect(() => {
    void localInstallationExists().then(setHasLocalInstall);
  }, []);

  // 用 ref 跟踪最新的 isUpdating 值，使被 memoize 的 checkForUpdates
  // 回调总能读到当前值。若不这样做，30 分钟的定时器会带着过期闭包触发，
  // 其中 isUpdating 为 false，从而在已有一个 installGlobalPackage() 进行中
  // 时又并发启动一个。
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;

  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }

    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      logForDebugging('AutoUpdater: Skipping update check in test/dev environment');
      return;
    }

    const currentVersion = MACRO.VERSION;
    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';
    let latestVersion = await getLatestVersion(channel);
    const isDisabled = isAutoUpdaterDisabled();

    // 检查是否设置了 maxVersion（服务端用于关闭自动更新的 kill switch）
    const maxVersion = await getMaxVersion();
    if (maxVersion && latestVersion && gt(latestVersion, maxVersion)) {
      logForDebugging(
        `AutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latestVersion} to ${maxVersion}`,
      );
      if (gte(currentVersion, maxVersion)) {
        logForDebugging(
          `AutoUpdater: current version ${currentVersion} is already at or above maxVersion ${maxVersion}, skipping update`,
        );
        setVersions({ global: currentVersion, latest: latestVersion });
        return;
      }
      latestVersion = maxVersion;
    }

    setVersions({ global: currentVersion, latest: latestVersion });

    // 检查是否需要更新并执行更新
    if (
      !isDisabled &&
      currentVersion &&
      latestVersion &&
      !gte(currentVersion, latestVersion) &&
      !shouldSkipVersion(latestVersion)
    ) {
      const startTime = Date.now();
      onChangeIsUpdating(true);

      // 由于使用基于 JS 的更新，移除 native installer 的符号链接
      // 但仅当用户未迁移到 native 安装时才移除
      const config = getGlobalConfig();
      if (config.installMethod !== 'native') {
        await removeInstalledSymlink();
      }

      // 检测实际运行中的安装类型
      const installationType = await getCurrentInstallationType();
      logForDebugging(`AutoUpdater: Detected installation type: ${installationType}`);

      // 跳过开发构建的更新
      if (installationType === 'development') {
        logForDebugging('AutoUpdater: Cannot auto-update development build');
        onChangeIsUpdating(false);
        return;
      }

      // 根据实际运行的安装类型选择合适的更新方式
      let installStatus: InstallStatus;
      let updateMethod: 'local' | 'global';

      if (installationType === 'npm-local') {
        // 本地安装使用本地更新方式
        logForDebugging('AutoUpdater: Using local update method');
        updateMethod = 'local';
        installStatus = await installOrUpdateClaudePackage(channel);
      } else if (installationType === 'npm-global') {
        // 全局安装使用全局更新方式
        logForDebugging('AutoUpdater: Using global update method');
        updateMethod = 'global';
        installStatus = await installGlobalPackage();
      } else if (installationType === 'native') {
        // 这不应发生 —— native 应使用 NativeAutoUpdater
        logForDebugging('AutoUpdater: Unexpected native installation in non-native updater');
        onChangeIsUpdating(false);
        return;
      } else {
        // 对未知类型回退到基于配置的检测
        logForDebugging(`AutoUpdater: Unknown installation type, falling back to config`);
        const isMigrated = config.installMethod === 'local';
        updateMethod = isMigrated ? 'local' : 'global';

        if (isMigrated) {
          installStatus = await installOrUpdateClaudePackage(channel);
        } else {
          installStatus = await installGlobalPackage();
        }
      }

      onChangeIsUpdating(false);

      if (installStatus === 'success') {
        logEvent('tengu_auto_updater_success', {
          fromVersion: currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toVersion: latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Date.now() - startTime,
          wasMigrated: updateMethod === 'local',
          installationType: installationType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      } else {
        logEvent('tengu_auto_updater_fail', {
          fromVersion: currentVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          attemptedVersion: latestVersion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          status: installStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs: Date.now() - startTime,
          wasMigrated: updateMethod === 'local',
          installationType: installationType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
      }

      onAutoUpdaterResult({
        version: latestVersion,
        status: installStatus,
      });
    }
    // isUpdating 故意未放入依赖；我们改为读取 isUpdatingRef，
    // 这样守卫条件始终是最新的，又不会改变回调的标识
    // （否则会重新触发下方的初始检查 useEffect）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAutoUpdaterResult]);

  // 初始检查
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // 每 30 分钟检查一次
  useInterval(checkForUpdates, 30 * 60 * 1000);

  if (!autoUpdaterResult?.version && (!versions.global || !versions.latest)) {
    return null;
  }

  if (!autoUpdaterResult?.version && !isUpdating) {
    return null;
  }

  return (
    <Box flexDirection="row" gap={1}>
      {verbose && (
        <Text dimColor wrap="truncate">
          当前版本: {versions.global} &middot; 最新版本: {versions.latest}
        </Text>
      )}
      {isUpdating ? (
        <>
          <Box>
            <Text color="text" dimColor wrap="truncate">
              自动更新中…
            </Text>
          </Box>
        </>
      ) : (
        autoUpdaterResult?.status === 'success' &&
        showSuccessMessage &&
        updateSemver && (
          <Text color="success" wrap="truncate">
            ✓ 更新已安装 · 重启后生效
          </Text>
        )
      )}
      {(autoUpdaterResult?.status === 'install_failed' || autoUpdaterResult?.status === 'no_permissions') && (
        <Text color="error" wrap="truncate">
          ✗ 自动更新失败 &middot; 请尝试 <Text bold>claude doctor</Text> 或{' '}
          <Text bold>
            {hasLocalInstall
              ? `cd ~/.hclaude/local && npm update ${MACRO.PACKAGE_URL}`
              : `npm i -g ${MACRO.PACKAGE_URL}`}
          </Text>
        </Text>
      )}
    </Box>
  );
}
