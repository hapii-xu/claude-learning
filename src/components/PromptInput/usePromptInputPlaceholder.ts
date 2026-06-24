import { feature } from 'bun:bundle'
import { useMemo } from 'react'
import { useCommandQueue } from 'src/hooks/useCommandQueue.js'
import { useAppState } from 'src/state/AppState.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { getExampleCommandFromCache } from 'src/utils/exampleCommands.js'
import { isQueuedCommandEditable } from 'src/utils/messageQueueManager.js'

// 死代码消除：proactive 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('../../proactive/index.js')
    : null

type Props = {
  input: string
  submitCount: number
  viewingAgentName?: string
}

const NUM_TIMES_QUEUE_HINT_SHOWN = 3
const MAX_TEAMMATE_NAME_LENGTH = 20

export function usePromptInputPlaceholder({
  input,
  submitCount,
  viewingAgentName,
}: Props): string | undefined {
  const queuedCommands = useCommandQueue()
  const promptSuggestionEnabled = useAppState(s => s.promptSuggestionEnabled)
  const placeholder = useMemo(() => {
    if (input !== '') {
      return
    }

    // 查看队友时显示队友提示
    if (viewingAgentName) {
      const displayName =
        viewingAgentName.length > MAX_TEAMMATE_NAME_LENGTH
          ? viewingAgentName.slice(0, MAX_TEAMMATE_NAME_LENGTH - 3) + '...'
          : viewingAgentName
      return `发消息给 @${displayName}…`
    }

    // 如果用户尚未看过提示，则显示队列提示。
    // 只统计用户可编辑的命令 —— task-notification 和 isMeta
    // 在提示区域中是隐藏的（见 PromptInputQueuedCommands）。
    if (
      queuedCommands.some(isQueuedCommandEditable) &&
      (getGlobalConfig().queuedCommandUpHintCount || 0) <
        NUM_TIMES_QUEUE_HINT_SHOWN
    ) {
      return '按上箭头键编辑已排队的消息'
    }

    // 如果用户尚未提交且建议已启用，则显示示例命令。
    // 在 proactive 模式下跳过 —— 模型主导对话，因此入门
    // 示例不再相关，且会阻止提示建议的显示。
    if (
      submitCount < 1 &&
      promptSuggestionEnabled &&
      !proactiveModule?.isProactiveActive()
    ) {
      return getExampleCommandFromCache()
    }
  }, [
    input,
    queuedCommands,
    submitCount,
    promptSuggestionEnabled,
    viewingAgentName,
  ])

  return placeholder
}
