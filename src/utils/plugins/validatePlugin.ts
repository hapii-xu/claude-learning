import type { Dirent, Stats } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import * as path from 'path'
import { z } from 'zod/v4'
import { errorMessage, getErrnoCode, isENOENT } from '../errors.js'
import { FRONTMATTER_REGEX } from '../frontmatterParser.js'
import { jsonParse } from '../slowOperations.js'
import { parseYaml } from '../yaml.js'
import {
  PluginHooksSchema,
  PluginManifestSchema,
  PluginMarketplaceEntrySchema,
  PluginMarketplaceSchema,
} from './schemas.js'

/**
 * 属于 marketplace.json 条目（PluginMarketplaceEntrySchema）而非 plugin.json
 * （PluginManifestSchema）的字段。插件作者有时会将两者互相复制。
 * 由 `claude plugin validate` 以警告形式呈现，因为这是已知的混淆点
 * — 加载路径通过 zod 的默认行为静默剥除所有未知键，
 * 运行时是无害的，但值得向作者提示。
 */
const MARKETPLACE_ONLY_MANIFEST_FIELDS = new Set([
  'category',
  'source',
  'tags',
  'strict',
  'id',
])

export type ValidationResult = {
  success: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  filePath: string
  fileType: 'plugin' | 'marketplace' | 'skill' | 'agent' | 'command' | 'hooks'
}

export type ValidationError = {
  path: string
  message: string
  code?: string
}

export type ValidationWarning = {
  path: string
  message: string
}

/**
 * 检测文件是插件清单还是 marketplace 清单
 */
function detectManifestType(
  filePath: string,
): 'plugin' | 'marketplace' | 'unknown' {
  const fileName = path.basename(filePath)
  const dirName = path.basename(path.dirname(filePath))

  // 检查文件名模式
  if (fileName === 'plugin.json') return 'plugin'
  if (fileName === 'marketplace.json') return 'marketplace'

  // 检查是否在 .claude-plugin 目录中
  if (dirName === '.claude-plugin') {
    return 'plugin' // 最可能是 plugin.json
  }

  return 'unknown'
}

/**
 * 将 Zod 校验错误格式化为可读格式
 */
function formatZodErrors(zodError: z.ZodError): ValidationError[] {
  return zodError.issues.map(error => ({
    path: error.path.join('.') || 'root',
    message: error.message,
    code: error.code,
  }))
}

/**
 * 检查路径字符串中是否有父目录段（'..'）。
 *
 * 对于 plugin.json 的组件路径，这是安全问题（逃出插件目录）。
 * 对于 marketplace.json 的来源路径，几乎总是解析基础误解：
 * 路径从 marketplace 仓库根解析，而非相对于 marketplace.json 本身，
 * 所以用户添加的用于"爬出 .claude-plugin/"的 '..' 是不必要的。
 * 调用者传入 `hint` 以附加正确的解释。
 */
function checkPathTraversal(
  p: string,
  field: string,
  errors: ValidationError[],
  hint?: string,
): void {
  if (p.includes('..')) {
    errors.push({
      path: field,
      message: hint
        ? `Path contains "..": ${p}. ${hint}`
        : `Path contains ".." which could be a path traversal attempt: ${p}`,
    })
  }
}

// 当 marketplace 插件来源包含 '..' 时显示。大多数用户遇到此问题是因为
// 他们期望路径相对于 marketplace.json（在 .claude-plugin/ 内）解析，
// 但实际解析从 marketplace 仓库根开始 — 见 gh-29485。
// 根据用户的实际路径计算定制的"使用 X 而非 Y"建议，
// 而非硬编码示例（#20895 的审查反馈）。
function marketplaceSourceHint(p: string): string {
  // 剥除前导 ../ 段：用户添加的用于"爬出 .claude-plugin/"的 '..'
  // 是不必要的，因为路径已经从仓库根开始。
  // 如果 '..' 出现在路径中间（少见），回退到通用示例。
  const stripped = p.replace(/^(\.\.\/)+/, '')
  const corrected = stripped !== p ? `./${stripped}` : './plugins/my-plugin'
  return (
    'Plugin source paths are resolved relative to the marketplace root (the directory ' +
    'containing .claude-plugin/), not relative to marketplace.json. ' +
    `Use "${corrected}" instead of "${p}".`
  )
}

/**
 * 校验插件清单文件（plugin.json）
 */
