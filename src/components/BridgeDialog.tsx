import { basename } from 'path';
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { getOriginalCwd } from '../bootstrap/state.js';
import {
  buildActiveFooterText,
  buildIdleFooterText,
  FAILED_FOOTER_TEXT,
  getBridgeStatus,
} from '../bridge/bridgeStatusUtil.js';
import { BRIDGE_FAILED_INDICATOR, BRIDGE_READY_INDICATOR } from '../constants/figures.js';
import { useRegisterOverlay } from '../context/overlayContext.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 原始 'd' 键用于断开连接，不是可配置的 keybinding 动作
import { Box, Text, useInput } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { saveGlobalConfig } from '../utils/config.js';
import { getBranch } from '../utils/git.js';
import { Dialog } from '@anthropic/ink';

type Props = {
  onDone: () => void;
};

export function BridgeDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('bridge-dialog');

  const connected = useAppState(s => s.replBridgeConnected);
  const sessionActive = useAppState(s => s.replBridgeSessionActive);
  const reconnecting = useAppState(s => s.replBridgeReconnecting);
  const connectUrl = useAppState(s => s.replBridgeConnectUrl);
  const sessionUrl = useAppState(s => s.replBridgeSessionUrl);
  const error = useAppState(s => s.replBridgeError);
  const explicit = useAppState(s => s.replBridgeExplicit);
  const environmentId = useAppState(s => s.replBridgeEnvironmentId);
  const sessionId = useAppState(s => s.replBridgeSessionId);
  const verbose = useAppState(s => s.verbose);
  const setAppState = useSetAppState();

  const [showQR, setShowQR] = useState(false);
  const [qrText, setQrText] = useState('');
  const [branchName, setBranchName] = useState('');

  const repoName = basename(getOriginalCwd());

  // 挂载时获取分支名
  useEffect(() => {
    getBranch()
      .then(setBranchName)
      .catch(() => {});
  }, []);

  // 要显示/生成二维码的 URL：已连接时用 session URL，就绪时用 connect URL
  const displayUrl = sessionActive ? sessionUrl : connectUrl;

  // 当 URL 变化或二维码开关切换时生成二维码
  useEffect(() => {
    if (!showQR || !displayUrl) {
      setQrText('');
      return;
    }
    qrToString(displayUrl, {
      type: 'terminal',
      errorCorrectionLevel: 'L',
      small: true,
    })
      .then(setQrText)
      .catch(() => setQrText(''));
  }, [showQR, displayUrl]);

  useKeybindings(
    {
      'confirm:yes': onDone,
      'confirm:toggle': () => {
        setShowQR(prev => !prev);
      },
    },
    { context: 'Confirmation' },
  );

  useInput(input => {
    if (input === 'd') {
      // 仅对通过 CLI flag/命令激活的 bridge 持久化退出选择。
      // 配置驱动和 GB 自动连接的用户只断开当前会话
      // —— 写入 false 会悄悄撤销 Settings 中的选择，或让
      // GB 灰度用户永久退出。
      if (explicit) {
        saveGlobalConfig(current => {
          if (current.remoteControlAtStartup === false) return current;
          return { ...current, remoteControlAtStartup: false };
        });
      }
      setAppState(prev => {
        if (!prev.replBridgeEnabled) return prev;
        return { ...prev, replBridgeEnabled: false };
      });
      onDone();
    }
  });

  const { label: statusLabel, color: statusColor } = getBridgeStatus({
    error,
    connected,
    sessionActive,
    reconnecting,
  });
  const indicator = error ? BRIDGE_FAILED_INDICATOR : BRIDGE_READY_INDICATOR;
  const qrLines = qrText ? qrText.split('\n').filter(l => l.length > 0) : [];

  // \u6784\u5efa\u5e26\u4ed3\u5e93\u548c\u5206\u652f\u4fe1\u606f\u7684\u540e\u7f00\uff08\u4e0e\u72ec\u7acb bridge \u683c\u5f0f\u4fdd\u6301\u4e00\u81f4\uff09
  const contextParts: string[] = [];
  if (repoName) contextParts.push(repoName);
  if (branchName) contextParts.push(branchName);
  const contextSuffix = contextParts.length > 0 ? ' \u00b7 ' + contextParts.join(' \u00b7 ') : '';

  // \u9875\u811a\u6587\u672c\u4e0e\u72ec\u7acb bridge \u4fdd\u6301\u4e00\u81f4
  const footerText = error
    ? FAILED_FOOTER_TEXT
    : displayUrl
      ? sessionActive
        ? buildActiveFooterText(displayUrl)
        : buildIdleFooterText(displayUrl)
      : undefined;

  return (
    <Dialog title="Remote Control" onCancel={onDone} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text>
            <Text color={statusColor}>
              {indicator} {statusLabel}
            </Text>
            <Text dimColor>{contextSuffix}</Text>
          </Text>
          {error && <Text color="error">{error}</Text>}
          {verbose && environmentId && <Text dimColor>环境: {environmentId}</Text>}
          {verbose && sessionId && <Text dimColor>会话: {sessionId}</Text>}
        </Box>
        {showQR && qrLines.length > 0 && (
          <Box flexDirection="column">
            {qrLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        )}
        {footerText && <Text dimColor>{footerText}</Text>}
        <Text dimColor>d 断开连接 · space 查看二维码 · Enter/Esc 关闭</Text>
      </Box>
    </Dialog>
  );
}
