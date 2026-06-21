import { z } from 'zod/v4'

/**
 * 同时接受数字字符串字面量如 "30"、"-5"、"3.14" 的 number。
 *
 * 工具输入以模型生成的 JSON 形式到达。模型偶尔会引号化
 * 数字 — `"head_limit":"30"` 而非 `"head_limit":30` — 而 z.number()
 * 会以类型错误拒绝。z.coerce.number() 是错误修复：它
 * 接受 "" 或 null 这样的值并通过 JS Number() 转换它们，掩盖
 * 了 bug 而非暴露它们。
 *
 * 仅强制转换匹配 /^-?\d+(\.\d+)?$/ 的有效十进制数字字面量字符串。
 * 其他任何内容透传并由内层 schema 拒绝。
 *
 * z.preprocess 向 API schema 发出 {"type":"number"}，因此模型
 * 仍被告知这是 number — 字符串容忍是不可见的客户端
 * 强制转换，而非公告的输入形态。
 *
 * .optional()/.default() 放在内部（内层 schema），而非链式追加：
 * 将它们链到 ZodPipe 上会在 Zod v4 中将 z.output<> 扩展为 unknown。
 *
 *   semanticNumber()                              → number
 *   semanticNumber(z.number().optional())         → number | undefined
 *   semanticNumber(z.number().default(0))         → number
 */
export function semanticNumber<T extends z.ZodType>(
  inner: T = z.number() as unknown as T,
) {
  return z.preprocess((v: unknown) => {
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
    return v
  }, inner)
}
