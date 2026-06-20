import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'

type BridgePermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}

type BridgePermissionCallbacks = {
  sendRequest(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    description: string,
    permissionSuggestions?: PermissionUpdate[],
    blockedPath?: string,
  ): void
  sendResponse(requestId: string, response: BridgePermissionResponse): void
  /** 取消一个待处理的 control_request，让 web 应用可以关掉它的提示框。 */
  cancelRequest(requestId: string): void
  onResponse(
    requestId: string,
    handler: (response: BridgePermissionResponse) => void,
  ): () => void // 返回取消订阅函数
}

/** 类型谓词：把解析后的 control_response 载荷校验为
 *  BridgePermissionResponse。检查必备的 `behavior` 判别字段，而不是
 *  使用不安全的 `as` 强转。 */
function isBridgePermissionResponse(
  value: unknown,
): value is BridgePermissionResponse {
  if (!value || typeof value !== 'object') return false
  return (
    'behavior' in value &&
    (value.behavior === 'allow' || value.behavior === 'deny')
  )
}

function toBridgePermissionMessage(
  controlResponse: Record<string, unknown>,
  parsed: BridgePermissionResponse | undefined,
): string | undefined {
  if (typeof controlResponse.message === 'string' && controlResponse.message) {
    return controlResponse.message
  }
  if (typeof parsed?.message === 'string' && parsed.message) {
    return parsed.message
  }
  if (typeof controlResponse.error === 'string' && controlResponse.error) {
    return controlResponse.error
  }
  return undefined
}

/**
 * 把 bridge transport 传过来的 control_response 归一化为简化的
 * allow/deny 结构，供交互式权限处理器使用。
 */
function parseBridgePermissionResponse(
  message: SDKControlResponse,
): BridgePermissionResponse | null {
  const controlResponse = message.response
  if (!controlResponse || typeof controlResponse !== 'object') return null

  if (
    controlResponse.subtype === 'success' &&
    'response' in controlResponse &&
    isBridgePermissionResponse(controlResponse.response)
  ) {
    return controlResponse.response
  }

  if (controlResponse.subtype !== 'error') {
    return null
  }

  const nested =
    'response' in controlResponse &&
    isBridgePermissionResponse(controlResponse.response)
      ? controlResponse.response
      : undefined

  const messageText = toBridgePermissionMessage(controlResponse, nested)

  if (nested) {
    return messageText ? { ...nested, message: messageText } : nested
  }

  if (messageText) {
    return {
      behavior: 'deny',
      message: messageText,
    }
  }

  return null
}

export { isBridgePermissionResponse, parseBridgePermissionResponse }
export type { BridgePermissionCallbacks, BridgePermissionResponse }
