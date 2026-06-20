import { spawn } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 白名单命令执行器
 * 只允许运行预定义的命令，所有参数走 args[]，不传 shell: true
 */

type AllowedCmd =
  | 'test:file'
  | 'test:all'
  | 'typecheck'
  | 'lint'
  | 'precheck'
  | 'health'

interface ActiveExec {
  execId: string
  cmd: AllowedCmd
  process: ReturnType<typeof spawn>
  stdout: string[]
  stderr: string[]
  exitCode: number | null
  startedAt: number
}

const activeExecs = new Map<string, ActiveExec>()

/**
 * 白名单命令定义
 */
function buildCommand(
  cmd: AllowedCmd,
  args: { path?: string },
): { command: string; cmdArgs: string[] } | null {
  switch (cmd) {
    case 'test:file': {
      if (!args.path) return null
      // 安全检查
      if (args.path.includes('..') || args.path.includes('\0')) return null
      return { command: 'bun', cmdArgs: ['test', args.path] }
    }
    case 'test:all':
      return { command: 'bun', cmdArgs: ['test'] }
    case 'typecheck':
      return { command: 'bun', cmdArgs: ['run', 'tsc', '--noEmit'] }
    case 'lint':
      return { command: 'bun', cmdArgs: ['run', 'lint'] }
    case 'precheck':
      return { command: 'bun', cmdArgs: ['run', 'precheck'] }
    case 'health':
      return { command: 'bun', cmdArgs: ['run', 'health'] }
    default:
      return null
  }
}

/**
 * 执行白名单命令
 * 返回 execId 用于 SSE 流订阅
 */
export function runCommand(
  cmd: AllowedCmd,
  args: { path?: string },
  projectRoot: string,
): { execId: string; error?: string } {
  const built = buildCommand(cmd, args)
  if (!built) {
    return {
      execId: '',
      error: 'Invalid command or missing required arguments',
    }
  }

  // 路径安全校验
  if (args.path) {
    const resolved = path.resolve(projectRoot, args.path)
    if (!resolved.startsWith(projectRoot)) {
      return { execId: '', error: 'Path escapes project root' }
    }
  }

  const execId = crypto.randomBytes(8).toString('hex')

  const child = spawn(built.command, built.cmdArgs, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })

  const exec: ActiveExec = {
    execId,
    cmd,
    process: child,
    stdout: [],
    stderr: [],
    exitCode: null,
    startedAt: Date.now(),
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    exec.stdout.push(text)
    // 推送到 SSE 监听者
    notifySSE(execId, 'stdout', text)
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    exec.stderr.push(text)
    notifySSE(execId, 'stderr', text)
  })

  child.on('exit', code => {
    exec.exitCode = code
    notifySSE(execId, 'exit', JSON.stringify({ code }))
    // 5 分钟后清理
    setTimeout(() => activeExecs.delete(execId), 5 * 60 * 1000)
  })

  child.on('error', err => {
    exec.exitCode = -1
    notifySSE(execId, 'stderr', `Spawn error: ${err.message}`)
    notifySSE(execId, 'exit', JSON.stringify({ code: -1 }))
    setTimeout(() => activeExecs.delete(execId), 5 * 60 * 1000)
  })

  activeExecs.set(execId, exec)

  // 10 分钟超时
  setTimeout(
    () => {
      if (exec.exitCode === null) {
        child.kill('SIGTERM')
        exec.exitCode = -1
        notifySSE(
          execId,
          'exit',
          JSON.stringify({ code: -1, reason: 'timeout' }),
        )
      }
    },
    10 * 60 * 1000,
  )

  return { execId }
}

/**
 * 取消正在执行的命令
 */
export function cancelExec(execId: string): boolean {
  const exec = activeExecs.get(execId)
  if (!exec || exec.exitCode !== null) return false
  exec.process.kill('SIGTERM')
  return true
}

// ─── SSE 管理 ───

type SSEListener = (event: string, data: string) => void

const sseListeners = new Map<string, Set<SSEListener>>()

function notifySSE(execId: string, event: string, data: string) {
  const listeners = sseListeners.get(execId)
  if (!listeners) return
  for (const listener of listeners) {
    listener(event, data)
  }
}

export function subscribeSSE(
  execId: string,
  listener: SSEListener,
): () => void {
  if (!sseListeners.has(execId)) {
    sseListeners.set(execId, new Set())
  }
  sseListeners.get(execId)!.add(listener)

  // 如果执行已经结束，发送缓存的结果
  const exec = activeExecs.get(execId)
  if (exec && exec.exitCode !== null) {
    for (const chunk of exec.stdout) listener('stdout', chunk)
    for (const chunk of exec.stderr) listener('stderr', chunk)
    listener('exit', JSON.stringify({ code: exec.exitCode }))
  }

  return () => {
    sseListeners.get(execId)?.delete(listener)
  }
}

// ─── HTTP handlers ───

export function handleExecRun(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
) {
  let body = ''
  req.on('data', chunk => {
    body += chunk
  })
  req.on('end', () => {
    try {
      const { cmd, args } = JSON.parse(body)
      if (
        !cmd ||
        ![
          'test:file',
          'test:all',
          'typecheck',
          'lint',
          'precheck',
          'health',
        ].includes(cmd)
      ) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid command' }))
        return
      }

      const result = runCommand(cmd, args || {}, projectRoot)
      if (result.error) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: result.error }))
        return
      }

      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ execId: result.execId }))
    } catch {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    }
  })
}

export function handleExecStream(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const execId = url.searchParams.get('execId')

  if (!execId) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'Missing execId' }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    retry: '86400000',
  })

  const unsubscribe = subscribeSSE(execId, (event, data) => {
    // 按行分割推送（避免大块数据）
    const lines = data.split('\n')
    for (const line of lines) {
      if (line) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(line)}\n\n`)
      }
    }
  })

  req.on('close', () => {
    unsubscribe()
  })
}

export function handleExecCancel(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const execId = url.searchParams.get('execId')

  if (!execId) {
    res.statusCode = 400
    res.end(JSON.stringify({ error: 'Missing execId' }))
    return
  }

  const cancelled = cancelExec(execId)
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ cancelled }))
}

export const ALLOWED_COMMANDS = [
  {
    id: 'test:file',
    label: '运行单文件测试',
    description: 'bun test <path>',
    icon: 'TestTube',
    needsPath: true,
  },
  {
    id: 'test:all',
    label: '运行全部测试',
    description: 'bun test',
    icon: 'TestTube2',
    needsPath: false,
  },
  {
    id: 'typecheck',
    label: '类型检查',
    description: 'tsc --noEmit',
    icon: 'ShieldCheck',
    needsPath: false,
  },
  {
    id: 'lint',
    label: 'Lint 检查',
    description: 'biome check',
    icon: 'FileCheck',
    needsPath: false,
  },
  {
    id: 'precheck',
    label: '完整预检',
    description: 'tsc + lint + test',
    icon: 'CheckCircle',
    needsPath: false,
  },
  {
    id: 'health',
    label: '健康检查',
    description: 'health-check script',
    icon: 'Heart',
    needsPath: false,
  },
]
