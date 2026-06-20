import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { readCache, writeCache } from './cache'

/**
 * 使用 TS Compiler API 解析单文件，提取所有顶层符号
 * （函数 / 方法 / 类 / 接口 / 类型 / 枚举 / 常量 / 变量）
 */

export interface SymbolInfo {
  name: string
  kind:
    | 'function'
    | 'method'
    | 'class'
    | 'interface'
    | 'type'
    | 'enum'
    | 'const'
    | 'variable'
  line: number
  endLine: number
  column: number
  exported: boolean
  visibility?: 'public' | 'private' | 'protected'
  isStatic?: boolean
  isAsync?: boolean
  jsdoc?: string
  signature?: string
  parentClass?: string
}

interface ExtractResult {
  symbols: SymbolInfo[]
}

/**
 * 提取文件中的所有符号（带缓存）
 */
export function extractSymbols(
  filePath: string,
  projectRoot: string,
): ExtractResult | null {
  // 先查缓存
  const cached = readCache<ExtractResult>('symbols', filePath)
  if (cached) return cached

  const absolutePath = resolveFilePath(filePath, projectRoot)
  if (!absolutePath) return null

  let content: string
  try {
    content = fs.readFileSync(absolutePath, 'utf-8')
  } catch {
    return null
  }

  const scriptKind = absolutePath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : absolutePath.endsWith('.ts')
      ? ts.ScriptKind.TS
      : absolutePath.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS

  const sourceFile = ts.createSourceFile(
    absolutePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )

  const symbols: SymbolInfo[] = []
  const lines = content.split('\n')

  function getLineAndColumn(pos: number): { line: number; column: number } {
    const lc = sourceFile.getLineAndCharacterOfPosition(pos)
    return { line: lc.line + 1, column: lc.character + 1 }
  }

  function getEndLine(end: number): number {
    return sourceFile.getLineAndCharacterOfPosition(end).line + 1
  }

  function getJsDoc(node: ts.Node): string | undefined {
    const jsDocs = ts.getJSDocTags(node)
    // 获取 JSDoc 注释文本
    const fullText = sourceFile.getFullText()
    const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart())
    if (!ranges) return undefined

    for (const range of ranges) {
      const commentText = fullText.slice(range.pos, range.end)
      if (commentText.startsWith('/**')) {
        // 提取 JSDoc 内容（去掉 /** * 和 */）
        return (
          commentText
            .replace(/^\/\*\*\s*/, '')
            .replace(/\s*\*\/$/, '')
            .split('\n')
            .map(l => l.replace(/^\s*\*\s?/, ''))
            .filter(l => !l.startsWith('@'))
            .join('\n')
            .trim() || undefined
        )
      }
    }
    return undefined
  }

  function buildFunctionSignature(
    name: string,
    params: ts.NodeArray<ts.ParameterDeclaration> | undefined,
    typeParams: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    returnType: ts.TypeNode | undefined,
  ): string {
    const typeParamStr = typeParams?.length
      ? `<${typeParams.map(tp => tp.getText(sourceFile)).join(', ')}>`
      : ''
    const paramStr = params
      ? `(${params.map(p => p.getText(sourceFile)).join(', ')})`
      : '()'
    const returnStr = returnType ? `: ${returnType.getText(sourceFile)}` : ''
    return `${name}${typeParamStr}${paramStr}${returnStr}`
  }

  function isExported(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)
      : undefined
    return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
  }

  function getVisibility(
    node: ts.Node,
  ): 'public' | 'private' | 'protected' | undefined {
    const modifiers = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)
      : undefined
    if (!modifiers) return undefined
    for (const m of modifiers) {
      if (m.kind === ts.SyntaxKind.PrivateKeyword) return 'private'
      if (m.kind === ts.SyntaxKind.ProtectedKeyword) return 'protected'
      if (m.kind === ts.SyntaxKind.PublicKeyword) return 'public'
    }
    return undefined
  }

  function isStatic(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)
      : undefined
    return modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) ?? false
  }

  function isAsync(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)
      : undefined
    return modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false
  }

  function visitClass(node: ts.ClassDeclaration) {
    const name = node.name?.getText(sourceFile) || '<anonymous>'
    const start = getLineAndColumn(node.getStart(sourceFile))
    const jsdoc = getJsDoc(node)

    symbols.push({
      name,
      kind: 'class',
      line: start.line,
      endLine: getEndLine(node.getEnd()),
      column: start.column,
      exported: isExported(node),
      jsdoc,
    })

    // 类的成员
    for (const member of node.members) {
      let memberName: string | undefined
      let kind: SymbolInfo['kind'] = 'method'
      let signature: string | undefined

      if (ts.isMethodDeclaration(member)) {
        memberName = member.name.getText(sourceFile)
        kind = 'method'
        signature = buildFunctionSignature(
          memberName,
          member.parameters,
          member.typeParameters,
          member.type,
        )
      } else if (ts.isConstructorDeclaration(member)) {
        memberName = 'constructor'
        kind = 'method'
        signature = buildFunctionSignature(
          'constructor',
          member.parameters,
          undefined,
          undefined,
        )
      } else if (ts.isPropertyDeclaration(member)) {
        memberName = member.name.getText(sourceFile)
        kind = 'const'
      } else if (ts.isGetAccessorDeclaration(member)) {
        memberName = member.name.getText(sourceFile)
        kind = 'method'
      } else if (ts.isSetAccessorDeclaration(member)) {
        memberName = member.name.getText(sourceFile)
        kind = 'method'
      }

      if (!memberName) continue

      const memberStart = getLineAndColumn(member.getStart(sourceFile))
      symbols.push({
        name: memberName,
        kind,
        line: memberStart.line,
        endLine: getEndLine(member.getEnd()),
        column: memberStart.column,
        exported: true, // 类成员默认对外部"可见"
        visibility: getVisibility(member),
        isStatic: isStatic(member),
        isAsync: isAsync(member),
        jsdoc: getJsDoc(member),
        signature,
        parentClass: name,
      })
    }
  }

  function visitNode(node: ts.Node, parentName?: string) {
    // ── FunctionDeclaration ──
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile)
      const start = getLineAndColumn(node.getStart(sourceFile))
      const signature = buildFunctionSignature(
        name,
        node.parameters,
        node.typeParameters,
        node.type,
      )
      symbols.push({
        name,
        kind: 'function',
        line: start.line,
        endLine: getEndLine(node.getEnd()),
        column: start.column,
        exported: isExported(node),
        isAsync: isAsync(node),
        jsdoc: getJsDoc(node),
        signature,
      })
      return
    }

    // ── ClassDeclaration ──
    if (ts.isClassDeclaration(node)) {
      visitClass(node)
      return
    }

    // ── InterfaceDeclaration ──
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile)
      const start = getLineAndColumn(node.getStart(sourceFile))
      symbols.push({
        name,
        kind: 'interface',
        line: start.line,
        endLine: getEndLine(node.getEnd()),
        column: start.column,
        exported: isExported(node),
        jsdoc: getJsDoc(node),
        signature: `interface ${name}`,
      })
      return
    }

    // ── TypeAliasDeclaration ──
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile)
      const start = getLineAndColumn(node.getStart(sourceFile))
      symbols.push({
        name,
        kind: 'type',
        line: start.line,
        endLine: getEndLine(node.getEnd()),
        column: start.column,
        exported: isExported(node),
        jsdoc: getJsDoc(node),
      })
      return
    }

    // ── EnumDeclaration ──
    if (ts.isEnumDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile)
      const start = getLineAndColumn(node.getStart(sourceFile))
      symbols.push({
        name,
        kind: 'enum',
        line: start.line,
        endLine: getEndLine(node.getEnd()),
        column: start.column,
        exported: isExported(node),
        jsdoc: getJsDoc(node),
      })
      return
    }

    // ── VariableStatement（顶层 const/let） ──
    if (ts.isVariableStatement(node)) {
      const exported = isExported(node)
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        const name = decl.name.getText(sourceFile)
        const start = getLineAndColumn(decl.getStart(sourceFile))

        // 判断是否是箭头函数赋值
        let kind: SymbolInfo['kind'] = 'const'
        let signature: string | undefined
        let isAsyncFn = false

        if (decl.initializer) {
          if (
            ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer)
          ) {
            kind = 'function'
            const fn = decl.initializer as
              | ts.ArrowFunction
              | ts.FunctionExpression
            signature = buildFunctionSignature(
              name,
              fn.parameters,
              fn.typeParameters,
              fn.type,
            )
            isAsyncFn = isAsync(fn)
          } else if (
            ts.isCallExpression(decl.initializer) ||
            ts.isAsExpression(decl.initializer)
          ) {
            // 可能是 as any / 复杂表达式，标记为 const
            kind = 'const'
          }
        }

        symbols.push({
          name,
          kind,
          line: start.line,
          endLine: getEndLine(node.getEnd()),
          column: start.column,
          exported,
          isAsync: isAsyncFn,
          jsdoc: getJsDoc(node),
          signature,
        })
      }
      return
    }

    // 对顶层节点遍历子节点
    ts.forEachChild(node, child => visitNode(child, parentName))
  }

  ts.forEachChild(sourceFile, visitNode)

  // 按行号排序
  symbols.sort((a, b) => a.line - b.line)

  const result: ExtractResult = { symbols }
  writeCache('symbols', filePath, result)
  return result
}

