/**
 * VaultHttpFetchTool 的 scrub（脱敏）函数集。
 *
 * 核心准则：任何密钥派生字符串都绝不能通过会进入 tool_result、jsonl、transcript
 * 检索、telemetry 或 compact 摘要的字段流出本工具的边界。scrub 层会作用于：
 *   - 响应体（服务器可能回显 Authorization）
 *   - 响应头（Authorization / X-Api-Key / Set-Cookie）
 *   - axios 错误信息（axios.AxiosError.config 可能携带请求头 ——
 *     包括我们刚刚发出的 Authorization）
 *
 * 策略：在请求之前先构造出密钥所有的"派生形式"，然后对本工具边界上流转的
 * 每一字节都应用 scrubAllSecretForms。
 *
 * 覆盖的派生形式：
 *   - 原始密钥值
 *   - 'Bearer <secret>'
 *   - <secret> 的 base64 编码（用于 Basic 风格的 payload）
 *   - 'Basic <base64>' 完整 header 值
 *
 * 自定义的 auth_header_name 会把原始密钥作为 header 值，这已被 raw-secret 形式覆盖。
 */

const REDACTED = '[REDACTED]'

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'www-authenticate',
])

/**
 * 对 RAW 形式做 scrub 所需的最小密钥长度。低于此阈值时，scrub 会引发病态的输出膨胀
 * —— 例如 1 字符的密钥 'X' 应用到一个恰好包含大量 X 字符的 1MB body 上，
 * 会产生约 10MB 的 [REDACTED]。
 *
 * 4 字符低于任何现实中的密钥（API token、OAuth token、JWT、口令都远大于 4）。
 * vault 存储在写入时本应拒绝小于 4 字符的值，但这里是 scrub 阶段的纵深防御。
 */
const MIN_SCRUB_LENGTH = 4

/**
 * 对 base64 派生形式做 scrub 所需的最小密钥长度。
 *
 * M3 修复（codecov-100 审计 #6）：4 字符的密钥会有 7-8 字符的 base64 表示，
 * 短到足以和响应体中自然出现的 token 发生碰撞（`x4Kp` → `eDRLcA==`，可能匹配
 * 无关的短标识符）。对短密钥仍会 scrub 其 raw + Bearer 形式，因为这些子串匹配要
 * 特殊得多（例如 `Bearer x4Kp` 几乎不会误撞）。对于 base64 形式，我们等到密钥
 * 长度 >= 8 字符（产生 >= 12 个 base64 字符）才 scrub —— 这是 OWASP 对凭据的最小
 * 要求，并足以避免偶然碰撞。这针对短密钥是更"收紧"的 scrub，而不是更宽松：
 * 我们仍然会 scrub 原始密钥值本身。
 */
const MIN_SCRUB_BASE64_LENGTH = 8

/**
 * 计算密钥在响应体 / 响应头 / 错误信息中所有可能出现的形式。
 *
 * L7 修复：当密钥长度小于 MIN_SCRUB_LENGTH 时返回 `[]`（空数组）——
 * 对过短的模式做 scrub 比不 scrub 更糟。调用方应在信任结果非空之前加守卫
 * `if (secret && secret.length >= MIN_SCRUB_LENGTH)`。之前的 JSDoc 宣称"始终非空"
 * 是不准确的。
 *
 * M3 修复（codecov-100 审计 #6）：对短密钥（4-7 字符）我们省略纯 base64 形式，
 * 因为其 7-8 字符的编码短到足以与响应体中的无关 token 碰撞，产生伪 [REDACTED] 标记。
 * 我们仍然输出 raw + Bearer + Basic-base64，因为它们具有更长/更具体的匹配形状。
 *
 * 返回的形式按长度从长到短排序，调用方无需再排序。
 */
