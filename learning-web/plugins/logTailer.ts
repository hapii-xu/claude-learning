import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 日志 tail 实现（tail -f 风格 SSE 流）
 * 支持白名单日志路径
 */

interface LogSource {
  id: string
  label: string
  path: string
}

/**
 * 白名单日志源
 */
const LOG_SOURCES: LogSource[] = [
  {
    id: 'claude-debug',
    label: 'Claude Debug Log',
    path: path.join(os.homedir(), '.hclaude', 'debug', 'latest'),
  },
  {
    id: 'claude-config',
    label: 'Claude Config',
    path: path.join(os.homedir(), '.hclaude', 'config.json'),
  },
]

// 活跃的 tail 连接
const activeTails = new Map<string, { watcher: fs.FSWatcher; offset: number }>()

function resolveLogPath(sourceId: string): string | null {
  const source = LOG_SOURCES.find(s => s.id === sourceId)
  if (!source) return null

  const resolved = source.path
  // 安全检查：只允许 ~/.hclaude/ 子树
  const claudeDir = path.join(os.homedir(), '.hclaude')
  if (!resolved.startsWith(claudeDir)) return null

  return resolved
}

export function handleLogsList(_req: IncomingMessage, res: ServerResponse) {
  // 返回可用的日志源列表（附带文件存在状态）
  const sources = LOG_SOURCES.map(s => {
    let exists = false
    let size = 0
    try {
      const stat = fs.statSync(s.path)
      exists = stat.isFile()
      size = stat.size
    } catch {
      exists = false
    }
    return { ...s, exists, size }
  })

  // 额外扫描 ~/.hclaude/errors/ 目录
  const errorsDir = path.join(os.homedir(), '.hclaude', 'errors')
  try {
    if (fs.existsSync(errorsDir)) {
      const files = fs
        .readdirSync(errorsDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 20)

      for (const file of files) {
        const filePath = path.join(errorsDir, file)
        try {
          const stat = fs.statSync(filePath)
          sources.push({
            id: `error:${file}`,
            label: `Error Log: ${file}`,
            path: filePath,
            exists: true,
            size: stat.size,
          })
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ sources }))
}

export function handleLogsTail(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const sourceId = url.searchParams.get('source')

  if (!sourceId) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'Missing source parameter' }))
    return
  }

  // 处理 error:filename 形式
  let logPath: string | null
  if (sourceId.startsWith('error:')) {
    const filename = sourceId.slice(6)
    const errorsDir = path.join(os.homedir(), '.hclaude', 'errors')
    logPath = path.join(errorsDir, filename)
    // 安全检查
    if (!logPath.startsWith(errorsDir)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: 'Invalid error log path' }))
      return
    }
  } else {
    logPath = resolveLogPath(sourceId)
  }

  if (!logPath) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'Unknown log source' }))
    return
  }

  if (!fs.existsSync(logPath)) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'Log file does not exist', path: logPath }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    retry: '86400000',
  })

  // 读取现有内容（最后 200 行）
  try {
    const content = fs.readFileSync(logPath, 'utf-8')
    const lines = content.split('\n')
    const tailLines = lines.slice(-200)
    for (const line of tailLines) {
      if (line) {
        res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`)
      }
    }
  } catch {
    // skip
  }

  // 发送初始标记
  res.write(`event: ready\ndata: ${JSON.stringify({ path: logPath })}\n\n`)

  // 开始监听文件变化
  let offset = 0
  try {
    const stat = fs.statSync(logPath)
    offset = stat.size
  } catch {
    // skip
  }

  const pollInterval = setInterval(() => {
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > offset) {
        const stream = fs.createReadStream(logPath, {
          start: offset,
          encoding: 'utf-8',
        })
        let data = ''
        stream.on('data', chunk => {
          data += chunk
        })
        stream.on('end', () => {
          offset = stat.size
          for (const line of data.split('\n')) {
            if (line) {
              res.write(`event: line\ndata: ${JSON.stringify(line)}\n\n`)
            }
          }
        })
      } else if (stat.size < offset) {
        // 文件被截断（日志轮转）
        offset = 0
        res.write(
          `event: rotated\ndata: ${JSON.stringify({ path: logPath })}\n\n`,
        )
      }
    } catch {
      // 文件可能被删除
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: 'Log file unavailable' })}\n\n`,
      )
    }
  }, 1000)

  // 10 分钟超时
  const timeout = setTimeout(
    () => {
      res.write(
        `event: timeout\ndata: ${JSON.stringify({ message: 'Connection timed out' })}\n\n`,
      )
      res.end()
    },
    10 * 60 * 1000,
  )

  req.on('close', () => {
    clearInterval(pollInterval)
    clearTimeout(timeout)
  })
}
