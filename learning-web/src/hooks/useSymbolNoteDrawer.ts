import { useSyncExternalStore } from 'react'
import type { SymbolInfo } from '@/data/types'

export interface SymbolNoteDrawerState {
  open: boolean
  filePath: string | null
  symbol: SymbolInfo | null
  height: number
}

const STORAGE_KEY = 'learning-web-symbol-note-drawer-state'
const DEFAULT_HEIGHT = 320
const MIN_HEIGHT = 160
const MAX_HEIGHT_RATIO = 0.5

function loadState(): SymbolNoteDrawerState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return { open: false, filePath: null, symbol: null, height: DEFAULT_HEIGHT }
}

function saveState(state: SymbolNoteDrawerState): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore
  }
}

// ─── 模块级共享 store ───

let state: SymbolNoteDrawerState = loadState()
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

function getSnapshot(): SymbolNoteDrawerState {
  return state
}

function setState(
  updater: (prev: SymbolNoteDrawerState) => SymbolNoteDrawerState,
) {
  state = updater(state)
  notify()
}

// ─── 公共 actions（模块级单例） ───

function openForSymbol(filePath: string, symbol: SymbolInfo) {
  setState(s => ({ ...s, open: true, filePath, symbol }))
}

function close() {
  setState(s => ({ ...s, open: false }))
}

function toggle() {
  setState(s => ({ ...s, open: !s.open }))
}

function setHeight(height: number) {
  const maxH =
    typeof window !== 'undefined' ? window.innerHeight * MAX_HEIGHT_RATIO : 400
  const clamped = Math.max(MIN_HEIGHT, Math.min(maxH, height))
  setState(s => ({ ...s, height: clamped }))
}

/**
 * 全局 Symbol Note Drawer 状态管理
 * 所有组件共享同一个 store（模块级单例）
 */
export function useSymbolNoteDrawer() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return {
    open: s.open,
    filePath: s.filePath,
    symbol: s.symbol,
    height: s.height,
    openForSymbol,
    close,
    toggle,
    setHeight,
  }
}
