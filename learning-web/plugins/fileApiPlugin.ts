import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import matter from 'gray-matter'
// symbolExtractor imported above with countAllSymbols
import { findReferences } from './referenceFinder'
import { findImports } from './importGraph'
import {
  handleExecRun,
  handleExecStream,
  handleExecCancel,
  ALLOWED_COMMANDS,
} from './execRunner'
import { handleLogsTail, handleLogsList } from './logTailer'
import {
  readProgress,
  setProgressEntry,
  getProgressEntry,
  getFileProgress,
  searchNotes,
  searchFileNotes,
  getStats,
  listAnnotations,
  setAnnotation,
  deleteAnnotation,
  listBookmarks,
  addBookmark,
  removeBookmark,
  isBookmarked,
  getPathProgress,
  completeStation,
  recordActivity,
  getRecentActivity,
  getFileCoverage,
  getFileNote,
  setFileNote,
  listFileNotes,
} from './progressStore'
import {
  listSessions,
  getSession,
  createSession,
  appendMessages,
  renameSession,
  deleteSession,
} from './chatStore'
import { extractSymbols, countAllSymbols } from './symbolExtractor'

/**
 * Vite dev server 中间件 — 提供本地文件读取 + 符号分析 + 执行 + 日志 API
 * 仅在开发模式有效，用于从磁盘读取 Claude Code 源码文件
 */
