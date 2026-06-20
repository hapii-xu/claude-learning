import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command, LocalCommandResult } from '../../types/command.js'
import {
  getSessionId,
  getSessionProjectDir,
  getOriginalCwd,
} from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { sanitizePath } from '../../utils/path.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'

import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 在将错误消息展示给用户前对其进行脱敏处理：
 * - 将 home 目录路径替换为 "~"，避免泄漏绝对路径。
 * - 截断到 200 字符以内，避免泄漏大段堆栈跟踪或 token 片段。
 */
function sanitizeErrorMessage(msg: string): string {
  const home = homedir()
  let sanitized = msg.replace(
    new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    '~',
  )
  if (sanitized.length > 200) sanitized = sanitized.slice(0, 200) + '…'
  return sanitized
}

// 通过 namespace import 在调用时重新解析，这样使用
// mock.module('node:child_process') 的测试运行器能看到替换结果（不同于
// 在模块加载时通过 promisify 捕获，后者会永久绑定原始引用）。
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return promisify(childProcess.execFile)(cmd, args, opts)
}

// 在共享内容中需要遮蔽的模式（API 密钥、token、密码、机密信息）
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Anthropic / OpenAI 风格的 API 密钥
  {
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },
  {
    pattern: /\b(sk-[A-Za-z0-9_-]{20,})/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // Bearer / Authorization token
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi,
    replacement: '$1[REDACTED_TOKEN]',
  },
  // 通用模式：key/token/secret/password 后接 = 或 : 再接值
  {
    pattern:
      /("(?:api[_-]?key|token|secret|password|passwd|auth)["\s]*[:=]\s*")[^"]{8,}"/gi,
    replacement: '$1[REDACTED]"',
  },
  // AWS 风格的访问密钥
  {
    pattern: /\b(AKIA[A-Z0-9]{16})\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  // GitHub 个人访问令牌（ghp_*、gho_*、ghs_*、ghr_*）
  {
    pattern: /\b(gh[a-z]_[A-Za-z0-9_]{36,})/g,
    replacement: '[REDACTED_GH_TOKEN]',
  },
  // Slack bot token（xoxb-*）
  {
    pattern: /\b(xoxb-[A-Za-z0-9-]{30,})/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },
  // 注意：我们有意不对通用的 ≥32 字符十六进制字符串进行脱敏，因为
  // 它们会匹配合法的 git commit SHA 和 base64 内容，导致共享输出变得
  // 混乱。Token 检测仅限于上方带前缀的模式。
]

/**
 * 遮蔽文本中形似机密信息的字符串。
 * 导出用于测试。
 */
export function maskSecrets(text: string): string {
  let result = text
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

/**
 * 构建会话 JSONL 的摘要版本：
 * 取每一轮（仅 user/assistant）文本内容的前 200 个字符。
 */
function buildSummaryContent(logPath: string): string {
  try {
    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)

    const summaryLines: string[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const role = entry.role as string | undefined
        if (role !== 'user' && role !== 'assistant') continue

        const content = entry.content
        let text = ''
        if (typeof content === 'string') {
          text = content.slice(0, 200)
        } else if (Array.isArray(content)) {
          const firstText = (content as Array<Record<string, unknown>>).find(
            b => b.type === 'text',
          )
          text = ((firstText?.text as string | undefined) ?? '').slice(0, 200)
        }
        if (text) {
          summaryLines.push(JSON.stringify({ role, content: text }))
        }
      } catch {
        // 跳过格式错误的内容
      }
    }
    return summaryLines.join('\n')
  } catch {
    // 防御性处理：日志文件在 existsSync 与 readFileSync 之间消失（TOCTOU）
    return ''
  }
}

