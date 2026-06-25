import React, { useCallback } from 'react';
import { Text, Dialog } from '@anthropic/ink';
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js';
import { isSupportedTerminal } from '../utils/ide.js';
import { Select } from './CustomSelect/index.js';

type IdeAutoConnectDialogProps = {
  onComplete: () => void;
};

export function IdeAutoConnectDialog({ onComplete }: IdeAutoConnectDialogProps): React.ReactNode {
  const handleSelect = useCallback(
    async (value: string) => {
      const autoConnect = value === 'yes';

      // 保存偏好并标记对话框已展示
      saveGlobalConfig(current => ({
        ...current,
        autoConnectIde: autoConnect,
        hasIdeAutoConnectDialogBeenShown: true,
      }));

      onComplete();
    },
    [onComplete],
  );

  const options = [
    { label: '是', value: 'yes' },
    { label: '否', value: 'no' },
  ];

  return (
    <Dialog title="是否启用自动连接到 IDE？" color="ide" onCancel={onComplete}>
      <Select options={options} onChange={handleSelect} defaultValue={'yes'} />
      <Text dimColor>您也可以在 /config 中或通过 --ide flag 配置此项</Text>
    </Dialog>
  );
}

export function shouldShowAutoConnectDialog(): boolean {
  const config = getGlobalConfig();
  return !isSupportedTerminal() && config.autoConnectIde !== true && config.hasIdeAutoConnectDialogBeenShown !== true;
}

type IdeDisableAutoConnectDialogProps = {
  onComplete: (disableAutoConnect: boolean) => void;
};

export function IdeDisableAutoConnectDialog({ onComplete }: IdeDisableAutoConnectDialogProps): React.ReactNode {
  const handleSelect = useCallback(
    (value: string) => {
      const disableAutoConnect = value === 'yes';

      if (disableAutoConnect) {
        saveGlobalConfig(current => ({
          ...current,
          autoConnectIde: false,
        }));
      }

      onComplete(disableAutoConnect);
    },
    [onComplete],
  );

  const handleCancel = useCallback(() => {
    onComplete(false);
  }, [onComplete]);

  const options = [
    { label: '否', value: 'no' },
    { label: '是', value: 'yes' },
  ];

  return (
    <Dialog
      title="是否禁用自动连接到 IDE？"
      subtitle="您也可以在 /config 中配置此项"
      onCancel={handleCancel}
      color="ide"
    >
      <Select options={options} onChange={handleSelect} defaultValue={'no'} />
    </Dialog>
  );
}

export function shouldShowDisableAutoConnectDialog(): boolean {
  const config = getGlobalConfig();
  return !isSupportedTerminal() && config.autoConnectIde === true;
}
