import * as React from 'react';
import { Box, Text, Link } from '@anthropic/ink';
import { Select } from '../CustomSelect/select.js';
import { Dialog } from '../design-system/Dialog.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { CCR_TERMS_URL } from '../../commands/ultraplan.js';
import { getPromptIdentifier, getDialogConfig, type PromptIdentifier } from 'src/utils/ultraplan/prompt.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type ChoiceValue = 'run' | 'cancel';

interface UltraplanLaunchDialogProps {
  onChoice: (
    choice: ChoiceValue,
    opts: {
      disconnectedBridge: boolean;
      promptIdentifier: PromptIdentifier;
    },
  ) => void;
}

function dispatchShowTermsLink() {
  return !getGlobalConfig().hasSeenUltraplanTerms;
}

function dispatchPromptIdentifier() {
  return getPromptIdentifier();
}

export function UltraplanLaunchDialog({ onChoice }: UltraplanLaunchDialogProps): React.ReactNode {
  // 用户是否从未见过 ultraplan 条款
  const [showTermsLink] = React.useState(dispatchShowTermsLink);

  // 此对话框实例的稳定 prompt identifier
  const [promptIdentifier] = React.useState(dispatchPromptIdentifier);

  // 从 prompt identifier 派生的对话框文案
  const dialogConfig = React.useMemo(() => {
    return getDialogConfig(promptIdentifier);
  }, [promptIdentifier]);

  // 远程控制 bridge 是否当前处于激活状态
  const isBridgeEnabled = useAppState(state => state.replBridgeEnabled);

  const setAppState = useSetAppState();

  // ------------------------------------------------------------------
  // 选择处理器
  // ------------------------------------------------------------------

  const handleChoice = React.useCallback(
    (value: ChoiceValue) => {
      // 如果用户在 bridge 启用时选择了 "run"，先断开 bridge，
      // 以免 ultraplan 会话与远程控制冲突。
      const disconnectedBridge = value === 'run' && isBridgeEnabled;

      if (disconnectedBridge) {
        setAppState(prev => {
          if (!prev.replBridgeEnabled) {
            return prev;
          }
          return {
            ...prev,
            replBridgeEnabled: false,
            replBridgeExplicit: false,
            replBridgeOutboundOnly: false,
          };
        });
      }

      // 持久化用户已经看过 ultraplan 条款
      if (value !== 'cancel' && showTermsLink) {
        saveGlobalConfig(prev => (prev.hasSeenUltraplanTerms ? prev : { ...prev, hasSeenUltraplanTerms: true }));
      }

      onChoice(value, { disconnectedBridge, promptIdentifier });
    },
    [onChoice, isBridgeEnabled, setAppState, showTermsLink],
  );

  const handleCancel = React.useCallback(() => {
    handleChoice('cancel');
  }, [handleChoice]);

  const runDescription = isBridgeEnabled
    ? '禁用远程控制并在 Claude Code on the web 中启动'
    : '在 Claude Code on the web 中启动';

  const options = [
    {
      label: '运行 ultraplan',
      value: 'run' as const,
      description: runDescription,
    },
    { label: '暂不', value: 'cancel' as const },
  ];

  return (
    <Dialog title="在云端运行 ultraplan？" subtitle={dialogConfig.timeEstimate} onCancel={handleCancel}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor>{dialogConfig.dialogBody}</Text>
          {showTermsLink ? (
            <Text dimColor>
              了解更多关于 Claude Code on the web 的信息：
              <Link url={CCR_TERMS_URL}>{CCR_TERMS_URL}</Link>
            </Text>
          ) : null}
        </Box>

        {/* Pipeline 描述（当 bridge 将被断开时隐藏） */}
        <Text dimColor>{isBridgeEnabled ? '这将在本次会话中禁用远程控制。' : dialogConfig.dialogPipeline}</Text>

        <Select options={options} onChange={handleChoice} />
      </Box>
    </Dialog>
  );
}

export default UltraplanLaunchDialog;
