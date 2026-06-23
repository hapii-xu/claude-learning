import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { WORKFLOW_DIR_NAME, WORKFLOW_TOOL_NAME } from '../constants.js'
import { resolveNamedWorkflow } from '../engine/namedWorkflows.js'
import { runWorkflow } from '../engine/runWorkflow.js'
import { parseScript } from '../engine/script.js'
import { containsPath, sanitizeWorkflowName } from '../engine/paths.js'
import type { WorkflowPorts } from '../ports.js'
import type { WorkflowRunResult } from '../types.js'
import { workflowInputSchema, type WorkflowInput } from './schema.js'
import { persistInlineScript } from './persistInline.js'

/** 自包含的工具描述符（核心层用 buildTool 包装它）。不依赖核心层。*/
export type WorkflowToolDescriptor = {
  name: string
  inputSchema: z.ZodType<WorkflowInput>
  isEnabled: () => boolean
  isReadOnly: (input: WorkflowInput) => boolean
  description: () => Promise<string>
  prompt: () => Promise<string>
  renderToolUseMessage: (input: Partial<WorkflowInput>) => string
  call: (
    input: WorkflowInput,
    context: unknown,
    canUseTool: unknown,
    parentMessage: unknown,
    onProgress?: unknown,
  ) => Promise<{ data: { output: string } }>
  mapToolResultToToolResultBlockParam: (
    data: { output: string },
    toolUseId: string,
  ) => {
    tool_use_id: string
    type: 'tool_result'
    content: Array<{ type: 'text'; text: string }>
  }
}

const WORKFLOW_TOOL_PROMPT = `使用 Workflow 工具执行一个 workflow 脚本，该脚本以确定性方式编排多个 subagent。脚本在后台运行；你会立即收到 run_id，并在完成时收到通知。

通过 "script" 内联提供脚本，或通过 "name" 引用命名 workflow（从 .hclaude/workflows/ 解析），或通过 "scriptPath" 引用现有文件。将 "args" 作为真实 JSON 值（对象/数组/字符串）传递，而非字符串化的字符串。

使用 "resumeFromRunId" 恢复之前的运行——已完成的 agent() 调用会从日志中即时回放。

并发数：默认为 3（硬上限 16）。省略 maxConcurrency 则使用 3。要将 maxConcurrency 设为 3 以外的任何值，必须先通过 AskUserQuestion 询问用户——提议 3 / 6 / 9（或与扇出宽度匹配的其他档位），并将 3 标记为"（推荐）"。唯一例外：用户在本次会话中已明确指定并发数（"使用 6"、"maxConcurrency 9"）——此时直接遵从，无需重新询问。不要因为 workflow 扇出而悄悄提高并发数超过 3；3 是推荐的默认值。

脚本执行模型（常见陷阱——搞错这些是脚本报错的首要原因）：脚本是 \`new AsyncFunction\` 的函数体——不是 ESM 模块，TypeScript 也不会被转译。因此：
- 不要使用 \`import\`——\`agent\`、\`parallel\`、\`pipeline\`、\`phase\`、\`log\`、\`workflow\`、\`args\` 和 \`budget\` 作为参数注入；直接引用即可。
- 不要使用 TS 类型注解、\`interface\`、\`enum\`、\`as\` 或泛型——引擎不进行转译，即使是带类型语法的 .ts 文件也会解析失败。
- 保留恰好一个 \`export const meta = {...}\`（纯字面量），移除所有其他 \`export\` / \`export default\`。
- 用顶层 \`return\` 返回结果。
优先使用 .js / .mjs。完整 playbook 和质量模式见 /ultracode。`

