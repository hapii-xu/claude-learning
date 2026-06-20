import { spawnSync } from 'child_process'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { buildCliLaunch, quoteCliLaunch } from '../../../utils/cliLaunch.js'
import type {
  BgEngine,
  BgStartOptions,
  BgStartResult,
  SessionEntry,
} from '../engine.js'

export class TmuxEngine implements BgEngine {
  readonly name = 'tmux' as const
  readonly supportsInteractiveInput = true

  async available(): Promise<boolean> {
    const { code } = await execFileNoThrow('tmux', ['-V'], { useCwd: false })
    return code === 0
  }

  async start(opts: BgStartOptions): Promise<BgStartResult> {
    const launch = buildCliLaunch(opts.args, {
      env: {
        ...opts.env,
        CLAUDE_CODE_SESSION_KIND: 'bg',
        CLAUDE_CODE_SESSION_NAME: opts.sessionName,
        CLAUDE_CODE_SESSION_LOG: opts.logPath,
        CLAUDE_CODE_TMUX_SESSION: opts.sessionName,
      } as NodeJS.ProcessEnv,
    })

    const cmd = quoteCliLaunch(launch)

    const result = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', opts.sessionName, cmd],
      { stdio: 'inherit', env: launch.env },
    )

    if (result.status !== 0) {
      throw new Error('Failed to create tmux session.')
    }

    // tmux 不会直接上报子进程 PID；这里返回 0。
    // 实际的会话进程会自行写入自己的 PID 文件。
    return {
      pid: 0,
      sessionName: opts.sessionName,
      logPath: opts.logPath,
      engineUsed: 'tmux',
    }
  }

  async attach(session: SessionEntry): Promise<void> {
    if (!session.tmuxSessionName) {
      throw new Error(`Session ${session.sessionId} has no tmux session name.`)
    }

    const result = spawnSync(
      'tmux',
      ['attach-session', '-t', session.tmuxSessionName],
      { stdio: 'inherit' },
    )

    if (result.status !== 0) {
      throw new Error(
        `Failed to attach to tmux session '${session.tmuxSessionName}'.`,
      )
    }
  }
}
