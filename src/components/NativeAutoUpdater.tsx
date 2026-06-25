import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from 'src/utils/log.js';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '@anthropic/ink';
import type { AutoUpdaterResult } from '../utils/autoUpdater.js';
import { getMaxVersion, getMaxVersionMessage } from '../utils/autoUpdater.js';
import { isAutoUpdaterDisabled } from '../utils/config.js';
import { installLatest } from '../utils/nativeInstaller/index.js';
import { gt } from '../utils/semver.js';
import { getInitialSettings } from '../utils/settings/settings.js';

/**
 * 对错误消息进行分类，用于分析
 */
function getErrorType(errorMessage: string): string {
  if (errorMessage.includes('timeout')) {
    return 'timeout';
  }
  if (errorMessage.includes('Checksum mismatch')) {
    return 'checksum_mismatch';
  }
  if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
    return 'not_found';
  }
  if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
    return 'permission_denied';
  }
  if (errorMessage.includes('ENOSPC')) {
    return 'disk_full';
  }
  if (errorMessage.includes('npm')) {
    return 'npm_error';
  }
  if (errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
    return 'network_error';
  }
  return 'unknown';
}

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};

export function NativeAutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose,
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    current?: string | null;
    latest?: string | null;
  }>({});
  const [maxVersionIssue, setMaxVersionIssue] = useState<string | null>(null);
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest';

  // 用 ref 跟踪最新的 isUpdating 值，这样被 memoize 的 checkForUpdates
  // 回调总能读到当前值，而不会改变回调身份（否则会重新触发下面的初始检查
  // useEffect，导致重新挂载时重复下载 —— 即 #22413 的上游触发原因）。
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;

  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }

    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      logForDebugging('NativeAutoUpdater: 在 test/dev 环境中跳过更新检查');
      return;
    }

    if (isAutoUpdaterDisabled()) {
      return;
    }

    onChangeIsUpdating(true);
    const startTime = Date.now();

    // 记录一次自动更新检查的开始，用于漏斗分析
    logEvent('tengu_native_auto_updater_start', {});

    try {
      // 检查当前版本是否高于允许的最大版本
      const maxVersion = await getMaxVersion();
      if (maxVersion && gt(MACRO.VERSION, maxVersion)) {
        const msg = await getMaxVersionMessage();
        setMaxVersionIssue(msg ?? 'affects your version');
      }

      const result = await installLatest(channel);
      const currentVersion = MACRO.VERSION;
      const latencyMs = Date.now() - startTime;

      // 优雅地处理锁竞争 - 直接返回，不当作错误处理
      if (result.lockFailed) {
        logEvent('tengu_native_auto_updater_lock_contention', {
          latency_ms: latencyMs,
        });
        return; // 静默跳过本次更新检查，稍后会再尝试
      }

      // 更新用于显示的版本信息
      setVersions({ current: currentVersion, latest: result.latestVersion });

      if (result.wasUpdated) {
        logEvent('tengu_native_auto_updater_success', {
          latency_ms: latencyMs,
        });

        onAutoUpdaterResult({
          version: result.latestVersion,
          status: 'success',
        });
      } else {
        // 已是最新版本
        logEvent('tengu_native_auto_updater_up_to_date', {
          latency_ms: latencyMs,
        });
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logError(error);

      const errorType = getErrorType(errorMessage);
      logEvent('tengu_native_auto_updater_fail', {
        latency_ms: latencyMs,
        error_timeout: errorType === 'timeout',
        error_checksum: errorType === 'checksum_mismatch',
        error_not_found: errorType === 'not_found',
        error_permission: errorType === 'permission_denied',
        error_disk_full: errorType === 'disk_full',
        error_npm: errorType === 'npm_error',
        error_network: errorType === 'network_error',
      });

      onAutoUpdaterResult({
        version: null,
        status: 'install_failed',
      });
    } finally {
      onChangeIsUpdating(false);
    }
    // isUpdating 有意不放入依赖；我们改为读取 isUpdatingRef，
    // 这样守卫条件始终是最新值，又不会改变回调身份（否则会重新触发下面的初始检查 useEffect）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onAutoUpdaterResult, channel]);

  // 初始检查
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // 每 30 分钟检查一次
  useInterval(checkForUpdates, 30 * 60 * 1000);

  const hasUpdateResult = !!autoUpdaterResult?.version;
  const hasVersionInfo = !!versions.current && !!versions.latest;
  // 在以下情况下显示该组件：
  // - 需要警告横幅（版本高于最大版本），或
  // - 有需要显示的更新结果（成功/错误），或
  // - 正在检查且我们有可显示的版本信息
  const shouldRender = !!maxVersionIssue || hasUpdateResult || (isUpdating && hasVersionInfo);

  if (!shouldRender) {
    return null;
  }

  return (
    <Box flexDirection="row" gap={1}>
      {verbose && (
        <Text dimColor wrap="truncate">
          当前: {versions.current} &middot; {channel}: {versions.latest}
        </Text>
      )}
      {isUpdating ? (
        <Box>
          <Text dimColor wrap="truncate">
            正在检查更新
          </Text>
        </Box>
      ) : (
        autoUpdaterResult?.status === 'success' &&
        showSuccessMessage &&
        updateSemver && (
          <Text color="success" wrap="truncate">
            ✓ 更新已安装 · 重启以应用更新
          </Text>
        )
      )}
      {autoUpdaterResult?.status === 'install_failed' && (
        <Text color="error" wrap="truncate">
          ✗ 自动更新失败 &middot; 请尝试 <Text bold>/status</Text>
        </Text>
      )}
      {maxVersionIssue && process.env.USER_TYPE === 'ant' && (
        <Text color="warning">
          ⚠ 已知问题：{maxVersionIssue} &middot; 运行 <Text bold>claude rollback --safe</Text> 以降级
        </Text>
      )}
    </Box>
  );
}
