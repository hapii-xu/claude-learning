import memoize from 'lodash-es/memoize.js'
import sample from 'lodash-es/sample.js'
import { getCwd } from '../utils/cwd.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from './config.js'
import { env } from './env.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getIsGit, gitExe } from './git.js'
import { logError } from './log.js'
import { getGitEmail } from './user.js'

// 标记文件为非核心（自动生成、依赖或配置）的模式。
// 用于确定性地过滤示例命令的文件名建议
// 而非调用 Haiku。
const NON_CORE_PATTERNS = [
  // lock / 依赖清单
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|bun\.lock|bun\.lockb|pnpm-lock\.yaml|Pipfile\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock)$/,
  // 生成 / 构建产物
  /\.generated\./,
  /(?:^|\/)(?:dist|build|out|target|node_modules|\.next|__pycache__)\//,
  /\.(?:min\.js|min\.css|map|pyc|pyo)$/,
  // 数据 / 文档 / 配置扩展名（非"为 X 编写测试"的材料）
  /\.(?:json|ya?ml|toml|xml|ini|cfg|conf|env|lock|txt|md|mdx|rst|csv|log|svg)$/i,
  // 配置 / 元数据
  /(?:^|\/)\.?(?:eslintrc|prettierrc|babelrc|editorconfig|gitignore|gitattributes|dockerignore|npmrc)/,
  /(?:^|\/)(?:tsconfig|jsconfig|biome|vitest\.config|jest\.config|webpack\.config|vite\.config|rollup\.config)\.[a-z]+$/,
  /(?:^|\/)\.(?:github|vscode|idea|claude)\//,
  // 文档 / 变更日志（非"X 如何工作"的材料）
  /(?:^|\/)(?:CHANGELOG|LICENSE|CONTRIBUTING|CODEOWNERS|README)(?:\.[a-z]+)?$/i,
]

function isCoreFile(path: string): boolean {
  return !NON_CORE_PATTERNS.some(p => p.test(path))
}

/**
 * 统计数组中项的出现次数，返回按次数降序排列的前 N 项，
 * 格式化为字符串。
 */
export function countAndSortItems(items: string[], topN: number = 20): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([item, count]) => `${count.toString().padStart(6)} ${item}`)
    .join('\n')
}

/**
 * 从按频率排序的路径列表中挑选最多 `want` 个 basename，
 * 跳过非核心文件并在不同目录间分散。
 * 若可用核心文件少于 `want` 个则返回空数组。
 */
export function pickDiverseCoreFiles(
  sortedPaths: string[],
  want: number,
): string[] {
  const picked: string[] = []
  const seenBasenames = new Set<string>()
  const dirTally = new Map<string, number>()

  // 贪心：每轮允许每个目录多 +1 个文件。防止
  // top-5 坍缩到单个热门文件夹，同时
  // 允许主导文件夹在仓库较窄时贡献多个文件。
  for (let cap = 1; picked.length < want && cap <= want; cap++) {
    for (const p of sortedPaths) {
      if (picked.length >= want) break
      if (!isCoreFile(p)) continue
      const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
      const base = lastSep >= 0 ? p.slice(lastSep + 1) : p
      if (!base || seenBasenames.has(base)) continue
      const dir = lastSep >= 0 ? p.slice(0, lastSep) : '.'
      if ((dirTally.get(dir) ?? 0) >= cap) continue
      picked.push(base)
      seenBasenames.add(base)
      dirTally.set(dir, (dirTally.get(dir) ?? 0) + 1)
    }
  }

  return picked.length >= want ? picked : []
}

async function getFrequentlyModifiedFiles(): Promise<string[]> {
  if (process.env.NODE_ENV === 'test') return []
  if (env.platform === 'win32') return []
  if (!(await getIsGit())) return []

  try {
    // 收集频繁修改的文件，优先用户自己的提交。
    const userEmail = await getGitEmail()

    const logArgs = [
      'log',
      '-n',
      '1000',
      '--pretty=format:',
      '--name-only',
      '--diff-filter=M',
    ]

    const counts = new Map<string, number>()
    const tallyInto = (stdout: string) => {
      for (const line of stdout.split('\n')) {
        const f = line.trim()
        if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
      }
    }

    if (userEmail) {
      const { stdout } = await execFileNoThrowWithCwd(
        'git',
        [...logArgs, `--author=${userEmail}`],
        { cwd: getCwd() },
      )
      tallyInto(stdout)
    }

    // 若用户自己的历史较少，回退到所有作者。
    if (counts.size < 10) {
      const { stdout } = await execFileNoThrowWithCwd(gitExe(), logArgs, {
        cwd: getCwd(),
      })
      tallyInto(stdout)
    }

    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p)

    return pickDiverseCoreFiles(sorted, 5)
  } catch (err) {
    logError(err as Error)
    return []
  }
}

const ONE_WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000

export const getExampleCommandFromCache = memoize(() => {
  const projectConfig = getCurrentProjectConfig()
  const frequentFile = projectConfig.exampleFiles?.length
    ? sample(projectConfig.exampleFiles)
    : '<filepath>'

  const commands = [
    'fix lint errors',
    'fix typecheck errors',
    `how does ${frequentFile} work?`,
    `refactor ${frequentFile}`,
    'how do I log an error?',
    `edit ${frequentFile} to...`,
    `write a test for ${frequentFile}`,
    'create a util logging.py that...',
  ]

  return `Try "${sample(commands)}"`
})

export const refreshExampleCommands = memoize(async (): Promise<void> => {
  const projectConfig = getCurrentProjectConfig()
  const now = Date.now()
  const lastGenerated = projectConfig.exampleFilesGeneratedAt ?? 0

  // 若示例超过一周则重新生成
  if (now - lastGenerated > ONE_WEEK_IN_MS) {
    projectConfig.exampleFiles = []
  }

  // 若未缓存示例文件，在后台启动获取
  if (!projectConfig.exampleFiles?.length) {
    void getFrequentlyModifiedFiles().then(files => {
      if (files.length) {
        saveCurrentProjectConfig(current => ({
          ...current,
          exampleFiles: files,
          exampleFilesGeneratedAt: Date.now(),
        }))
      }
    })
  }
})
