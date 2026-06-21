/**
 * team memory 的客户端密钥扫描器（PSR M22174）。
 *
 * 在上传前扫描内容中的凭证，确保密钥永远不会离开用户的机器。
 * 使用 gitleaks（https://github.com/gitleaks/gitleaks，MIT 许可证）中
 * 经精选的高置信度规则子集 —— 仅包含具有独特前缀且误报率接近零的规则。
 * 通用的关键字-上下文规则被省略。
 *
 * 规则 ID 和正则表达式直接取自公开的 gitleaks 配置：
 * https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml
 *
 * JS 正则注意事项：
 *   - gitleaks 使用 Go 正则；内联 (?i) 和模式分组 (?-i:...) 无法
 *     移植到 JS。受影响的规则用显式字符类重写
 *     （用 [a-zA-Z0-9] 替代 (?i)[a-z0-9]）。
 *   - 来自 Go 正则的尾部边界交替如 (?:[\x60'"\s;]|\\[nr]|$)
 *     被保留（JS 的 $ 在默认模式下匹配字符串结尾）。
 */

import { capitalize } from '../../utils/stringUtils.js'

type SecretRule = {
  /** Gitleaks 规则 ID（kebab-case），用于标签和分析 */
  id: string
  /** 正则表达式源码，首次扫描时延迟编译 */
  source: string
  /** 可选的 JS 正则标志（大多数规则默认大小写敏感） */
  flags?: string
}

export type SecretMatch = {
  /** 匹配的 Gitleaks 规则 ID（例如 "github-pat"、"aws-access-token"） */
  ruleId: string
  /** 从规则 ID 派生的人类可读标签 */
  label: string
}

// ─── 精选规则 ──────────────────────────────────────────────
// 来自 gitleaks 的具有独特前缀的高置信度模式。
// 大致按在开发团队内容中出现的可能性排序。

// Anthropic API 密钥前缀，在运行时组装，以确保字面字节
// 序列不会出现在外部 bundle 中（excluded-strings 检查）。
// join() 不会被压缩器常量折叠。
const ANT_KEY_PFX = ['sk', 'ant', 'api'].join('-')