export async function validatePluginManifest(
  filePath: string,
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const absolutePath = path.resolve(filePath)

  // 读取文件内容 — 直接处理 ENOENT / EISDIR / 权限错误
  let content: string
  try {
    content = await readFile(absolutePath, { encoding: 'utf-8' })
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    let message: string
    if (code === 'ENOENT') {
      message = `File not found: ${absolutePath}`
    } else if (code === 'EISDIR') {
      message = `Path is not a file: ${absolutePath}`
    } else {
      message = `Failed to read file: ${errorMessage(error)}`
    }
    return {
      success: false,
      errors: [{ path: 'file', message, code }],
      warnings: [],
      filePath: absolutePath,
      fileType: 'plugin',
    }
  }

  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch (error) {
    return {
      success: false,
      errors: [
        {
          path: 'json',
          message: `Invalid JSON syntax: ${errorMessage(error)}`,
        },
      ],
      warnings: [],
      filePath: absolutePath,
      fileType: 'plugin',
    }
  }

  // 在 schema 校验前检查解析的 JSON 中的路径遍历
  // 确保即使 schema 校验失败也能捕获安全问题
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>

    // 检查 commands
    if (obj.commands) {
      const commands = Array.isArray(obj.commands)
        ? obj.commands
        : [obj.commands]
      commands.forEach((cmd, i) => {
        if (typeof cmd === 'string') {
          checkPathTraversal(cmd, `commands[${i}]`, errors)
        }
      })
    }

    // 检查 agents
    if (obj.agents) {
      const agents = Array.isArray(obj.agents) ? obj.agents : [obj.agents]
      agents.forEach((agent, i) => {
        if (typeof agent === 'string') {
          checkPathTraversal(agent, `agents[${i}]`, errors)
        }
      })
    }

    // 检查 skills
    if (obj.skills) {
      const skills = Array.isArray(obj.skills) ? obj.skills : [obj.skills]
      skills.forEach((skill, i) => {
        if (typeof skill === 'string') {
          checkPathTraversal(skill, `skills[${i}]`, errors)
        }
      })
    }
  }

  // 在校验标记之前将 marketplace 专属字段作为警告呈现。
  // `claude plugin validate` 是开发者工具 — 运行它的作者
  // 想知道这些字段不属于这里。但这是警告，不是错误：
  // 插件在运行时正常加载（基础 schema 剥除未知键）。
  // 此处剥除它们，使下面的 .strict() 调用不会在针对性警告之上
  // 重复报告它们为未识别键错误。
  let toValidate = parsed
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>
    const strayKeys = Object.keys(obj).filter(k =>
      MARKETPLACE_ONLY_MANIFEST_FIELDS.has(k),
    )
    if (strayKeys.length > 0) {
      const stripped = { ...obj }
      for (const key of strayKeys) {
        delete stripped[key]
        warnings.push({
          path: key,
          message:
            `Field '${key}' belongs in the marketplace entry (marketplace.json), ` +
            `not plugin.json. It's harmless here but unused — Claude Code ` +
            `ignores it at load time.`,
        })
      }
      toValidate = stripped
    }
  }

  // 针对 schema 校验（剥除后，marketplace 字段不会导致失败）。
  // 此处在本地调用 .strict()，即使基础 schema 是宽松的 —
  // 运行时加载路径为了韧性静默剥除未知键，但
  // 这是开发者工具，运行它的作者需要拼写错误反馈。
  const result = PluginManifestSchema().strict().safeParse(toValidate)

  if (!result.success) {
    errors.push(...formatZodErrors(result.error))
  }

  // 检查常见问题并添加警告
  if (result.success) {
    const manifest = result.data

    // 若名称不是严格的 kebab-case 则警告。CC 的 schema 仅拒绝空格，
    // 但 Claude.ai marketplace 同步拒绝非 kebab 名称。在此处
    // 显示让作者在 CI 中捕获它，而非在同步失败时才发现。
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name)) {
      warnings.push({
        path: 'name',
        message:
          `Plugin name "${manifest.name}" is not kebab-case. Claude Code accepts ` +
          `it, but the Claude.ai marketplace sync requires kebab-case ` +
          `(lowercase letters, digits, and hyphens only, e.g., "my-plugin").`,
      })
    }

    // 若未指定版本则警告
    if (!manifest.version) {
      warnings.push({
        path: 'version',
        message:
          'No version specified. Consider adding a version following semver (e.g., "1.0.0")',
      })
    }

    // 若没有描述则警告
    if (!manifest.description) {
      warnings.push({
        path: 'description',
        message:
          'No description provided. Adding a description helps users understand what your plugin does',
      })
    }

    // 若没有作者则警告
    if (!manifest.author) {
      warnings.push({
        path: 'author',
        message:
          'No author information provided. Consider adding author details for plugin attribution',
      })
    }
  }

  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath: absolutePath,
    fileType: 'plugin',
  }
}

