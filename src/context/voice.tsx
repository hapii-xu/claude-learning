import React, { createContext, useContext, useState, useSyncExternalStore } from 'react';
import { createStore, type Store } from '../state/store.js';

export type VoiceState = {
  voiceState: 'idle' | 'recording' | 'processing';
  voiceError: string | null;
  voiceInterimTranscript: string;
  voiceAudioLevels: number[];
  voiceWarmingUp: boolean;
};

const DEFAULT_STATE: VoiceState = {
  voiceState: 'idle',
  voiceError: null,
  voiceInterimTranscript: '',
  voiceAudioLevels: [],
  voiceWarmingUp: false,
};

type VoiceStore = Store<VoiceState>;

const VoiceContext = createContext<VoiceStore | null>(null);

type Props = {
  children: React.ReactNode;
};

export function VoiceProvider({ children }: Props): React.ReactNode {
  // Store 只创建一次——稳定的上下文值意味着 provider 永远不会
  // 触发重新渲染。消费者通过 useVoiceState 订阅切片。
  const [store] = useState(() => createStore<VoiceState>(DEFAULT_STATE));
  return <VoiceContext.Provider value={store}>{children}</VoiceContext.Provider>;
}

function useVoiceStore(): VoiceStore {
  const store = useContext(VoiceContext);
  if (!store) {
    throw new Error('useVoiceState must be used within a VoiceProvider');
  }
  return store;
}

/**
 * 订阅语音状态的一部分。仅当所选值改变时
 * 才重新渲染（通过 Object.is 比较）。
 */
export function useVoiceState<T>(selector: (state: VoiceState) => T): T {
  const store = useVoiceStore();
  const get = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * 获取语音状态设置器。稳定的引用——永远不会导致重新渲染。
 * store.setState 是同步的：调用方可以立即读取 getVoiceState()
 * 以观察新值（VoiceKeybindingHandler 依赖此行为）。
 */
export function useSetVoiceState(): (updater: (prev: VoiceState) => VoiceState) => void {
  return useVoiceStore().setState;
}

/**
 * 获取回调内新鲜状态的同步读取器。与
 * useVoiceState（会订阅）不同，此函数不会导致重新渲染——
 * 在需要读取同一 tick 内先前设置的状态的事件处理器中使用。
 */
export function useGetVoiceState(): () => VoiceState {
  return useVoiceStore().getState;
}