export function fileApiPlugin(projectRoot: string): Plugin {
  // 缓存文件树扫描结果
  let fileTreeCache: FileTreeNode[] | null = null

  return {
    name: 'file-api',
    configureServer(server) {
      // ─── 已有端点 ───

      // POST /api/file/write — 写入文件内容（编辑保存）
      // (must be before /api/file — connect matches by prefix)
      server.middlewares.use(
        '/api/file/write',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }

          let body = ''
          req.on('data', chunk => {
            body += chunk
          })
          req.on('end', () => {
            try {
              const { path: filePath, content } = JSON.parse(body)
              if (!filePath || typeof content !== 'string') {
                res.statusCode = 400
                res.end(JSON.stringify({ error: 'Missing path or content' }))
                return
              }

              const resolved = safeResolve(projectRoot, filePath)
              if (!resolved) {
                res.statusCode = 403
                res.end(
                  JSON.stringify({
                    error: 'Access denied: path escapes project root',
                  }),
                )
                return
              }

              // 只允许写入安全目录
              const ALLOWED_PREFIXES = [
                'src/',
                'packages/',
                'scripts/',
                'docs/',
                'analysis/',
                'learning-web/',
              ]
              const relPath = filePath.replace(/\\/g, '/')
              const isAllowed = ALLOWED_PREFIXES.some(prefix =>
                relPath.startsWith(prefix),
              )
              if (!isAllowed) {
                res.statusCode = 403
                res.end(
                  JSON.stringify({
                    error:
                      'Access denied: can only write to src/, packages/, scripts/, docs/, analysis/',
                  }),
                )
                return
              }

              // 禁止写入敏感路径
              const FORBIDDEN = ['node_modules', '.git/', 'dist/', '.cache/']
              if (FORBIDDEN.some(f => relPath.includes(f))) {
                res.statusCode = 403
                res.end(
                  JSON.stringify({ error: 'Access denied: forbidden path' }),
                )
                return
              }

              fs.writeFileSync(resolved, content, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ path: filePath, success: true }))
            } catch (err) {
              res.statusCode = 500
              res.end(
                JSON.stringify({
                  error: err instanceof Error ? err.message : 'Write failed',
                }),
              )
            }
          })
        },
      )

      // GET /api/file?path=src/query.ts — 读取源文件内容
      server.middlewares.use(
        '/api/file',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const filePath = url.searchParams.get('path')

          if (!filePath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const { resolved, actualPath } = resolveWithFallback(
            projectRoot,
            filePath,
          )
          if (!resolved) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Access denied' }))
            return
          }

          try {
            const content = fs.readFileSync(resolved, 'utf-8')
            const stat = fs.statSync(resolved)
            // Record file access for "今日续读" feature
            try {
              recordActivity(projectRoot, actualPath)
            } catch {
              /* non-critical */
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                path: actualPath,
                originalPath: actualPath !== filePath ? filePath : undefined,
                content,
                size: stat.size,
                lastModified: stat.mtime.toISOString(),
              }),
            )
          } catch {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'File not found', path: filePath }))
          }
        },
      )

      // GET /api/file-tree — 返回项目文件树
      server.middlewares.use(
        '/api/file-tree',
        (_req: IncomingMessage, res: ServerResponse) => {
          if (!fileTreeCache) {
            fileTreeCache = scanDirectory(
              projectRoot,
              '',
              ['src', 'packages', 'scripts', 'docs', 'analysis'],
              3,
            )
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ tree: fileTreeCache }))
        },
      )

      // GET /api/doc?path=docs/conversation/the-loop.mdx — 读取文档文件
      server.middlewares.use(
        '/api/doc',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const docPath = url.searchParams.get('path')

          if (!docPath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const resolved = safeResolve(projectRoot, docPath)
          if (!resolved) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Access denied' }))
            return
          }

          try {
            const raw = fs.readFileSync(resolved, 'utf-8')
            const { data: frontmatter, content } = matter(raw)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ path: docPath, content, frontmatter }))
          } catch {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({ error: 'Document not found', path: docPath }),
            )
          }
        },
      )

      // ─── 新增端点 ───

      // GET /api/symbols?path=src/query.ts — 提取文件符号
      server.middlewares.use(
        '/api/symbols',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const filePath = url.searchParams.get('path')

          if (!filePath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const resolved = safeResolve(projectRoot, filePath)
          if (!resolved) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Access denied' }))
            return
          }

          const result = extractSymbols(filePath, projectRoot)
          if (!result) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({ error: 'Cannot parse file', path: filePath }),
            )
            return
          }

          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              path: filePath,
              symbols: result.symbols,
              cached: false,
            }),
          )
        },
      )

      // GET /api/references?path=src/query.ts&symbol=query — 查找引用
      server.middlewares.use(
        '/api/references',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const filePath = url.searchParams.get('path')
          const symbol = url.searchParams.get('symbol')

          if (!filePath || !symbol) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({ error: 'Missing path or symbol parameter' }),
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

          const result = findReferences(filePath, symbol, projectRoot)
          if (!result) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'File or symbol not found' }))
            return
          }

          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              path: filePath,
              symbol,
              callers: result.callers,
              callees: result.callees,
            }),
          )
        },
      )

      // GET /api/imports?path=src/query.ts — 文件导入关系
      server.middlewares.use(
        '/api/imports',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const filePath = url.searchParams.get('path')

          if (!filePath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const resolved = safeResolve(projectRoot, filePath)
          if (!resolved) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Access denied' }))
            return
          }

          const result = findImports(filePath, projectRoot)
          if (!result) {
            res.statusCode = 404
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({ error: 'Cannot parse file', path: filePath }),
            )
            return
          }

          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              path: filePath,
              imports: result.imports,
              importedBy: result.importedBy,
            }),
          )
        },
      )

      // POST /api/exec/run — 执行白名单命令
      server.middlewares.use(
        '/api/exec/run',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }
          handleExecRun(req, res, projectRoot)
        },
      )

      // GET /api/exec/stream?execId=xxx — SSE 流订阅
      server.middlewares.use(
        '/api/exec/stream',
        (req: IncomingMessage, res: ServerResponse) => {
          handleExecStream(req, res)
        },
      )

      // POST /api/exec/cancel?execId=xxx — 取消执行
      server.middlewares.use(
        '/api/exec/cancel',
        (req: IncomingMessage, res: ServerResponse) => {
          handleExecCancel(req, res)
        },
      )

      // GET /api/exec/commands — 列出可用命令
      server.middlewares.use(
        '/api/exec/commands',
        (_req: IncomingMessage, res: ServerResponse) => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ commands: ALLOWED_COMMANDS }))
        },
      )

      // GET /api/logs/sources — 列出日志源
      server.middlewares.use(
        '/api/logs/sources',
        (_req: IncomingMessage, res: ServerResponse) => {
          handleLogsList(_req, res)
        },
      )

      // GET /api/logs/tail?source=xxx — SSE 日志流
      server.middlewares.use(
        '/api/logs/tail',
        (req: IncomingMessage, res: ServerResponse) => {
          handleLogsTail(req, res, projectRoot)
        },
      )

      // ─── 学习进度 ───

      // ─── 文件笔记 / 文件完成标记 ───
      // (must be before /api/progress/file and /api/progress — prefix matching)

      // GET  /api/progress/file-meta/list — 获取所有文件笔记列表
      server.middlewares.use(
        '/api/progress/file-meta/list',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }
          try {
            const entries = listFileNotes(projectRoot)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ entries }))
          } catch (err) {
            res.statusCode = 500
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Failed',
              }),
            )
          }
        },
      )

      // GET /api/progress/file-meta?path=... — 获取单文件笔记
      // PUT /api/progress/file-meta — 更新文件笔记/完成状态
      server.middlewares.use(
        '/api/progress/file-meta',
        (req: IncomingMessage, res: ServerResponse) => {
          res.setHeader('Content-Type', 'application/json')

          if (req.method === 'GET') {
            const url = new URL(req.url || '/', `http://${req.headers.host}`)
            const filePath = url.searchParams.get('path')
            if (!filePath) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Missing path parameter' }))
              return
            }
            const entry = getFileNote(projectRoot, filePath) ?? null
            res.end(JSON.stringify({ filePath, entry }))
            return
          }

          if (req.method === 'PUT') {
            let body = ''
            req.on('data', chunk => {
              body += chunk
            })
            req.on('end', () => {
              try {
                const { filePath, completed, note } = JSON.parse(body)
                if (!filePath || typeof filePath !== 'string') {
                  res.statusCode = 400
                  res.end(JSON.stringify({ error: 'Missing filePath' }))
                  return
                }
                const patch: { completed?: boolean; note?: string } = {}
                if (completed !== undefined)
                  patch.completed = Boolean(completed)
                if (note !== undefined) patch.note = String(note)
                const entry = setFileNote(projectRoot, filePath, patch)
                res.end(JSON.stringify({ entry }))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        },
      )

      // GET /api/progress/file?path=src/query.ts — 获取某文件所有符号进度
      // (must be before /api/progress — connect matches by prefix)
      server.middlewares.use(
        '/api/progress/file',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const filePath = url.searchParams.get('path')

          if (!filePath) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'Missing path parameter' }))
            return
          }

          const entries = getFileProgress(projectRoot, filePath)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ path: filePath, entries }))
        },
      )

      // ─── Notes Search ───
      // (must be before /api/progress — connect matches by prefix)

      // GET /api/progress/search?q=keyword&kind=symbol|file|all — 搜索笔记
      server.middlewares.use(
        '/api/progress/search',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const q = url.searchParams.get('q') || ''
          const kind = url.searchParams.get('kind') || 'all'
          res.setHeader('Content-Type', 'application/json')

          if (kind === 'file') {
            const results = searchFileNotes(projectRoot, q)
            res.end(JSON.stringify({ results }))
            return
          }

          if (kind === 'symbol') {
            const results = searchNotes(projectRoot, q)
            res.end(JSON.stringify({ results }))
            return
          }

          // all: merge symbol + file notes
          const symbolResults = searchNotes(projectRoot, q).map(r => ({
            ...r,
            kind: 'symbol' as const,
          }))
          const fileResults = searchFileNotes(projectRoot, q).map(r => ({
            ...r,
            kind: 'file' as const,
          }))
          const results = [...symbolResults, ...fileResults].sort((a, b) =>
            (b.updatedAt || '').localeCompare(a.updatedAt || ''),
          )
          res.end(JSON.stringify({ results }))
        },
      )

      // ─── Dashboard Stats ───
      // (must be before /api/progress — connect matches by prefix)

      // GET /api/progress/stats?days=30 — 聚合统计（带真实 unstudied 分母）
      server.middlewares.use(
        '/api/progress/stats',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const days = Number(url.searchParams.get('days')) || 30
          // 异步获取真实符号总数（不阻塞响应，首次可能较慢）
          let totalSymbolCount: number | undefined
          try {
            totalSymbolCount = countAllSymbols(projectRoot)
          } catch {
            /* fallback to undefined */
          }
          const stats = getStats(projectRoot, days, totalSymbolCount)
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ...stats, totalSymbolCount }))
        },
      )

      // GET /api/progress/file-coverage — 每文件 studied/total 覆盖率
      server.middlewares.use(
        '/api/progress/file-coverage',
        (_req: IncomingMessage, res: ServerResponse) => {
          try {
            // 收集所有有 progress 条目的文件，plus a quick symbol count
            const totalByFile: Record<string, number> = {}
            const entries = readProgress(projectRoot)
            for (const key of Object.keys(entries)) {
              const sep = key.indexOf('::')
              if (sep === -1) continue
              const fp = key.slice(0, sep)
              if (!(fp in totalByFile)) {
                // Count symbols for this file
                try {
                  const r = extractSymbols(fp, projectRoot)
                  totalByFile[fp] = r?.symbols.length ?? 1
                } catch {
                  totalByFile[fp] = 1
                }
              }
            }
            const coverage = getFileCoverage(projectRoot, totalByFile)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ coverage }))
          } catch (err) {
            res.statusCode = 500
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Failed',
              }),
            )
          }
        },
      )

      // GET /api/progress — 读取全部进度
      // POST /api/progress — 更新一条进度 { key, status, note }
      server.middlewares.use(
        '/api/progress',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method === 'GET') {
            const store = readProgress(projectRoot)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ progress: store }))
            return
          }

          if (req.method === 'POST') {
            let body = ''
            req.on('data', chunk => {
              body += chunk
            })
            req.on('end', () => {
              try {
                const { key, status, note, completed } = JSON.parse(body)
                if (!key || typeof key !== 'string') {
                  res.statusCode = 400
                  res.end(JSON.stringify({ error: 'Missing key' }))
                  return
                }
                const validStatuses = ['unstudied', 'studying', 'studied']
                if (status && !validStatuses.includes(status)) {
                  res.statusCode = 400
                  res.end(
                    JSON.stringify({ error: `Invalid status: ${status}` }),
                  )
                  return
                }
                // Merge with existing so partial updates don't overwrite fields
                const existing = getProgressEntry(projectRoot, key)
                const now = new Date().toISOString()
                setProgressEntry(projectRoot, key, {
                  status: status ?? existing?.status ?? 'studying',
                  note: note !== undefined ? note : (existing?.note ?? ''),
                  updatedAt: now,
                  completed:
                    completed !== undefined
                      ? Boolean(completed)
                      : existing?.completed,
                  completedAt:
                    completed === true && !existing?.completedAt
                      ? now
                      : completed === false
                        ? undefined
                        : existing?.completedAt,
                })
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ success: true }))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        },
      )

      // ─── Knowledge Graph ───

      // graph.json mtime 缓存：避免每次请求都 JSON.parse 36MB 文件
      let cachedGraph: {
        mtime: number
        data: GraphJson
        nodeById: Map<string, GraphNode>
      } | null = null

      function loadCachedGraph(graphPath: string): {
        data: GraphJson
        nodeById: Map<string, GraphNode>
      } {
        const stat = fs.statSync(graphPath)
        if (cachedGraph && cachedGraph.mtime === stat.mtimeMs) {
          return { data: cachedGraph.data, nodeById: cachedGraph.nodeById }
        }
        const data = JSON.parse(
          fs.readFileSync(graphPath, 'utf-8'),
        ) as GraphJson
        const nodeById = new Map<string, GraphNode>()
        for (const n of data.nodes) nodeById.set(n.id, n)
        cachedGraph = { mtime: stat.mtimeMs, data, nodeById }
        return { data, nodeById }
      }

      // POST /api/graph/regen — 触发 graph 重新生成
      server.middlewares.use(
        '/api/graph/regen',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }
          // Fire-and-forget: spawn regen-graph in background
          const { spawn } =
            require('node:child_process') as typeof import('node:child_process')
          const scriptPath = path.join(
            projectRoot,
            'learning-web',
            'scripts',
            'regen-graph.ts',
          )
          const child = spawn('bun', ['run', scriptPath], {
            cwd: path.join(projectRoot, 'learning-web'),
            detached: true,
            stdio: 'ignore',
          })
          child.unref()
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              success: true,
              message: 'regen started in background',
            }),
          )
        },
      )

      // GET /api/graph?file=src/query.ts&relations=imports,calls&limit=500
      //   - 无参: 返回文件级概览（按目录聚合）
      //   - file=xxx: 返回该文件内节点 + 其 N 跳邻居
      server.middlewares.use(
        '/api/graph',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const fileFilter = url.searchParams.get('file') || ''
          const dirFilter = url.searchParams.get('dir') || ''
          const relationsParam = url.searchParams.get('relations') || ''
          const limit = Number(url.searchParams.get('limit')) || 800

          const graphPath = path.join(
            projectRoot,
            'learning-web',
            '.cache',
            'graphify',
            'graph.json',
          )
          if (!fs.existsSync(graphPath)) {
            res.statusCode = 404
            res.end(
              JSON.stringify({
                error: 'graph.json not found. Run `bun run regen-graph` first.',
              }),
            )
            return
          }

          try {
            const { data: raw, nodeById } = loadCachedGraph(graphPath)
            const relations = relationsParam
              ? relationsParam.split(',').map(s => s.trim())
              : null

            let { nodes, edges } = filterGraph(raw, nodeById, {
              fileFilter,
              dirFilter,
              relations,
              limit,
            })
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                nodes,
                edges,
                totalNodes: raw.nodes.length,
                totalEdges: getEdges(raw).length,
                filtered: !!(fileFilter || dirFilter || relations),
              }),
            )
          } catch (err) {
            res.statusCode = 500
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : 'Failed',
              }),
            )
          }
        },
      )

      // ─── GET /api/code-search — 全文代码搜索（ripgrep）───
      server.middlewares.use(
        '/api/code-search',
        (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'GET') {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }

          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const q = url.searchParams.get('q')?.trim()
          if (!q) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Missing query parameter: q' }))
            return
          }

          const subPath = url.searchParams.get('path') || ''
          const glob = url.searchParams.get('glob') || ''
          const regex = url.searchParams.get('regex') === '1'

          // 路径安全检查
          let targetDir = projectRoot
          if (subPath) {
            const resolved = safeResolve(projectRoot, subPath)
            if (!resolved) {
              res.statusCode = 403
              res.end(
                JSON.stringify({
                  error: 'Access denied: path escapes project root',
                }),
              )
              return
            }
            if (
              !fs.existsSync(resolved) ||
              !fs.statSync(resolved).isDirectory()
            ) {
              res.statusCode = 404
              res.end(
                JSON.stringify({ error: `Directory not found: ${subPath}` }),
              )
              return
            }
            targetDir = resolved
          }

          const rgPath = resolveRgBinary(projectRoot)
          const args: string[] = ['--json', '--max-count', '200']
          if (!regex) args.push('-F')
          if (glob) args.push('-g', glob)
          args.push(q, targetDir)

          const start = Date.now()
          const child = spawn(rgPath, args, {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          })

          let stdout = ''
          let stderr = ''
          let timedOut = false

          const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
          }, 10_000)

          child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString()
          })
          child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
          })

          child.on('exit', () => {
            clearTimeout(timer)
            const elapsed_ms = Date.now() - start
            const matches: CodeSearchMatchInternal[] = []
            let truncated = false

            // rg --json 输出 NDJSON，每行是一个 JSON 对象
            for (const line of stdout.split('\n')) {
              if (!line.trim()) continue
              if (matches.length >= 200) {
                truncated = true
                break
              }
              try {
                const obj = JSON.parse(line) as {
                  type?: string
                  data?: {
                    path?: { text?: string }
                    lines?: { text?: string }
                    line_number?: number
                    submatches?: Array<{
                      match: { text: string }
                      start: number
                    }>
                  }
                }
                if (obj.type !== 'match' || !obj.data) continue
                const { path: p, lines, line_number, submatches } = obj.data
                if (!p?.text || !line_number || !submatches?.length) continue
                const matchLine = (lines?.text || '').replace(/\n$/, '')
                const firstSub = submatches[0]
                matches.push({
                  file: path.relative(projectRoot, p.text).replace(/\\/g, '/'),
                  line: line_number,
                  column: firstSub.start + 1,
                  match: matchLine,
                  matchText: firstSub.match.text,
                })
              } catch {
                // 跳过非 JSON 行
              }
            }

            if (timedOut) {
              res.statusCode = 504
              res.end(
                JSON.stringify({
                  error:
                    'Search timed out (10s limit). Try a more specific query.',
                }),
              )
              return
            }

            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                query: q,
                results: matches,
                truncated,
                elapsed_ms,
                stderr: stderr.trim() || undefined,
              }),
            )
          })

          child.on('error', err => {
            clearTimeout(timer)
            res.statusCode = 500
            res.end(
              JSON.stringify({
                error: `Failed to spawn ripgrep: ${err.message}. Ensure rg binary exists or install system ripgrep.`,
              }),
            )
          })
        },
      )

      // ─── 行级标注 ───

      // GET /api/annotations?filePath=src/query.ts  POST  PATCH  DELETE?id=xxx
      server.middlewares.use(
        '/api/annotations',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)

          if (req.method === 'GET') {
            const filePath = url.searchParams.get('filePath') ?? undefined
            const annotations = listAnnotations(projectRoot, filePath)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ annotations }))
            return
          }

          if (req.method === 'POST' || req.method === 'PATCH') {
            let body = ''
            req.on('data', c => {
              body += c
            })
            req.on('end', () => {
              try {
                const data = JSON.parse(body)
                if (!data.filePath || !data.startLine) {
                  res.statusCode = 400
                  res.end(
                    JSON.stringify({
                      error: 'filePath and startLine required',
                    }),
                  )
                  return
                }
                const now = new Date().toISOString()
                const annotation = {
                  id: data.id || crypto.randomUUID(),
                  filePath: data.filePath,
                  startLine: Number(data.startLine),
                  endLine: Number(data.endLine ?? data.startLine),
                  color: data.color || 'yellow',
                  comment: data.comment || '',
                  createdAt: data.createdAt || now,
                  updatedAt: now,
                  ...(data.startCol !== undefined && {
                    startCol: Number(data.startCol),
                  }),
                  ...(data.endCol !== undefined && {
                    endCol: Number(data.endCol),
                  }),
                  ...(data.styles && { styles: data.styles }),
                  ...(data.selectedText && {
                    selectedText: String(data.selectedText),
                  }),
                }
                setAnnotation(projectRoot, annotation)
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ annotation }))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          if (req.method === 'DELETE') {
            const id = url.searchParams.get('id')
            if (!id) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'id required' }))
              return
            }
            deleteAnnotation(projectRoot, id)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: true }))
            return
          }

          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        },
      )

      // ─── 书签 ───

      // GET /api/bookmarks  POST { filePath, tag? }  DELETE?filePath=xxx
      // GET /api/bookmarks/check?filePath=xxx
      server.middlewares.use(
        '/api/bookmarks/check',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const filePath = url.searchParams.get('filePath')
          if (!filePath) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'filePath required' }))
            return
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({ bookmarked: isBookmarked(projectRoot, filePath) }),
          )
        },
      )

      server.middlewares.use(
        '/api/bookmarks',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)

          if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ bookmarks: listBookmarks(projectRoot) }))
            return
          }

          if (req.method === 'POST') {
            let body = ''
            req.on('data', c => {
              body += c
            })
            req.on('end', () => {
              try {
                const { filePath, tag } = JSON.parse(body)
                if (!filePath) {
                  res.statusCode = 400
                  res.end(JSON.stringify({ error: 'filePath required' }))
                  return
                }
                addBookmark(projectRoot, filePath, tag)
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ success: true }))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          if (req.method === 'DELETE') {
            const filePath = url.searchParams.get('filePath')
            if (!filePath) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'filePath required' }))
              return
            }
            removeBookmark(projectRoot, filePath)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: true }))
            return
          }

          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        },
      )

      // ─── 最近活动 ───

      // GET /api/activity/recent?limit=10
      server.middlewares.use(
        '/api/activity/recent',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          const limit = Number(url.searchParams.get('limit')) || 10
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({ activity: getRecentActivity(projectRoot, limit) }),
          )
        },
      )

      // ─── 学习路径进度 ───

      // GET /api/paths/progress?pathId=xxx  POST { pathId, stationId, summary, nextStationIndex }
      server.middlewares.use(
        '/api/paths/progress',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)

          if (req.method === 'GET') {
            const pathId = url.searchParams.get('pathId')
            if (!pathId) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'pathId required' }))
              return
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(getPathProgress(projectRoot, pathId)))
            return
          }

          if (req.method === 'POST') {
            let body = ''
            req.on('data', c => {
              body += c
            })
            req.on('end', () => {
              try {
                const { pathId, stationId, summary, nextStationIndex } =
                  JSON.parse(body)
                if (!pathId || !stationId || typeof summary !== 'string') {
                  res.statusCode = 400
                  res.end(
                    JSON.stringify({
                      error: 'pathId, stationId, summary required',
                    }),
                  )
                  return
                }
                completeStation(
                  projectRoot,
                  pathId,
                  stationId,
                  summary,
                  nextStationIndex ?? 0,
                )
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ success: true }))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        },
      )

      // ─── Chat 会话管理 ───

      // /api/chat/sessions — list / create / get / rename / delete / append messages
      server.middlewares.use(
        '/api/chat/sessions',
        (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url || '/', `http://${req.headers.host}`)
          // pathname like /api/chat/sessions, /api/chat/sessions/123, /api/chat/sessions/123/messages
          const parts = url.pathname
            .replace(/^\/api\/chat\/sessions\/?/, '')
            .split('/')
            .filter(Boolean)
          const sessionId = parts[0] || null
          const sub = parts[1] || null // 'messages' for /sessions/:id/messages

          // POST /api/chat/sessions — create
          if (!sessionId && req.method === 'POST') {
            let body = ''
            req.on('data', c => {
              body += c
            })
            req.on('end', () => {
              try {
                const { contextFile, contextSymbol } = JSON.parse(body || '{}')
                const session = createSession(projectRoot, {
                  contextFile,
                  contextSymbol,
                })
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify(session))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          // GET /api/chat/sessions — list
          if (!sessionId && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ sessions: listSessions(projectRoot) }))
            return
          }

          if (!sessionId) {
            res.statusCode = 405
            res.end(JSON.stringify({ error: 'Method not allowed' }))
            return
          }

          // POST /api/chat/sessions/:id/messages — append
          if (sub === 'messages' && req.method === 'POST') {
            let body = ''
            req.on('data', c => {
              body += c
            })
            req.on('end', () => {
              try {
                const { messages } = JSON.parse(body)
                if (!Array.isArray(messages)) {
                  res.statusCode = 400
                  res.end(JSON.stringify({ error: 'messages array required' }))
                  return
                }
                const updated = appendMessages(projectRoot, sessionId, messages)
                if (!updated) {
                  res.statusCode = 404
                  res.end(JSON.stringify({ error: 'Session not found' }))
                  return
                }
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify(updated))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          // GET /api/chat/sessions/:id — get full session
          if (!sub && req.method === 'GET') {
            const session = getSession(projectRoot, sessionId)
            if (!session) {
              res.statusCode = 404
              res.end(JSON.stringify({ error: 'Session not found' }))
              return
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(session))
            return
          }

          // PATCH /api/chat/sessions/:id — rename
          if (!sub && req.method === 'PATCH') {
            let body = ''
            req.on('data', c => {
              body += c
            })
            req.on('end', () => {
              try {
                const { title } = JSON.parse(body)
                if (!title) {
                  res.statusCode = 400
                  res.end(JSON.stringify({ error: 'title required' }))
                  return
                }
                const updated = renameSession(projectRoot, sessionId, title)
                if (!updated) {
                  res.statusCode = 404
                  res.end(JSON.stringify({ error: 'Session not found' }))
                  return
                }
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify(updated))
              } catch (err) {
                res.statusCode = 500
                res.end(
                  JSON.stringify({
                    error: err instanceof Error ? err.message : 'Failed',
                  }),
                )
              }
            })
            return
          }

          // DELETE /api/chat/sessions/:id
          if (!sub && req.method === 'DELETE') {
            const ok = deleteSession(projectRoot, sessionId)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ success: ok }))
            return
          }

          res.statusCode = 405
          res.end(JSON.stringify({ error: 'Method not allowed' }))
        },
      )
    },
  }
}

