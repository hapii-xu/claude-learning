import { Ajv, type ValidateFunction } from 'ajv'

const cache = new WeakMap<object, ValidateFunction>()

/**
 * 根据 JSON Schema 验证 agent 输出（Ajv，按 schema 对象缓存编译结果）。
 * 引擎对适配器返回的 schema 结果执行二次验证，并用于测试。
 */
export function validateAgainstSchema(
  value: unknown,
  schema: object,
): { valid: boolean; errors: string[] } {
  let validate = cache.get(schema)
  if (!validate) {
    const ajv = new Ajv({ allErrors: true, strict: false })
    validate = ajv.compile(schema) as ValidateFunction
    cache.set(schema, validate)
  }
  const valid = validate(value) as boolean
  return {
    valid,
    errors: valid
      ? []
      : (validate.errors ?? []).map(e => e.message ?? 'validation error'),
  }
}
