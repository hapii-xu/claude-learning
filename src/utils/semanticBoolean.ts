import { z } from 'zod/v4'

/**
 * 同时接受字符串字面量 "true"/"false" 的 boolean。
 *
 * 工具输入以模型生成的 JSON 形式到达。模型偶尔会引号化
 * 布尔值 — `"replace_all":"false"` 而非 `"replace_all":false` — 而
 * z.boolean() 会以类型错误拒绝。z.coerce.boolean() 是错误
 * 修复：它使用 JS 真值性，所以 "false" → true。
 *
 * z.preprocess 向 API schema 发出 {"type":"boolean"}，因此模型
 * 仍被告知这是 boolean — 字符串容忍是不可见的客户端
 * 强制转换，而非公告的输入形态。
 *
 * .optional()/.default() 放在内部（内层 schema），而非链式追加：
 * 将它们链到 ZodPipe 上会在 Zod v4 中将 z.output<> 扩展为 unknown。
 *
 *   semanticBoolean()                              → boolean
 *   semanticBoolean(z.boolean().optional())        → boolean | undefined
 *   semanticBoolean(z.boolean().default(false))    → boolean
 */
export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  )
}
