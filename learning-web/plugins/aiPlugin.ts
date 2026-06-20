import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Anthropic from '@anthropic-ai/sdk'
import { readProgress } from './progressStore'

const DEFAULT_MODEL_FALLBACK = 'claude-sonnet-4-5'
const MAX_FILE_CHARS = 80_000
const CHAT_FILE_CHARS = 20_000
const MAX_TOKENS = 2048
const CHAT_MAX_TOKENS = 4096

interface ExplainRequest {
  kind: 'file' | 'symbol'
  filePath: string
  symbolName?: string
  model?: string
}

type CacheControl = { type: 'ephemeral' }

interface TextBlock {
  type: 'text'
  text: string
  cache_control?: CacheControl
}

const SYSTEM_PROMPT = `你是 claude-code 代码库的学习助教。该项目是 Anthropic 官方 Claude Code CLI 的反编译版本，TypeScript + Bun，反编译后变量名/注释多有缺失。

讲解时遵循：
- 用简体中文回答
- 结构：先一句话概括职责，然后分四节：「核心职责」「关键抽象/数据结构」「上下文/调用关系」「易踩坑或值得注意的点」
- 引用具体行号用 \`Lxx\` 格式（不用区间）
- 提到其他文件用反引号包路径（如 \`src/query.ts\`）
- 不要复述代码原文，要"翻译"成意图
- 不知道就直说，不要编造`

const CHAT_SYSTEM_PROMPT = `你是 claude-code 代码库的学习助教，通过本地学习网站与用户持续对话。

回答准则：
- 使用简体中文
- 引用具体文件和行号，格式如 \`src/query.ts\` 的 \`L42\`
- 基于用户已学的内容主动建议"下一步学什么"
- 回答简洁、结构化，用要点列表而非长段落
- 不复述代码原文，要解释"为什么这样设计"
- 不知道就直说，不要编造
- 当用户附加了文件时，优先围绕该文件回答，并主动关联到它引用的上下游`

function readClaudeMd(projectRoot: string): string {
  try {
    return fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8')
  } catch {
    return ''
  }
}

function safeResolve(root: string, filePath: string): string | null {
  const resolved = path.resolve(root, filePath)
  if (!resolved.startsWith(root)) return null
  return resolved
}

function clampFile(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_FILE_CHARS)
    return { text: content, truncated: false }
  return {
    text:
      content.slice(0, MAX_FILE_CHARS) +
      '\n\n/* … (file truncated for context window) … */',
    truncated: true,
  }
}

function buildSymbolQuestion(symbolName: string, filePath: string): string {
  return `请讲解 \`${filePath}\` 中的符号 \`${symbolName}\`：

1. 它的职责是什么（一句话）
2. 它在系统中扮演的角色（被谁调用、调用了谁、为什么需要它）
3. 实现上有什么关键点或巧思
4. 如果我要修改它，最容易踩的坑是什么

请只关注这个符号本身（包括它的实现体和直接相关的内部逻辑），不要展开讲整个文件。`
}

function buildFileQuestion(filePath: string): string {
  return `请讲解 \`${filePath}\` 这个文件：

1. 一句话概括这个文件做什么
2. 关键抽象与数据结构（重要的 class / interface / type / 顶层常量）
3. 它在整个 claude-code 架构中处于什么位置、与谁交互（上下游）
4. 阅读这个文件时容易混淆或需要特别注意的点（反编译噪音、feature flag 影响等）

请简明，不需要逐行解释。`
}