// ─── 辅助函数 ───

interface CodeSearchMatchInternal {
  file: string
  line: number
  column: number
  match: string
  matchText: string
}

function resolveRgBinary(projectRoot: string): string {
  const arch = process.arch // x64 / arm64
  const platform = process.platform // win32 / darwin / linux
  const ext = platform === 'win32' ? '.exe' : ''
  const builtin = path.join(
    projectRoot,
    'src',
    'utils',
    'vendor',
    'ripgrep',
    `${arch}-${platform}`,
    `rg${ext}`,
  )
  if (fs.existsSync(builtin)) return builtin
  return 'rg' // fallback to system PATH
}

function safeResolve(root: string, filePath: string): string | null {
  const resolved = path.resolve(root, filePath)
  if (!resolved.startsWith(root)) return null
  return resolved
}

/**
 * 尝试解析文件路径，若原路径不存在则尝试 TypeScript 扩展名回退。
 * 本项目以 TypeScript 为主，访问 .js 时自动尝试 .ts/.tsx/.jsx。
 */
function resolveWithFallback(
  root: string,
  filePath: string,
): { resolved: string | null; actualPath: string } {
  const resolved = safeResolve(root, filePath)
  if (!resolved) return { resolved: null, actualPath: filePath }

  if (fs.existsSync(resolved)) return { resolved, actualPath: filePath }

  // .js → .ts / .tsx / .jsx
  if (filePath.endsWith('.js')) {
    const base = filePath.slice(0, -3)
    for (const ext of ['.ts', '.tsx', '.jsx']) {
      const candidate = base + ext
      const r = safeResolve(root, candidate)
      if (r && fs.existsSync(r)) return { resolved: r, actualPath: candidate }
    }
  }

  // 无扩展名 → 尝试常见扩展名
  if (!path.extname(filePath)) {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      const candidate = filePath + ext
      const r = safeResolve(root, candidate)
      if (r && fs.existsSync(r)) return { resolved: r, actualPath: candidate }
    }
  }

  return { resolved, actualPath: filePath } // 返回原始路径，让调用方报 404
}

interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '__tests__',
  '.cache',
])

function scanDirectory(
  root: string,
  relativePath: string,
  topDirs: string[],
  maxDepth: number,
): FileTreeNode[] {
  const fullPath = path.join(root, relativePath)
  let entries: fs.Dirent[]

  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: FileTreeNode[] = []

  // 如果是根目录，只扫描指定的顶级目录
  const dirsToScan = relativePath === '' ? topDirs : null

  for (const entry of entries) {
    const name = entry.name

    if (dirsToScan && !dirsToScan.includes(name) && entry.isDirectory()) {
      continue
    }

    if (SKIP_DIRS.has(name)) continue
    if (name.startsWith('.') && name !== '.env') continue

    const entryPath = relativePath ? `${relativePath}/${name}` : name

    if (entry.isDirectory()) {
      const children =
        maxDepth > 0 ? scanDirectory(root, entryPath, [], maxDepth - 1) : []
      nodes.push({ name, path: entryPath, type: 'directory', children })
    } else if (entry.isFile()) {
      // 只包含源码相关的文件
      if (
        name.endsWith('.ts') ||
        name.endsWith('.tsx') ||
        name.endsWith('.js') ||
        name.endsWith('.jsx') ||
        name.endsWith('.md') ||
        name.endsWith('.mdx') ||
        name.endsWith('.json') ||
        name.endsWith('.css')
      ) {
        nodes.push({ name, path: entryPath, type: 'file' })
      }
    }
  }

  // 排序：目录在前，然后按名称
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return nodes
}

