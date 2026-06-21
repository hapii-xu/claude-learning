// 自动生成的 stub —— 用真实实现替换
export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  content?: string
  [key: string]: unknown
}
export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | string
