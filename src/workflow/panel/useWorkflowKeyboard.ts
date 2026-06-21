import { useInput } from '@anthropic/ink'

/** The column that currently has focus. */
export type FocusColumn = 'phases' | 'agents'

/** Keyboard mode: normal = regular navigation; confirm = a Dialog is open, waiting for the user's y/n confirmation. */
export type WorkflowKeyboardMode = 'normal' | 'confirm'

/** Subset of the useInput key object (only declares the fields we use, to avoid coupling to the ink Key type). */
type KeyEvent = {
  tab?: boolean
  shift?: boolean
  escape?: boolean
  return?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
}

/** key -> action (pure function, easy to unit test; no rendering dependencies). */
export type WorkflowKeyAction =
  | 'nextTab'
  | 'prevTab'
  | 'focusLeft'
  | 'focusRight'
  | 'moveUp'
  | 'moveDown'
  | 'killAgent'
  | 'killWorkflow'
  | 'resume'
  | 'newRun'
  | 'quit'
  | 'confirmYes'
  | 'confirmNo'

export function routeWorkflowKey(
  input: string,
  key: KeyEvent,
  mode: WorkflowKeyboardMode = 'normal',
): WorkflowKeyAction | null {
  // 确认模式：只有 y/Enter 确认，n/Esc/q 取消，其他按键一律吞掉（防止误触）
  if (mode === 'confirm') {
    if (input === 'y' || input === 'Y' || key.return) return 'confirmYes'
    if (input === 'n' || input === 'N' || key.escape || input === 'q') {
      return 'confirmNo'
    }
    return null
  }
  // @anthropic/ink 把 Tab 键的 key.tab 设为 true；部分环境回退到 '\t'
  if (key.tab || input === '\t') return key.shift ? 'prevTab' : 'nextTab'
  if (key.escape || input === 'q') return 'quit'
  // 大写 K = 杀掉整个 workflow；小写 x = 杀掉当前选中的 agent（仅 agents 列）。
  // 大小写区分避免 x 意外触发 workflow kill；K 显式要求 Shift，暗示这是"重操作"。
  if (input === 'K') return 'killWorkflow'
  if (input === 'x') return 'killAgent'
  if (input === 'r') return 'resume'
  if (input === 'n') return 'newRun'
  if (key.leftArrow) return 'focusLeft'
  if (key.rightArrow) return 'focusRight'
  if (key.upArrow) return 'moveUp'
  if (key.downArrow) return 'moveDown'
  return null
}

/** 聚焦模型回调（由 WorkflowsPanel 注入）。 */
export type WorkflowKeyboardHandlers = {
  nextTab: () => void
  prevTab: () => void
  focusLeft: () => void
  focusRight: () => void
  moveUp: () => void
  moveDown: () => void
  /** 请求杀掉当前选中的 agent（面板弹出 Dialog 二次确认）。 */
  killAgent: () => void
  /** 请求杀掉整个 workflow（面板弹出 Dialog 二次确认）。 */
  killWorkflow: () => void
  resumeFocused: () => void
  newRun: () => void
  quit: () => void
  /** 用户在确认模式下确认（y/Enter）。 */
  confirmYes: () => void
  /** 用户在确认模式下取消（n/Esc/q）。 */
  confirmNo: () => void
}

/**
 * /workflows panel keybindings (focus rotation model):
 * - Tab / Shift+Tab: switch the top run tab
 * - Left / Right: switch focus between phases and agents
 * - Up / Down: move within the currently focused column
 * - x kill single agent · K kill the entire workflow (with Dialog secondary confirmation) · r resume · n new · q / Esc quit
 *
 * @param mode In confirm mode only y/n/Esc/q are accepted, all other keys are swallowed - avoid mis-navigation inside the confirmation dialog.
 */
export function useWorkflowKeyboard(
  h: WorkflowKeyboardHandlers,
  mode: WorkflowKeyboardMode = 'normal',
): void {
  useInput((input, key) => {
    const action = routeWorkflowKey(input, key as KeyEvent, mode)
    if (action === null) return
    switch (action) {
      case 'nextTab':
        h.nextTab()
        break
      case 'prevTab':
        h.prevTab()
        break
      case 'focusLeft':
        h.focusLeft()
        break
      case 'focusRight':
        h.focusRight()
        break
      case 'moveUp':
        h.moveUp()
        break
      case 'moveDown':
        h.moveDown()
        break
      case 'killAgent':
        h.killAgent()
        break
      case 'killWorkflow':
        h.killWorkflow()
        break
      case 'resume':
        h.resumeFocused()
        break
      case 'newRun':
        h.newRun()
        break
      case 'quit':
        h.quit()
        break
      case 'confirmYes':
        h.confirmYes()
        break
      case 'confirmNo':
        h.confirmNo()
        break
    }
  })
}