export function buildDerivedSecretForms(secret: string): readonly string[] {
  if (!secret || secret.length < MIN_SCRUB_LENGTH) return []
  const base64 = Buffer.from(secret, 'utf8').toString('base64')
  // 预排序为长度从长到短（通常是 Basic > Bearer > base64 > raw），
  // 这样调用方不必在每次 scrub 调用上承担排序成本。
  if (secret.length < MIN_SCRUB_BASE64_LENGTH) {
    // M3 修复：对短密钥省略纯 base64 形式（有碰撞风险）。
    // 带 Basic 前缀的形式仍把 base64 内容保留在 scrub 列表中，但锚定在字面量
    // "Basic " 前缀上，因此与 body 中随机 8 字符 token 碰撞的概率微乎其微。
    return [`Basic ${base64}`, `Bearer ${secret}`, secret]
  }
  return [`Basic ${base64}`, `Bearer ${secret}`, base64, secret]
}

/**
 * 把 `s` 中每一种密钥派生形式的所有出现都替换为 [REDACTED]。
 *
 * M7 修复：forms 数组由 buildDerivedSecretForms 预排序为长度从长到短，
 * 因此我们不再在每次调用上分配一份排序副本。另外增加了在 `includes()` 之前的
 * `s.length >= form.length` 快速路径，用以跳过不可能匹配的情形；而 `includes()`
 * 检查本身也是快速路径，让我们在 body 干净时跳过 split/join 分配。
 */
export function scrubAllSecretForms(
  s: string,
  forms: readonly string[],
): string {
  if (!s || forms.length === 0) return s
  let out = s
  for (const form of forms) {
    if (form.length > 0 && out.length >= form.length && out.includes(form)) {
      out = out.split(form).join(REDACTED)
    }
  }
  return out
}

/**
 * 清洗响应头：对敏感 header 名称整体脱敏，对其余 header 的值做密钥回显 scrub。
 */
export function scrubResponseHeaders(
  headers: unknown,
  forms: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers || typeof headers !== 'object') return out
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    const lname = key.toLowerCase()
    if (SENSITIVE_HEADER_NAMES.has(lname)) {
      out[key] = REDACTED
      continue
    }
    const sv = Array.isArray(value)
      ? value.map(v => String(v ?? '')).join(', ')
      : String(value ?? '')
    out[key] = scrubAllSecretForms(sv, forms)
  }
  return out
}

/**
 * 把字符串截断到最多 `maxBytes` 个 UTF-8 字节，返回值仍是合法的 UTF-8
 *（不会有半个编码的 code point）。
 *
 * H1 修复（codecov-100 审计）：原代码使用 `String#slice(0, 80)`，统计的是
 * UTF-16 *code unit*。对于多字节 UTF-8（CJK、emoji、组合标记）来说，
 * 80 字符的切片可能膨胀到 240+ 字节 —— 违反了 analytics 字段的字节上限契约。
 * 我们遍历字节缓冲区并回退到上一个完整的 UTF-8 code point 起点。
 *（同时回退任何依赖于刚刚被截断的前导字节的组合标记延续字节；这一点由前导字节
 * 检查隐式处理，因为 UTF-8 延续字节都是 0b10xxxxxx。）
 *
 * 空 / null 类输入返回 ''。
 */
export function truncateToBytes(input: string, maxBytes: number): string {
  if (!input || maxBytes <= 0) return ''
  const buf = Buffer.from(input, 'utf8')
  if (buf.length <= maxBytes) return input
  // 从 maxBytes 往前回退，直到落在一个 code point 边界上。
  // UTF-8 延续字节匹配 10xxxxxx（0x80–0xBF）。code point 边界是任何
  // 不匹配该掩码的字节。
  let end = maxBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--
  }
  return buf.subarray(0, end).toString('utf8')
}

/**
 * 把 axios / fetch 错误转换为安全的摘要字符串。绝不要对原始错误做 stringify：
 * axios.AxiosError 会携带 .config.headers，其中包含我们刚刚发出的 Authorization。
 * 这里构造一条合成信息并做 scrub。
 */
export function scrubAxiosError(e: unknown, forms: readonly string[]): string {
  if (e instanceof Error) {
    const msg = scrubAllSecretForms(e.message, forms)
    return `请求失败：${msg}`
  }
  return '请求失败（未知错误）'
}
