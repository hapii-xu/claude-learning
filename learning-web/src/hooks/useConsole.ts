import { useSyncExternalStore } from 'react'

export type ConsoleTab = 'test' | 'log' | 'exec' | 'chat'

export interface ConsoleState {
  open: boolean
  tab: ConsoleTab
  height: number
  /** 打开 chat tab 时携带的上下文（文件路径 + 可选符号名） */
  chatContext?: { filePath?: string; symbolName?: string; sessionId?: string }
}

const STORAGE_KEY = 'learning-web-console-state'
const DEFAULT_HEIGHT = 280
const MIN_HEIGHT = 120
const MAX_HEIGHT_RATIO = 0.6

function loadState(): ConsoleState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return { open: false, tab: 'test', height: DEFAULT_HEIGHT }
}

function saveState(state: ConsoleState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

// ─── 模块级共享 store ───

let state: ConsoleState = loadState()
const listeners = new Set<() => void>()

function notify() {
  saveState(state)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ConsoleState {
  return state
}

function setState(updater: (prev: ConsoleState) => ConsoleState) {
  state = updater(state)
  notify()
}

// ─── 公共 actions（模块级单例） ───

function toggle() {
  setState(s => ({ ...s, open: !s.open }))
}

function setOpen(open: boolean) {
  setState(s => ({ ...s, open }))
}

function setTab(tab: ConsoleTab) {
  setState(s => ({ ...s, tab, open: true }))
}

function openChat(context?: ConsoleState['chatContext']) {
  setState(s => ({ ...s, tab: 'chat', open: true, chatContext: context }))
}

function setHeight(height: number) {
  const maxH =
    typeof window !== 'undefined' ? window.innerHeight * MAX_HEIGHT_RATIO : 600
  const clamped = Math.max(MIN_HEIGHT, Math.min(maxH, height))
  setState(s => ({ ...s, height: clamped }))
}

/**
 * 全局 Console 抽屉状态管理
 * 所有组件共享同一个 store（模块级单例）
 */
export function useConsole() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    open: s.open,
    tab: s.tab,
    height: s.height,
    chatContext: s.chatContext,
    toggle,
    setOpen,
    setTab,
    setHeight,
    openChat,
  }
}
