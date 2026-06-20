import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Box, Pane, Text } from '@anthropic/ink';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useAppState } from '../../state/AppState.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { logForDebugging } from '../../utils/debug.js';

type Props = {
  onDone: () => void;
};

function SessionInfo({ onDone }: Props): React.ReactNode {
  const remoteSessionUrl = useAppState(s => s.remoteSessionUrl);
  const [qrCode, setQrCode] = useState<string>('');

  // 当 URL 可用时生成二维码
  useEffect(() => {
    if (!remoteSessionUrl) return;

    const url = remoteSessionUrl;
    async function generateQRCode(): Promise<void> {
      const qr = await qrToString(url, {
        type: 'utf8',
        errorCorrectionLevel: 'L',
      });
      setQrCode(qr);
    }
    // 故意静默失败 - URL 仍会展示，因此二维码并非关键功能
    generateQRCode().catch(e => {
      logForDebugging('QR code generation failed', e);
    });
  }, [remoteSessionUrl]);

  // 处理 ESC 以关闭
  useKeybinding('confirm:no', onDone, { context: 'Confirmation' });

  // 不在 remote 模式
  if (!remoteSessionUrl) {
    return (
      <Pane>
        <Text color="warning">Not in remote mode. Start with `claude --remote` to use this command.</Text>
        <Text dimColor>(press esc to close)</Text>
      </Pane>
    );
  }

  const lines = qrCode.split('\n').filter(line => line.length > 0);
  const isLoading = lines.length === 0;

  return (
    <Pane>
      <Box marginBottom={1}>
        <Text bold>Remote session</Text>
      </Box>

      {/* 二维码 - 生成失败时静默处理，URL 仍会展示 */}
      {isLoading ? <Text dimColor>Generating QR code…</Text> : lines.map((line, i) => <Text key={i}>{line}</Text>)}

      {/* URL */}
      <Box marginTop={1}>
        <Text dimColor>Open in browser: </Text>
        <Text color="ide">{remoteSessionUrl}</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>(press esc to close)</Text>
      </Box>
    </Pane>
  );
}

export const call: LocalJSXCommandCall = async onDone => {
  return <SessionInfo onDone={onDone} />;
};
