import type { UUID } from 'crypto'
import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import {
  cleanMessagesForLogging,
  isChainParticipant,
  recordTranscript,
} from '../utils/sessionStorage.js'

/**
 * 将消息记录到 transcript 的 Hook
 * 对话 ID 仅在新对话开始时更改。
 *
 * @param messages 当前对话消息
 * @param ignore 为 true 时，消息不会被记录到 transcript
 */
export function useLogMessages(messages: Message[], ignore: boolean = false) {
  const teamContext = useAppState(s => s.teamContext)

  // messages 在压缩之间是仅追加的，所以跟踪我们
  // 停止的位置并仅将新的尾部传递给 recordTranscript。
  // 避免在每次 setMessages 上进行 O(n) 过滤+扫描
  // （每回合约 20 次，所以 n=3000 时约 12 万次浪费迭代）。
  const lastRecordedLengthRef = useRef(0)
  const lastParentUuidRef = useRef<UUID | undefined>(undefined)
  // 首个 uuid 变化 = 压缩或 /clear 重建了数组；仅靠长度
  // 无法检测这一点，因为压缩后 [CB,summary,...keep,new] 可能更长。
  const firstMessageUuidRef = useRef<UUID | undefined>(undefined)
  // 防止过时的异步 .then() 在增量渲染在压缩 .then() 解析
  // 之前触发时覆盖更新的同步更新。
  const callSeqRef = useRef(0)

  useEffect(() => {
    if (ignore) return

    const currentFirstUuid = messages[0]?.uuid as UUID | undefined
    const prevLength = lastRecordedLengthRef.current

    // 首次渲染：firstMessageUuidRef 为 undefined。压缩：首个 uuid 变化。
    // 两者都是 !isIncremental，但首次渲染的同步遍历是安全的（无 messagesToKeep）。
    const wasFirstRender = firstMessageUuidRef.current === undefined
    const isIncremental =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength <= messages.length
    // 同头缩小：墓碑过滤、回退、剪切、部分压缩。
    // 与压缩区分（首个 uuid 变化），因为尾部
    // 要么是已有的磁盘消息，要么是此同一 effect 的
    // recordTranscript(fullArray) 将写入的新消息 —— 见下方同步遍历守卫。
    const isSameHeadShrink =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength > messages.length

    const startIndex = isIncremental ? prevLength : 0
    if (startIndex === messages.length) return

    // 首次调用 + 压缩后的完整数组：recordTranscript 自己的
    // O(n) 去重循环在那里正确处理 messagesToKeep 交错。
    const slice = startIndex === 0 ? messages : messages.slice(startIndex)
    const parentHint = isIncremental ? lastParentUuidRef.current : undefined

    // 即发即忘 - 我们不想阻塞 UI。
    const seq = ++callSeqRef.current
    void recordTranscript(
      slice,
      isAgentSwarmsEnabled()
        ? {
            teamName: teamContext?.teamName,
            agentName: teamContext?.selfAgentName,
          }
        : {},
      parentHint,
      messages,
    ).then(lastRecordedUuid => {
      // 对于压缩/完整数组情况（!isIncremental）：使用异步返回值。
      // 压缩后，数组中的 messagesToKeep 被跳过
      // （已在 transcript 中），所以同步循环会找到错误的 UUID。
      // 如果更新的 effect 已运行则跳过（过时闭包会覆盖
      // 后续增量渲染产生的更新同步更新）。
      if (seq !== callSeqRef.current) return
      if (lastRecordedUuid && !isIncremental) {
        lastParentUuidRef.current = lastRecordedUuid
      }
    })

    // 同步遍历安全用于：增量（纯新尾部切片）、首次渲染
    // （无 messagesToKeep 交错）和同头缩小。缩小是
    // 微妙的：选取的 uuid 要么已在磁盘上（墓碑/回退
    // —— 幸存者在之前写入），要么正被此 effect 的
    // recordTranscript(fullArray) 调用写入（剪切边界 / 部分压缩尾部
    // —— enqueueWrite 顺序保证它在任何链接到它的
    // 后续写入之前落地）。否则，ref 会停留在
    // 墓碑 uuid 上过时：异步 .then() 校正在
    // 大会话上被下一个 effect 的 seq 提升竞争掉，
    // 其中 recordTranscript(fullArray) 很慢。仅压缩情况
    // （首个 uuid 变化）仍然不安全 —— 尾部可能是
    // messagesToKeep，其最后实际记录的 uuid 不同。
    if (isIncremental || wasFirstRender || isSameHeadShrink) {
      // 精确匹配 recordTranscript 持久化的内容：cleanMessagesForLogging
      // 应用 isLoggableMessage 过滤器和（对外部用户）REPL 剥离 +
      // isVirtual 提升转换。此处使用原始谓词
      // 会选择被转换丢弃的 UUID，使父提示
      // 指向从未到达磁盘的消息。传递完整 messages 作为
      // replId 上下文 —— REPL tool_use 及其 tool_result 在
      // 分离的渲染周期落地，所以仅切片无法配对它们。
      const last = cleanMessagesForLogging(slice, messages).findLast(
        isChainParticipant,
      )
      if (last) lastParentUuidRef.current = last.uuid as UUID
    }

    lastRecordedLengthRef.current = messages.length
    firstMessageUuidRef.current = currentFirstUuid
  }, [messages, ignore, teamContext?.teamName, teamContext?.selfAgentName])
}
