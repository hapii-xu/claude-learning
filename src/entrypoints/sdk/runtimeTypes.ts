/**
 * Stub：SDK 运行时类型（尚未在开源版本中发布）。
 * 不可序列化的类型：回调、含方法的接口。
 */

export type AnyZodRawShape = Record<string, unknown>
export type InferShape<T extends AnyZodRawShape> = { [K in keyof T]: unknown }

export type ForkSessionOptions = {
  dir?: string
  upToMessageId?: string
  title?: string
}
export type ForkSessionResult = { sessionId: string }
export type GetSessionInfoOptions = { dir?: string }
export type GetSessionMessagesOptions = {
  dir?: string
  limit?: number
  offset?: number
  includeSystemMessages?: boolean
}
export type ListSessionsOptions = {
  dir?: string
  limit?: number
  offset?: number
}
export type SessionMutationOptions = { dir?: string }
export type SessionMessage = {
  role: string
  content: unknown
  [key: string]: unknown
}

export interface SDKSession {
  sessionId: string
  prompt(input: string | AsyncIterable<unknown>): Promise<unknown>
  abort(): void
  [key: string]: unknown
}

export type SDKSessionOptions = {
  model?: string
  systemPrompt?: string
  [key: string]: unknown
}

export interface SdkMcpToolDefinition<
  T extends AnyZodRawShape = AnyZodRawShape,
> {
  name: string
  description: string
  inputSchema: T
  handler: (args: InferShape<T>, extra: unknown) => Promise<unknown>
  [key: string]: unknown
}

export type McpSdkServerConfigWithInstance = {
  name: string
  version?: string
  tools?: SdkMcpToolDefinition[]
  [key: string]: unknown
}

export interface Options {
  model?: string
  systemPrompt?: string
  [key: string]: unknown
}

export interface InternalOptions extends Options {
  [key: string]: unknown
}

export interface Query {
  [Symbol.asyncIterator](): AsyncIterator<unknown>
  [key: string]: unknown
}

export interface InternalQuery extends Query {
  [key: string]: unknown
}
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