/**
 * 校验 marketplace 清单文件（marketplace.json）
 */
export async function validateMarketplaceManifest(
  filePath: string,
): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const absolutePath = path.resolve(filePath)

  // 读取文件内容 — 直接处理 ENOENT / EISDIR / 权限错误
  let content: string
  try {
    content = await readFile(absolutePath, { encoding: 'utf-8' })
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    let message: string
    if (code === 'ENOENT') {
      message = `File not found: ${absolutePath}`
    } else if (code === 'EISDIR') {
      message = `Path is not a file: ${absolutePath}`
    } else {
      message = `Failed to read file: ${errorMessage(error)}`
    }
    return {
      success: false,
      errors: [{ path: 'file', message, code }],
      warnings: [],
      filePath: absolutePath,
      fileType: 'marketplace',
    }
  }

  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch (error) {
    return {
      success: false,
      errors: [
        {
          path: 'json',
          message: `Invalid JSON syntax: ${errorMessage(error)}`,
        },
      ],
      warnings: [],
      filePath: absolutePath,
      fileType: 'marketplace',
    }
  }

  // 在 schema 校验前检查插件来源中的路径遍历
  // 确保即使 schema 校验失败也能捕获安全问题
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>

    if (Array.isArray(obj.plugins)) {
      obj.plugins.forEach((plugin: unknown, i: number) => {
        if (plugin && typeof plugin === 'object' && 'source' in plugin) {
          const source = (plugin as { source: unknown }).source
          // 检查字符串来源（相对路径）
          if (typeof source === 'string') {
            checkPathTraversal(
              source,
              `plugins[${i}].source`,
              errors,
              marketplaceSourceHint(source),
            )
          }
          // 检查对象来源的 .path（git-subdir：远程仓库中的子目录，通过稀疏克隆获取）。
          // 此处的 '..' 是远程仓库树内的真正遍历尝试，而非对 marketplace 根目录的误解 —
          // 保留安全框架（不使用 marketplaceSourceHint）。参见 #20895 审查。
          if (
            source &&
            typeof source === 'object' &&
            'path' in source &&
            typeof (source as { path: unknown }).path === 'string'
          ) {
            checkPathTraversal(
              (source as { path: string }).path,
              `plugins[${i}].source.path`,
              errors,
            )
          }
        }
      })
    }
  }

  // 针对 schema 校验。
  // 基础 schema 是宽松的（移除未知键）以保证运行时韧性，
  // 但这是开发者工具 — 作者需要拼写错误反馈。我们在此处
  // 使用 .strict() 重建 schema。注意外层对象上的 .strict() 不会
  // 传播到 z.array() 元素中，因此我们也将 plugins 数组
  // 覆盖为严格条目，以捕获单个插件条目内的拼写错误。
  const strictMarketplaceSchema = PluginMarketplaceSchema()
    .extend({
      plugins: z.array(PluginMarketplaceEntrySchema().strict()),
    })
    .strict()
  const result = strictMarketplaceSchema.safeParse(parsed)

  if (!result.success) {
    errors.push(...formatZodErrors(result.error))
  }

  // 检查常见问题并添加警告
  if (result.success) {
    const marketplace = result.data

    // 若未定义插件则警告
    if (!marketplace.plugins || marketplace.plugins.length === 0) {
      warnings.push({
        path: 'plugins',
        message: 'Marketplace has no plugins defined',
      })
    }

    // 检查每个插件条目
    if (marketplace.plugins) {
      marketplace.plugins.forEach((plugin, i) => {
        // 检查重复的插件名称
        const duplicates = marketplace.plugins.filter(
          p => p.name === plugin.name,
        )
        if (duplicates.length > 1) {
          errors.push({
            path: `plugins[${i}].name`,
            message: `Duplicate plugin name "${plugin.name}" found in marketplace`,
          })
        }
      })

      // 版本不匹配检查：对于声明了版本的本地来源条目，
      // 与插件自己的 plugin.json 进行比较。在安装时，
      // calculatePluginVersion（pluginVersioning.ts）优先使用清单版本
      // 并静默忽略条目版本 — 因此过时的 entry.version 会造成
      // 不可见的用户混淆（marketplace UI 显示一个版本，
      // 安装后 /status 显示另一个版本）。
      // 仅检查本地来源：远程来源需要克隆才能检查。
      const manifestDir = path.dirname(absolutePath)
      const marketplaceRoot =
        path.basename(manifestDir) === '.claude-plugin'
          ? path.dirname(manifestDir)
          : manifestDir
      for (const [i, entry] of marketplace.plugins.entries()) {
        if (
          !entry.version ||
          typeof entry.source !== 'string' ||
          !entry.source.startsWith('./')
        ) {
          continue
        }
        const pluginJsonPath = path.join(
          marketplaceRoot,
          entry.source,
          '.claude-plugin',
          'plugin.json',
        )
        let manifestVersion: string | undefined
        try {
          const raw = await readFile(pluginJsonPath, { encoding: 'utf-8' })
          const parsed = jsonParse(raw) as { version?: unknown }
          if (typeof parsed.version === 'string') {
            manifestVersion = parsed.version
          }
        } catch {
          // 缺失/不可读的 plugin.json 由其他人报告错误
          continue
        }
        if (manifestVersion && manifestVersion !== entry.version) {
          warnings.push({
            path: `plugins[${i}].version`,
            message:
              `Entry declares version "${entry.version}" but ${entry.source}/.claude-plugin/plugin.json says "${manifestVersion}". ` +
              `At install time, plugin.json wins (calculatePluginVersion precedence) — the entry version is silently ignored. ` +
              `Update this entry to "${manifestVersion}" to match.`,
          })
        }
      }
    }

    // 如果 metadata 中没有描述则警告
    if (!marketplace.metadata?.description) {
      warnings.push({
        path: 'metadata.description',
        message:
          'No marketplace description provided. Adding a description helps users understand what this marketplace offers',
      })
    }
  }

  return {
    success: errors.length === 0,
    errors,
    warnings,
    filePath: absolutePath,
    fileType: 'marketplace',
  }
}
/**
 * 校验插件组件 markdown 文件中的 YAML frontmatter。
 *
 * 运行时加载器（parseFrontmatter）将不可解析的 YAML 静默丢弃到
 * 调试日志并返回空对象。这对加载路径来说是正确的韧性选择，
 * 但运行 `claude plugin validate` 的作者需要明确的信号。
 * 此函数重新解析 frontmatter 块并呈现运行时加载器会静默吞掉的内容。
 */
