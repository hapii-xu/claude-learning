/**
 * SDK MCP Transport 桥接层
 *
 * 本文件实现了一个 transport 桥接层，允许在 SDK 进程中运行的 MCP 服务端
 * 通过控制消息与 Claude Code CLI 进程通信。
 *
 * ## 架构概述
 *
 * 与普通 MCP 服务端（以独立进程运行）不同，SDK MCP 服务端在 SDK 进程内运行。
 * 这需要在以下两者之间建立特殊的传输机制：
 * - CLI 进程（运行 MCP 客户端）
 * - SDK 进程（运行 SDK MCP 服务端）
 *
 * ## 消息流
 *
 * ### CLI → SDK（通过 SdkControlClientTransport）
 * 1. CLI 的 MCP 客户端调用工具 → 向 SdkControlClientTransport 发送 JSONRPC 请求
 * 2. Transport 将消息封装为控制请求，附带 server_name 和 request_id
 * 3. 控制请求通过 stdout 发送到 SDK 进程
 * 4. SDK 的 StructuredIO 接收控制响应并将其路由回 transport
 * 5. Transport 解包响应并返回给 MCP 客户端
 *
 * ### SDK → CLI（通过 SdkControlServerTransport）
 * 1. Query 收到携带 MCP 消息的控制请求，并调用 transport.onmessage
 * 2. MCP 服务端处理消息并通过 transport.send() 返回响应
 * 3. Transport 通过回调函数 sendMcpMessage 返回响应
 * 4. Query 的回调函数用响应解析挂起的 Promise
 * 5. Query 返回响应以完成控制请求
 *
 * ## 关键设计要点
 *
 * - SdkControlClientTransport：StructuredIO 跟踪挂起的请求
 * - SdkControlServerTransport：Query 跟踪挂起的请求
 * - 控制请求封装包含 server_name，用于路由到正确的 SDK 服务端
 * - 系统支持多个 SDK MCP 服务端同时运行
 * - 消息 ID 在整个流程中被保留，用于正确的请求/响应关联
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * 发送 MCP 消息并获取响应的回调函数
 */
export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>

/**
 * CLI 端的 SDK MCP 服务端 transport。
 *
 * 在 CLI 进程中使用此 transport，桥接以下两者之间的通信：
 * - CLI 的 MCP 客户端（希望调用 SDK MCP 服务端上的工具）
 * - SDK 进程（实际的 MCP 服务端所在位置）
 *
 * 它将 MCP 协议消息转换为可通过 stdout/stdin 发送到 SDK 进程的控制请求。
 */
export class SdkControlClientTransport implements Transport {
  private isClosed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(
    private serverName: string,
    private sendMcpMessage: SendMcpMessageCallback,
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }

    // 发送消息并等待响应
    const response = await this.sendMcpMessage(this.serverName, message)

    // 将响应回传给 MCP 客户端
    if (this.onmessage) {
      this.onmessage(response)
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.onclose?.()
  }
}

/**
 * SDK 端的 SDK MCP 服务端 transport。
 *
 * 在 SDK 进程中使用此 transport，桥接以下两者之间的通信：
 * - 来自 CLI 的控制请求（通过 stdin）
 * - 在 SDK 进程中运行的实际 MCP 服务端
 *
 * 它作为简单的透传层，将消息转发给 MCP 服务端
 * 并通过回调发送响应。
 *
 * 注：Query 负责处理所有请求/响应的关联和异步流程。
 */
export class SdkControlServerTransport implements Transport {
  private isClosed = false

  constructor(private sendMcpMessage: (message: JSONRPCMessage) => void) {}

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.isClosed) {
      throw new Error('Transport is closed')
    }

    // 简单地通过回调将响应返回
    this.sendMcpMessage(message)
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return
    }
    this.isClosed = true
    this.onclose?.()
  }
}