/* ─── Knowledge Graph helpers ──────────────────── */

interface GraphNode {
  id: string
  label: string
  file_type?: string
  source_file?: string
  source_location?: string
  metadata?: { language?: string; kind?: string }
  _origin?: string
}

interface GraphEdge {
  source: string
  target: string
  relation: string
  context?: string
  confidence?: string
  confidence_score?: number
  source_file?: string
  source_location?: string
  weight?: number
}

interface GraphJson {
  nodes: GraphNode[]
  edges?: GraphEdge[]
  links?: GraphEdge[]
  input_tokens?: number
  output_tokens?: number
}

function getEdges(raw: GraphJson): GraphEdge[] {
  return raw.edges || raw.links || []
}

interface FilterOptions {
  fileFilter: string
  dirFilter: string
  relations: string[] | null
  limit: number
}

// 需要排除的路径前缀
const EXCLUDED_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  '.cache/',
  'graphify-out/',
  '.husky/',
  'coverage/',
  '__tests__/',
]

function isIncluded(file: string): boolean {
  if (!file) return false
  if (EXCLUDED_PREFIXES.some(p => file.startsWith(p) || file.includes(`/${p}`)))
    return false
  // 只包含有意义的文件类型
  const tsLike = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)
  const config = /(\.json|\.md|\.mdx|\.yaml|\.yml|\.toml)$/.test(file)
  return tsLike || config
}

