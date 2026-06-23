import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { logError } from '../../utils/log.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { ProvidersFileSchema, type ProviderConfig } from './types.js'

/**
 * 四个内置的 OpenAI 兼容 provider。
 *
 * 当 providers.json 不存在或没有条目时使用这些默认值。
 * 用户在 ~/.hclaude/providers.json 中定义的 provider 会覆盖同 id 的内置项。
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'cerebras',
    kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'llama-3.3-70b',
    compatRule: 'cerebras',
  },
  {
    id: 'groq',
    kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    compatRule: 'groq',
  },
  {
    id: 'qwen',
    kind: 'openai-compat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    compatRule: 'strict-openai',
  },
  {
    id: 'deepseek',
    kind: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    compatRule: 'deepseek',
  },
]

/**
 * 返回 Claude 配置目录下 providers.json 文件的路径。
 */
export function getProvidersFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'providers.json')
}

// ── J1：进程级缓存，失效时置为过期 ─────────────────────────────────────────────

let _cachedProviders: ProviderConfig[] | null = null

/** 使进程内 provider 缓存失效（在 saveProviders 之后调用）。 */
export function _invalidateProviderCache(): void {
  _cachedProviders = null
}

/**
 * 加载 provider 配置。
 *
 * 策略：
 * 1. 从 DEFAULT_PROVIDERS 开始。
 * 2. 若 ~/.hclaude/providers.json 存在，用 Zod 解析并校验。
 *    - 有效条目替换同 id 的默认值；新 id 追加到末尾。
 *    - 文件损坏/无效：记录警告，仅返回默认值。
 * 3. providers.json 为空：返回默认值。
 *
 * A1 修复：返回加载诊断信息，供调用方（ProviderView）展示错误。
 * J1 修复：进程级缓存；在 saveProviders() 之后失效。
 *
 * 此函数不抛出异常——文件损坏时产生警告并回退到默认值。
 */
export function loadProviders(): ProviderConfig[] {
  // J1：若缓存可用则直接返回（防止 findProvider 重复读取磁盘）
  if (_cachedProviders !== null) return _cachedProviders

  const result = _loadProvidersInternal()
  _cachedProviders = result.providers
  return result.providers
}

/**
 * 加载 provider 并附带诊断信息。
 * 返回 { providers, error? }，调用方可将错误展示到界面。
 * A1 修复：将解析错误暴露给 UI 层，而非仅通过 logError 记录。
 */
export function loadProvidersWithDiagnostic(): {
  providers: ProviderConfig[]
  error?: string
} {
  const result = _loadProvidersInternal()
  _cachedProviders = result.providers
  return result
}

function _loadProvidersInternal(): {
  providers: ProviderConfig[]
  error?: string
} {
  const filePath = getProvidersFilePath()

  if (!existsSync(filePath)) {
    return { providers: [...DEFAULT_PROVIDERS] }
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    const msg = `loadProviders: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    logError(new Error(msg))
    return { providers: [...DEFAULT_PROVIDERS], error: msg }
  }

  // 文件为空 → 返回默认值
  if (!raw.trim()) {
    return { providers: [...DEFAULT_PROVIDERS] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const msg = `loadProviders: ${filePath} is not valid JSON. Using default providers.`
    logError(new Error(msg))
    return { providers: [...DEFAULT_PROVIDERS], error: msg }
  }

  const result = ProvidersFileSchema.safeParse(parsed)
  if (!result.success) {
    const msg = `loadProviders: ${filePath} failed schema validation: ${result.error.message}. Using default providers.`
    logError(new Error(msg))
    return { providers: [...DEFAULT_PROVIDERS], error: msg }
  }

  if (result.data.length === 0) {
    return { providers: [...DEFAULT_PROVIDERS] }
  }

  // 合并：用户条目覆盖同 id 的默认值；新 id 追加到末尾。
  const merged = new Map<string, ProviderConfig>()
  for (const p of DEFAULT_PROVIDERS) {
    merged.set(p.id, p)
  }
  for (const p of result.data) {
    merged.set(p.id, p)
  }

  return { providers: Array.from(merged.values()) }
}

/**
 * 在已加载的列表中按 id 查找 provider。未找到时返回 undefined。
 */
export function findProvider(
  id: string,
  providers?: ProviderConfig[],
): ProviderConfig | undefined {
  return (providers ?? loadProviders()).find(p => p.id === id)
}

/**
 * 对 ProviderConfig 对象进行深度相等比较，与键顺序无关。
 * E4 修复：替代对键顺序敏感的 JSON.stringify 比较方式。
 */
function providerConfigEqual(a: ProviderConfig, b: ProviderConfig): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (a[k as keyof ProviderConfig] !== b[k as keyof ProviderConfig])
      return false
  }
  return true
}

/**
 * 将额外的 provider 写入 ~/.hclaude/providers.json。
 *
 * 仅写入不在 DEFAULT_PROVIDERS（或现有文件）中的 provider。
 * 若存在相同 id 的 provider，则替换之。
 *
 * C3 修复：使用原子性 tmp+rename 写入。
 * E4 修复：使用与键顺序无关的深度比较来对比默认值。
 * J1 修复：写入后使缓存失效。
 *
 * 返回已写入的最终合并列表。
 */
export function saveProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const filePath = getProvidersFilePath()

  // 构建合并列表（provider 按 id 覆盖默认值）
  const merged = new Map<string, ProviderConfig>()
  for (const p of DEFAULT_PROVIDERS) {
    merged.set(p.id, p)
  }
  for (const p of providers) {
    merged.set(p.id, p)
  }

  // 仅持久化非默认 provider（默认值始终内置）
  const toWrite: ProviderConfig[] = []
  for (const [id, p] of merged) {
    const isDefault = DEFAULT_PROVIDERS.some(d => d.id === id)
    if (!isDefault) {
      toWrite.push(p)
    } else {
      // E4：若用户覆盖了默认值，则持久化该覆盖（使用与键顺序无关的比较）
      const defaultEntry = DEFAULT_PROVIDERS.find(d => d.id === id)
      if (defaultEntry && !providerConfigEqual(defaultEntry, p)) {
        toWrite.push(p)
      }
    }
  }

  // C3：原子写入——临时文件 + rename 防止并发保存时的更新丢失
  const tmpPath = join(
    tmpdir(),
    `.providers-${randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      renameSync(tmpPath, tmpPath + '.cleanup')
    } catch {
      /* ignore */
    }
    throw err
  }

  // J1：使缓存失效，确保下次 loadProviders() 读取最新数据
  _invalidateProviderCache()

  return Array.from(merged.values())
}