function validateComponentFile(
  filePath: string,
  content: string,
  fileType: 'skill' | 'agent' | 'command',
): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const match = content.match(FRONTMATTER_REGEX)
  if (!match) {
    warnings.push({
      path: 'frontmatter',
      message:
        'No frontmatter block found. Add YAML frontmatter between --- delimiters ' +
        'at the top of the file to set description and other metadata.',
    })
    return { success: true, errors, warnings, filePath, fileType }
  }

  const frontmatterText = match[1] || ''
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatterText)
  } catch (e) {
    errors.push({
      path: 'frontmatter',
      message:
        `YAML frontmatter failed to parse: ${errorMessage(e)}. ` +
        `At runtime this ${fileType} loads with empty metadata (all frontmatter ` +
        `fields silently dropped).`,
    })
    return { success: false, errors, warnings, filePath, fileType }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({
      path: 'frontmatter',
      message:
        'Frontmatter must be a YAML mapping (key: value pairs), got ' +
        `${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}.`,
    })
    return { success: false, errors, warnings, filePath, fileType }
  }

  const fm = parsed as Record<string, unknown>

  // description: 必须是标量值。coerceDescriptionToString 在运行时丢弃数组/对象并记录日志。
  if (fm.description !== undefined) {
    const d = fm.description
    if (
      typeof d !== 'string' &&
      typeof d !== 'number' &&
      typeof d !== 'boolean' &&
      d !== null
    ) {
      errors.push({
        path: 'description',
        message:
          `description must be a string, got ${Array.isArray(d) ? 'array' : typeof d}. ` +
          `At runtime this value is dropped.`,
      })
    }
  } else {
    warnings.push({
      path: 'description',
      message:
        `No description in frontmatter. A description helps users and Claude ` +
        `understand when to use this ${fileType}.`,
    })
  }

  // name: 如果存在，必须是字符串（skills/commands 将其用作 displayName；
  // 插件 agent 将其用作 agentType 词干 — 非字符串会被字符串化为垃圾值）
  if (
    fm.name !== undefined &&
    fm.name !== null &&
    typeof fm.name !== 'string'
  ) {
    errors.push({
      path: 'name',
      message: `name must be a string, got ${typeof fm.name}.`,
    })
  }

  // allowed-tools: 字符串或字符串数组
  const at = fm['allowed-tools']
  if (at !== undefined && at !== null) {
    if (typeof at !== 'string' && !Array.isArray(at)) {
      errors.push({
        path: 'allowed-tools',
        message: `allowed-tools must be a string or array of strings, got ${typeof at}.`,
      })
    } else if (Array.isArray(at) && at.some(t => typeof t !== 'string')) {
      errors.push({
        path: 'allowed-tools',
        message: 'allowed-tools array must contain only strings.',
      })
    }
  }

  // shell: 'bash' | 'powershell'（控制 !`cmd` 块的路由）
  const sh = fm.shell
  if (sh !== undefined && sh !== null) {
    if (typeof sh !== 'string') {
      errors.push({
        path: 'shell',
        message: `shell must be a string, got ${typeof sh}.`,
      })
    } else {
      // 规范化以匹配 parseShellFrontmatter() 的运行时行为 —
      // `shell: PowerShell` 不应导致校验失败，而是在运行时正常工作。
      const normalized = sh.trim().toLowerCase()
      if (normalized !== 'bash' && normalized !== 'powershell') {
        errors.push({
          path: 'shell',
          message: `shell must be 'bash' or 'powershell', got '${sh}'.`,
        })
      }
    }
  }

  return { success: errors.length === 0, errors, warnings, filePath, fileType }
}

