// biome-ignore-all lint/suspicious/noConsole: file uses console intentionally
/**
 * Chrome 原生宿主 - 纯 TypeScript 实现
 *
 * 本模块提供 Chrome 原生消息宿主功能，
 * 原先通过 Rust NAPI 绑定实现，现已改用纯 TypeScript 实现。
 */

import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { homedir, platform } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { lazySchema } from '../lazySchema.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getSecureSocketPath, getSocketDir } from './common.js'

const VERSION = '1.0.0'
const MAX_MESSAGE_SIZE = 1024 * 1024 // 1MB - 可发送给 Chrome 的最大消息体积

const LOG_FILE =
  process.env.USER_TYPE === 'ant'
    ? join(homedir(), '.hclaude', 'debug', 'chrome-native-host.txt')
    : undefined

function log(message: string, ...args: unknown[]): void {
  if (LOG_FILE) {
    const timestamp = new Date().toISOString()
    const formattedArgs = args.length > 0 ? ' ' + jsonStringify(args) : ''
    const logLine = `[${timestamp}] [Claude Chrome Native Host] ${message}${formattedArgs}\n`
    // 即发即忘：日志记录尽力而为，调用方（包括事件
    // 处理器）不会 await
    void appendFile(LOG_FILE, logLine).catch(() => {
      // 忽略文件写入错误
    })
  }
  console.error(`[Claude Chrome Native Host] ${message}`, ...args)
}
/**
 * 向 stdout 发送消息（Chrome 原生消息协议）
 */
export function sendChromeMessage(message: string): void {
  const jsonBytes = Buffer.from(message, 'utf-8')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32LE(jsonBytes.length, 0)

  process.stdout.write(lengthBuffer)
  process.stdout.write(jsonBytes)
}

export async function runChromeNativeHost(): Promise<void> {
  log('Initializing...')

  const host = new ChromeNativeHost()
  const messageReader = new ChromeMessageReader()

  // 启动原生宿主服务器
  await host.start()

  // 持续处理来自 Chrome 的消息，直到 stdin 关闭
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const message = await messageReader.read()
    if (message === null) {
      // stdin 已关闭，Chrome 已断开连接
      break
    }

    await host.handleMessage(message)
  }

  // 停止服务器
  await host.stop()
}

const messageSchema = lazySchema(() =>
  z
    .object({
      type: z.string(),
    })
    .passthrough(),
)

type ToolRequest = {
  method: string
  params?: unknown
}

type McpClient = {
  id: number
  socket: Socket
  buffer: Buffer
}

class ChromeNativeHost {
  private mcpClients = new Map<number, McpClient>()
  private nextClientId = 1
  private server: Server | null = null
  private running = false
  private socketPath: string | null = null

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.socketPath = getSecureSocketPath()

    if (platform() !== 'win32') {
      const socketDir = getSocketDir()

      // 迁移旧版 socket：若 socket 目录路径以文件/socket 形式存在，则将其删除
      try {
        const dirStats = await stat(socketDir)
        if (!dirStats.isDirectory()) {
          await unlink(socketDir)
        }
      } catch {
        // 不存在，没问题
      }

      // 以安全权限创建 socket 目录
      await mkdir(socketDir, { recursive: true, mode: 0o700 })

      // 若目录已存在则修正权限
      await chmod(socketDir, 0o700).catch(() => {
        // 忽略
      })

      // 清理过期 socket
      try {
        const files = await readdir(socketDir)
        for (const file of files) {
          if (!file.endsWith('.sock')) {
            continue
          }
          const pid = parseInt(file.replace('.sock', ''), 10)
          if (isNaN(pid)) {
            continue
          }
          try {
            process.kill(pid, 0)
            // 进程存活，保留
          } catch {
            // 进程已死亡，删除过期 socket
            await unlink(join(socketDir, file)).catch(() => {
              // 忽略
            })
            log(`Removed stale socket for PID ${pid}`)
          }
        }
      } catch {
        // 忽略扫描目录时的错误
      }
    }

    log(`Creating socket listener: ${this.socketPath}`)

