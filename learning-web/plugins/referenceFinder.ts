import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readCache, writeCache } from './cache'
import { extractSymbols } from './symbolExtractor'

/**
 * 查找某个 symbol 的 callers（谁调用了它）和 callees（它调用了什么）
 * 使用 ripgrep 搜索 + AST 验证
 */

export interface ReferenceLocation {
  file: string
  line: number
  column: number
  snippet: string
  enclosingSymbol?: string
}

export interface CalleeInfo {
  name: string
  line: number
  file?: string
}

export interface ReferencesResult {
  callers: ReferenceLocation[]
  callees: CalleeInfo[]
}

/**
 * 查找 ripgrep 二进制路径
 */
function findRipgrep(): string {
  // 源项目自带 ripgrep vendor 二进制
  const vendorPaths = [
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      'src',
      'utils',
      'vendor',
      'ripgrep',
      'bin',
      process.platform === 'win32' ? 'rg.exe' : 'rg',
    ),
  ]

  for (const vp of vendorPaths) {
    if (fs.existsSync(vp)) return vp
  }

  // fallback: 系统 rg
  return 'rg'
}

/**
 * 用 ripgrep 搜索标识符的使用
 */
function ripgrepSearch(
  pattern: string,
  projectRoot: string,
  excludeFiles: string[] = [],
): Array<{ file: string; line: number; column: number; text: string }> {
  const rg = findRipgrep()
  const args = [
    '--json',
    '-t',
    'ts',
    '-t',
    'tsx',
    '-g',
    '!node_modules',
    '-g',
    '!dist',
    '-g',
    '!coverage',
    ...excludeFiles.flatMap(f => ['-g', `!${f}`]),
    pattern,
    projectRoot,
  ]

  try {
    const output = execFileSync(rg, args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15000,
    })

    const results: Array<{
      file: string
      line: number
      column: number
      text: string
    }> = []

    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'match') {
          const data = obj.data
          results.push({
            file: path.relative(projectRoot, data.path.text),
            line: data.line_number,
            column: data.submatches[0]?.start ?? 1,
            text: data.lines.text.trim(),
          })
        }
      } catch {
        // 跳过非 JSON 行
      }
    }

    return results
  } catch {
    return []
  }
}

/**
 * 解析文件的 import 语句，返回导入符号映射
 * Map<symbolName, sourceFilePath>
 */
function parseImports(
  filePath: string,
  projectRoot: string,
): Map<string, string> {
  const result = new Map<string, string>()
  const absPath = path.resolve(projectRoot, filePath)
  const dir = path.dirname(absPath)

  let content: string
  try {
    content = fs.readFileSync(absPath, 'utf-8')
  } catch {
    return result
  }

  // 简单正则提取 import ... from '...'
  const importRegex =
    /import\s+(?:{([^}]+)}|(\w+)(?:\s*,\s*{([^}]+)})?|(?:\*\s+as\s+(\w+)))\s+from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = importRegex.exec(content)) !== null) {
    const namedImports = match[1]
    const defaultImport = match[2]
    const namedAfterDefault = match[3]
    const namespaceImport = match[4]
    const source = match[5]

    const resolvedSource = resolveImportSource(source, dir, projectRoot)

    const namedParts = [namedImports, namedAfterDefault]
      .filter(Boolean)
      .join(',')
    if (namedParts) {
      for (const part of namedParts.split(',')) {
        const trimmed = part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim()
        if (trimmed && resolvedSource) {
          result.set(trimmed, resolvedSource)
        }
      }
    }
    if (defaultImport && resolvedSource) {
      result.set(defaultImport, resolvedSource)
    }
    if (namespaceImport && resolvedSource) {
      result.set(namespaceImport, resolvedSource)
    }
  }

  return result
}

function resolveImportSource(
  source: string,
  fromDir: string,
  projectRoot: string,
): string | null {
  if (source.startsWith('.')) {
    // 相对路径
    const resolved = path.resolve(fromDir, source)
    const relative = path.relative(projectRoot, resolved)
    // 尝试补 .ts / .tsx / /index.ts
    for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const candidate = relative + suffix
      const abs = path.resolve(projectRoot, candidate)
      if (fs.existsSync(abs)) return candidate
    }
    return relative
  }

  if (source.startsWith('src/') || source.startsWith('src\\')) {
    return source
  }

  // 其他（node_modules / package）
  return null
}

/**
 * 查找 callers：谁从外部导入了该 symbol 并调用
 */
