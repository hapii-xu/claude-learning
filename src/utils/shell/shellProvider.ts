export const SHELL_TYPES = ['bash', 'powershell'] as const
export type ShellType = (typeof SHELL_TYPES)[number]
export const DEFAULT_HOOK_SHELL: ShellType = 'bash'

export type ShellProvider = {
  type: ShellType
  shellPath: string
  detached: boolean

  /**
   * 构建完整的命令字符串，包含所有 shell 特定的初始化。
   * 对 bash：source snapshot、session env、禁用 extglob、eval 包装、pwd 跟踪。
   */
  buildExecCommand(
    command: string,
    opts: {
      id: number | string
      sandboxTmpDir?: string
      useSandbox: boolean
    },
  ): Promise<{ commandString: string; cwdFilePath: string }>

  /**
   * 用于 spawn 的 shell 参数（例如 bash 使用 ['-c', '-l', cmd]）。
   */
  getSpawnArgs(commandString: string): string[]

  /**
   * 该 shell 类型附加的环境变量。
   * 可能执行异步初始化（例如 bash 的 tmux socket 初始化）。
   */
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