// 概览模式白名单：只保留跨文件依赖关系，排除层级/内部噪声
const OVERVIEW_EDGE_TYPES = new Set([
  'imports',
  'imports_from',
  'calls',
  'extends',
  'implements',
  'inherits',
  're_exports',
  'references',
  'rationale_for',
])

const RELATION_PRIORITY = [
  'extends',
  'implements',
  'inherits',
  'imports',
  'imports_from',
  're_exports',
  'references',
  'calls',
  'rationale_for',
]

/**
 * 从 graphify 的 graph.json 中按条件过滤，返回精简后的节点和边。
 *
 * 策略：
 * - 如果指定 fileFilter：返回该文件内所有节点 + 与它相连的邻居（1 跳）
 * - 如果指定 dirFilter：返回该目录（含子目录）内的所有文件节点
 * - 否则：文件级概览 — 每个文件折叠成 1 个节点（取文件名为 label），边为文件间 imports/calls
 */
function filterGraph(
  raw: GraphJson,
  nodeById: Map<string, GraphNode>,
  opts: FilterOptions,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (opts.fileFilter) {
    return filterByFile(raw, nodeById, opts.fileFilter, opts.limit)
  }
  if (opts.dirFilter) {
    return filterByDir(raw, opts.dirFilter, opts.limit)
  }
  return buildFileOverview(raw, nodeById, opts.limit)
}