export function createWorkflowTool(
  ports: WorkflowPorts,
): WorkflowToolDescriptor {
  return {
    name: WORKFLOW_TOOL_NAME,
    inputSchema: workflowInputSchema,
    // 此处没有会话级运行时启用门控："ultracode 在本会话中已开启"
    // 的信号由 harness（claude.ai/client）注入，而非保存在仓库状态中。
    // 此工具通过 src/tools.ts 中的 feature('WORKFLOW_SCRIPTS') 编译进/出；
    // 除此之外，只要工具存在就始终启用。
    isEnabled: () => true,
    isReadOnly: () => false,

    async description() {
      return '执行一个 workflow 脚本，编排多个 subagent 协作完成任务'
    },

    async prompt() {
      return WORKFLOW_TOOL_PROMPT
    },

    renderToolUseMessage(input) {
      if (input.resumeFromRunId)
        return `Workflow 恢复：${input.resumeFromRunId}`
      const id =
        input.name ?? input.scriptPath ?? (input.script ? 'inline' : 'unknown')
      return `Workflow：${id}`
    },

    async call(input, context, canUseTool, parentMessage) {
      const host = ports.hostFactory({ context, canUseTool, parentMessage })

      // 解析脚本来源
      let script: string
      let workflowFile: string | undefined
      try {
        const resolved = await resolveScriptSource(input, host.cwd)
        script = resolved.script
        workflowFile = resolved.workflowFile
      } catch (e) {
        return { data: { output: `Error: ${(e as Error).message}` } }
      }

      // 快速校验（meta + 语法）：失败时直接向模型返回错误，不进入后台
      try {
        parseScript(script)
      } catch (e) {
        return {
          data: {
            output: `Error: script validation failed: ${(e as Error).message}`,
          },
        }
      }

      const workflowName = input.name ?? input.title ?? 'workflow'
      const { runId, signal } = ports.taskRegistrar.register(
        {
          workflowName,
          ...(workflowFile ? { workflowFile } : {}),
          ...(input.description ? { summary: input.description } : {}),
          ...(host.toolUseId ? { toolUseId: host.toolUseId } : {}),
          ...(input.resumeFromRunId ? { runId: input.resumeFromRunId } : {}),
        },
        host.handle,
      )

      // 内联入口：将脚本持久化到运行目录并返回可复用路径
      //（ultracode skill 承诺的 inline → persist → edit → resubmit-as-scriptPath 迭代循环）。
      // 写入失败时降级为占位符并警告，不中止运行（脚本已在内存中）。
      if (!workflowFile && input.script) {
        try {
          workflowFile = await persistInlineScript(
            input.script,
            runId,
            host.cwd,
          )
        } catch (e) {
          ports.logger.warn?.(
            `inline script persist failed: ${(e as Error).message}`,
          )
        }
      }

      // 后台分离执行
      void runWorkflow({
        script,
        ...(input.args !== undefined
          ? { args: normalizeArgs(input.args) }
          : {}),
        runId,
        workflowName,
        ports,
        host: host.handle,
        signal,
        cwd: host.cwd,
        budgetTotal: host.budgetTotal,
        ...(input.maxConcurrency !== undefined
          ? { maxConcurrency: input.maxConcurrency }
          : {}),
        ...(input.resumeFromRunId ? { resume: true } : {}),
      })
        .then(result => onFinish(ports, result, runId))
        .catch(e => ports.taskRegistrar.fail(runId, (e as Error).message))

      const scriptPath = workflowFile ?? `<inline run ${runId}>`
      return {
        data: {
          output: [
            'Workflow 已启动（在后台运行）。',
            `run_id: ${runId}`,
            `workflow: ${workflowName}`,
            `script: ${scriptPath}`,
            '',
            '完成时将通知你。使用 /workflows 查看实时进度。',
          ].join('\n'),
        },
      }
    },

    mapToolResultToToolResultBlockParam(data, toolUseId) {
      return {
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: [{ type: 'text', text: data.output }],
      }
    },
  }
}

function onFinish(
  ports: WorkflowPorts,
  result: WorkflowRunResult,
  runId: string,
): void {
  if (result.status === 'completed') {
    const summary =
      result.returnValue == null
        ? '（无返回值）'
        : formatValue(result.returnValue)
    ports.taskRegistrar.complete(runId, summary)
  } else if (result.status === 'failed') {
    ports.taskRegistrar.fail(runId, result.error ?? 'workflow failed')
  } else {
    ports.taskRegistrar.kill(runId)
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 500)
  try {
    return JSON.stringify(v).slice(0, 500)
  } catch {
    return String(v)
  }
}

/**
 * 防御性地规范化 args：在旧版 `z.string()` 约定下，模型可能发送字符串化的 JSON 对象。
 * 仅当字符串能 JSON.parse 为对象/数组时才规范化；普通字符串、数字等保持原样。
 */
function normalizeArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) return parsed
    return raw
  } catch {
    return raw
  }
}

async function resolveScriptSource(
  input: WorkflowInput,
  cwd: string,
): Promise<{ script: string; workflowFile?: string }> {
  if (input.script) return { script: input.script }
  if (input.scriptPath) {
    const resolved = resolve(cwd, input.scriptPath)
    if (!containsPath(cwd, resolved)) {
      throw new Error(
        `scriptPath "${input.scriptPath}" 超出范围（resolve 后，${resolved} 不在 cwd ${cwd} 内）`,
      )
    }
    return {
      script: await readFile(resolved, 'utf-8'),
      workflowFile: resolved,
    }
  }
  if (input.name) {
    if (sanitizeWorkflowName(input.name) === null) {
      throw new Error(
        `命名 workflow 名称 "${input.name}" 无效（包含路径分隔符，或为 . / ..）`,
      )
    }
    const found = await resolveNamedWorkflow(
      join(cwd, WORKFLOW_DIR_NAME),
      input.name,
    )
    if (!found) {
      throw new Error(
        `命名 workflow "${input.name}" 未找到（已在 ${WORKFLOW_DIR_NAME}/ 中查找）`,
      )
    }
    return { script: found.content, workflowFile: found.path }
  }
  throw new Error('必须提供 script、name 或 scriptPath 之一')
}
