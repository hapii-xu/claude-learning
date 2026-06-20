import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readCache, writeCache } from './cache'

/**
 * 文件级导入图：解析 import 语句，构建双向依赖关系
 * imports: 当前文件导入了哪些文件
 * importedBy: 哪些文件导入了当前文件
 */

export type ImportKind = 'relative' | 'alias' | 'package' | 'node'

export interface ImportEntry {
  file: string
  symbols: string[]
  kind: ImportKind
}

export interface ImportedByEntry {
  file: string
  symbols: string[]
  line: number
}

export interface ImportsResult {
  imports: ImportEntry[]
  importedBy: ImportedByEntry[]
}

/**
 * 解析文件的 import 语句
 */
function parseFileImports(
  filePath: string,
  projectRoot: string,
): ImportEntry[] {
  const absPath = path.resolve(projectRoot, filePath)
  const dir = path.dirname(absPath)

  let content: string
  try {
    content = fs.readFileSync(absPath, 'utf-8')
  } catch {
    return []
  }

  const entries: ImportEntry[] = []

  // 匹配各种 import 形式
  const importRegex =
    /import\s+(?:(?:{([^}]+)}|(\w+)(?:\s*,\s*{([^}]+)})?|(?:\*\s+as\s+(\w+)))\s+from\s+)?['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null

  while ((match = importRegex.exec(content)) !== null) {
    const namedImports = match[1]
    const defaultImport = match[2]
    const namedAfterDefault = match[3]
    const namespaceImport = match[4]
    const source = match[5]

    const symbols: string[] = []
    const namedParts = [namedImports, namedAfterDefault]
      .filter(Boolean)
      .join(',')
    if (namedParts) {
      for (const part of namedParts.split(',')) {
        const trimmed = part.trim()
        if (trimmed) {
          // 处理 import { foo as bar }
          const actualName = trimmed.split(/\s+as\s+/)[0]?.trim()
          if (actualName) symbols.push(actualName)
        }
      }
    }
    if (defaultImport) symbols.push(defaultImport)
    if (namespaceImport) symbols.push(`* as ${namespaceImport}`)

    const resolved = resolveImport(source, dir, projectRoot)
    const kind = classifyImport(source, projectRoot)

    if (resolved) {
      entries.push({ file: resolved, symbols, kind })
    } else if (kind === 'node' || kind === 'package') {
      entries.push({ file: source, symbols, kind })
    }
  }

  return entries
}

function resolveImport(
  source: string,
  fromDir: string,
  projectRoot: string,
): string | null {
  if (!source.startsWith('.')) return null

  const resolved = path.resolve(fromDir, source)
  const relative = path.relative(projectRoot, resolved)

  // .js → .ts/.tsx/.jsx 替换（TypeScript 项目常见）
  if (relative.endsWith('.js')) {
    const base = relative.slice(0, -3)
    for (const ext of ['.ts', '.tsx', '.jsx']) {
      const candidate = base + ext
      const abs = path.resolve(projectRoot, candidate)
      if (fs.existsSync(abs)) return candidate.replace(/\\/g, '/')
    }
  }

  // 尝试补后缀
  for (const suffix of [
    '',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '/index.ts',
    '/index.tsx',
  ]) {
    const candidate = relative + suffix
    const abs = path.resolve(projectRoot, candidate)
    if (fs.existsSync(abs)) return candidate.replace(/\\/g, '/')
  }

  return relative.replace(/\\/g, '/')
}

function classifyImport(source: string, projectRoot: string): ImportKind {
  if (source.startsWith('.')) return 'relative'
  if (source.startsWith('src/') || source.startsWith('src\\')) return 'alias'
  // node builtin
  if (
    source.startsWith('node:') ||
    [
      'fs',
      'path',
      'os',
      'child_process',
      'crypto',
      'http',
      'https',
      'url',
      'util',
      'stream',
      'events',
      'buffer',
      'net',
      'tls',
      'dns',
      'zlib',
      'readline',
      'assert',
      'tty',
      'worker_threads',
      'perf_hooks',
    ].includes(source)
  ) {
    return 'node'
  }
  return 'package'
}

/**
 * 查找哪些文件导入了当前文件（使用 ripgrep）
 */
function findImportedBy(
  filePath: string,
  projectRoot: string,
): ImportedByEntry[] {
  const absPath = path.resolve(projectRoot, filePath)
  const dir = path.dirname(absPath)
  const baseName = path.basename(filePath, path.extname(filePath))

  // 构造搜索模式：从当前文件可能的引用路径
  const patterns: string[] = []

  // 相对路径引用：任何文件都可能用 '../query' 或 './query' 引用
  // 简化：搜索 baseName 相关的 from 语句
  patterns.push(`from\\s+['"][^'"]*${escapeRegex(baseName)}['"]`)

  // alias 引用：src/path 形式
  if (!filePath.startsWith('node_modules')) {
    patterns.push(
      `from\\s+['"]${escapeRegex(filePath).replace(/\.tsx?$/, '')}['"]`,
    )
    patterns.push(`from\\s+['"]${escapeRegex(filePath)}['"]`)
  }

  const entries: ImportedByEntry[] = []
  const seenFiles = new Set<string>()

  for (const pattern of patterns) {
    const hits = ripgrepSimple(pattern, projectRoot, [filePath])
    for (const hit of hits) {
      if (seenFiles.has(hit.file)) continue
      seenFiles.add(hit.file)

      // 解析该文件从当前文件导入了什么符号
      const imports = parseFileImports(hit.file, projectRoot)
      const matchingImport = imports.find(imp =>
        matchesPath(imp.file, filePath),
      )

      entries.push({
        file: hit.file,
        symbols: matchingImport?.symbols ?? [],
        line: hit.line,
      })
    }
  }

  return entries
}

function ripgrepSimple(
  pattern: string,
  projectRoot: string,
  excludeFiles: string[] = [],
): Array<{ file: string; line: number; text: string }> {
  let rg = 'rg'
  // 尝试找 vendor rg
  const vendorRg = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'src',
    'utils',
    'vendor',
    'ripgrep',
    'bin',
    process.platform === 'win32' ? 'rg.exe' : 'rg',
  )
  if (fs.existsSync(vendorRg)) rg = vendorRg

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

    const results: Array<{ file: string; line: number; text: string }> = []
    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'match') {
          results.push({
            file: path
              .relative(projectRoot, obj.data.path.text)
              .replace(/\\/g, '/'),
            line: obj.data.line_number,
            text: obj.data.lines.text.trim(),
          })
        }
      } catch {
        // skip
      }
    }
    return results
  } catch {
    return []
  }
}

function matchesPath(a: string, b: string): boolean {
  const na = a
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')
    .replace(/\/index$/, '')
  const nb = b
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '')
    .replace(/\/index$/, '')
  return na === nb || nb.endsWith(na) || na.endsWith(nb)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 主函数：获取文件级导入关系（带缓存）
 */
export function findImports(
  filePath: string,
  projectRoot: string,
): ImportsResult | null {
  const cached = readCache<ImportsResult>('imports', filePath)
  if (cached) return cached

  const imports = parseFileImports(filePath, projectRoot)
  const importedBy = findImportedBy(filePath, projectRoot)

  const result: ImportsResult = { imports, importedBy }
  writeCache('imports', filePath, result)
  return result
}
