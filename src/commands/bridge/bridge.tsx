import { feature } from 'bun:bundle';
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { getBridgeAccessToken } from '../../bridge/bridgeConfig.js';
import { checkBridgeMinVersion, getBridgeDisabledReason, isEnvLessBridgeEnabled } from '../../bridge/bridgeEnabled.js';
import { checkEnvLessBridgeMinVersion } from '../../bridge/envLessBridgeConfig.js';
import { BRIDGE_LOGIN_INSTRUCTION, REMOTE_CONTROL_DISCONNECTED_MSG } from '../../bridge/types.js';
import { Dialog, ListItem } from '@anthropic/ink';
import { shouldShowRemoteCallout } from '../../components/RemoteCallout.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { Box, Text } from '@anthropic/ink';
import { useKeybindings } from '../../keybindings/useKeybinding.js';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import { useAppState, useSetAppState } from '../../state/AppState.js';
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js';
import { logForDebugging } from '../../utils/debug.js';

type Props = {
  onDone: LocalJSXCommandOnDone;
  name?: string;
};

/**
 * /remote-control 命令 — 管理双向 bridge 连接。
 *
 * 启用时会在 AppState 中设置 replBridgeEnabled，从而触发
 * REPL.tsx 中的 useReplBridge 初始化 bridge 连接。
 * bridge 会注册一个环境，基于当前对话创建会话，
 * 轮询工作，并连接一个入口 WebSocket 以实现 CLI 和 claude.ai 之间的双向消息传递。
 *
 * 在已连接时运行 /remote-control 会显示一个包含会话 URL 的对话框，
 * 以及断开连接或继续的选项。
 */