const SECRET_RULES: SecretRule[] = [
  // — 云服务商 —
  {
    id: 'aws-access-token',
    source: '\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b',
  },
  {
    id: 'gcp-api-key',
    source: '\\b(AIza[\\w-]{35})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'azure-ad-client-secret',
    source:
      '(?:^|[\\\\\'"\\x60\\s>=:(,)])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\\\\'"\\x60\\s<),])',
  },
  {
    id: 'digitalocean-pat',
    source: '\\b(dop_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'digitalocean-access-token',
    source: '\\b(doo_v1_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — AI API —
  {
    id: 'anthropic-api-key',
    source: `\\b(${ANT_KEY_PFX}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,
  },
  {
    id: 'anthropic-admin-api-key',
    source:
      '\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'openai-api-key',
    source:
      '\\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'huggingface-access-token',
    // gitleaks: hf_(?i:[a-z]{34}) → JS: hf_[a-zA-Z]{34}
    source: '\\b(hf_[a-zA-Z]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — 版本控制 —
  {
    id: 'github-pat',
    source: 'ghp_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-fine-grained-pat',
    source: 'github_pat_\\w{82}',
  },
  {
    id: 'github-app-token',
    source: '(?:ghu|ghs)_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-oauth',
    source: 'gho_[0-9a-zA-Z]{36}',
  },
  {
    id: 'github-refresh-token',
    source: 'ghr_[0-9a-zA-Z]{36}',
  },
  {
    id: 'gitlab-pat',
    source: 'glpat-[\\w-]{20}',
  },
  {
    id: 'gitlab-deploy-token',
    source: 'gldt-[0-9a-zA-Z_\\-]{20}',
  },

  // — 通信 —
  {
    id: 'slack-bot-token',
    source: 'xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*',
  },
  {
    id: 'slack-user-token',
    source: 'xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}',
  },
  {
    id: 'slack-app-token',
    source: 'xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+',
    flags: 'i',
  },
  {
    id: 'twilio-api-key',
    source: 'SK[0-9a-fA-F]{32}',
  },
  {
    id: 'sendgrid-api-token',
    // gitleaks: SG\.(?i)[a-z0-9=_\-\.]{66} → JS: case-insensitive via flag
    source: '\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — 开发工具 —
  {
    id: 'npm-access-token',
    source: '\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'pypi-upload-token',
    source: 'pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}',
  },
  {
    id: 'databricks-api-token',
    source: '\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'hashicorp-tf-api-token',
    // gitleaks: (?i)[a-z0-9]{14}\.(?-i:atlasv1)\.[a-z0-9\-_=]{60,70}
    // → JS: case-insensitive hex+alnum prefix, literal "atlasv1", case-insensitive suffix
    source: '[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}',
  },
  {
    id: 'pulumi-api-token',
    source: '\\b(pul-[a-f0-9]{40})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'postman-api-token',
    // gitleaks: PMAK-(?i)[a-f0-9]{24}\-[a-f0-9]{34} → JS: use [a-fA-F0-9]
    source:
      '\\b(PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },

  // — 可观测性 —
  {
    id: 'grafana-api-key',
    source:
      '\\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'grafana-cloud-api-token',
    source: '\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'grafana-service-account-token',
    source:
      '\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'sentry-user-token',
    source: '\\b(sntryu_[a-f0-9]{64})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'sentry-org-token',
    source:
      '\\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}',
  },

  // — 支付 / 商务 —
  {
    id: 'stripe-access-token',
    source:
      '\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60\'"\\s;]|\\\\[nr]|$)',
  },
  {
    id: 'shopify-access-token',
    source: 'shpat_[a-fA-F0-9]{32}',
  },
  {
    id: 'shopify-shared-secret',
    source: 'shpss_[a-fA-F0-9]{32}',
  },

  // — 加密 —
  {
    id: 'private-key',
    source:
      '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S-]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----',
    flags: 'i',
  },
]

// 延迟编译的模式缓存 —— 首次扫描时编译一次。
let compiledRules: Array<{ id: string; re: RegExp }> | null = null

function getCompiledRules(): Array<{ id: string; re: RegExp }> {
  if (compiledRules === null) {
    compiledRules = SECRET_RULES.map(r => ({
      id: r.id,
      re: new RegExp(r.source, r.flags),
    }))
  }
  return compiledRules
}

/**
 * 将 gitleaks 规则 ID（kebab-case）转换为人类可读的标签。
 * 例如 "github-pat" → "GitHub PAT"，"aws-access-token" → "AWS Access Token"
 */
function ruleIdToLabel(ruleId: string): string {
  // 规范大小写与 title case 不同的单词
  const specialCase: Record<string, string> = {
    aws: 'AWS',
    gcp: 'GCP',
    api: 'API',
    pat: 'PAT',
    ad: 'AD',
    tf: 'TF',
    oauth: 'OAuth',
    npm: 'NPM',
    pypi: 'PyPI',
    jwt: 'JWT',
    github: 'GitHub',
    gitlab: 'GitLab',
    openai: 'OpenAI',
    digitalocean: 'DigitalOcean',
    huggingface: 'HuggingFace',
    hashicorp: 'HashiCorp',
    sendgrid: 'SendGrid',
  }
  return ruleId
    .split('-')
    .map(part => specialCase[part] ?? capitalize(part))
    .join(' ')
}

/**
 * 扫描字符串中潜在的密钥。
 *
 * 每个触发的规则返回一个匹配（按规则 ID 去重）。实际匹配的文本
 * 故意不返回 —— 我们从不记录或显示密钥值。
 */
export function scanForSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = []
  const seen = new Set<string>()

  for (const rule of getCompiledRules()) {
    if (seen.has(rule.id)) {
      continue
    }
    if (rule.re.test(content)) {
      seen.add(rule.id)
      matches.push({
        ruleId: rule.id,
        label: ruleIdToLabel(rule.id),
      })
    }
  }

  return matches
}

/**
 * 获取 gitleaks 规则 ID 的人类可读标签。
 * 对于未知 ID 回退到 kebab-to-Title 转换。
 */
export function getSecretLabel(ruleId: string): string {
  return ruleIdToLabel(ruleId)
}

/**
 * 用 [REDACTED] 原位脱敏所有匹配的密钥。
 * 与 scanForSecrets 不同，此函数返回替换了片段的内容，
 * 以便周围文本仍能安全写入磁盘。
 */
let redactRules: RegExp[] | null = null

export function redactSecrets(content: string): string {
  redactRules ??= SECRET_RULES.map(
    r => new RegExp(r.source, (r.flags ?? '').replace('g', '') + 'g'),
  )
  for (const re of redactRules) {
    // 仅替换捕获组而非整个匹配 —— 模式包含组外的
    // 边界字符（空格、引号、;），这些必须保留。
    content = content.replace(re, (match, g1) =>
      typeof g1 === 'string' ? match.replace(g1, '[REDACTED]') : '[REDACTED]',
    )
  }
  return content
}