    this.server = createServer(socket => this.handleMcpClient(socket))

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath!, () => {
        log('Socket server listening for connections')
        this.running = true
        resolve()
      })

      this.server!.on('error', err => {
        log('Socket server error:', err)
        reject(err)
      })
    })

    // 在 Unix 上设置权限（在 listen resolve 之后，此时 socket 文件已存在）
    if (platform() !== 'win32') {
      try {
        await chmod(this.socketPath!, 0o600)
        log('Socket permissions set to 0600')
      } catch (e) {
        log('Failed to set socket permissions:', e)
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    // 关闭所有 MCP 客户端
    for (const [, client] of this.mcpClients) {
      client.socket.destroy()
    }
    this.mcpClients.clear()

    // 关闭服务器
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }

    // 清理 socket 文件
    if (platform() !== 'win32' && this.socketPath) {
      try {
        await unlink(this.socketPath)
        log('Cleaned up socket file')
      } catch {
        // ENOENT 是正常情况，忽略
      }

      // 若目录为空则删除
      try {
        const socketDir = getSocketDir()
        const remaining = await readdir(socketDir)
        if (remaining.length === 0) {
          await rmdir(socketDir)
          log('Removed empty socket directory')
        }
      } catch {
        // 忽略
      }
    }

    this.running = false
  }

  async isRunning(): Promise<boolean> {
    return this.running
  }

  async getClientCount(): Promise<number> {
    return this.mcpClients.size
  }

  async handleMessage(messageJson: string): Promise<void> {
    let rawMessage: unknown
    try {
      rawMessage = jsonParse(messageJson)
    } catch (e) {
      log('Invalid JSON from Chrome:', (e as Error).message)
      sendChromeMessage(
        jsonStringify({
          type: 'error',
          error: 'Invalid message format',
        }),
      )
      return
    }
    const parsed = messageSchema().safeParse(rawMessage)
    if (!parsed.success) {
      log('Invalid message from Chrome:', parsed.error.message)
      sendChromeMessage(
        jsonStringify({
          type: 'error',
          error: 'Invalid message format',
        }),
      )
      return
    }
    const message = parsed.data

    log(`Handling Chrome message type: ${message.type}`)

    switch (message.type) {
      case 'ping':
        log('Responding to ping')

        sendChromeMessage(
          jsonStringify({
            type: 'pong',
            timestamp: Date.now(),
          }),
        )
        break

      case 'get_status':
        sendChromeMessage(
          jsonStringify({
            type: 'status_response',
            native_host_version: VERSION,
          }),
        )
        break

      case 'tool_response': {
        if (this.mcpClients.size > 0) {
          log(`Forwarding tool response to ${this.mcpClients.size} MCP clients`)

          // 提取数据部分（'type' 以外的所有字段）
          const { type: _, ...data } = message
          const responseData = Buffer.from(jsonStringify(data), 'utf-8')
          const lengthBuffer = Buffer.alloc(4)
          lengthBuffer.writeUInt32LE(responseData.length, 0)
          const responseMsg = Buffer.concat([lengthBuffer, responseData])

          for (const [id, client] of this.mcpClients) {
            try {
              client.socket.write(responseMsg)
            } catch (e) {
              log(`Failed to send to MCP client ${id}:`, e)
            }
          }
        }
        break
      }

      case 'notification': {
        if (this.mcpClients.size > 0) {
          log(`Forwarding notification to ${this.mcpClients.size} MCP clients`)

          // 提取数据部分（'type' 以外的所有字段）
          const { type: _, ...data } = message
          const notificationData = Buffer.from(jsonStringify(data), 'utf-8')
          const lengthBuffer = Buffer.alloc(4)
          lengthBuffer.writeUInt32LE(notificationData.length, 0)
          const notificationMsg = Buffer.concat([
            lengthBuffer,
            notificationData,
          ])

          for (const [id, client] of this.mcpClients) {
            try {
              client.socket.write(notificationMsg)
            } catch (e) {
              log(`Failed to send notification to MCP client ${id}:`, e)
            }
          }
        }
        break
      }

      default:
        log(`Unknown message type: ${message.type}`)

        sendChromeMessage(
          jsonStringify({
            type: 'error',
            error: `Unknown message type: ${message.type}`,
          }),
        )
    }
  }

  private handleMcpClient(socket: Socket): void {
    const clientId = this.nextClientId++
    const client: McpClient = {
      id: clientId,
      socket,
      buffer: Buffer.alloc(0),
    }

    this.mcpClients.set(clientId, client)
    log(
      `MCP client ${clientId} connected. Total clients: ${this.mcpClients.size}`,
    )

    // 通知 Chrome 已连接
    sendChromeMessage(
      jsonStringify({
        type: 'mcp_connected',
      }),
    )

    socket.on('data', (data: Buffer) => {
      client.buffer = Buffer.concat([client.buffer, data])

      // 处理完整消息
      while (client.buffer.length >= 4) {
        const length = client.buffer.readUInt32LE(0)

        if (length === 0 || length > MAX_MESSAGE_SIZE) {
          log(`Invalid message length from MCP client ${clientId}: ${length}`)
          socket.destroy()
          return
        }

        if (client.buffer.length < 4 + length) {
          break // 等待更多数据
        }

        const messageBytes = client.buffer.slice(4, 4 + length)
        client.buffer = client.buffer.slice(4 + length)

        try {
          const request = jsonParse(
            messageBytes.toString('utf-8'),
          ) as ToolRequest
          log(
            `Forwarding tool request from MCP client ${clientId}: ${request.method}`,
          )

          // 转发给 Chrome
          sendChromeMessage(
            jsonStringify({
              type: 'tool_request',
              method: request.method,
              params: request.params,
            }),
          )
        } catch (e) {
          log(`Failed to parse tool request from MCP client ${clientId}:`, e)
        }
      }
    })

    socket.on('error', err => {
      log(`MCP client ${clientId} error: ${err}`)
    })

    socket.on('close', () => {
      log(
        `MCP client ${clientId} disconnected. Remaining clients: ${this.mcpClients.size - 1}`,
      )
      this.mcpClients.delete(clientId)

      // 通知 Chrome 已断开连接
      sendChromeMessage(
        jsonStringify({
          type: 'mcp_disconnected',
        }),
      )
    })
  }
}