function getTranscriptPath(): string {
  const sessionId = getSessionId()
  const projectDir = getSessionProjectDir()
  if (projectDir) {
    return join(projectDir, `${sessionId}.jsonl`)
  }
  const encoded = sanitizePath(getOriginalCwd())
  return join(
    getClaudeConfigHomeDir(),
    'projects',
    encoded,
    `${sessionId}.jsonl`,
  )
}

async function ghAvailable(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function uploadToGist(
  filePath: string,
  isPublic: boolean,
): Promise<string> {
  const visibility = isPublic ? '--public' : '--secret'
  const result = await execFileAsync(
    'gh',
    [
      'gist',
      'create',
      filePath,
      visibility,
      '--filename',
      'claude-session.jsonl',
    ],
    { timeout: 30000 },
  )
  const url = result.stdout.trim()
  if (!url.startsWith('https://')) {
    throw new Error(`Unexpected gh gist output: ${url}`)
  }
  return url
}

/**
 * 通过 0x0.st（免费文本粘贴服务）进行回退上传。
 * 仅在 gh gist 失败且设置了 --allow-public-fallback 时使用。
 */
async function uploadTo0x0(filePath: string): Promise<string> {
  const result = await execFileAsync(
    'curl',
    ['-s', '-F', `file=@${filePath}`, 'https://0x0.st'],
    { timeout: 20000 },
  )
  const url = result.stdout.trim()
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new Error(`0x0.st returned unexpected output: ${url.slice(0, 100)}`)
  }
  return url
}

/**
 * 解析 /share 标志。
 * 支持：--public、--private（默认）、--mask-secrets、--summary-only、--allow-public-fallback
 */
interface ShareOptions {
  isPublic: boolean
  maskSecrets: boolean
  summaryOnly: boolean
  allowPublicFallback: boolean
  valid: boolean
}

function parseShareArgs(args: string): ShareOptions {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const unknownFlags = parts.filter(
    p =>
      p.startsWith('--') &&
      ![
        '--public',
        '--private',
        '--mask-secrets',
        '--summary-only',
        '--allow-public-fallback',
      ].includes(p),
  )
  if (unknownFlags.length > 0) {
    return {
      isPublic: false,
      maskSecrets: false,
      summaryOnly: false,
      allowPublicFallback: false,
      valid: false,
    }
  }
  return {
    isPublic: parts.includes('--public'),
    maskSecrets: parts.includes('--mask-secrets'),
    summaryOnly: parts.includes('--summary-only'),
    allowPublicFallback: parts.includes('--allow-public-fallback'),
    valid: true,
  }
}

