import {
  type ListResourcesResult,
  ListResourcesResultSchema,
  type ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { errorMessage } from '../utils/errors.js'
import { logMCPDebug, logMCPError } from '../utils/log.js'
import { recursivelySanitizeUnicode } from '../utils/sanitization.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'

const SKILL_URI_PREFIX = 'skill://'
const MCP_FETCH_CACHE_SIZE = 20

/**
 * 发现 MCP 服务器暴露为 `skill://` 资源的技能。
 *
 * 每个匹配的资源都会被读取，其 markdown 内容会被解析 frontmatter，
 * 结果会被转换为 Command，技能系统可以像本地 `.md` 技能文件一样
 * 对其进行索引和调用。
 *
 * 按服务器名称进行记忆化，以便连接生命周期内的重复调用返回
 * 缓存的结果。调用方通过 `.cache.delete(name)` 使缓存失效。
 */
export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []

    try {
      if (!client.capabilities?.resources) {
        return []
      }

      // 列出所有资源并过滤为 skill:// URI
      const result = (await client.client.request(
        { method: 'resources/list' },
        ListResourcesResultSchema,
      )) as ListResourcesResult

      if (!result.resources) return []

      const skillResources = result.resources.filter(r =>
        r.uri.startsWith(SKILL_URI_PREFIX),
      )

      if (skillResources.length === 0) return []

      logMCPDebug(
        client.name,
        `Found ${skillResources.length} skill resource(s)`,
      )

      const { createSkillCommand, parseSkillFrontmatterFields } =
        getMCPSkillBuilders()

      const commands: Command[] = []

      for (const resource of skillResources) {
        try {
          // 读取技能资源内容
          const readResult = (await client.client.request(
            {
              method: 'resources/read',
              params: { uri: resource.uri },
            },
            ReadResourceResultSchema,
          )) as ReadResourceResult

          // 从资源中提取文本内容
          const textContent = readResult.contents
            ?.map(c => ('text' in c ? c.text : undefined))
            .filter(Boolean)
            .join('\n')

          if (!textContent) {
            logMCPDebug(
              client.name,
              `Skill resource ${resource.uri} returned no text content, skipping`,
            )
            continue
          }

          const sanitizedContent = recursivelySanitizeUnicode(textContent)

          // 解析 markdown frontmatter
          const { frontmatter, content: markdownContent } =
            parseFrontmatter(sanitizedContent)

          // 从资源 URI 派生技能名称。剥离 skill:// 前缀并使用
          // 剩余部分，并以 MCP 服务器名称作为前缀，以便在服务器
          // 之间保持唯一。
          const rawName = resource.uri.slice(SKILL_URI_PREFIX.length)
          const skillName =
            'mcp__' + normalizeNameForMCP(client.name) + '__' + rawName

          const parsed = parseSkillFrontmatterFields(
            frontmatter,
            markdownContent,
            skillName,
          )

          commands.push(
            createSkillCommand({
              ...parsed,
              skillName,
              markdownContent,
              source: 'mcp',
              loadedFrom: 'mcp',
              baseDir: undefined,
              paths: undefined,
            }),
          )
        } catch (error) {
          logMCPError(
            client.name,
            `Failed to load skill resource ${resource.uri}: ${errorMessage(error)}`,
          )
        }
      }

      logMCPDebug(
        client.name,
        `Loaded ${commands.length} skill(s) from resources`,
      )

      return commands
    } catch (error) {
      logMCPError(
        client.name,
        `Failed to fetch skill resources: ${errorMessage(error)}`,
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_FETCH_CACHE_SIZE,
)
