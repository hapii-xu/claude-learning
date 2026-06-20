import { feature } from 'bun:bundle';
import * as React from 'react';
import { resetCostState } from '../../bootstrap/state.js';
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js';
import { Box, Dialog, useInput } from '@anthropic/ink';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { Text } from '@anthropic/ink';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { stripSignatureBlocks } from '../../utils/messages.js';
import {
  checkAndDisableAutoModeIfNeeded,
  resetAutoModeGateCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { resetUserCache } from '../../utils/user.js';
import { AuthPlaneSummary } from './AuthPlaneSummary.js';
import { getAuthStatus } from './getAuthStatus.js';
import { WorkspaceKeyInputContainer } from './WorkspaceKeyInput.js';
import { removeWorkspaceKey } from '../../services/auth/saveWorkspaceKey.js';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  // 在调用时一次性快照认证状态（纯函数，无网络）
  const authStatus = getAuthStatus();

  return (
    <Login
      authStatus={authStatus}
      onDone={async success => {
        context.onChangeAPIKey();
        // 带签名的 block（thinking、connector_text）与 API key 绑定 ——
        // 把它们剥离掉，避免新 key 拒绝旧的签名。
        context.setMessages(stripSignatureBlocks);
        if (success) {
          // 登录后刷新逻辑。需与 src/interactiveHelpers.tsx 中的 onboarding 保持同步
          // 切换账号时重置 cost 状态
          resetCostState();
          // 登录后刷新远程托管设置（非阻塞）
          void refreshRemoteManagedSettings();
          // 登录后刷新 policy limits（非阻塞）
          void refreshPolicyLimits();
          // 在 GrowthBook 刷新前清除用户数据缓存，使其能拿到最新凭证
          resetUserCache();
          // 登录后刷新 GrowthBook，获取最新的 feature flag（例如 claude.ai MCPs 相关）
          refreshGrowthBookAfterAuthChange();
          // 在重新注册为可信设备之前，清除上一个账号遗留的 trusted device token ——
          // 避免在异步 enrollTrustedDevice() 进行期间 bridge 调用仍发送旧 token。
          clearTrustedDeviceToken();
          // 注册为 Remote Control 的可信设备（10 分钟的新鲜会话窗口）
          void enrollTrustedDevice();
          // 重置 killswitch 门控检查，并在新 org 下重新执行
          resetAutoModeGateCheck();
          const appState = context.getAppState();
          void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState, appState.fastMode);
          // 自增 authVersion，触发 hooks 重新拉取依赖认证的数据（例如 MCP 服务器）
          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }));
        }
        onDone(success ? 'Login successful' : 'Login interrupted');
      }}
    />
  );
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void;
  startingMessage?: string;
  /** 预先计算好的认证状态快照 —— 由 call() 传入以避免重复计算 */
  authStatus?: import('./getAuthStatus.js').AuthStatus;
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel();
  const [showWorkspaceKeyInput, setShowWorkspaceKeyInput] = React.useState(false);
  // 'idle' | 'confirm-remove' | 'removing' | { error: string }
  const [removeState, setRemoveState] = React.useState<
    { phase: 'idle' } | { phase: 'confirm-remove' } | { phase: 'removing' } | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  // 保存/删除 key 后重新快照认证状态，使对应行立即更新
  const [liveAuthStatus, setLiveAuthStatus] = React.useState(props.authStatus);

  const workspaceKeySet = liveAuthStatus !== undefined && liveAuthStatus.workspaceKey.set;
  // 通过 source 区分 env-var（无法从 UI 删除）和 settings 保存的 key
  const workspaceKeyFromSettings = workspaceKeySet && liveAuthStatus.workspaceKey.source === 'settings';

  const refreshLiveStatus = React.useCallback(() => {
    const { getAuthStatus } = require('./getAuthStatus.js') as typeof import('./getAuthStatus.js');
    setLiveAuthStatus(getAuthStatus());
  }, []);

  // W = 输入/替换 key；D = 删除（仅当存储在 settings 中时）
  useInput(
    (input: string) => {
      if (showWorkspaceKeyInput) return;
      if (removeState.phase === 'confirm-remove') {
        if (input === 'y' || input === 'Y') {
          setRemoveState({ phase: 'removing' });
          void (async () => {
            try {
              await removeWorkspaceKey();
              refreshLiveStatus();
              setRemoveState({ phase: 'idle' });
            } catch (err) {
              setRemoveState({
                phase: 'error',
                message: err instanceof Error ? err.message : 'Failed to remove workspace API key',
              });
            }
          })();
          return;
        }
        if (input === 'n' || input === 'N') {
          setRemoveState({ phase: 'idle' });
          return;
        }
        return;
      }
      if (input === 'w' || input === 'W') {
        setShowWorkspaceKeyInput(true);
        return;
      }
      if ((input === 'd' || input === 'D') && workspaceKeyFromSettings) {
        setRemoveState({ phase: 'confirm-remove' });
      }
    },
    { isActive: !showWorkspaceKeyInput },
  );

  const handleWorkspaceKeySaved = React.useCallback(() => {
    refreshLiveStatus();
    setShowWorkspaceKeyInput(false);
  }, [refreshLiveStatus]);

  const handleWorkspaceKeyCancel = React.useCallback(() => {
    setShowWorkspaceKeyInput(false);
  }, []);

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
        )
      }
    >
      <Box flexDirection="column">
        {liveAuthStatus !== undefined && (
          <Box marginBottom={1}>
            <AuthPlaneSummary status={liveAuthStatus} />
          </Box>
        )}

        {showWorkspaceKeyInput ? (
          <WorkspaceKeyInputContainer onSaved={handleWorkspaceKeySaved} onCancel={handleWorkspaceKeyCancel} />
        ) : removeState.phase === 'confirm-remove' || removeState.phase === 'removing' ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              Remove the saved workspace API key? <Text dimColor>(settings.json only — env var is unaffected)</Text>
            </Text>
            <Text dimColor>{removeState.phase === 'removing' ? 'Removing…' : 'Press Y to confirm, N to cancel'}</Text>
          </Box>
        ) : (
          <>
            <Box flexDirection="column" marginBottom={1}>
              {!workspaceKeySet ? (
                <Text dimColor>Press W to enter workspace API key (saves to settings, no restart needed)</Text>
              ) : workspaceKeyFromSettings ? (
                <Text dimColor>Press W to replace workspace API key · Press D to remove it</Text>
              ) : (
                <Text dimColor>
                  Workspace API key from ANTHROPIC_API_KEY env. Press W to override with a settings-saved key.
                </Text>
              )}
              {removeState.phase === 'error' && <Text color="error">{removeState.message}</Text>}
            </Box>
            <ConsoleOAuthFlow
              onDone={() => props.onDone(true, mainLoopModel)}
              startingMessage={props.startingMessage}
            />
          </>
        )}
      </Box>
    </Dialog>
  );
}
