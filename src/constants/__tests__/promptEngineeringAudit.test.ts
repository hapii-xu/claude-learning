/**
 * promptEngineeringAudit.test.ts
 *
 * 轻量的子进程包装器，在隔离的 bun:test 进程中运行真实的审计。
 * 这样可以避免 runner 中的 30+ 个 mock.module() 调用
 * 泄漏到同一 bun test 批次中的其他测试文件里。
 */

import { describe, test, expect } from 'bun:test'
import { resolve, relative } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, '..', 'promptEngineeringAudit.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('Opus 4.7 Prompt Engineering Audit', () => {
  test('runs 64 audit checks in isolated subprocess', async () => {
    const proc = Bun.spawn(['bun', 'test', RUNNER_REL], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      const output = (stderr + '\n' + stdout).slice(-3000)
      throw new Error(
        `Prompt audit subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
