import type { WorkflowMeta } from '../types.js'

export class ScriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptError'
  }
}

/** 引擎注入到脚本的 hook 函数集合。 */
export type WorkflowHooks = {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>
  pipeline: <T, R>(
    items: readonly T[],
    ...stages: Array<
      (prev: unknown, item: T, index: number) => Promise<unknown>
    >
  ) => Promise<Array<R | null>>
  phase: (title: string) => void
  log: (message: string) => void
  workflow: (
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ) => Promise<unknown>
}

const META_RE = /export\s+const\s+meta\s*=\s*/

/**
 * 提取 `export const meta = { ... }` 纯字面量。返回 meta 对象和剥离后的主体。
 * 字面量通过无参数 Function 执行 —— 任何标识符引用都会抛出 ReferenceError → 报告为"非纯字面量"。
 */
export function extractMeta(source: string): {
  meta: WorkflowMeta | null
  body: string
} {
  const match = META_RE.exec(source)
  if (!match) return { meta: null, body: source }

  let i = match.index + match[0].length
  while (i < source.length && /\s/.test(source[i]!)) i++
  if (source[i] !== '{') {
    throw new ScriptError('meta must be an object literal `{ ... }`')
  }

  // 花括号匹配（处理字符串 / 转义 / 嵌套）
  let depth = 0
  const start = i
  let inStr: string | null = null
  for (; i < source.length; i++) {
    const ch = source[i]!
    if (inStr) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }
  if (depth !== 0) throw new ScriptError('meta literal braces are not closed')

  const literal = source.slice(start, i)
  let metaObj: unknown
  try {
    // 无参数 Function：纯字面量可执行；引用任何标识符 → ReferenceError
    metaObj = new Function(`return (${literal})`)()
  } catch (e) {
    throw new ScriptError(
      `meta must be a plain literal (no variable/function calls/interpolation): ${(e as Error).message}`,
    )
  }
  const meta = validateMeta(metaObj)

  // 剥离 meta 语句（含尾随分号和多余空行）
  const body =
    source.slice(0, match.index) +
    source.slice(i).replace(/^[ \t]*;[ \t]*\n/, '\n')
  return { meta, body }
}

function validateMeta(v: unknown): WorkflowMeta {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ScriptError('meta must be an object')
  }
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.description !== 'string') {
    throw new ScriptError('meta must include string name and description')
  }
  return o as unknown as WorkflowMeta
}

// ---- 非确定性沙箱 shim ----
class NonDeterministicError extends Error {
  constructor(fn: string) {
    super(
      `${fn} 在 workflow 脚本中不可用（会破坏恢复确定性）。请通过 args 传递时间戳/随机种子。`,
    )
    this.name = 'NonDeterministicError'
  }
}

function sandboxDate(): DateConstructor {
  const fn = function (...args: unknown[]): Date {
    if (args.length === 0)
      throw new NonDeterministicError('Date.now()/new Date()')
    return new (Date as unknown as DateConstructor)(
      ...(args as [string | number | Date]),
    )
  } as unknown as DateConstructor
  fn.now = () => {
    throw new NonDeterministicError('Date.now()')
  }
  fn.parse = Date.parse
  fn.UTC = Date.UTC
  return fn
}

function sandboxMath(): Math {
  return new Proxy(Math, {
    get(target, prop, receiver) {
      if (prop === 'random') {
        return () => {
          throw new NonDeterministicError('Math.random()')
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Math
}

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as {
  new (...args: string[]): (...args: unknown[]) => Promise<unknown>
}

export type ParsedScript = {
  meta: WorkflowMeta | null
  execute: (
    hooks: WorkflowHooks,
    args: unknown,
    budget: unknown,
  ) => Promise<unknown>
}

/** 验证 + 将脚本封装为可执行的 async 函数（Date/Math 已被 shim）。 */
/**
 * 检测脚本主体中的常见违规（import / 多余 export）并产出精确错误和指导。
 * 否则会降级到 AsyncFunction 的通用"语法错误"，使模型/用户难以定位根本原因
 * （脚本是非 ESM 函数体，hooks 已注入，引擎不转译 TS）。
 */
function assertScriptBody(body: string): void {
  if (/^\s*import\b/m.test(body)) {
    throw new ScriptError(
      'workflow scripts are the body of new AsyncFunction (not ESM modules); import is not supported. ' +
        'agent / parallel / pipeline / phase / log / workflow / args / budget are injected as parameters — use them directly.',
    )
  }
  // 动态 import(...) 调用：沙箱仅保障恢复确定性而非安全性，但明显的越狱尝试应被阻止。
  // 不锚定行首以捕获 `await import(...)`、`return import(...)` 等；要求 `import` 后跟 `(` 拦截，
  // 避免字符串字面量中出现的"import"一词误报（例如 agent('please import this module')）。
  if (/\bimport\s*\(/m.test(body)) {
    throw new ScriptError(
      'dynamic import(...) is forbidden in workflow scripts: it bypasses the Date/Math sandbox and breaks resume determinism. ' +
        'The sandbox does not guarantee security (same trust level as the LLM), but explicit escapes are prohibited. Inject external dependencies via args.',
    )
  }
  if (/^\s*export\b/m.test(body)) {
    throw new ScriptError(
      'workflow scripts allow only one export const meta = {...} (already extracted by the engine). ' +
        'Remove other export / export default statements; use top-level return for the result.',
    )
  }
}

export function parseScript(source: string): ParsedScript {
  const { meta, body } = extractMeta(source)
  assertScriptBody(body)
  let fn: (...args: unknown[]) => Promise<unknown>
  try {
    fn = new AsyncFunction(
      'agent',
      'parallel',
      'pipeline',
      'phase',
      'log',
      'workflow',
      'args',
      'budget',
      'Date',
      'Math',
      body,
    )
  } catch (e) {
    throw new ScriptError(`Script syntax error: ${(e as Error).message}`)
  }
  const sandboxedDate = sandboxDate()
  const sandboxedMath = sandboxMath()
  return {
    meta,
    async execute(hooks, args, budget) {
      return fn(
        hooks.agent,
        hooks.parallel,
        hooks.pipeline,
        hooks.phase,
        hooks.log,
        hooks.workflow,
        args,
        budget,
        sandboxedDate,
        sandboxedMath,
      )
    },
  }
}
