import { join, normalize, sep } from 'path'
import { getProjectRoot } from 'src/bootstrap/state.js'
import { buildMemoryPrompt, ensureMemoryDirExists } from 'src/memdir/memdir.js'
import { getMemoryBaseDir } from 'src/memdir/paths.js'
import { getCwd } from 'src/utils/cwd.js'
import { findCanonicalGitRoot } from 'src/utils/git.js'
import { sanitizePath } from 'src/utils/path.js'
import { CLAUDE_DIR_NAME } from 'src/constants/claudeDirName.js'

// 持久化代理记忆作用域：'user' (~/.hclaude/agent-memory/)、'project' (.hclaude/agent-memory/) 或 'local' (.hclaude/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * 对代理类型名称进行清理以用作目录名。
 * 将冒号（在 Windows 上非法，用于插件命名空间的代理类型，
 * 例如 "my-plugin:my-agent"）替换为连字符。
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  return agentType.replace(/:/g, '-')
}

/**
 * 返回本地代理记忆目录，该目录特定于项目且不提交到版本控制。
 * 设置 CLAUDE_CODE_REMOTE_MEMORY_DIR 时，持久化到挂载点并以项目命名空间隔离。
 * 否则，使用 <cwd>/.hclaude/agent-memory-local/<agentType>/。
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(
          findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot(),
        ),
        'agent-memory-local',
        dirName,
      ) + sep
    )
  }
  return join(getCwd(), CLAUDE_DIR_NAME, 'agent-memory-local', dirName) + sep
}

/**
 * 返回给定代理类型和作用域的代理记忆目录。
 * - 'user' 作用域：<memoryBase>/agent-memory/<agentType>/
 * - 'project' 作用域：<cwd>/.hclaude/agent-memory/<agentType>/
 * - 'local' 作用域：参见 getLocalAgentMemoryDir()
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      return join(getCwd(), CLAUDE_DIR_NAME, 'agent-memory', dirName) + sep
    case 'local':
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

// 检查文件是否在代理记忆目录内（任意作用域）。
export function isAgentMemoryPath(absolutePath: string): boolean {
  // 安全性：规范化以防止通过 .. 段绕过路径遍历
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()

  // 用户作用域：检查 memory base（可能是自定义目录或配置主目录）
  if (normalizedPath.startsWith(join(memoryBase, 'agent-memory') + sep)) {
    return true
  }

  // 项目作用域：始终基于 cwd（不会被重定向）
  if (
    normalizedPath.startsWith(
      join(getCwd(), CLAUDE_DIR_NAME, 'agent-memory') + sep,
    )
  ) {
    return true
  }

  // 本地作用域：当设置 CLAUDE_CODE_REMOTE_MEMORY_DIR 时持久化到挂载点，否则基于 cwd
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    normalizedPath.startsWith(
      join(getCwd(), CLAUDE_DIR_NAME, 'agent-memory-local') + sep,
    )
  ) {
    return true
  }

  return false
}

/**
 * 返回给定代理类型和作用域的代理记忆文件路径。
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
}

export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      return `User (${join(getMemoryBaseDir(), 'agent-memory')}/)`
    case 'project':
      return 'Project (.hclaude/agent-memory/)'
    case 'local':
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      return 'None'
  }
}

/**
 * 为启用了记忆功能的代理加载持久化记忆。
 * 如有需要会创建记忆目录，并返回包含记忆内容的提示字符串。
 *
 * @param agentType 代理类型名称（用作目录名）
 * @param scope 'user' 对应 ~/.hclaude/agent-memory/，'project' 对应 .hclaude/agent-memory/
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  let scopeNote: string
  switch (scope) {
    case 'user':
      scopeNote =
        '- 由于此记忆为 user 作用域，请保持学习内容的通用性，因为它适用于所有项目'
      break
    case 'project':
      scopeNote =
        '- 由于此记忆为 project 作用域，并通过版本控制与团队共享，请针对此项目定制你的记忆内容'
      break
    case 'local':
      scopeNote =
        '- 由于此记忆为 local 作用域（不提交到版本控制），请针对此项目和此机器定制你的记忆内容'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // 即发即弃：这在代理生成时运行于同步
  // getSystemPrompt() 回调内（从 AgentDetail.tsx 的 React 渲染中调用，
  // 因此不能是异步的）。生成的代理在完整的 API 往返之前
  // 不会尝试写入，到那时 mkdir 将已完成。即使
  // 尚未完成，FileWriteTool 也会自己对父目录执行 mkdir。
  void ensureMemoryDirExists(memoryDir)

  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines]
        : [scopeNote],
  })
}
