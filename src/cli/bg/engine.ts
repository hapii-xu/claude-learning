/**
 * BgEngine — 跨平台后台会话引擎抽象。
 *
 * 实现：
 *   TmuxEngine    — 安装了 tmux 的 macOS/Linux
 *   DetachedEngine — Windows，或未安装 tmux 的 macOS/Linux（兜底方案）
 */

export interface SessionEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind: string
  name?: string
  logPath?: string
  entrypoint?: string
  status?: string
  waitingFor?: string
  updatedAt?: number
  bridgeSessionId?: string
  agent?: string
  tmuxSessionName?: string
  engine?: 'tmux' | 'detached'
}

export interface BgStartOptions {
  sessionName: string
  args: string[]
  env: Record<string, string | undefined>
  logPath: string
  cwd: string
}

export interface BgStartResult {
  pid: number
  sessionName: string
  logPath: string
  engineUsed: 'tmux' | 'detached'
}

export interface BgEngine {
  readonly name: 'tmux' | 'detached'
  /** 该引擎是否提供 TTY 以支持交互式 REPL 输入。 */
  readonly supportsInteractiveInput: boolean
  available(): Promise<boolean>
  start(opts: BgStartOptions): Promise<BgStartResult>
  attach(session: SessionEntry): Promise<void>
}
