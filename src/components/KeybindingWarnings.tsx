import React from 'react';
import { Box, Text } from '@anthropic/ink';
import {
  getCachedKeybindingWarnings,
  getKeybindingsPath,
  isKeybindingCustomizationEnabled,
} from '../keybindings/loadUserBindings.js';

/**
 * 在 UI 中显示 keybinding 校验警告。
 * 类似于 McpParsingWarnings，提供对配置问题的持续可见性。
 *
 * 仅当 keybinding 自定义功能启用时显示（ant 用户 + feature gate）。
 */
export function KeybindingWarnings(): React.ReactNode {
  // 仅当 keybinding 自定义功能启用时才显示警告
  if (!isKeybindingCustomizationEnabled()) {
    return null;
  }

  const warnings = getCachedKeybindingWarnings();

  if (warnings.length === 0) {
    return null;
  }

  const errors = warnings.filter(w => w.severity === 'error');
  const warns = warnings.filter(w => w.severity === 'warning');

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text bold color={errors.length > 0 ? 'error' : 'warning'}>
        Keybinding 配置问题
      </Text>
      <Box>
        <Text dimColor>位置： </Text>
        <Text dimColor>{getKeybindingsPath()}</Text>
      </Box>
      <Box marginLeft={1} flexDirection="column" marginTop={1}>
        {errors.map((error, i) => (
          <Box key={`error-${i}`} flexDirection="column">
            <Box>
              <Text dimColor>└ </Text>
              <Text color="error">[错误]</Text>
              <Text dimColor> {error.message}</Text>
            </Box>
            {error.suggestion && (
              <Box marginLeft={3}>
                <Text dimColor>→ {error.suggestion}</Text>
              </Box>
            )}
          </Box>
        ))}
        {warns.map((warning, i) => (
          <Box key={`warning-${i}`} flexDirection="column">
            <Box>
              <Text dimColor>└ </Text>
              <Text color="warning">[警告]</Text>
              <Text dimColor> {warning.message}</Text>
            </Box>
            {warning.suggestion && (
              <Box marginLeft={3}>
                <Text dimColor>→ {warning.suggestion}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
