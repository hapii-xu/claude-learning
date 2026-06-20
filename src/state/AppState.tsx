import { feature } from 'bun:bundle';
import React, { useContext, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import { MailboxProvider } from '../context/mailbox.js';
import { useSettingsChange } from '../hooks/useSettingsChange.js';
import { logForDebugging } from '../utils/debug.js';
import {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
} from '../utils/permissions/permissionSetup.js';
import { applySettingsChange } from '../utils/settings/applySettingsChange.js';
import type { SettingSource } from '../utils/settings/constants.js';
import { createStore } from './store.js';

// DCE：语音上下文是 ant-only。外部构建获得一个空操作提供者，
// 仍将子组件包装在 VoiceContext 中，以便 useVoiceState 永不抛出。
/* eslint-disable @typescript-eslint/no-require-imports */
const VoiceProvider: (props: { children: React.ReactNode }) => React.ReactNode = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : (() => {
      const { VoiceContext } = require('../context/voice.js');
      const noopStore = createStore({
        voiceState: 'idle' as const,
        voiceError: null as string | null,
        voiceInterimTranscript: '',
        voiceAudioLevels: [] as number[],
        voiceWarmingUp: false,
      });
      return ({ children }: { children: React.ReactNode }) => (
        <VoiceContext.Provider value={noopStore}>{children}</VoiceContext.Provider>
      );
    })();

/* eslint-enable @typescript-eslint/no-require-imports */
import { type AppState, type AppStateStore, getDefaultAppState } from './AppStateStore.js';

// TODO: 在所有调用者直接从 ./AppStateStore.js 导入后移除此处重新导出。
// 在迁移期间保留向后兼容，以便 .ts 调用者可以逐步
// 从 .tsx 导入迁移并停止拉取 React。
export {
  type AppState,
  type AppStateStore,
  type CompletionBoundary,
  getDefaultAppState,
  IDLE_SPECULATION_STATE,
  type SpeculationResult,
  type SpeculationState,
} from './AppStateStore.js';

export const AppStoreContext = React.createContext<AppStateStore | null>(null);

type Props = {
  children: React.ReactNode;
  initialState?: AppState;
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void;
};

const HasAppStateContext = React.createContext<boolean>(false);

export function AppStateProvider({ children, initialState, onChangeAppState }: Props): React.ReactNode {
  // 不允许嵌套的 AppStateProvider。
  const hasAppStateContext = useContext(HasAppStateContext);
  if (hasAppStateContext) {
    throw new Error('AppStateProvider 不能嵌套在另一个 AppStateProvider 内');
  }

  // Store 创建一次且永不改变 —— 稳定的上下文值意味着
  // 提供者永不触发重新渲染。消费者通过 useSyncExternalStore
  // 在 useAppState(selector) 中订阅切片。
  const [store] = useState(() => createStore<AppState>(initialState ?? getDefaultAppState(), onChangeAppState));

  // 在挂载时检查是否应禁用绕过模式
  // 这处理了远程设置在组件挂载前加载的竞争条件，
  // 意味着设置更改通知发送时没有订阅的监听器。
  // 在后续会话中，缓存的 remote-settings.json 在初始设置期间读取，
  // 但在首次会话中远程获取可能在 React 挂载前完成。
  useEffect(() => {
    const { toolPermissionContext } = store.getState();
    if (toolPermissionContext.isBypassPermissionsModeAvailable && isBypassPermissionsModeDisabled()) {
      logForDebugging('Disabling bypass permissions mode on mount (remote settings loaded before mount)');
      store.setState(prev => ({
        ...prev,
        toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext),
      }));
    }
  }, []);

  // 监听外部设置变更并同步到 AppState。
  // 这确保文件观察者的变更传播到整个应用 -
  // 通过 applySettingsChange 与无头/SDK 路径共享。
  const onSettingsChange = useEffectEvent((source: SettingSource) => applySettingsChange(source, store.setState));
  useSettingsChange(onSettingsChange);

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        <MailboxProvider>
          <VoiceProvider>{children}</VoiceProvider>
        </MailboxProvider>
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  );
}

function useAppStore(): AppStateStore {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new ReferenceError('useAppState/useSetAppState cannot be called outside of an <AppStateProvider />');
  }
  return store;
}

/**
 * 订阅 AppState 的一个切片。仅当所选值更改时重新渲染
 * （通过 Object.is 比较）。
 *
 * 对于多个独立字段，多次调用此 hook：
 * ```
 * const verbose = useAppState(s => s.verbose)
 * const model = useAppState(s => s.mainLoopModel)
 * ```
 *
 * 不要从选择器返回新对象 -- Object.is 会始终认为它们已更改。
 * 相反，选择一个现有的子对象引用：
 * ```
 * const { text, promptId } = useAppState(s => s.promptSuggestion) // 正确
 * ```
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore();

  const get = () => {
    const state = store.getState();
    const selected = selector(state);

    if (process.env.USER_TYPE === 'ant' && state === selected) {
      throw new Error(
        `Your selector in \`useAppState(${selector.toString()})\` returned the original state, which is not allowed. You must instead return a property for optimised rendering.`,
      );
    }

    return selected;
  };

  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * 获取 setAppState 更新器而不订阅任何状态。
 * 返回永不更改的稳定引用 -- 仅使用此 hook 的组件
 * 不会因状态更改而重新渲染。
 */
export function useSetAppState(): (updater: (prev: AppState) => AppState) => void {
  return useAppStore().setState;
}

/**
 * 直接获取 store（用于将 getState/setState 传递给非 React 代码）。
 */
export function useAppStateStore(): AppStateStore {
  return useAppStore();
}

const NOOP_SUBSCRIBE = () => () => {};

/**
 * useAppState 的安全版本，在 AppStateProvider 外部调用时返回 undefined。
 * 适用于可能在 AppStateProvider 不可用的上下文中渲染的组件。
 */
export function useAppStateMaybeOutsideOfProvider<T>(selector: (state: AppState) => T): T | undefined {
  const store = useContext(AppStoreContext);
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, () =>
    store ? selector(store.getState()) : undefined,
  );
}
