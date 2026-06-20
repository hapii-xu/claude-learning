import { readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { findGitRoot } from '../utils/git.js'

/**
 * `claude up` — 运行最近的 CLAUDE.md 中的 "# claude up" 段落。
 *
 * 从 CWD 向上查找 CLAUDE.md 文件，提取 `# claude up` 标题下的段落，
 * 并作为 shell 脚本执行。
 *
 * 仅 ANT 可用的命令（USER_TYPE === "ant"）。
 */
export async function up(): Promise<void> {
  const cwd = process.cwd()
  const gitRoot = findGitRoot(cwd)
  const searchDirs = gitRoot ? [gitRoot, cwd] : [cwd]

  let upSection: string | null = null

  for (const dir of searchDirs) {
    const claudeMdPath = join(dir, 'CLAUDE.md')
    try {
      const content = readFileSync(claudeMdPath, 'utf-8')
      upSection = extractUpSection(content)
      if (upSection) {
        console.log(`Found "# claude up" in ${claudeMdPath}`)
        break
      }
    } catch {
      // 文件未找到 — 继续查找
    }
  }

  if (!upSection) {
    console.log(
      'No "# claude up" section found in CLAUDE.md.\n' +
        'Add a section like:\n\n' +
        '  # claude up\n' +
        '  ```bash\n' +
        '  npm install\n' +
        '  npm run build\n' +
        '  ```',
    )
    return
  }

  console.log('Running:\n')
  console.log(upSection)
  console.log()

  const result = spawnSync('bash', ['-c', upSection], {
    cwd,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    console.error(`\nclaude up failed with exit code ${result.status}`)
    process.exitCode = result.status ?? 1
  } else {
    console.log('\nclaude up completed successfully.')
  }
}

/**
 * 从 markdown 中提取 "# claude up" 标题下的内容。
 * 返回 `# claude up` 和下一个 `#` 标题（或 EOF）之间的文本。
 * 如果存在代码块标记则将其去除。
 */
function extractUpSection(markdown: string): string | null {
  const lines = markdown.split('\n')
  let inSection = false
  const sectionLines: string[] = []

  for (const line of lines) {
    if (/^#\s+claude\s+up\b/i.test(line)) {
      inSection = true
      continue
    }
    if (inSection && /^#\s/.test(line)) {
      break
    }
    if (inSection) {
      sectionLines.push(line)
    }
  }

  if (sectionLines.length === 0) return null

  // 去除代码块标记
  let text = sectionLines.join('\n').trim()
  text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')

  return text.trim() || null
}
