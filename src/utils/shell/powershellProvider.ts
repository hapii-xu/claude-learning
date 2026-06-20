import { tmpdir } from 'os'
import { join } from 'path'
import { join as posixJoin } from 'path/posix'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * PowerShell 调用 flag + 命令。被 provider 的 getSpawnArgs 与
 * hooks.ts 中的 hook spawn 路径共享，保证 flag 集中维护。
 */
export function buildPowerShellArgs(cmd: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', cmd]
}

/**
 * 以 UTF-16LE 编码 base64 化字符串，供 PowerShell 的 -EncodedCommand 使用。
 * 与 parser 使用的编码一致（parser.ts 的 toUtf16LeBase64）。输出只包含
 * [A-Za-z0-9+/=] — 能穿过任何 shell 引用层，包括
 * @anthropic-ai/sandbox-runtime 的 shellquote.quote()，否则在把单引号字符串
 * 再次用双引号包裹时，会把 !$? 错改成 \!$?。Review 2964609818。
 */
function encodePowerShellCommand(psCommand: string): string {
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

export function createPowerShellProvider(shellPath: string): ShellProvider {
  let currentSandboxTmpDir: string | undefined

  return {
    type: 'powershell' as ShellProvider['type'],
    shellPath,
    detached: false,

    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        useSandbox: boolean
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      // 暂存 sandboxTmpDir，供 getEnvironmentOverrides 使用（与 bashProvider 对称）
      currentSandboxTmpDir = opts.useSandbox ? opts.sandboxTmpDir : undefined

      // sandbox 下 tmpdir() 不可写 — sandbox 只允许写入 sandboxTmpDir。
      // 把 cwd 跟踪文件放到那里，内部的 pwsh 才能真正写入。仅适用于
      // Linux/macOS/WSL2；原生 Windows 从不启用 sandbox，因此该分支是死代码。
      const cwdFilePath =
        opts.useSandbox && opts.sandboxTmpDir
          ? posixJoin(opts.sandboxTmpDir, `claude-pwd-ps-${opts.id}`)
          : join(tmpdir(), `claude-pwd-ps-${opts.id}`)
      const escapedCwdFilePath = cwdFilePath.replace(/'/g, "''")
      // 退出码捕获：如果有原生 exe 运行过，优先使用 $LASTEXITCODE。
      // 在 PS 5.1 上，原生命令在 stderr 被 PS 重定向时（例如
      // `git push 2>&1`），即使 exe 返回 exit 0 也会把 $? 置为 $false —
      // 因此 `if (!$?)` 会误报失败。$LASTEXITCODE 只有在当前 session 中
      // 未运行任何原生 exe 时才为 $null；此时回退到 $? 以处理纯 cmdlet
      // 管道。代价：`native-ok; cmdlet-fail` 现在返回 0（原来是 1）；
      // 反过来也一样：`native-fail; cmdlet-ok` 现在返回 native 退出码
      // （原来是 0 — 旧逻辑只看 $?，而尾部 cmdlet 把它设成了 true）。
      // 这两种组合都比 git/npm/curl 的 stderr 场景少见。
      const cwdTracking = `\n; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n; (Get-Location).Path | Out-File -FilePath '${escapedCwdFilePath}' -Encoding utf8 -NoNewline\n; exit $_ec`
      const psCommand = command + cwdTracking

      // sandbox 把返回的 commandString 包装成 `<binShell> -c '<cmd>'` —
      // `-c` 是硬编码的，无法注入 -NoProfile -NonInteractive。因此 sandbox
      // 路径下要构建一个自身就调用 pwsh 并带上完整 flag 的命令。Shell.ts
      // 把 /bin/sh 作为 sandbox 的 binShell，最终效果是：
      // bwrap ... sh -c 'pwsh -NoProfile ... -EncodedCommand ...'。
      // 非 sandbox 路径直接返回纯 PS 命令；getSpawnArgs() 通过
      // buildPowerShellArgs() 补上 flag。
      //
      // 使用 -EncodedCommand（base64 UTF-16LE）而不是 -Command：sandbox
      // runtime 会在我们构建的命令之上再套一层自己的 shellquote.quote()。
      // 任何包含 ' 的字符串都会触发双引号模式，把 ! 转义为 \! — POSIX sh
      // 会原样保留，pwsh 解析报错。base64 只包含 [A-Za-z0-9+/=] —
      // 没有任何字符能被引用层破坏。Review 2964609818。
      //
      // shellPath 用 POSIX 单引号包裹，这样包含空格的安装路径（例如
      // /opt/my tools/pwsh）才能穿过内部 `/bin/sh -c` 的分词。
      // flag 和 base64 只包含 [A-Za-z0-9+/=-] — 无需引用。
      const commandString = opts.useSandbox
        ? [
            `'${shellPath.replace(/'/g, `'\\''`)}'`,
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            encodePowerShellCommand(psCommand),
          ].join(' ')
        : psCommand

      return { commandString, cwdFilePath }
    },

    getSpawnArgs(commandString: string): string[] {
      return buildPowerShellArgs(commandString)
    },

    async getEnvironmentOverrides(): Promise<Record<string, string>> {
      const env: Record<string, string> = {}
      // 应用通过 /env 设置的 session 环境变量（仅作用于子进程，不影响
      // REPL）。如果不这样做，`/env PATH=...` 会影响 Bash 工具命令，
      // 但不会影响 PowerShell — 导致 PATH 被精简的 PyCharm 用户无法自救。
      // 顺序：先设置 session 变量，这样下面的 sandbox TMPDIR 才不会被
      // `/env TMPDIR=...` 覆盖。bashProvider.ts 中的顺序相反（历史遗留），
      // 但 sandbox 隔离应当优先。
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      if (currentSandboxTmpDir) {
        // Linux/macOS 上的 PowerShell 会读取 TMPDIR 作为 [System.IO.Path]::GetTempPath() 的结果
        env.TMPDIR = currentSandboxTmpDir
        env.CLAUDE_CODE_TMPDIR = currentSandboxTmpDir
      }
      return env
    },
  }
}
