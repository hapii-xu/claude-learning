/**
 * Remote Control bridge 诊断的基于文件的调试日志器。
 * 将 [RC-DEBUG] 行写入 ~/.claude/rc-debug.log，使其能在
 * REPL / bridge UI 中 Ink 的 stdout 捕获后留存。
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOG_PATH = join(homedir(), '.claude', 'rc-debug.log')

function ensureLogDir() {
  const dir = join(homedir(), '.claude')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

let headerWritten = false

export function rcLog(msg: string): void {
  try {
    if (!headerWritten) {
      ensureLogDir()
      appendFileSync(
        LOG_PATH,
        `\n===== RC-DEBUG session ${new Date().toISOString()} =====\n`,
      )
      headerWritten = true
    }
    const ts = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
    appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`)
  } catch {
    // 尽力而为 —— 绝不让 bridge 崩溃
  }
}

/** 在会话开始时清空日志文件。 */
export function rcLogClear(): void {
  try {
    ensureLogDir()
    appendFileSync(LOG_PATH, '')
  } catch {}
}
