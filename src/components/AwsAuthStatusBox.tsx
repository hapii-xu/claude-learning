import React, { useEffect, useState } from 'react';
import { Box, Link, Text } from '@anthropic/ink';
import { type AwsAuthStatus, AwsAuthStatusManager } from '../utils/awsAuthStatusManager.js';

const URL_RE = /https?:\/\/\S+/;

export function AwsAuthStatusBox(): React.ReactNode {
  const [status, setStatus] = useState<AwsAuthStatus>(AwsAuthStatusManager.getInstance().getStatus());

  useEffect(() => {
    // 订阅状态更新
    const unsubscribe = AwsAuthStatusManager.getInstance().subscribe(setStatus);
    return unsubscribe;
  }, []);

  // 不在认证中且无错误时不显示任何内容
  if (!status.isAuthenticating && !status.error && status.output.length === 0) {
    return null;
  }

  // 认证成功时不显示（无错误且不在认证中）
  if (!status.isAuthenticating && !status.error) {
    return null;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1} marginY={1}>
      <Text bold color="permission">
        云端认证
      </Text>

      {status.output.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {status.output.slice(-5).map((line, index) => {
            const m = line.match(URL_RE);
            if (!m) {
              return (
                <Text key={index} dimColor>
                  {line}
                </Text>
              );
            }
            const url = m[0];
            const start = m.index ?? 0;
            const before = line.slice(0, start);
            const after = line.slice(start + url.length);
            return (
              <Text key={index} dimColor>
                {before}
                <Link url={url}>{url}</Link>
                {after}
              </Text>
            );
          })}
        </Box>
      )}

      {status.error && (
        <Box marginTop={1}>
          <Text color="error">{status.error}</Text>
        </Box>
      )}
    </Box>
  );
}