export function aiPlugin(
  projectRoot: string,
  env: Record<string, string>,
): Plugin {
  return {
    name: 'ai-explain',
    configureServer(server) {
      server.middlewares.use(
        '/api/ai/explain',
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }

          const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
          if (!apiKey) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error:
                  '未配置 ANTHROPIC_API_KEY。请在 learning-web/.env.local 中加入：ANTHROPIC_API_KEY=sk-ant-...',
              }),
            )
            return
          }

          let body = ''
          req.on('data', chunk => {
            body += chunk
          })
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body) as ExplainRequest
              const { kind, filePath, symbolName, model } = payload

              if (!filePath) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Missing filePath' }))
                return
              }
              if (kind !== 'file' && kind !== 'symbol') {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({ error: 'kind must be "file" or "symbol"' }),
                )
                return
              }
              if (kind === 'symbol' && !symbolName) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({ error: 'symbol kind requires symbolName' }),
                )
                return
              }

              const resolved = safeResolve(projectRoot, filePath)
              if (!resolved) {
                res.statusCode = 403
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'Access denied' }))
                return
              }

              let rawContent: string
              try {
                rawContent = fs.readFileSync(resolved, 'utf-8')
              } catch {
                res.statusCode = 404
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'File not found' }))
                return
              }

              const { text: fileContent, truncated } = clampFile(rawContent)
              const claudeMd = readClaudeMd(projectRoot)

              const systemBlocks: TextBlock[] = [
                {
                  type: 'text',
                  text: SYSTEM_PROMPT,
                  cache_control: { type: 'ephemeral' },
                },
              ]
              if (claudeMd) {
                systemBlocks.push({
                  type: 'text',
                  text: `## 项目背景（CLAUDE.md 摘录）\n\n${claudeMd}`,
                  cache_control: { type: 'ephemeral' },
                })
              }

              const filePrefix = `## 文件 \`${filePath}\`${truncated ? '（已截断）' : ''}\n\n\`\`\`\n${fileContent}\n\`\`\``
              const userQuestion =
                kind === 'symbol'
                  ? buildSymbolQuestion(symbolName!, filePath)
                  : buildFileQuestion(filePath)

              const userBlocks: TextBlock[] = [
                {
                  type: 'text',
                  text: filePrefix,
                  cache_control: { type: 'ephemeral' },
                },
                { type: 'text', text: userQuestion },
              ]

              const resolvedModel =
                model || env.ANTHROPIC_MODEL || DEFAULT_MODEL_FALLBACK
              const baseURL = env.ANTHROPIC_BASE_URL || undefined
              const client = new Anthropic({ apiKey, baseURL })

              const response = await client.messages.create({
                model: resolvedModel,
                max_tokens: MAX_TOKENS,
                system: systemBlocks as never,
                messages: [{ role: 'user', content: userBlocks as never }],
              })

              const textOut = response.content
                .filter(b => b.type === 'text')
                .map(b => (b as { type: 'text'; text: string }).text)
                .join('\n')

              const usage = response.usage as unknown as {
                input_tokens: number
                output_tokens: number
                cache_read_input_tokens?: number
                cache_creation_input_tokens?: number
              }

              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  explanation: textOut,
                  model: response.model,
                  truncated,
                  usage: {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_read: usage.cache_read_input_tokens || 0,
                    cache_creation: usage.cache_creation_input_tokens || 0,
                  },
                }),
              )
            } catch (err) {
              const message =
                err instanceof Error ? err.message : 'AI call failed'
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: message }))
            }
          })
        },
      )

      // ─── POST /api/ai/chat — 流式学习对话 ───
      server.middlewares.use(
        '/api/ai/chat',
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }

          const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
          if (!apiKey) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error:
                  '未配置 ANTHROPIC_API_KEY。请在 learning-web/.env.local 中加入：ANTHROPIC_API_KEY=sk-ant-...',
              }),
            )
            return
          }

          let body = ''
          req.on('data', chunk => {
            body += chunk
          })
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body) as {
                messages?: Array<{
                  role: 'user' | 'assistant'
                  content: string
                }>
                context?: { currentFile?: string }
                model?: string
              }

              const { messages, context, model } = payload
              if (
                !messages ||
                !Array.isArray(messages) ||
                messages.length === 0
              ) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: 'messages required' }))
                return
              }
              if (messages[messages.length - 1].role !== 'user') {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(
                  JSON.stringify({ error: 'last message must be from user' }),
                )
                return
              }
              // 限制历史长度，避免 token 爆炸
              const trimmedMessages = messages.slice(-20)

              // 组装 system blocks
              const systemBlocks: TextBlock[] = [
                {
                  type: 'text',
                  text: CHAT_SYSTEM_PROMPT,
                  cache_control: { type: 'ephemeral' },
                },
              ]
              const claudeMd = readClaudeMd(projectRoot)
              if (claudeMd) {
                systemBlocks.push({
                  type: 'text',
                  text: `## 项目背景（CLAUDE.md 摘录）\n\n${claudeMd.slice(0, 12_000)}`,
                  cache_control: { type: 'ephemeral' },
                })
              }

              // 附加当前文件内容
              if (context?.currentFile) {
                const resolved = safeResolve(projectRoot, context.currentFile)
                if (resolved) {
                  try {
                    let raw = fs.readFileSync(resolved, 'utf-8')
                    if (raw.length > CHAT_FILE_CHARS) {
                      raw =
                        raw.slice(0, CHAT_FILE_CHARS) +
                        '\n\n/* … (truncated) … */'
                    }
                    systemBlocks.push({
                      type: 'text',
                      text: `## 用户当前查看的文件 \`${context.currentFile}\`\n\n\`\`\`\n${raw}\n\`\`\``,
                      cache_control: { type: 'ephemeral' },
                    })
                  } catch {
                    // 文件读不到就跳过
                  }
                }
              }

              // 附加最近学习活动
              try {
                const store = readProgress(projectRoot)
                const recent = Object.entries(store)
                  .filter(
                    ([, e]) =>
                      e.status === 'studied' || e.status === 'studying',
                  )
                  .sort(([, a], [, b]) =>
                    (b.updatedAt || '').localeCompare(a.updatedAt || ''),
                  )
                  .slice(0, 30)
                if (recent.length > 0) {
                  const lines = recent.map(([key, e]) => {
                    const [file, sym] = key.split('::')
                    const tag = e.status === 'studied' ? '✅' : '🔵'
                    const noteShort = e.note ? ` — ${e.note.slice(0, 80)}` : ''
                    return `${tag} \`${file}\` · ${sym || '(file)'}${noteShort}`
                  })
                  systemBlocks.push({
                    type: 'text',
                    text: `## 用户最近的学习活动\n\n${lines.join('\n')}`,
                  })
                }
              } catch {
                // progress 读不到就跳过
              }

              // 构造 API 消息（只传 role + content，不带缓存控制）
              const apiMessages = trimmedMessages.map(m => ({
                role: m.role,
                content: m.content,
              }))

              const resolvedModel =
                model || env.ANTHROPIC_MODEL || DEFAULT_MODEL_FALLBACK
              const baseURL = env.ANTHROPIC_BASE_URL || undefined
              const client = new Anthropic({ apiKey, baseURL })

              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              })

              const stream = client.messages.stream({
                model: resolvedModel,
                max_tokens: CHAT_MAX_TOKENS,
                system: systemBlocks as never,
                messages: apiMessages as never,
              })

              let aborted = false
              req.on('close', () => {
                aborted = true
                try {
                  stream.abort()
                } catch {
                  // 忽略
                }
              })

              stream.on('text', text => {
                if (aborted) return
                res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`)
              })

              try {
                const finalMsg = await stream.finalMessage()
                if (!aborted) {
                  const usage = finalMsg.usage as unknown as {
                    input_tokens: number
                    output_tokens: number
                    cache_read_input_tokens?: number
                    cache_creation_input_tokens?: number
                  }
                  res.write(
                    `event: done\ndata: ${JSON.stringify({
                      usage: {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_read: usage.cache_read_input_tokens || 0,
                        cache_creation: usage.cache_creation_input_tokens || 0,
                      },
                    })}\n\n`,
                  )
                  res.end()
                }
              } catch (streamErr) {
                if (!aborted) {
                  res.write(
                    `event: error\ndata: ${JSON.stringify({
                      error:
                        streamErr instanceof Error
                          ? streamErr.message
                          : 'Stream failed',
                    })}\n\n`,
                  )
                  res.end()
                }
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : 'Chat failed'
              if (!res.headersSent) {
                res.statusCode = 500
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: message }))
              } else {
                res.write(
                  `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`,
                )
                res.end()
              }
            }
          })
        },
      )
    },
  }
}
