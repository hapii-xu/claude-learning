import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { WORKFLOW_RUNS_DIR } from '../constants.js'

/**
 * 将内联 workflow 脚本持久化到运行目录，使调用方能通过 `scriptPath` + `resumeFromRunId` 迭代，
 * 无需重传完整脚本（ultracode skill 为内联入口路径承诺的往返优化）。
 *
 * 与 engine/journal.ts 对称：通过 node:fs/promises 直接写入（无 port）到
 * `<cwd>/<WORKFLOW_RUNS_DIR>/<runId>/script.js` —— 与 journal.jsonl 同目录，
 * 因此 journalStore.truncate(runId) 会随 journal 一并清理。
 *
 * 固定文件名 `script.js`：parseScript 忽略扩展名，runId 已使目录唯一，
 * 稳定命名有助于肌肉记忆。
 */
export async function persistInlineScript(
  script: string,
  runId: string,
  cwd: string,
): Promise<string> {
  const dir = join(cwd, WORKFLOW_RUNS_DIR, runId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, 'script.js')
  await writeFile(filePath, script, 'utf-8')
  return filePath
}