/**
 * 使用异步 stdin 的 Chrome 消息读取器。同步读取可能导致 Bun 崩溃，因此
 * 使用带缓冲区的异步读取。
 */
class ChromeMessageReader {
  private buffer = Buffer.alloc(0)
  private pendingResolve: ((value: string | null) => void) | null = null
  private closed = false

  constructor() {
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.tryProcessMessage()
    })

    process.stdin.on('end', () => {
      this.closed = true
      if (this.pendingResolve) {
        this.pendingResolve(null)
        this.pendingResolve = null
      }
    })

    process.stdin.on('error', () => {
      this.closed = true
      if (this.pendingResolve) {
        this.pendingResolve(null)
        this.pendingResolve = null
      }
    })
  }

  private tryProcessMessage(): void {
    if (!this.pendingResolve) {
      return
    }

    // 长度前缀至少需要 4 个字节
    if (this.buffer.length < 4) {
      return
    }

    const length = this.buffer.readUInt32LE(0)

    if (length === 0 || length > MAX_MESSAGE_SIZE) {
      log(`Invalid message length: ${length}`)
      this.pendingResolve(null)
      this.pendingResolve = null
      return
    }

    // 检查是否已收到完整消息
    if (this.buffer.length < 4 + length) {
      return // 等待更多数据
    }

    // 提取消息
    const messageBytes = this.buffer.subarray(4, 4 + length)
    this.buffer = this.buffer.subarray(4 + length)

    const message = messageBytes.toString('utf-8')
    this.pendingResolve(message)
    this.pendingResolve = null
  }

  async read(): Promise<string | null> {
    if (this.closed) {
      return null
    }

    // 检查缓冲区中是否已有完整消息
    if (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (
        length > 0 &&
        length <= MAX_MESSAGE_SIZE &&
        this.buffer.length >= 4 + length
      ) {
        const messageBytes = this.buffer.subarray(4, 4 + length)
        this.buffer = this.buffer.subarray(4 + length)
        return messageBytes.toString('utf-8')
      }
    }

    // 等待更多数据
    return new Promise(resolve => {
      this.pendingResolve = resolve
      // 防止在检查与设置 pendingResolve 之间有数据到达
      this.tryProcessMessage()
    })
  }
}
