import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type WsWebSocket from 'ws'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { toError } from './errors.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// WebSocket readyState 常量（原生与 ws 包相同）
const WS_CONNECTING = 0
const WS_OPEN = 1

// globalThis.WebSocket 和 ws.WebSocket 共享的最小接口
type WebSocketLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
}

export class WebSocketTransport implements Transport {
  private started = false
  private opened: Promise<void>
  private isBun = typeof Bun !== 'undefined'

  constructor(private ws: WebSocketLike) {
    this.opened = new Promise((resolve, reject) => {
      if (this.ws.readyState === WS_OPEN) {
        resolve()
      } else if (this.isBun) {
        const nws = this.ws as unknown as globalThis.WebSocket
        const onOpen = () => {
          nws.removeEventListener('open', onOpen)
          nws.removeEventListener('error', onError)
          resolve()
        }
        const onError = (event: Event) => {
          nws.removeEventListener('open', onOpen)
          nws.removeEventListener('error', onError)
          logForDiagnosticsNoPII('error', 'mcp_websocket_connect_fail')
          reject(event)
        }
        nws.addEventListener('open', onOpen)
        nws.addEventListener('error', onError)
      } else {
        const nws = this.ws as unknown as WsWebSocket
        nws.on('open', () => {
          resolve()
        })
        nws.on('error', error => {
          logForDiagnosticsNoPII('error', 'mcp_websocket_connect_fail')
          reject(error)
        })
      }
    })

    // 附加持久化事件处理器
    if (this.isBun) {
      const nws = this.ws as unknown as globalThis.WebSocket
      nws.addEventListener('message', this.onBunMessage)
      nws.addEventListener('error', this.onBunError)
      nws.addEventListener('close', this.onBunClose)
    } else {
      const nws = this.ws as unknown as WsWebSocket
      nws.on('message', this.onNodeMessage)
      nws.on('error', this.onNodeError)
      nws.on('close', this.onNodeClose)
    }
  }

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  // Bun（原生 WebSocket）事件处理器
  private onBunMessage = (event: MessageEvent) => {
    try {
      const data =
        typeof event.data === 'string' ? event.data : String(event.data)
      const messageObj = jsonParse(data)
      const message = JSONRPCMessageSchema.parse(messageObj)
      this.onmessage?.(message)
    } catch (error) {
      this.handleError(error)
    }
  }

  private onBunError = () => {
    this.handleError(new Error('WebSocket error'))
  }

  private onBunClose = () => {
    this.handleCloseCleanup()
  }

  // Node（ws 包）事件处理器
  private onNodeMessage = (data: Buffer) => {
    try {
      const messageObj = jsonParse(data.toString('utf-8'))
      const message = JSONRPCMessageSchema.parse(messageObj)
      this.onmessage?.(message)
    } catch (error) {
      this.handleError(error)
    }
  }

  private onNodeError = (error: unknown) => {
    this.handleError(error)
  }

  private onNodeClose = () => {
    this.handleCloseCleanup()
  }

  // 共享错误处理器
  private handleError(error: unknown): void {
    logForDiagnosticsNoPII('error', 'mcp_websocket_message_fail')
    this.onerror?.(toError(error))
  }

  // 共享关闭处理器，含监听器清理
  private handleCloseCleanup(): void {
    this.onclose?.()
    // 关闭后清理监听器
    if (this.isBun) {
      const nws = this.ws as unknown as globalThis.WebSocket
      nws.removeEventListener('message', this.onBunMessage)
      nws.removeEventListener('error', this.onBunError)
      nws.removeEventListener('close', this.onBunClose)
    } else {
      const nws = this.ws as unknown as WsWebSocket
      nws.off('message', this.onNodeMessage)
      nws.off('error', this.onNodeError)
      nws.off('close', this.onNodeClose)
    }
  }

  /**
   * 开始监听 WebSocket 上的消息。
   */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Start can only be called once per transport.')
    }
    await this.opened
    if (this.ws.readyState !== WS_OPEN) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_start_not_opened')
      throw new Error('WebSocket is not open. Cannot start transport.')
    }
    this.started = true
    // 与 stdio 不同，WebSocket 连接在 transport 创建时通常已建立。
    // 此处不需要显式连接操作，只需附加监听器。
  }

  /**
   * 关闭 WebSocket 连接。
   */
  async close(): Promise<void> {
    if (
      this.ws.readyState === WS_OPEN ||
      this.ws.readyState === WS_CONNECTING
    ) {
      this.ws.close()
    }
    // 即使 close 由外部调用或连接已关闭，也确保监听器被移除
    this.handleCloseCleanup()
  }

  /**
   * 通过 WebSocket 连接发送 JSON-RPC 消息。
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== WS_OPEN) {
      logForDiagnosticsNoPII('error', 'mcp_websocket_send_not_opened')
      throw new Error('WebSocket is not open. Cannot send message.')
    }
    const json = jsonStringify(message)

    try {
      if (this.isBun) {
        // 原生 WebSocket.send() 是同步的（无回调）
        this.ws.send(json)
      } else {
        await new Promise<void>((resolve, reject) => {
          ;(this.ws as unknown as WsWebSocket).send(json, error => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        })
      }
    } catch (error) {
      this.handleError(error)
      throw error
    }
  }
}
