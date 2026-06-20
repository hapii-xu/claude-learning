/**
 * 对进入 session 之前的 GitHub webhook 载荷内容做净化。
 *
 * 在 feature('KAIROS_GITHUB_WEBHOOKS') 启用时，由 useReplBridge.tsx 调用。
 * 剥离已知的敏感模式（token、API key、凭据），同时保留有意义的内容
 *（PR 标题、描述、commit 消息等）。
 *
 * 必须同步执行且永不抛错 —— 出错时返回安全的占位符。
 */

/** 匹配已知 secret/token 格式的正则。 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub token（PAT、OAuth、App、Server-to-server）
  {
    pattern: /\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  // Anthropic API key
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },
  // header 中的通用 Bearer token
  {
    pattern: /(Bearer\s+)[A-Za-z0-9._\-/+=]{20,}/gi,
    replacement: '$1[REDACTED_TOKEN]',
  },
  // AWS access key（访问密钥）
  {
    pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  // AWS secret key（常见 label 后跟 40 字符的类 base64 串）
  {
    pattern:
      /(aws_secret_access_key|secret_key|SecretAccessKey)['":\s=]+[A-Za-z0-9/+=]{30,}/gi,
    replacement: '$1=[REDACTED_AWS_SECRET]',
  },
  // 通用 API key 模式（key=value 或 "key": "value"）
  {
    pattern:
      /(api[_-]?key|apikey|secret|password|token|credential)['":\s=]+["']?[A-Za-z0-9._\-/+=]{16,}["']?/gi,
    replacement: '$1=[REDACTED]',
  },
  // npm token
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replacement: '[REDACTED_NPM_TOKEN]' },
  // Slack token
  {
    pattern: /\bxox[bporas]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },
]

/** 截断前的最大内容长度（100KB）。 */
const MAX_CONTENT_LENGTH = 100_000

export function sanitizeInboundWebhookContent(content: string): string {
  try {
    if (!content) return content

    let sanitized = content

    // 先脱敏再截断，避免把 secret 切在截断边界上
    for (const { pattern, replacement } of SECRET_PATTERNS) {
      pattern.lastIndex = 0
      sanitized = sanitized.replace(pattern, replacement)
    }

    // 脱敏后，过大的载荷再截断
    if (sanitized.length > MAX_CONTENT_LENGTH) {
      sanitized = sanitized.slice(0, MAX_CONTENT_LENGTH) + '\n... [truncated]'
    }

    return sanitized
  } catch {
    // 永不抛错，永不返回原始内容 —— 返回安全占位符
    return '[webhook content redacted due to sanitization error]'
  }
}
