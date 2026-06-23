import { readdirSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import type { FrontmatterData } from '../utils/frontmatterParser.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import {
  getProjectDirsUpToHome,
  extractDescriptionFromMarkdown,
  type ClaudeConfigDirectory,
} from '../utils/markdownConfigLoader.js'

export interface TemplateInfo {
  name: string
  description: string
  filePath: string
  frontmatter: FrontmatterData
  content: string
}

/**
 * 从 CWD 向上到 git 根目录发现 .hclaude/templates 目录，
 * 以及用户级别的 ~/.hclaude/templates。
 */
function getTemplatesDirs(): string[] {
  const projectDirs = getProjectDirsUpToHome(
    'templates' as ClaudeConfigDirectory,
    process.cwd(),
  )

  // 用户级别目录（getProjectDirsUpToHome 在主目录之前停止）
  const userDir = join(getClaudeConfigHomeDir(), 'templates')
  try {
    readdirSync(userDir)
    return [...projectDirs, userDir]
  } catch {
    return projectDirs
  }
}

/**
 * 列出所有可用的模板。
 */
export function listTemplates(): TemplateInfo[] {
  const templates: TemplateInfo[] = []
  const seenNames = new Set<string>()

  for (const dir of getTemplatesDirs()) {
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const name = basename(file, '.md')
      if (seenNames.has(name)) continue
      seenNames.add(name)

      const filePath = join(dir, file)
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const { frontmatter, content } = parseFrontmatter(raw, filePath)
        const description =
          (typeof frontmatter.description === 'string'
            ? frontmatter.description
            : '') || extractDescriptionFromMarkdown(content, 'No description')

        templates.push({ name, description, filePath, frontmatter, content })
      } catch {
        // 跳过无法读取的文件
      }
    }
  }

  return templates
}

/**
 * 按名称加载特定模板。
 */
export function loadTemplate(name: string): TemplateInfo | null {
  const all = listTemplates()
  return all.find(t => t.name === name) ?? null
}
