import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { getPlatform } from '../../utils/platform.js';
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js';

type Props = {
  depCheck: SandboxDependencyCheck;
};

export function SandboxDependenciesTab({ depCheck }: Props): React.ReactNode {
  const platform = getPlatform();
  const isMac = platform === 'macos';

  // ripgrep 在所有平台上都是必需的（用于扫描危险目录）。
  // 在 macOS 上，seatbelt 内置于系统中 —— ripgrep 是唯一的运行时依赖。
  // 在 Linux/WSL 上，bwrap + socat 是必需的，seccomp 是可选的。
  //
  // #31804：此前此标签页无条件渲染 Linux 依赖（bwrap、socat、seccomp）。
  // 当 macOS 上缺少 ripgrep 时，用户会看到令人困惑的 Linux 安装说明，
  // 而没有任何关于实际问题的提示。
  const rgMissing = depCheck.errors.some(e => e.includes('ripgrep'));
  const bwrapMissing = depCheck.errors.some(e => e.includes('bwrap'));
  const socatMissing = depCheck.errors.some(e => e.includes('socat'));
  const seccompMissing = depCheck.warnings.length > 0;

  // 任何我们没有专属行来显示的错误 —— 原样渲染，以免被静默吞掉
  // （例如"不支持的平台"或未来的依赖）。
  const otherErrors = depCheck.errors.filter(
    e => !e.includes('ripgrep') && !e.includes('bwrap') && !e.includes('socat'),
  );

  const rgInstallHint = isMac ? 'brew install ripgrep' : 'apt install ripgrep';

  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      {isMac && (
        <Box flexDirection="column">
          <Text>
            seatbelt：<Text color="success">内置（macOS）</Text>
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        <Text>ripgrep (rg)：{rgMissing ? <Text color="error">未找到</Text> : <Text color="success">已找到</Text>}</Text>
        {rgMissing && (
          <Text dimColor>
            {'  '}· {rgInstallHint}
          </Text>
        )}
      </Box>

      {!isMac && (
        <>
          <Box flexDirection="column">
            <Text>
              bubblewrap (bwrap)：{' '}
              {bwrapMissing ? <Text color="error">未安装</Text> : <Text color="success">已安装</Text>}
            </Text>
            {bwrapMissing && <Text dimColor>{'  '}· apt install bubblewrap</Text>}
          </Box>

          <Box flexDirection="column">
            <Text>socat：{socatMissing ? <Text color="error">未安装</Text> : <Text color="success">已安装</Text>}</Text>
            {socatMissing && <Text dimColor>{'  '}· apt install socat</Text>}
          </Box>

          <Box flexDirection="column">
            <Text>
              seccomp filter：{' '}
              {seccompMissing ? <Text color="warning">未安装</Text> : <Text color="success">已安装</Text>}
              {seccompMissing && <Text dimColor>（拦截 unix domain sockets 所需）</Text>}
            </Text>
            {seccompMissing && (
              <Box flexDirection="column">
                <Text dimColor>{'  '}· npm install -g @anthropic-ai/sandbox-runtime</Text>
                <Text dimColor>{'  '}· 或从 sandbox-runtime 复制 vendor/seccomp/* 并设置</Text>
                <Text dimColor>{'    '}settings.json 中的 sandbox.seccomp.bpfPath 和 applyPath</Text>
              </Box>
            )}
          </Box>
        </>
      )}

      {otherErrors.map(err => (
        <Text key={err} color="error">
          {err}
        </Text>
      ))}
    </Box>
  );
}
