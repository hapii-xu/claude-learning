import type { LocalCommandCall } from '../../types/command.js'
import { isPoorModeActive, setPoorMode } from './poorMode.js'

export const call: LocalCommandCall = async (_, context) => {
  const currentlyActive = isPoorModeActive()
  const newState = !currentlyActive
  setPoorMode(newState)

  if (newState) {
    // 在 AppState 中禁用 prompt 建议
    context.setAppState(prev => ({
      ...prev,
      promptSuggestionEnabled: false,
    }))
  } else {
    // 重新启用 prompt 建议
    context.setAppState(prev => ({
      ...prev,
      promptSuggestionEnabled: true,
    }))
  }

  const status = newState ? 'ON' : 'OFF'
  const details = newState
    ? 'extract_memories and prompt_suggestion are disabled'
    : 'extract_memories and prompt_suggestion are restored'
  return { type: 'text', value: `Poor mode ${status} — ${details}` }
}