function BridgeToggle({ onDone, name }: Props): React.ReactNode {
  const setAppState = useSetAppState();
  const replBridgeConnected = useAppState(s => s.replBridgeConnected);
  const replBridgeEnabled = useAppState(s => s.replBridgeEnabled);
  const replBridgeOutboundOnly = useAppState(s => s.replBridgeOutboundOnly);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

  useEffect(() => {
    // 如果已经连接或以完整双向模式启用，则显示
    // 断开连接确认。仅出站（CCR 镜像）不算在内 ——
    // /remote-control 会将其升级为完整 RC。
    if ((replBridgeConnected || replBridgeEnabled) && !replBridgeOutboundOnly) {
      setShowDisconnectDialog(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      // 启用前的预检查（当磁盘缓存过期时会等待 GrowthBook 初始化 ——
      // 这样 Max 用户就不会错误地收到 "not enabled" 错误）
      const error = await checkBridgePrerequisites();
      if (cancelled) return;
      if (error) {
        logEvent('tengu_bridge_command', {
          action: 'preflight_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        onDone(error, { display: 'system' });
        return;
      }

      // 如果尚未展示过，则显示首次 remote 对话框。
      // 立即保存 name，这样当后续 callout 处理器启用 bridge 时它已在 AppState 中
      //（该处理器只设置 replBridgeEnabled，不设置 name）。
      if (shouldShowRemoteCallout()) {
        setAppState(prev => {
          if (prev.showRemoteCallout) return prev;
          return {
            ...prev,
            showRemoteCallout: true,
            replBridgeInitialName: name,
          };
        });
        onDone('', { display: 'system' });
        return;
      }

      // 启用 bridge —— REPL.tsx 中的 useReplBridge 处理其余工作：
      // 注册环境、基于对话创建会话、连接 WebSocket
      logEvent('tengu_bridge_command', {
        action: 'connect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      setAppState(prev => {
        if (prev.replBridgeEnabled && !prev.replBridgeOutboundOnly) return prev;
        return {
          ...prev,
          replBridgeEnabled: true,
          replBridgeExplicit: true,
          replBridgeOutboundOnly: false,
          replBridgeInitialName: name,
        };
      });
      onDone('Remote Control connecting\u2026', {
        display: 'system',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 挂载时仅运行一次

  if (showDisconnectDialog) {
    return <BridgeDisconnectDialog onDone={onDone} />;
  }

  return null;
}

/**
 * 当 bridge 已连接时运行 /remote-control 显示的对话框。
 * 显示会话 URL 并允许用户断开连接或继续。
 */
function BridgeDisconnectDialog({ onDone }: Props): React.ReactNode {
  useRegisterOverlay('bridge-disconnect-dialog');
  const setAppState = useSetAppState();
  const sessionUrl = useAppState(s => s.replBridgeSessionUrl);
  const connectUrl = useAppState(s => s.replBridgeConnectUrl);
  const sessionActive = useAppState(s => s.replBridgeSessionActive);
  const [focusIndex, setFocusIndex] = useState(2);
  const [showQR, setShowQR] = useState(false);
  const [qrText, setQrText] = useState('');

  const displayUrl = sessionActive ? sessionUrl : connectUrl;

  // 当 URL 变化或切换 QR 开启时生成二维码
  useEffect(() => {
    if (!showQR || !displayUrl) {
      setQrText('');
      return;
    }
    qrToString(displayUrl, {
      type: 'utf8',
      errorCorrectionLevel: 'L',
      small: true,
    } as Parameters<typeof qrToString>[1])
      .then(setQrText)
      .catch(() => setQrText(''));
  }, [showQR, displayUrl]);

  function handleDisconnect(): void {
    setAppState(prev => {
      if (!prev.replBridgeEnabled) return prev;
      return {
        ...prev,
        replBridgeEnabled: false,
        replBridgeExplicit: false,
        replBridgeOutboundOnly: false,
      };
    });
    logEvent('tengu_bridge_command', {
      action: 'disconnect' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(REMOTE_CONTROL_DISCONNECTED_MSG, { display: 'system' });
  }

  function handleShowQR(): void {
    setShowQR(prev => !prev);
  }

  function handleContinue(): void {
    onDone(undefined, { display: 'skip' });
  }

  const ITEM_COUNT = 3;

  useKeybindings(
    {
      'select:next': () => setFocusIndex(i => (i + 1) % ITEM_COUNT),
      'select:previous': () => setFocusIndex(i => (i - 1 + ITEM_COUNT) % ITEM_COUNT),
      'select:accept': () => {
        if (focusIndex === 0) {
          handleDisconnect();
        } else if (focusIndex === 1) {
          handleShowQR();
        } else {
          handleContinue();
        }
      },
    },
    { context: 'Select' },
  );

  const qrLines = qrText ? qrText.split('\n').filter(l => l.length > 0) : [];

  return (
    <Dialog title="Remote Control" onCancel={handleContinue} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        <Text>
          This session is available via Remote Control
          {displayUrl ? ` at ${displayUrl}` : ''}.
        </Text>
        {showQR && qrLines.length > 0 && (
          <Box flexDirection="column">
            {qrLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
          <ListItem isFocused={focusIndex === 0}>
            <Text>Disconnect this session</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 1}>
            <Text>{showQR ? 'Hide QR code' : 'Show QR code'}</Text>
          </ListItem>
          <ListItem isFocused={focusIndex === 2}>
            <Text>Continue</Text>
          </ListItem>
        </Box>
        <Text dimColor>Enter to select · Esc to continue</Text>
      </Box>
    </Dialog>
  );
}

/**
 * 检查 bridge 前置条件。如果某项前置条件失败则返回错误消息，
 * 否则返回 null 表示全部通过。当磁盘缓存过期时会等待 GrowthBook 初始化，
 * 这样刚获得权限的用户（例如升级到 Max 或 flag 刚上线）首次即可获得准确结果。
 */
async function checkBridgePrerequisites(): Promise<string | null> {
  // 检查组织策略 — remote control 可能被禁用
  const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import('../../services/policyLimits/index.js');
  await waitForPolicyLimitsToLoad();
  if (!isPolicyAllowed('allow_remote_control')) {
    return "Remote Control is disabled by your organization's policy.";
  }

  const disabledReason = await getBridgeDisabledReason();
  if (disabledReason) {
    return disabledReason;
  }

  // 镜像 initReplBridge 中的 v1/v2 分支逻辑：仅当 flag 开启且会话非永久时
  // 才使用 env-less（v2）。在 assistant 模式（KAIROS）下 useReplBridge 会设置
  // perpetual=true，强制 initReplBridge 走 v1 路径 —— 因此前置检查必须匹配。
  let useV2 = isEnvLessBridgeEnabled();
  if (feature('KAIROS') && useV2) {
    const { isAssistantMode } = await import('../../assistant/index.js');
    if (isAssistantMode()) {
      useV2 = false;
    }
  }
  const versionError = useV2 ? await checkEnvLessBridgeMinVersion() : checkBridgeMinVersion();
  if (versionError) {
    return versionError;
  }

  if (!getBridgeAccessToken()) {
    return BRIDGE_LOGIN_INSTRUCTION;
  }

  logForDebugging('[bridge] Prerequisites passed, enabling bridge');
  return null;
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const name = args.trim() || undefined;
  return <BridgeToggle onDone={onDone} name={name} />;
}
