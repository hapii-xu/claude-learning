// autofix-pr 的 gh CLI 集成：抓取 PR 快照并送进 prOutcomeCheck.ts 中的
// 纯决策矩阵。单独抽出，是为了让决策矩阵的测试不必 mock node:child_process ——
// 同时让 callAutofixPr 的测试可以只 mock 本模块，而不污染纯决策矩阵模块
// （Bun 的 mock.module 是进程级生效的）。

import { spawn } from 'node:child_process'
import {
  type AutofixOutcomeProbeResult,
  type PrViewPayload,
  summariseAutofixOutcome,
} from './prOutcomeCheck.js'

export interface AutofixOutcomeProbeInput {
  owner: string
  repo: string
  prNumber: number
  /**
   * /autofix-pr 启动时记录的 head commit SHA。当它与当前 head 不同时，
   * 说明 autofix 至少 push 了一个 commit。
   */
  initialHeadSha?: string
  /**
   * gh CLI 调用的超时时间。调用方是框架的逐 tick 轮询器，因此失败必须有上界 ——
   * 挂起的 gh 进程会拖住整个轮询循环。
   */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * 抓取 PR 当前的 head SHA、state 和 CI rollup，并判定 autofix 是否结束。
 * 完成则返回 `{ completed: true, summary }`，否则返回 `{ completed: false }`。
 * 永不抛错。
 */
export async function checkPrAutofixOutcome(
  input: AutofixOutcomeProbeInput,
): Promise<AutofixOutcomeProbeResult> {
  const { owner, repo, prNumber, initialHeadSha, timeoutMs } = input

  let payload: PrViewPayload
  try {
    payload = await runGhPrView(
      owner,
      repo,
      prNumber,
      timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
  } catch {
    return { completed: false }
  }

  return summariseAutofixOutcome(payload, {
    owner,
    repo,
    prNumber,
    initialHeadSha,
  })
}

/**
 * 获取 PR 当前的 head commit SHA。用于 /autofix-pr 启动时抓取 baseline，
 * 后续会与实时 SHA 对比以检测是否发生 push。任何失败（网络、缺少 gh、
 * 权限）都返回 null —— 调用方把 null 视作「无 baseline」，回退到只依据
 * 终态判定完成。
 */
export async function fetchPrHeadSha(
  owner: string,
  repo: string,
  prNumber: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const payload = await runGhPrView(owner, repo, prNumber, timeoutMs)
    return payload.headRefOid || null
  } catch {
    return null
  }
}

interface SpawnError extends Error {
  code?: string
}

/**
 * 启动 `gh pr view {n} --repo {owner}/{repo} --json ...` 并解析结果。
 * 非零退出、超时或 JSON 解析失败时 reject。
 */
function runGhPrView(
  owner: string,
  repo: string,
  prNumber: number,
  timeoutMs: number,
): Promise<PrViewPayload> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,state,statusCheckRollup',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill('SIGKILL')
      reject(new Error(`gh pr view timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout.on('data', chunk => stdoutChunks.push(chunk as Buffer))
    proc.stderr.on('data', chunk => stderrChunks.push(chunk as Buffer))

    proc.on('error', (err: SpawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    proc.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
        reject(
          new Error(`gh pr view exited ${code}: ${stderr || '<no stderr>'}`),
        )
        return
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      try {
        const parsed = JSON.parse(stdout) as PrViewPayload
        resolve(parsed)
      } catch (e) {
        reject(
          new Error(`gh pr view JSON parse failed: ${(e as Error).message}`),
        )
      }
    })
  })
}