/**
 * 校验插件的 hooks.json 文件。与 frontmatter 不同，这个在运行时是硬错误
 * （pluginLoader 使用 .parse() 而非 .safeParse()）— 一个错误的 hooks.json
 * 会破坏整个插件。在此处呈现它是必要的。
 */
async function validateHooksJson(filePath: string): Promise<ValidationResult> {
  let content: string
  try {
    content = await readFile(filePath, { encoding: 'utf-8' })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // ENOENT 没问题 — hooks 是可选的
    if (code === 'ENOENT') {
      return {
        success: true,
        errors: [],
        warnings: [],
        filePath,
        fileType: 'hooks',
      }
    }
    return {
      success: false,
      errors: [
        { path: 'file', message: `Failed to read file: ${errorMessage(e)}` },
      ],
      warnings: [],
      filePath,
      fileType: 'hooks',
    }
  }

  let parsed: unknown
  try {
    parsed = jsonParse(content)
  } catch (e) {
    return {
      success: false,
      errors: [
        {
          path: 'json',
          message:
            `Invalid JSON syntax: ${errorMessage(e)}. ` +
            `At runtime this breaks the entire plugin load.`,
        },
      ],
      warnings: [],
      filePath,
      fileType: 'hooks',
    }
  }

  const result = PluginHooksSchema().safeParse(parsed)
  if (!result.success) {
    return {
      success: false,
      errors: formatZodErrors(result.error),
      warnings: [],
      filePath,
      fileType: 'hooks',
    }
  }

  return {
    success: true,
    errors: [],
    warnings: [],
    filePath,
    fileType: 'hooks',
  }
}

/**
 * 递归收集目录下的 .md 文件。使用 withFileTypes 避免对每个条目
 * 执行 stat。返回绝对路径以保持错误消息的可读性。
 */
async function collectMarkdown(
  dir: string,
  isSkillsDir: boolean,
): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw e
  }

  // Skills 使用 <name>/SKILL.md — 只下降一层，只收集 SKILL.md。
  // 匹配运行时加载器：skills/ 中的单个 .md 文件不会被加载，
  // 技能目录的子目录也不会被扫描。路径是推测性的
  // （子目录可能没有 SKILL.md）；调用者处理 ENOENT。
  if (isSkillsDir) {
    return entries
      .filter(e => e.isDirectory())
      .map(e => path.join(dir, e.name, 'SKILL.md'))
  }

  // 命令/代理：递归并收集所有 .md 文件。
  const out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(full, false)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