function findCallers(
  filePath: string,
  symbolName: string,
  projectRoot: string,
): ReferenceLocation[] {
  // 搜索 symbolName + ( 的模式
  const pattern = `\\b${escapeRegex(symbolName)}\\s*\\(`
  const hits = ripgrepSearch(pattern, projectRoot, [filePath])

  const callers: ReferenceLocation[] = []

  for (const hit of hits) {
    // 检查该文件是否从当前文件导入了此 symbol
    const imports = parseImports(hit.file, projectRoot)
    const importedFrom = imports.get(symbolName)

    // 只有确实从当前文件导入的才算数
    if (!importedFrom) continue
    if (!matchesSource(importedFrom, filePath)) continue

    // 获取 enclosing symbol
    const enclosing = findEnclosingSymbol(hit.file, hit.line, projectRoot)

    callers.push({
      file: hit.file,
      line: hit.line,
      column: hit.column,
      snippet: hit.text,
      enclosingSymbol: enclosing,
    })
  }

  return callers
}

/**
 * 查找 callees：该 symbol 体内调用了什么
 */
function findCallees(
  filePath: string,
  symbolName: string,
  projectRoot: string,
): CalleeInfo[] {
  const symbolResult = extractSymbols(filePath, projectRoot)
  if (!symbolResult) return []

  // 找到目标 symbol 的范围
  const target = symbolResult.symbols.find(s => s.name === symbolName)
  if (!target) return []

  const absPath = path.resolve(projectRoot, filePath)
  let content: string
  try {
    content = fs.readFileSync(absPath, 'utf-8')
  } catch {
    return []
  }

  const lines = content.split('\n')
  // 提取 symbol body 范围（line ~ endLine）
  const bodyLines = lines.slice(target.line - 1, target.endLine)
  const bodyText = bodyLines.join('\n')

  // 搜索函数调用模式
  const callRegex = /\b([a-zA-Z_$][\w$]*)\s*\(/g
  const callees: CalleeInfo[] = []
  const seen = new Set<string>()

  let match: RegExpExecArray | null
  while ((match = callRegex.exec(bodyText)) !== null) {
    const name = match[1]
    // 跳过关键字、自身、常见内置
    if (
      [
        'if',
        'for',
        'while',
        'switch',
        'catch',
        'return',
        'throw',
        'new',
        'typeof',
        'void',
        'function',
        'class',
        'import',
        'export',
        'const',
        'let',
        'var',
        'async',
        'await',
        'yield',
        'try',
      ].includes(name)
    )
      continue
    if (name === symbolName) continue
    if (seen.has(name)) continue
    seen.add(name)

    // 计算实际行号
    const matchOffset = match.index
    const linesBefore = bodyText.slice(0, matchOffset).split('\n')
    const actualLine = target.line - 1 + linesBefore.length

    // 查找定义文件
    const imports = parseImports(filePath, projectRoot)
    const importedFile = imports.get(name)

    // 检查是否是同文件内的其他 symbol
    const localSymbol = symbolResult.symbols.find(
      s => s.name === name && s.line !== target.line,
    )

    callees.push({
      name,
      line: actualLine,
      file: importedFile || (localSymbol ? filePath : undefined),
    })
  }

  return callees
}

function findEnclosingSymbol(
  filePath: string,
  line: number,
  projectRoot: string,
): string | undefined {
  const result = extractSymbols(filePath, projectRoot)
  if (!result) return undefined

  // 找到包含该 line 的最近 symbol
  let best: { name: string; line: number; endLine: number } | undefined

  for (const sym of result.symbols) {
    if (sym.line <= line && sym.endLine >= line) {
      if (!best || sym.line > best.line) {
        best = { name: sym.name, line: sym.line, endLine: sym.endLine }
      }
    }
  }

  return best?.name
}

function matchesSource(importedFrom: string, targetPath: string): boolean {
  // 标准化路径比较
  const normalizedImport = importedFrom
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')
    .replace(/\/index$/, '')
  const normalizedTarget = targetPath
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')
    .replace(/\/index$/, '')
  return (
    normalizedImport === normalizedTarget ||
    normalizedTarget.endsWith(normalizedImport) ||
    normalizedImport.endsWith(normalizedTarget)
  )
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 主函数：获取 symbol 的引用关系（带缓存）
 */
export function findReferences(
  filePath: string,
  symbolName: string,
  projectRoot: string,
): ReferencesResult | null {
  const cached = readCache<ReferencesResult>('references', filePath, symbolName)
  if (cached) return cached

  const callers = findCallers(filePath, symbolName, projectRoot)
  const callees = findCallees(filePath, symbolName, projectRoot)

  const result: ReferencesResult = { callers, callees }
  writeCache('references', filePath, result, symbolName)
  return result
}