const share: Command = {
  type: 'local',
  name: 'share',
  description:
    'Upload the current session log to GitHub Gist. Flags: --public, --private (default), --mask-secrets, --summary-only, --allow-public-fallback',
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  bridgeSafe: true,
  load: async () => ({
    call: async (args: string): Promise<LocalCommandResult> => {
      const opts = parseShareArgs(args)
      if (!opts.valid) {
        return {
          type: 'text',
          value: [
            'Usage: /share [--public|--private] [--mask-secrets] [--summary-only] [--allow-public-fallback]',
            '',
            '  --public               Create a public Gist (default: secret)',
            '  --private              Create a secret Gist (default)',
            '  --mask-secrets         Redact API keys, tokens, and secrets before uploading',
            '  --summary-only         Upload a summary (first 200 chars per turn) instead of full log',
            '  --allow-public-fallback  Fall back to 0x0.st if gh gist fails',
          ].join('\n'),
        }
      }

      const sessionId = getSessionId()
      const logPath = getTranscriptPath()

      logEvent('tengu_share_started', {
        visibility: (opts.isPublic
          ? 'public'
          : 'private') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mask_secrets: String(
          opts.maskSecrets,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        summary_only: String(
          opts.summaryOnly,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      if (!existsSync(logPath)) {
        logEvent('tengu_share_failed', {
          reason:
            'log_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          type: 'text',
          value: [
            '## Session log not found',
            '',
            `Session: ${sessionId}`,
            `Expected path: \`${logPath}\``,
            '',
            'The session log may not have been written yet. Try sending at least one message first.',
          ].join('\n'),
        }
      }

      const hasGh = await ghAvailable()
      if (!hasGh && !opts.allowPublicFallback) {
        logEvent('tengu_share_failed', {
          reason:
            'gh_not_installed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          type: 'text',
          value: [
            '## Share session log',
            '',
            `Session: ${sessionId}`,
            `Log file: \`${logPath}\``,
            '',
            'To upload to GitHub Gist automatically, install the `gh` CLI:',
            '  https://cli.github.com/',
            '',
            'Then run:',
            `  \`gh gist create "${logPath}" --secret --filename claude-session.jsonl\``,
            '',
            'Or use `--allow-public-fallback` to upload to 0x0.st instead.',
            '',
            '_Privacy note: the JSONL contains everything typed in this session,_',
            '_including tool outputs. Review before sharing._',
          ].join('\n'),
        }
      }

      // 准备要上传的内容
      let uploadContent: string
      if (opts.summaryOnly) {
        uploadContent = buildSummaryContent(logPath)
        if (!uploadContent) {
          return {
            type: 'text',
            value: 'No conversation content found in session log.',
          }
        }
      } else {
        uploadContent = readFileSync(logPath, 'utf8')
      }

      // 如有需要则遮蔽机密信息
      if (opts.maskSecrets) {
        uploadContent = maskSecrets(uploadContent)
      }

      // 写入临时文件，以便传递（可能已修改的）内容
      const tmpDir = mkdtempSync(join(tmpdir(), 'cc-share-'))
      const tmpFile = join(tmpDir, 'claude-session.jsonl')
      try {
        writeFileSync(tmpFile, uploadContent, 'utf8')
      } catch (writeErr: unknown) {
        // 防御性处理：mkdtempSync 成功后临时文件写入失败（TOCTOU）
        rmSync(tmpDir, { recursive: true, force: true })
        const msg = sanitizeErrorMessage(
          writeErr instanceof Error ? writeErr.message : String(writeErr),
        )
        return { type: 'text', value: `Failed to prepare share file: ${msg}` }
      }

      try {
        let url: string
        let method: string

        if (hasGh) {
          try {
            url = await uploadToGist(tmpFile, opts.isPublic)
            method = 'GitHub Gist'
          } catch (gistErr: unknown) {
            if (!opts.allowPublicFallback) throw gistErr
            // Gist 失败 — 尝试 0x0.st 回退
            url = await uploadTo0x0(tmpFile)
            method = '0x0.st (fallback)'
          }
        } else {
          // 没有 gh，但设置了 --allow-public-fallback
          url = await uploadTo0x0(tmpFile)
          method = '0x0.st (fallback)'
        }

        logEvent('tengu_share_succeeded', {
          visibility: (opts.isPublic
            ? 'public'
            : 'private') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          method:
            method as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          type: 'text',
          value: [
            '## Session shared',
            '',
            `URL:        ${url}`,
            `Session:    ${sessionId}`,
            `Visibility: ${opts.isPublic ? 'public' : 'secret'}`,
            `Method:     ${method}`,
            opts.summaryOnly ? 'Content:    summary only (truncated)' : '',
            opts.maskSecrets ? 'Secrets:    masked before upload' : '',
            '',
            '_Privacy note: the JSONL contains everything typed in this session._',
          ]
            .filter(l => l !== '')
            .join('\n'),
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logEvent('tengu_share_failed', {
          reason:
            'upload_error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          type: 'text',
          value: [
            '## Failed to share session',
            '',
            `Error: ${msg}`,
            '',
            hasGh
              ? 'Make sure you are logged in: `gh auth login`'
              : 'Install the `gh` CLI: https://cli.github.com/',
            `Log file: \`${logPath}\``,
          ].join('\n'),
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  }),
}

export default share