function filterByFile(
  raw: GraphJson,
  nodeById: Map<string, GraphNode>,
  filePath: string,
  limit: number,
) {
  const directNodes = raw.nodes.filter(n => n.source_file === filePath)
  const directIds = new Set(directNodes.map(n => n.id))
  const neighbors = new Set<string>()
  const neighborEdges: GraphEdge[] = []

  for (const e of getEdges(raw)) {
    if (directIds.has(e.source)) {
      neighbors.add(e.target)
      neighborEdges.push(e)
    } else if (directIds.has(e.target)) {
      neighbors.add(e.source)
      neighborEdges.push(e)
    }
  }

  const neighborNodes = raw.nodes
    .filter(n => neighbors.has(n.id) && n.source_file !== filePath)
    .slice(0, limit - directNodes.length)

  const includedIds = new Set([
    ...directNodes.map(n => n.id),
    ...neighborNodes.map(n => n.id),
  ])
  const edges = neighborEdges.filter(
    e => includedIds.has(e.source) && includedIds.has(e.target),
  )

  return { nodes: [...directNodes, ...neighborNodes], edges }
}

function filterByDir(raw: GraphJson, dirPath: string, limit: number) {
  const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
  const nodes = raw.nodes
    .filter(
      n =>
        n.source_file &&
        (n.source_file.startsWith(prefix) || n.source_file === dirPath),
    )
    .slice(0, limit)
  const ids = new Set(nodes.map(n => n.id))
  const edges = getEdges(raw).filter(
    e => ids.has(e.source) && ids.has(e.target),
  )
  return { nodes, edges }
}