/**
 * 校验插件目录中的内容文件 — skills、agents、commands 和 hooks.json。
 * 扫描默认组件目录（清单可以声明自定义路径，但默认布局覆盖了
 * 绝大多数插件；这是 linter，不是加载器）。
 *
 * 为每个有错误或警告的文件返回一个 ValidationResult。
 * 干净的插件返回空数组。
 */
export async function validatePluginContents(
  pluginDir: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = []

  const dirs: Array<['skill' | 'agent' | 'command', string]> = [
    ['skill', path.join(pluginDir, 'skills')],
    ['agent', path.join(pluginDir, 'agents')],
    ['command', path.join(pluginDir, 'commands')],
  ]

  for (const [fileType, dir] of dirs) {
    const files = await collectMarkdown(dir, fileType === 'skill')
    for (const filePath of files) {
      let content: string
      try {
        content = await readFile(filePath, { encoding: 'utf-8' })
      } catch (e: unknown) {
        // ENOENT 是推测性技能路径的预期（没有 SKILL.md 的子目录）
        if (isENOENT(e)) continue
        results.push({
          success: false,
          errors: [
            { path: 'file', message: `Failed to read: ${errorMessage(e)}` },
          ],
          warnings: [],
          filePath,
          fileType,
        })
        continue
      }
      const r = validateComponentFile(filePath, content, fileType)
      if (r.errors.length > 0 || r.warnings.length > 0) {
        results.push(r)
      }
    }
  }

  const hooksResult = await validateHooksJson(
    path.join(pluginDir, 'hooks', 'hooks.json'),
  )
  if (hooksResult.errors.length > 0 || hooksResult.warnings.length > 0) {
    results.push(hooksResult)
  }

  return results
}

/**
 * 校验清单文件或目录（自动检测类型）
 */
export async function validateManifest(
  filePath: string,
): Promise<ValidationResult> {
  const absolutePath = path.resolve(filePath)

  // Stat 路径以检查是否为目录 — 内联处理 ENOENT
  let stats: Stats | null = null
  try {
    stats = await stat(absolutePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      throw e
    }
  }

  if (stats?.isDirectory()) {
    // 在 .claude-plugin 目录中查找清单文件
    // 优先使用 marketplace.json 而非 plugin.json
    const marketplacePath = path.join(
      absolutePath,
      '.claude-plugin',
      'marketplace.json',
    )
    const marketplaceResult = await validateMarketplaceManifest(marketplacePath)
    // 仅当 marketplace 文件未找到（ENOENT）时才回退
    if (marketplaceResult.errors[0]?.code !== 'ENOENT') {
      return marketplaceResult
    }

    const pluginPath = path.join(absolutePath, '.claude-plugin', 'plugin.json')
    const pluginResult = await validatePluginManifest(pluginPath)
    if (pluginResult.errors[0]?.code !== 'ENOENT') {
      return pluginResult
    }

    return {
      success: false,
      errors: [
        {
          path: 'directory',
          message: `No manifest found in directory. Expected .claude-plugin/marketplace.json or .claude-plugin/plugin.json`,
        },
      ],
      warnings: [],
      filePath: absolutePath,
      fileType: 'plugin',
    }
  }

  const manifestType = detectManifestType(filePath)

  switch (manifestType) {
    case 'plugin':
      return validatePluginManifest(filePath)
    case 'marketplace':
      return validateMarketplaceManifest(filePath)
    case 'unknown': {
      // 尝试解析并根据内容猜测
      try {
        const content = await readFile(absolutePath, { encoding: 'utf-8' })
        const parsed = jsonParse(content) as Record<string, unknown>

        // 启发式：如果有 "plugins" 数组，可能是 marketplace
        if (Array.isArray(parsed.plugins)) {
          return validateMarketplaceManifest(filePath)
        }
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code === 'ENOENT') {
          return {
            success: false,
            errors: [
              {
                path: 'file',
                message: `File not found: ${absolutePath}`,
              },
            ],
            warnings: [],
            filePath: absolutePath,
            fileType: 'plugin', // 错误报告时默认为插件类型
          }
        }
          // 回退到默认校验以处理其他错误（例如 JSON 解析）
      }

      // 默认：作为插件清单校验
      return validatePluginManifest(filePath)
    }
  }
}
