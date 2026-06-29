import { readFile, readdir } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'
import { WORKFLOW_SCRIPT_EXTENSIONS } from '../constants.js'
import { containsPath } from './paths.js'

type Ext = (typeof WORKFLOW_SCRIPT_EXTENSIONS)[number]

function isScriptExt(ext: string): ext is Ext {
  return (WORKFLOW_SCRIPT_EXTENSIONS as readonly string[]).includes(
    ext.toLowerCase(),
  )
}

/** 按优先级 .ts → .js → .mjs 解析命名 workflow 文件。 */
export async function resolveNamedWorkflow(
  workflowDir: string,
  name: string,
): Promise<{ path: string; content: string } | null> {
  for (const ext of WORKFLOW_SCRIPT_EXTENSIONS) {
    const p = resolve(workflowDir, name + ext)
    // 双重保障：防止上层 sanitize 遗漏的边界情况穿越到 workflowDir 外的路径
    if (!containsPath(workflowDir, p)) return null
    try {
      return { path: p, content: await readFile(p, 'utf-8') }
    } catch {
      // 尝试下一个扩展名
    }
  }
  return null
}

/** List all named workflows in the directory (excluding non-script files). */
export async function listNamedWorkflows(
  workflowDir: string,
): Promise<string[]> {
  let files: string[]
  try {
    files = await readdir(workflowDir)
  } catch {
    return []
  }
  return files
    .filter(f => isScriptExt(parse(f).ext))
    .map(f => parse(f).name)
    .sort()
}
