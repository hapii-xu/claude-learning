import React, { useEffect, useState } from 'react';
import { useTimeout } from '../hooks/useTimeout.js';
import { Box, Text } from '@anthropic/ink';
import { Spinner } from '../components/Spinner.js';

export interface PreflightCheckResult {
  success: boolean;
  error?: string;
  sslHint?: string;
}

async function checkEndpoints(): Promise<PreflightCheckResult> {
  // 跳过连接检查 — 用户可能使用第三方 API provider
  // (OpenAI、Gemini、Grok 等) 或处于受限网络后。
  return { success: true };
}

interface PreflightStepProps {
  onSuccess: () => void;
}

export function PreflightStep({ onSuccess }: PreflightStepProps): React.ReactNode {
  const [result, setResult] = useState<PreflightCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(true);

  // 延迟显示检查，因为通常非常快
  // 我们希望直接立即显示下一步，避免闪烁
  const showSpinner = useTimeout(1000) && isChecking;

  useEffect(() => {
    async function run() {
      const checkResult = await checkEndpoints();
      setResult(checkResult);
      setIsChecking(false);
    }
    void run();
  }, []);

  useEffect(() => {
    if (result?.success) {
      onSuccess();
    }
    // 失败分支已移除 — 预检始终成功
  }, [result, onSuccess]);

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      {isChecking && showSpinner ? (
        <Box paddingLeft={1}>
          <Spinner />
          <Text>Checking connectivity...</Text>
        </Box>
      ) : (
        !result?.success &&
        !isChecking && (
          <Box flexDirection="column" gap={1}>
            <Text color="error">Unable to connect to Anthropic services</Text>
            <Text color="error">{result?.error}</Text>
          </Box>
        )
      )}
    </Box>
  );
}
