/**
 * prefetch.test.ts
 *
 * 轻量子进程包装器，在隔离的 bun:test 进程中运行真正的测试。
 * 这样可以防止本文件对 toolIndex.js 的 mock.module() 泄漏到
 * 其他测试文件（如 toolIndex.test.ts）中。
 */

import { describe, test, expect } from 'bun:test'
import { resolve, relative } from 'path'

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const RUNNER_ABS = resolve(__dirname, 'prefetch.runner.ts')
const RUNNER_REL = './' + relative(PROJECT_ROOT, RUNNER_ABS).replace(/\\/g, '/')

describe('prefetch', () => {
  test('runs all prefetch tests in isolated subprocess', async () => {
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
        `prefetch test subprocess failed (exit ${code}):\n${output}`,
      )
    }
  }, 60_000)
})
