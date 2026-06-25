import * as React from 'react';
import { Box, Text } from '@anthropic/ink';
import { SandboxManager, shouldAllowManagedSandboxDomainsOnly } from '../../utils/sandbox/sandbox-adapter.js';

export function SandboxConfigTab(): React.ReactNode {
  const isEnabled = SandboxManager.isSandboxingEnabled();

  // 显示警告（例如 Linux 上 seccomp 不可用）
  const depCheck = SandboxManager.checkDependencies();
  const warningsNote =
    depCheck.warnings.length > 0 ? (
      <Box marginTop={1} flexDirection="column">
        {depCheck.warnings.map((w, i) => (
          <Text key={i} dimColor>
            {w}
          </Text>
        ))}
      </Box>
    ) : null;

  if (!isEnabled) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text color="subtle">Sandbox 未启用</Text>
        {warningsNote}
      </Box>
    );
  }

  const fsReadConfig = SandboxManager.getFsReadConfig();
  const fsWriteConfig = SandboxManager.getFsWriteConfig();
  const networkConfig = SandboxManager.getNetworkRestrictionConfig();
  const allowUnixSockets = SandboxManager.getAllowUnixSockets();
  const excludedCommands = SandboxManager.getExcludedCommands();
  const globPatternWarnings = SandboxManager.getLinuxGlobPatternWarnings();

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* 排除的命令 */}
      <Box flexDirection="column">
        <Text bold color="permission">
          排除的命令：
        </Text>
        <Text dimColor>{excludedCommands.length > 0 ? excludedCommands.join(', ') : '无'}</Text>
      </Box>

      {/* 文件系统读取限制 */}
      {fsReadConfig.denyOnly.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            文件系统读取限制：
          </Text>
          <Text dimColor>拒绝：{fsReadConfig.denyOnly.join(', ')}</Text>
          {fsReadConfig.allowWithinDeny && fsReadConfig.allowWithinDeny.length > 0 && (
            <Text dimColor>在拒绝范围内允许：{fsReadConfig.allowWithinDeny.join(', ')}</Text>
          )}
        </Box>
      )}

      {/* 文件系统写入限制 */}
      {fsWriteConfig.allowOnly.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            文件系统写入限制：
          </Text>
          <Text dimColor>允许：{fsWriteConfig.allowOnly.join(', ')}</Text>
          {fsWriteConfig.denyWithinAllow.length > 0 && (
            <Text dimColor>在允许范围内拒绝：{fsWriteConfig.denyWithinAllow.join(', ')}</Text>
          )}
        </Box>
      )}

      {/* 网络限制 */}
      {((networkConfig.allowedHosts && networkConfig.allowedHosts.length > 0) ||
        (networkConfig.deniedHosts && networkConfig.deniedHosts.length > 0)) && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            网络限制
            {shouldAllowManagedSandboxDomainsOnly() ? '（受管）' : ''}：
          </Text>
          {networkConfig.allowedHosts && networkConfig.allowedHosts.length > 0 && (
            <Text dimColor>允许：{networkConfig.allowedHosts.join(', ')}</Text>
          )}
          {networkConfig.deniedHosts && networkConfig.deniedHosts.length > 0 && (
            <Text dimColor>拒绝：{networkConfig.deniedHosts.join(', ')}</Text>
          )}
        </Box>
      )}

      {/* Unix Sockets */}
      {allowUnixSockets && allowUnixSockets.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="permission">
            允许的 Unix Sockets：
          </Text>
          <Text dimColor>{allowUnixSockets.join(', ')}</Text>
        </Box>
      )}

      {/* Linux Glob 模式警告 */}
      {globPatternWarnings.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="warning">
            ⚠ 警告：Linux 上不完全支持 Glob 模式
          </Text>
          <Text dimColor>
            以下模式将被忽略：{globPatternWarnings.slice(0, 3).join(', ')}
            {globPatternWarnings.length > 3 && `（还有 ${globPatternWarnings.length - 3} 个）`}
          </Text>
        </Box>
      )}

      {warningsNote}
    </Box>
  );
}