function resolveFilePath(filePath: string, projectRoot: string): string | null {
  const resolved = path.resolve(projectRoot, filePath)
  if (!resolved.startsWith(projectRoot)) return null
  return resolved
}

/* ─── 全库符号总数统计（带磁盘缓存） ───────────────────────── */

const SYMBOL_COUNT_CACHE = path.resolve(
  import.meta.dirname,
  '..',
  '.cache',
  'learning-web',
  'symbol-count.json',
)

interface SymbolCountCache {
  count: number
  computedAt: number
}

const CACHE_TTL_MS = 10 * 60 * 1000 // 10 分钟

/**
 * 统计 src/ 和 packages/ 下所有 TS/TSX 文件的符号总数。
 * 结果缓存 10 分钟到磁盘，避免每次都扫描。
 */
export function countAllSymbols(projectRoot: string): number {
  // 读取缓存
  try {
    const cached = JSON.parse(
      fs.readFileSync(SYMBOL_COUNT_CACHE, 'utf-8'),
    ) as SymbolCountCache
    if (Date.now() - cached.computedAt < CACHE_TTL_MS) return cached.count
  } catch {
    /* 缓存不存在或失效 */
  }

  const SCAN_DIRS = ['src', 'packages']
  const SKIP = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    '__tests__',
    '.cache',
  ])
  const TS_EXT = /\.(ts|tsx)$/

  let total = 0

  function scan(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scan(full)
      } else if (
        entry.isFile() &&
        TS_EXT.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        const relPath = path.relative(projectRoot, full).replace(/\\/g, '/')
        try {
          const result = extractSymbols(relPath, projectRoot)
          if (result) total += result.symbols.length
        } catch {
          /* skip parse errors */
        }
      }
    }
  }

  for (const dir of SCAN_DIRS) {
    scan(path.join(projectRoot, dir))
  }

  // 写入缓存
  try {
    fs.mkdirSync(path.dirname(SYMBOL_COUNT_CACHE), { recursive: true })
    fs.writeFileSync(
      SYMBOL_COUNT_CACHE,
      JSON.stringify({ count: total, computedAt: Date.now() }),
      'utf-8',
    )
  } catch {
    /* non-critical */
  }

  return total
}