/**
 * 文件级概览：每个源文件折叠成 1 个节点，边为文件间关系。
 * 只包含 src/ 和 packages/ 下的 TS/TSX 文件。
 * 使用 Map 查找（O(1)）代替 raw.nodes.find（O(N)），按文件对聚合边。
 */
function buildFileOverview(
  raw: GraphJson,
  nodeById: Map<string, GraphNode>,
  limit: number,
) {
  const fileMap = new Map<string, GraphNode>()

  for (const n of raw.nodes) {
    if (!n.source_file) continue
    if (!isIncluded(n.source_file)) continue
    if (
      !n.source_file.startsWith('src/') &&
      !n.source_file.startsWith('packages/')
    )
      continue
    if (n.source_file.includes('.test.') || n.source_file.includes('__tests__'))
      continue
    if (!/\.(ts|tsx|js|jsx)$/.test(n.source_file)) continue

    if (!fileMap.has(n.source_file)) {
      const parts = n.source_file.split('/')
      const filename = parts[parts.length - 1]
      fileMap.set(n.source_file, {
        id: `file:${n.source_file}`,
        label: filename,
        file_type: 'file',
        source_file: n.source_file,
        source_location: 'L1',
        metadata: {
          kind: 'file',
          language: n.metadata?.language || 'typescript',
        },
        _origin: 'overview',
      })
    }
  }

  const nodes = Array.from(fileMap.values()).slice(0, limit)

  // 构建源文件 → 节点 ID 映射
  const fileToNodeId = new Map<string, string>()
  for (const n of nodes) {
    if (n.source_file) fileToNodeId.set(n.source_file, n.id)
  }

  // 按文件对聚合边：保留最高优先级关系类型，累计 weight
  const edgeAgg = new Map<string, GraphEdge>()

  for (const e of getEdges(raw)) {
    if (!OVERVIEW_EDGE_TYPES.has(e.relation)) continue

    const srcNode = nodeById.get(e.source)
    const tgtNode = nodeById.get(e.target)
    if (!srcNode?.source_file || !tgtNode?.source_file) continue
    if (srcNode.source_file === tgtNode.source_file) continue

    const srcFileId = fileToNodeId.get(srcNode.source_file)
    const tgtFileId = fileToNodeId.get(tgtNode.source_file)
    if (!srcFileId || !tgtFileId) continue

    const key = `${srcFileId}|${tgtFileId}`
    const existing = edgeAgg.get(key)
    if (existing) {
      existing.weight = (existing.weight ?? 1) + 1
      const newPri = RELATION_PRIORITY.indexOf(e.relation)
      const oldPri = RELATION_PRIORITY.indexOf(existing.relation)
      if (newPri >= 0 && (oldPri === -1 || newPri < oldPri)) {
        existing.relation = e.relation
      }
    } else {
      edgeAgg.set(key, {
        source: srcFileId,
        target: tgtFileId,
        relation: e.relation,
        source_file: srcNode.source_file,
        weight: 1,
      })
    }
    if (edgeAgg.size >= limit * 3) break
  }

  return { nodes, edges: Array.from(edgeAgg.values()) }
}
