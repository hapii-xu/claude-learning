import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
import { buildTool } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  DISCOVER_SKILLS_TOOL_NAME,
  DESCRIPTION,
  DISCOVER_SKILLS_PROMPT,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    description: z
      .string()
      .describe(
        '描述你想要做什么。要具体 — 例如「将 Next.js 应用部署到 Cloudflare Workers」而不是仅说「部署」。',
      ),
    limit: z
      .number()
      .optional()
      .describe('返回的最大结果数（默认：5）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type DiscoverInput = z.infer<InputSchema>

type DiscoverOutput = {
  results: Array<{ name: string; description: string; score: number }>
  count: number
}

export const DiscoverSkillsTool = buildTool({
  name: DISCOVER_SKILLS_TOOL_NAME,
  searchHint: 'find search discover skills commands tools capabilities',
  maxResultSizeChars: 10_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DISCOVER_SKILLS_PROMPT
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'Discover Skills'
  },

  renderToolUseMessage(input: Partial<DiscoverInput>) {
    return `Searching skills: ${input.description?.slice(0, 80) ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: DiscoverOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    if (content.count === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No matching skills found for that description.',
      }
    }
    const lines = content.results.map(
      (r, i) =>
        `${i + 1}. **${r.name}** (score: ${r.score.toFixed(2)})\n   ${r.description}`,
    )
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Found ${content.count} relevant skill(s):\n\n${lines.join('\n\n')}`,
    }
  },

  async call(input: DiscoverInput, context) {
    const { getSkillIndex, searchSkills } = await import(
      'src/services/skillSearch/localSearch.js'
    )
    const { getCwd } = await import('src/utils/cwd.js')
    const cwd = getCwd()

    const index = await getSkillIndex(cwd)
    const results = searchSkills(input.description, index, input.limit ?? 5)

    return {
      data: {
        results: results.map(r => ({
          name: r.name,
          description: r.description,
          score: r.score,
        })),
        count: results.length,
      },
    }
  },
})
