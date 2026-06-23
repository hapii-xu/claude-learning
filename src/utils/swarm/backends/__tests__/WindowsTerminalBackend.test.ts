import { mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { WindowsTerminalBackend } from '../WindowsTerminalBackend'

type Call = { command: string; args: string[] }

let tempDir: string

beforeEach(async () => {
  tempDir = join(
    tmpdir(),
    `windows-terminal-backend-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  await mkdir(tempDir, { recursive: true })
  process.env.CLAUDE_WT_PANE_TIMEOUT_MS = '2000'
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
  delete process.env.CLAUDE_WT_PANE_TIMEOUT_MS
})

function createBackend(
  calls: Call[],
  opts: { simulatePidWrite?: boolean | number } = {},
): WindowsTerminalBackend {
  const simulate = opts.simulatePidWrite !== false
  const delayMs =
    typeof opts.simulatePidWrite === 'number' ? opts.simulatePidWrite : 30
  return new WindowsTerminalBackend({
    runCommand: async (command, args) => {
      calls.push({ command, args })
      if (simulate && command === 'wt.exe') {
        const encIdx = args.indexOf('-EncodedCommand')
        if (encIdx >= 0) {
          const decoded = Buffer.from(args[encIdx + 1]!, 'base64').toString(
            'utf16le',
          )
          const match = decoded.match(/Set-Content -LiteralPath '([^']+)'/)
          if (match) {
            setTimeout(() => {
              writeFile(match[1]!, '54321', 'utf-8').catch(() => {})
            }, delayMs)
          }
        }
      }
      return { stdout: 'ok', stderr: '', code: 0 }
    },
    getPlatform: () => 'windows',
    pidFileDir: tempDir,
  })
}

function decodeEncodedCommand(call: Call): {
  args: string[]
  decodedLauncher: string
} {
  expect(call.command).toBe('wt.exe')
  const encIdx = call.args.indexOf('-EncodedCommand')
  expect(encIdx).toBeGreaterThanOrEqual(0)
  const encoded = call.args[encIdx + 1]!
  const decodedLauncher = Buffer.from(encoded, 'base64').toString('utf16le')
  return { args: call.args, decodedLauncher }
}

describe('WindowsTerminalBackend', () => {
  test('launches split panes through wt.exe with a wrapped PowerShell command', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls)
    const pane = await backend.createTeammatePaneInSwarmView('worker', 'blue')

    await backend.sendCommandToPane(
      pane.paneId,
      "Set-Location -LiteralPath 'C:\\repo'; & 'claude.exe' '--agent-id' 'worker@alpha'",
    )

    expect(calls).toHaveLength(1)
    const { args, decodedLauncher } = decodeEncodedCommand(calls[0]!)
    expect(args).toContain('split-pane')
    expect(args).toContain('--vertical')
    expect(args).toContain('--title')
    expect(args).toContain('worker')
    expect(decodedLauncher).toContain('Set-Content -LiteralPath')
    expect(decodedLauncher).toContain('claude.exe')
  })

  test('preserves use_splitpane false as a separate Windows Terminal window', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls)
    const pane = await backend.createTeammateWindowInSwarmView(
      'reviewer',
      'cyan',
    )

    await backend.sendCommandToPane(pane.paneId, "Write-Output 'hello'")

    expect(pane.windowName).toBe('teammate-reviewer')
    const { args } = decodeEncodedCommand(calls[0]!)
    expect(args.join(' ')).toContain('-w -1 new-tab --title')
  })

  test('force kills the cached pid from sendCommandToPane without reading pidFile', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls)
    const pane = await backend.createTeammatePaneInSwarmView('killer', 'red')

    // sendCommandToPane 执行完毕 — 模拟向 pidFile 写入 '54321'，
    // 成为 pane.pid。killPane 应使用缓存的 pid，而不是重新读取文件。
    await backend.sendCommandToPane(pane.paneId, "Write-Output 'running'")

    const killed = await backend.killPane(pane.paneId)

    expect(killed).toBe(true)
    expect(calls[calls.length - 1]!.command).toBe('powershell.exe')
    expect(calls[calls.length - 1]!.args.join(' ')).toContain(
      'Stop-Process -Id 54321',
    )
  })

  test('throws a diagnostic error when pidFile never appears within timeout', async () => {
    process.env.CLAUDE_WT_PANE_TIMEOUT_MS = '300'
    const calls: Call[] = []
    const backend = createBackend(calls, { simulatePidWrite: false })
    const pane = await backend.createTeammatePaneInSwarmView('slowpane', 'blue')
    let caught: unknown
    try {
      await backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(
      /Windows Terminal pane failed to launch within 300ms/,
    )
  })

  test('error message includes paneId pidFile and override hint', async () => {
    process.env.CLAUDE_WT_PANE_TIMEOUT_MS = '250'
    const calls: Call[] = []
    const backend = createBackend(calls, { simulatePidWrite: false })
    const pane = await backend.createTeammatePaneInSwarmView(
      'diagpane',
      'green',
    )
    let caught: unknown
    try {
      await backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    const msg = (caught as Error).message
    expect(msg).toContain(pane.paneId)
    expect(msg).toContain('CLAUDE_WT_PANE_TIMEOUT_MS')
  })

  test('unlinks stale pidFile so a stale pid is not adopted', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls, { simulatePidWrite: 30 })
    const pane = await backend.createTeammatePaneInSwarmView('stale', 'pink')
    // pidFile 路径是确定性的：<tempDir>/<sanitized paneId>.pid
    const stalePidFile = join(
      tempDir,
      `${pane.paneId.replace(/[^a-zA-Z0-9_-]/g, '-')}.pid`,
    )
    // 预填充过期内容。如果 sendCommandToPane 没有 unlink，waitForPidFile
    // 会立即接受 '99999' 并缓存为 pane.pid。经过 unlink 后，
    // simulate 的 '54321' 才是 killPane 看到的值。
    await writeFile(stalePidFile, '99999', 'utf-8')

    await backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")
    const killed = await backend.killPane(pane.paneId)
    expect(killed).toBe(true)
    expect(calls[calls.length - 1]!.args.join(' ')).toContain(
      'Stop-Process -Id 54321',
    )
  })

  test('rejects re-spawn on a ready pane', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls)
    const pane = await backend.createTeammatePaneInSwarmView('reentry', 'cyan')
    await backend.sendCommandToPane(pane.paneId, "Write-Output 'first'")
    // 此时 pane.status === 'ready'。第二次 sendCommandToPane 必须抛出异常。
    let caught: unknown
    try {
      await backend.sendCommandToPane(pane.paneId, "Write-Output 'second'")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/already spawned/)
  })

  test('throws on unknown paneId in sendCommandToPane', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls)
    let caught: unknown
    try {
      await backend.sendCommandToPane('wt-nonexistent', "Write-Output 'x'")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('Unknown Windows Terminal pane')
  })

  test('rejects corrupted pidFile content ("123abc") and times out', async () => {
    process.env.CLAUDE_WT_PANE_TIMEOUT_MS = '400'
    const calls: Call[] = []
    // 自定义 runner 写入无效的 pid 内容（不全是数字）。
    const backend = new WindowsTerminalBackend({
      runCommand: async (command, args) => {
        calls.push({ command, args })
        if (command === 'wt.exe') {
          const encIdx = args.indexOf('-EncodedCommand')
          if (encIdx >= 0) {
            const decoded = Buffer.from(args[encIdx + 1]!, 'base64').toString(
              'utf16le',
            )
            const match = decoded.match(/Set-Content -LiteralPath '([^']+)'/)
            if (match) {
              setTimeout(() => {
                writeFile(match[1]!, '123abc', 'utf-8').catch(() => {})
              }, 30)
            }
          }
        }
        return { stdout: 'ok', stderr: '', code: 0 }
      },
      getPlatform: () => 'windows',
      pidFileDir: tempDir,
    })
    const pane = await backend.createTeammatePaneInSwarmView('corrupt', 'red')
    let caught: unknown
    try {
      await backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    // waitForPidFile 的内部错误必须传递到包装后的诊断消息中。
    const msg = (caught as Error).message
    expect(msg).toMatch(/failed to launch within 400ms/)
    expect(msg).toMatch(/not a valid pid|invalid pid|123abc/)
  })

  test('killPane awaits in-flight spawn before killing (kill-while-spawn race)', async () => {
    // simulatePidWrite: 800ms — sendCommandToPane 在 waitForPidFile 中停留约 800ms。
    process.env.CLAUDE_WT_PANE_TIMEOUT_MS = '3000'
    const calls: Call[] = []
    const backend = createBackend(calls, { simulatePidWrite: 800 })
    const pane = await backend.createTeammatePaneInSwarmView('racy', 'blue')

    // 启动 spawn 但先不 await 它。
    const spawnP = backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")
    // 50ms 后，调用 killPane — 此时 pane 仍处于 'spawning' 状态，killPane 必须
    // await spawnPromise（在 simulate 于 ~800ms 时写入 pid 54321 后 resolve），
    // 然后使用缓存的 pid 执行 kill。
    await new Promise(r => setTimeout(r, 50))
    const killP = backend.killPane(pane.paneId)

    // 两者都必须正常 resolve。
    await spawnP
    const killed = await killP
    expect(killed).toBe(true)
    // kill 必须针对刚启动的 pid（54321），不能使用
    // 过期或缺失的回退路径。
    const killCall = calls[calls.length - 1]!
    expect(killCall.command).toBe('powershell.exe')
    expect(killCall.args.join(' ')).toContain('Stop-Process -Id 54321')
  })

  test('Stop-Process failure clears cached pid and marks pane dead', async () => {
    const calls: Call[] = []
    // Runner 仅对 powershell.exe（kill）返回 code 1；wt.exe 成功。
    const backend = new WindowsTerminalBackend({
      runCommand: async (command, args) => {
        calls.push({ command, args })
        if (command === 'wt.exe') {
          const encIdx = args.indexOf('-EncodedCommand')
          if (encIdx >= 0) {
            const decoded = Buffer.from(args[encIdx + 1]!, 'base64').toString(
              'utf16le',
            )
            const match = decoded.match(/Set-Content -LiteralPath '([^']+)'/)
            if (match) {
              setTimeout(() => {
                writeFile(match[1]!, '54321', 'utf-8').catch(() => {})
              }, 30)
            }
          }
          return { stdout: 'ok', stderr: '', code: 0 }
        }
        // powershell Stop-Process 失败
        return { stdout: '', stderr: 'access denied', code: 1 }
      },
      getPlatform: () => 'windows',
      pidFileDir: tempDir,
    })
    const pane = await backend.createTeammatePaneInSwarmView('dier', 'orange')
    await backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")

    const killed = await backend.killPane(pane.paneId)
    expect(killed).toBe(false) // Stop-Process 退出码 1 → false

    // kill 失败后，pane 从 map 中移除：第二次 killPane → false（非重试）。
    const killedAgain = await backend.killPane(pane.paneId)
    expect(killedAgain).toBe(false)
    // 关键：只发生了一次 powershell 调用 — 第二次 killPane 返回 false
    // 是因为 "pane 不在 map 中"，而非另一次 Stop-Process 尝试。
    const psCalls = calls.filter(c => c.command === 'powershell.exe')
    expect(psCalls.length).toBe(1)
  })

  test('killPane uses cached pid and returns false when pane is unknown', async () => {
    const calls: Call[] = []
    const backend = createBackend(calls, { simulatePidWrite: 30 })
    const pane = await backend.createTeammatePaneInSwarmView('cached', 'yellow')
    await backend.sendCommandToPane(pane.paneId, "Write-Output 'x'")

    // sendCommandToPane 之后，pane.pid = 54321（来自 simulate）。killPane 必须
    // 使用此缓存的 pid，完全不读取 pidFile。
    const killed = await backend.killPane(pane.paneId)
    expect(killed).toBe(true)
    expect(calls[calls.length - 1]!.args.join(' ')).toContain(
      'Stop-Process -Id 54321',
    )

    // kill 之后，pane 被移除 — 第二次 killPane 必须返回 false。
    const killedAgain = await backend.killPane(pane.paneId)
    expect(killedAgain).toBe(false)
  })
})
