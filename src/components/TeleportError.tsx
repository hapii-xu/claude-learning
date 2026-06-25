import React, { useCallback, useEffect, useState } from 'react';
import { checkIsGitClean, checkNeedsClaudeAiLogin } from 'src/utils/background/remote/preconditions.js';
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { Box, Text } from '@anthropic/ink';
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from '@anthropic/ink';
import { TeleportStash } from './TeleportStash.js';

export type TeleportLocalErrorType = 'needsLogin' | 'needsGitStash';

type TeleportErrorProps = {
  onComplete: () => void;
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>;
};

// 模块级哨兵值，保证默认参数拥有稳定的引用身份。
// 此前 `= new Set()` 每次渲染都会创建一个新的 Set，这会在 checkErrors 的
// 依赖里放入一个新对象，导致挂载 effect 在每次渲染时都重新触发。
const EMPTY_ERRORS_TO_IGNORE: ReadonlySet<TeleportLocalErrorType> = new Set();

export function TeleportError({
  onComplete,
  errorsToIgnore = EMPTY_ERRORS_TO_IGNORE,
}: TeleportErrorProps): React.ReactNode {
  const [currentError, setCurrentError] = useState<TeleportLocalErrorType | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // 在挂载时以及错误被解决后检查错误
  const checkErrors = useCallback(async () => {
    const currentErrors = await getTeleportErrors();
    const filteredErrors = new Set(
      Array.from(currentErrors).filter((error: TeleportLocalErrorType) => !errorsToIgnore.has(error)),
    );

    // 如果没有剩余错误，调用 onComplete
    if (filteredErrors.size === 0) {
      onComplete();
      return;
    }

    // 设置当前要处理的错误（login 优先于 git）
    if (filteredErrors.has('needsLogin')) {
      setCurrentError('needsLogin');
    } else if (filteredErrors.has('needsGitStash')) {
      setCurrentError('needsGitStash');
    }
  }, [onComplete, errorsToIgnore]);

  // 挂载时检查错误
  useEffect(() => {
    void checkErrors();
  }, [checkErrors]);

  const onCancel = useCallback(() => {
    gracefulShutdownSync(0);
  }, []);

  const handleLoginComplete = useCallback(() => {
    setIsLoggingIn(false);
    void checkErrors();
  }, [checkErrors]);

  const handleLoginWithClaudeAI = useCallback(() => {
    setIsLoggingIn(true);
  }, [setIsLoggingIn]);

  const handleLoginDialogSelect = useCallback(
    (value: string) => {
      if (value === 'login') {
        handleLoginWithClaudeAI();
      } else {
        // 用户选择了退出
        onCancel();
      }
    },
    [handleLoginWithClaudeAI, onCancel],
  );

  const handleStashComplete = useCallback(() => {
    void checkErrors();
  }, [checkErrors]);

  // 如果没有当前错误则不渲染任何内容（会调用 onComplete）
  if (!currentError) {
    return null;
  }

  switch (currentError) {
    case 'needsGitStash':
      return <TeleportStash onStashAndContinue={handleStashComplete} onCancel={onCancel} />;

    case 'needsLogin': {
      if (isLoggingIn) {
        return <ConsoleOAuthFlow onDone={handleLoginComplete} mode="login" forceLoginMethod="claudeai" />;
      }

      return (
        <Dialog title="登录 Claude" onCancel={onCancel}>
          <Box flexDirection="column">
            <Text dimColor>Teleport 需要一个 Claude.ai 账户。</Text>
            <Text dimColor>你的 Claude Pro/Max 订阅将由 Claude Code 使用。</Text>
          </Box>
          <Select
            options={[
              { label: '使用 Claude 账户登录', value: 'login' },
              { label: '退出', value: 'exit' },
            ]}
            onChange={handleLoginDialogSelect}
          />
        </Dialog>
      );
    }
  }
}

/**
 * 获取当前需要解决的 teleport 错误
 * @returns 需要处理的 teleport 错误类型集合
 */
export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  const errors = new Set<TeleportLocalErrorType>();

  const [needsLogin, isGitClean] = await Promise.all([checkNeedsClaudeAiLogin(), checkIsGitClean()]);

  if (needsLogin) {
    errors.add('needsLogin');
  }
  if (!isGitClean) {
    errors.add('needsGitStash');
  }

  return errors;
}
