/**
 * SDK 控制类型 —— 从 controlSchemas.ts / coreSchemas.ts 中的 Zod schema 推导。
 *
 * 这些类型定义了 CLI bridge 与 server 之间的控制协议。
 * 被 bridge/transport 层、远程会话管理器以及 CLI print/IO 路径使用。
 */
import type { z } from 'zod'
import type {
  SDKControlRequestSchema,
  SDKControlResponseSchema,
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlReloadPluginsResponseSchema,
  SDKControlPermissionRequestSchema,
  SDKControlCancelRequestSchema,
  SDKControlRequestInnerSchema,
  StdoutMessageSchema,
  StdinMessageSchema,
} from './controlSchemas.js'
import type { SDKPartialAssistantMessageSchema } from './coreSchemas.js'

export type SDKControlRequest = z.infer<
  ReturnType<typeof SDKControlRequestSchema>
>
export type SDKControlResponse = z.infer<
  ReturnType<typeof SDKControlResponseSchema>
>
export type StdoutMessage = z.infer<ReturnType<typeof StdoutMessageSchema>>
export type SDKControlInitializeRequest = z.infer<
  ReturnType<typeof SDKControlInitializeRequestSchema>
>
export type SDKControlInitializeResponse = z.infer<
  ReturnType<typeof SDKControlInitializeResponseSchema>
>
export type SDKControlMcpSetServersResponse = z.infer<
  ReturnType<typeof SDKControlMcpSetServersResponseSchema>
>
export type SDKControlReloadPluginsResponse = z.infer<
  ReturnType<typeof SDKControlReloadPluginsResponseSchema>
>
export type StdinMessage = z.infer<ReturnType<typeof StdinMessageSchema>>
export type SDKPartialAssistantMessage = z.infer<
  ReturnType<typeof SDKPartialAssistantMessageSchema>
>
export type SDKControlPermissionRequest = z.infer<
  ReturnType<typeof SDKControlPermissionRequestSchema>
>
export type SDKControlCancelRequest = z.infer<
  ReturnType<typeof SDKControlCancelRequestSchema>
>
export type SDKControlRequestInner = z.infer<
  ReturnType<typeof SDKControlRequestInnerSchema>
>
