import { basename, extname, posix, sep } from 'path'

/**
 * 应从归属统计中排除的文件模式。
 * 基于 GitHub Linguist 的 vendored 模式与常见生成文件模式。
 */

// 精确文件名匹配（大小写不敏感）
const EXCLUDED_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'shrinkwrap.json',
  'npm-shrinkwrap.json',
])

// 文件扩展名模式（大小写不敏感）
const EXCLUDED_EXTENSIONS = new Set([
  '.lock',
  '.min.js',
  '.min.css',
  '.min.html',
  '.bundle.js',
  '.bundle.css',
  '.generated.ts',
  '.generated.js',
  '.d.ts', // TypeScript 声明文件
])

// 表示生成/vendored 内容的目录模式
const EXCLUDED_DIRECTORIES = [
  '/dist/',
  '/build/',
  '/out/',
  '/output/',
  '/node_modules/',
  '/vendor/',
  '/vendored/',
  '/third_party/',
  '/third-party/',
  '/external/',
  '/.next/',
  '/.nuxt/',
  '/.svelte-kit/',
  '/coverage/',
  '/__pycache__/',
  '/.tox/',
  '/venv/',
  '/.venv/',
  '/target/release/',
  '/target/debug/',
]

// 使用正则表达式进行更复杂匹配的文件名模式
const EXCLUDED_FILENAME_PATTERNS = [
  /^.*\.min\.[a-z]+$/i, // *.min.*
  /^.*-min\.[a-z]+$/i, // *-min.*
  /^.*\.bundle\.[a-z]+$/i, // *.bundle.*
  /^.*\.generated\.[a-z]+$/i, // *.generated.*
  /^.*\.gen\.[a-z]+$/i, // *.gen.*
  /^.*\.auto\.[a-z]+$/i, // *.auto.*
  /^.*_generated\.[a-z]+$/i, // *_generated.*
  /^.*_gen\.[a-z]+$/i, // *_gen.*
  /^.*\.pb\.(go|js|ts|py|rb)$/i, // Protocol buffer 生成的文件
  /^.*_pb2?\.py$/i, // Python protobuf 文件
  /^.*\.pb\.h$/i, // C++ protobuf 头文件
  /^.*\.grpc\.[a-z]+$/i, // gRPC 生成的文件
  /^.*\.swagger\.[a-z]+$/i, // Swagger 生成的文件
  /^.*\.openapi\.[a-z]+$/i, // OpenAPI 生成的文件
]

/**
 * 检查文件是否应基于 Linguist 风格的规则从归属统计中排除。
 *
 * @param filePath - 从仓库根目录起的相对文件路径
 * @returns 若文件应从归属统计中排除则为 true
 */
export function isGeneratedFile(filePath: string): boolean {
  // 规范化路径分隔符以进行一致的模式匹配（模式使用 posix 风格的 /）
  const normalizedPath =
    posix.sep + filePath.split(sep).join(posix.sep).replace(/^\/+/, '')
  const fileName = basename(filePath).toLowerCase()
  const ext = extname(filePath).toLowerCase()

  // 检查精确文件名匹配
  if (EXCLUDED_FILENAMES.has(fileName)) {
    return true
  }

  // 检查扩展名匹配
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return true
  }

  // 检查复合扩展名如 .min.js
  const parts = fileName.split('.')
  if (parts.length > 2) {
    const compoundExt = '.' + parts.slice(-2).join('.')
    if (EXCLUDED_EXTENSIONS.has(compoundExt)) {
      return true
    }
  }

  // 检查目录模式
  for (const dir of EXCLUDED_DIRECTORIES) {
    if (normalizedPath.includes(dir)) {
      return true
    }
  }

  // 检查文件名模式
  for (const pattern of EXCLUDED_FILENAME_PATTERNS) {
    if (pattern.test(fileName)) {
      return true
    }
  }

  return false
}

/**
 * 过滤文件列表以排除生成文件。
 *
 * @param files - 文件路径数组
 * @returns 非生成文件的数组
 */
export function filterGeneratedFiles(files: string[]): string[] {
  return files.filter(file => !isGeneratedFile(file))
}
