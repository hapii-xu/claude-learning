import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../tasks/LocalShellTask/LocalShellTask.js'
import type {
  NormalizedUserMessage,
  RenderableMessage,
} from '../types/message.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import { extractTag } from './messages.js'

function isCompletedBackgroundBash(
  msg: RenderableMessage,
): msg is NormalizedUserMessage {
  if (msg.type !== 'user') return false
  const content0 = Array.isArray(msg.message.content)
    ? msg.message.content[0]
    : undefined
  if (!content0 || typeof content0 === 'string' || content0?.type !== 'text')
    return false
  if (!content0.text.includes(`<${TASK_NOTIFICATION_TAG}`)) return false
  // 仅折叠成功完成的 —— 失败/被杀的任务保持单独可见。
  if (extractTag(content0.text, STATUS_TAG) !== 'completed') return false
  // 此前缀常量区分 bash 类型的 LocalShellTask 完成通知与
  // agent/workflow/monitor 通知。monitor 类型的完成通知有
  // 自己的摘要措辞，有意不在此折叠。
  return (
    extractTag(content0.text, SUMMARY_TAG)?.startsWith(
      BACKGROUND_BASH_SUMMARY_PREFIX,
    ) ?? false
  )
}

/**
 * 将连续的成功后台 bash 任务通知折叠为单个合成的
 * "N 个后台命令已完成" 通知。失败/被杀的任务和 agent/workflow 通知
 * 保持原样。Monitor 流事件（enqueueStreamEvent）没有 <status> 标签，
 * 永远不会匹配。
 *
 * 在 verbose 模式下直通，以便 ctrl+O 显示每次完成。
 */
export function collapseBackgroundBashNotifications(
  messages: RenderableMessage[],
  verbose: boolean,
): RenderableMessage[] {
  if (!isFullscreenEnvEnabled()) return messages
  if (verbose) return messages

  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isCompletedBackgroundBash(msg)) {
      let count = 0
      while (i < messages.length && isCompletedBackgroundBash(messages[i]!)) {
        count++
        i++
      }
      if (count === 1) {
        result.push(msg)
      } else {
        // 合成一个 UserAgentNotificationMessage 已能渲染的任务通知
        // —— 无需新的渲染器。
        result.push({
          ...msg,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `<${TASK_NOTIFICATION_TAG}><${STATUS_TAG}>completed</${STATUS_TAG}><${SUMMARY_TAG}>${count} background commands completed</${SUMMARY_TAG}></${TASK_NOTIFICATION_TAG}>`,
              },
            ],
          },
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
