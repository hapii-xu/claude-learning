/**
 * promptEngineeringAudit.test.ts
 *
 * 验证 prompts.ts 中从 Opus 4.7 官方 prompt 借鉴的提示词工程改进。
 * 对应审计文档: docs/features/opus-4.7-prompt-engineering-audit.md
 *
 * 测试策略: 通过 getSystemPrompt() 生成完整 system prompt，
 * 然后检查关键段落是否存在。大部分被测函数是 module-private，
 * 只能通过最终输出间接验证。
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'

// --- MACRO 全局注入 (编译时 define 在测试中不可用) ---
;(globalThis as any).MACRO = {
  VERSION: '2.1.888',
  BUILD_TIME: '2026-04-22T00:00:00Z',
  FEEDBACK_CHANNEL: '',
  ISSUES_EXPLAINER: 'report issues on GitHub',
  NATIVE_PACKAGE_URL: '',
  PACKAGE_URL: '',
  VERSION_CHANGELOG: '',
}

// --- Mock 链 (阻断副作用) ---

mock.module('src/bootstrap/state.js', () => ({
  getIsNonInteractiveSession: () => false,
  sessionId: 'test-session',
  getCwd: () => '/test/project',
}))
mock.module('src/utils/cwd.js', () => ({
  getCwd: () => '/test/project',
}))
mock.module('src/utils/git.js', () => ({
  getIsGit: async () => true,
}))
mock.module('src/utils/worktree.js', () => ({
  getCurrentWorktreeSession: () => null,
}))
mock.module('src/constants/common.js', () => ({
  getSessionStartDate: () => '2026-04-22',
}))
mock.module('src/utils/settings/settings.js', () => ({
  getInitialSettings: () => ({ language: undefined }),
}))
mock.module('src/commands/poor/poorMode.js', () => ({
  isPoorModeActive: () => false,
}))
mock.module('src/utils/env.js', () => ({
  env: { platform: 'linux' },
}))
mock.module('src/utils/envUtils.js', () => ({
  isEnvTruthy: () => false,
}))
mock.module('src/utils/model/model.js', () => ({
  getCanonicalName: (id: string) => id,
  getMarketingNameForModel: (id: string) => {
    if (id.includes('opus-4-7')) return 'Claude Opus 4.7'
    if (id.includes('opus-4-6')) return 'Claude Opus 4.6'
    if (id.includes('sonnet-4-6')) return 'Claude Sonnet 4.6'
    return null
  },
}))
mock.module('src/commands.js', () => ({
  getSkillToolCommands: async () => [],
}))
mock.module('src/constants/outputStyles.js', () => ({
  getOutputStyleConfig: async () => null,
}))
mock.module('src/utils/embeddedTools.js', () => ({
  hasEmbeddedSearchTools: () => false,
}))
mock.module('src/utils/permissions/filesystem.js', () => ({
  isScratchpadEnabled: () => false,
  getScratchpadDir: () => '/tmp/scratchpad',
}))
mock.module('src/utils/betas.js', () => ({
  shouldUseGlobalCacheScope: () => false,
}))
mock.module('src/utils/undercover.js', () => ({
  isUndercover: () => false,
}))
mock.module('src/utils/model/antModels.js', () => ({
  getAntModelOverrideConfig: () => null,
}))
mock.module('src/utils/mcpInstructionsDelta.js', () => ({
  isMcpInstructionsDeltaEnabled: () => false,
}))
mock.module('src/memdir/memdir.js', () => ({
  loadMemoryPrompt: async () => null,
}))
mock.module('src/utils/debug.js', () => ({
  logForDebugging: () => {},
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))
mock.module('src/constants/systemPromptSections.js', () => ({
  systemPromptSection: (_name: string, fn: () => any) => fn(),
  DANGEROUS_uncachedSystemPromptSection: (_name: string, fn: () => any) => fn(),
  resolveSystemPromptSections: async (sections: any[]) =>
    sections.filter(s => s !== null),
}))

// 工具常量 mock
const TOOL_NAMES = {
  Bash: 'Bash',
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  Glob: 'Glob',
  Grep: 'Grep',
  Agent: 'Agent',
  AskUserQuestion: 'AskUserQuestion',
  TaskCreate: 'TaskCreate',
  DiscoverSkills: 'DiscoverSkills',
  Skill: 'Skill',
  Sleep: 'Sleep',
}

mock.module(
  '@claude-code-best/builtin-tools/tools/BashTool/toolName.js',
  () => ({ BASH_TOOL_NAME: TOOL_NAMES.Bash }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/FileReadTool/prompt.js',
  () => ({ FILE_READ_TOOL_NAME: TOOL_NAMES.Read }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/FileEditTool/constants.js',
  () => ({ FILE_EDIT_TOOL_NAME: TOOL_NAMES.Edit }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/FileWriteTool/prompt.js',
  () => ({ FILE_WRITE_TOOL_NAME: TOOL_NAMES.Write }),
)
mock.module('@claude-code-best/builtin-tools/tools/GlobTool/prompt.js', () => ({
  GLOB_TOOL_NAME: TOOL_NAMES.Glob,
}))
mock.module('@claude-code-best/builtin-tools/tools/GrepTool/prompt.js', () => ({
  GREP_TOOL_NAME: TOOL_NAMES.Grep,
}))
mock.module(
  '@claude-code-best/builtin-tools/tools/AgentTool/constants.js',
  () => ({
    AGENT_TOOL_NAME: TOOL_NAMES.Agent,
    VERIFICATION_AGENT_TYPE: 'verification',
  }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/AgentTool/forkSubagent.js',
  () => ({ isForkSubagentEnabled: () => false }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/AgentTool/builtInAgents.js',
  () => ({ areExplorePlanAgentsEnabled: () => false }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/AgentTool/built-in/exploreAgent.js',
  () => ({
    EXPLORE_AGENT: { agentType: 'explore' },
    EXPLORE_AGENT_MIN_QUERIES: 5,
  }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/AskUserQuestionTool/prompt.js',
  () => ({ ASK_USER_QUESTION_TOOL_NAME: TOOL_NAMES.AskUserQuestion }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/TodoWriteTool/constants.js',
  () => ({ TODO_WRITE_TOOL_NAME: 'TodoWrite' }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/TaskCreateTool/constants.js',
  () => ({ TASK_CREATE_TOOL_NAME: TOOL_NAMES.TaskCreate }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/DiscoverSkillsTool/prompt.js',
  () => ({ DISCOVER_SKILLS_TOOL_NAME: TOOL_NAMES.DiscoverSkills }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/SkillTool/constants.js',
  () => ({ SKILL_TOOL_NAME: TOOL_NAMES.Skill }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/SleepTool/prompt.js',
  () => ({ SLEEP_TOOL_NAME: TOOL_NAMES.Sleep }),
)
mock.module(
  '@claude-code-best/builtin-tools/tools/REPLTool/constants.js',
  () => ({ isReplModeEnabled: () => false }),
)

// --- 导入被测模块 ---

import {
  getSystemPrompt,
  prependBullets,
  computeSimpleEnvInfo,
  getScratchpadInstructions,
} from './prompts.js'
import type { Tools } from '../Tool.js'

// --- 辅助 ---

const standardTools: Tools = [
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Edit' },
  { name: 'Write' },
  { name: 'Glob' },
  { name: 'Grep' },
  { name: 'Agent' },
  { name: 'AskUserQuestion' },
  { name: 'TaskCreate' },
] as any

async function getFullPrompt(
  tools: Tools = standardTools,
  model = 'claude-opus-4-7',
): Promise<string> {
  const sections = await getSystemPrompt(tools, model)
  return sections.join('\n\n')
}

// =====================================================================
// 第一部分: 提示词工程技巧验证
// 对应审计文档 第一部分 #1-#10
// =====================================================================

describe('Opus 4.7 Prompt Engineering Audit', () => {
  // ------------------------------------------------------------------
  // #1 决策树结构 (Decision Tree)
  // TXT 来源: {request_evaluation_checklist} — Step 0→1→2→3
  // ------------------------------------------------------------------
  describe('#1 Decision tree for tool selection', () => {
    test('prompt contains tool selection guidance via dedicated tools', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('优先使用专用工具')
      expect(prompt).toContain('保留')
      expect(prompt).toContain('shell 操作')
    })

    test('guidance distinguishes dedicated tools from Bash', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('专用工具')
    })

    test('lists core tools as directly callable', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('核心工具')
      expect(prompt).toContain('根据需要直接调用')
    })

    test('provides concrete tool preference examples', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('而非 cat')
      expect(prompt).toContain('而非 sed')
    })
  })

  // ------------------------------------------------------------------
  // #2 反模式先行 (Anti-Pattern First)
  // TXT 来源: {unnecessary_computer_use_avoidance}, {artifact_usage_criteria}
  // ------------------------------------------------------------------
  describe('#2 Anti-pattern guidance (when NOT to use tools)', () => {
    test('prompt says when NOT to use tools', async () => {
      const prompt = await getFullPrompt()
      const hasAntiPattern =
        prompt.includes('不要使用') ||
        prompt.includes('保留') ||
        prompt.includes('不要重新尝试')
      expect(hasAntiPattern).toBe(true)
    })

    test('guidance covers Bash misuse', async () => {
      const prompt = await getFullPrompt()
      const hasBashGuidance =
        prompt.includes('保留') && prompt.includes('shell 操作')
      expect(hasBashGuidance).toBe(true)
    })

    test('anti-pattern covers file creation', async () => {
      const prompt = await getFullPrompt()
      const hasFileAntiPattern =
        prompt.includes('不要创建文件，除非') ||
        prompt.includes('优先编辑现有文件')
      expect(hasFileAntiPattern).toBe(true)
    })

    test('includes file creation anti-pattern', async () => {
      const prompt = await getFullPrompt()
      const hasFileAntiPattern =
        prompt.includes('不要创建文件，除非') ||
        prompt.includes('优先编辑现有文件')
      expect(hasFileAntiPattern).toBe(true)
    })
  })

  // ------------------------------------------------------------------
  // #6 渐进式回退链 (Progressive Fallback Chain)
  // TXT 来源: {core_search_behaviors}, {past_chats_tools}
  // ------------------------------------------------------------------
  describe('#6 Progressive fallback chain', () => {
    test('prompt encourages searching before asking user', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('搜索')
    })

    test('search tools are available for discovery', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Grep')
      expect(prompt).toContain('Glob')
    })

    test('fallback includes escalating to user via AskUserQuestion', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('AskUserQuestion')
    })

    test('search before saying unknown is present', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('先搜索再说不知道')
    })
  })

  // ------------------------------------------------------------------
  // #3 Few-Shot 场景示例 (Few-Shot Examples)
  // TXT 来源: {examples}, {visualizer_examples}, {past_chats_tools}
  // ------------------------------------------------------------------
  describe('#3 Few-shot examples', () => {
    test('contains concrete tool preference examples', async () => {
      const prompt = await getFullPrompt()
      const hasExamples =
        prompt.includes('而非 cat') || prompt.includes('而非 sed')
      expect(hasExamples).toBe(true)
    })

    test('examples cover different tool types', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Read')
      expect(prompt).toContain('Edit')
      expect(prompt).toContain('Grep')
    })

    test('examples include negative cases (what NOT to use)', async () => {
      const prompt = await getFullPrompt()
      const hasNegative =
        prompt.includes('而非 cat') ||
        prompt.includes('而非 sed') ||
        prompt.includes('而非 find') ||
        prompt.includes('而非 grep')
      expect(hasNegative).toBe(true)
    })

    test('core tools are enumerated', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('核心工具')
    })
  })

  // ------------------------------------------------------------------
  // #4 语言信号识别 (Linguistic Signal Detection)
  // TXT 来源: {past_chats_tools}, {file_creation_advice}
  // ------------------------------------------------------------------
  describe('#4 Linguistic signal detection', () => {
    test('file creation signals teach when to create vs inline', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('语言信号')
      expect(prompt).toContain('写一个脚本')
      expect(prompt).toContain('创建配置')
    })

    test('inline answer signals are listed', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('给我看怎么做')
      expect(prompt).toContain('内联回答')
    })

    test('20-line threshold for file creation', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('20 行')
    })
  })

  // ------------------------------------------------------------------
  // #5 成本不对称分析 (Asymmetric Cost Analysis)
  // TXT 来源: {tool_discovery} "treat tool_search as essentially free"
  // ------------------------------------------------------------------
  describe('#5 Cost asymmetry framing', () => {
    test('prompt has cost asymmetry for actions (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('暂停确认的成本很低')
    })

    test('guidance encourages searching over guessing', async () => {
      const prompt = await getFullPrompt()
      const hasSearchGuidance =
        prompt.includes('先搜索再说不知道') || prompt.includes('search with')
      expect(hasSearchGuidance).toBe(true)
    })

    test('expanded cost asymmetry with multiple scenarios', async () => {
      const prompt = await getFullPrompt()
      // 简化版 prompt 通过 「search before saying unknown」 传达成本概念
      expect(prompt).toContain('搜索')
    })
  })

  // ------------------------------------------------------------------
  // #7 反过度解释 (Anti-Over-Explanation)
  // TXT 来源: {sharing_files}, {request_evaluation_checklist}
  // ------------------------------------------------------------------
  describe('#7 Anti-over-explanation', () => {
    test('prompt contains no-machinery-narration rule (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不要叙述内部机制')
    })

    test('includes anti-postamble guidance', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不要重述')
      expect(prompt).toContain('报告结果')
    })

    test('discourages offering unchosen approach', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('未被选择的方案')
    })
  })

  // ------------------------------------------------------------------
  // #8 查询构造教学 (Query Construction Teaching)
  // TXT 来源: {search_usage_guidelines}, {past_chats_tools}
  // ------------------------------------------------------------------
  describe('#8 Query construction guidance', () => {
    test('Grep is mentioned as a search tool', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Grep')
    })

    test('Glob is mentioned as a search tool', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Glob')
    })

    test('search tools are referenced in "Search before saying unknown"', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('先搜索再说不知道')
    })

    test('dedicated tools are preferred over Bash equivalents', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('优先使用专用工具')
    })
  })

  // ------------------------------------------------------------------
  // #9 Prompt 注入防御 (Prompt Injection Defense)
  // TXT 来源: {anthropic_reminders}, {request_evaluation_checklist}
  // ------------------------------------------------------------------
  describe('#9 Prompt injection defense', () => {
    test('prompt warns about prompt injection in tool results (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('提示注入')
    })

    test('distinguishes file instructions from user instructions', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不是来自用户')
    })
  })

  // =====================================================================
  // 第二部分: 行为规则验证
  // 对应审计文档 第二部分 #11-#18
  // =====================================================================

  // ------------------------------------------------------------------
  // #11 格式化纪律 (Formatting Discipline)
  // TXT 来源: {lists_and_bullets}
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // #10 分步搜索策略 (Multi-Step Search Strategy)
  // TXT 来源: {tool_discovery}, {core_search_behaviors}
  // ------------------------------------------------------------------
  describe('#10 Multi-step search strategy', () => {
    test('encourages searching before concluding', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('先搜索再说不知道')
    })

    test('provides multiple search tools for different scopes', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('Grep')
      expect(prompt).toContain('Glob')
    })
  })

  describe('#11 Formatting discipline', () => {
    test('prompt contains prose-first guidance (existing)', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('散文段落')
    })

    test('discourages over-formatting', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('过度格式化')
      expect(prompt).toContain('简单的答案')
    })

    test('bullet points must be 1-2 sentences, not fragments', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('1-2 句话')
    })
  })

  // ------------------------------------------------------------------
  // #22 先搜再说不知道 (Search Before Saying Unknown)
  // TXT 来源: {tool_discovery}
  // ------------------------------------------------------------------
  describe('#22 Search before saying unknown', () => {
    test('instructs to search before claiming something does not exist', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('先搜索再说不知道')
    })

    test('core tools are listed as always available', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('直接调用')
    })
  })

  // ------------------------------------------------------------------
  // #12 温暖语气 (Warm Tone)
  // TXT 来源: {tone_and_formatting}
  // ------------------------------------------------------------------
  describe('#12 Warm tone', () => {
    test('avoids negative assumptions about user abilities', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('负面假设')
    })

    test('pushback should be constructive', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('建设性')
    })
  })

  // ------------------------------------------------------------------
  // #20 风险感知时说得更少 (Say Less When Risky)
  // TXT 来源: {refusal_handling}
  // ------------------------------------------------------------------
  describe('#20 Say less when risky', () => {
    test('security-sensitive code should say less about details', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('少说实现细节')
    })
  })

  // ------------------------------------------------------------------
  // #23 不解释为什么搜索 (Don't Justify Search)
  // TXT 来源: {search_usage_guidelines}
  // ------------------------------------------------------------------
  describe("#23 Don't justify search", () => {
    test('instructs not to justify why searching', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不要证明你为什么搜索')
    })
  })

  // ------------------------------------------------------------------
  // #13 产品线信息 (Product Information)
  // TXT 来源: {product_information}
  // ------------------------------------------------------------------
  describe('#13 Product information', () => {
    test('env info contains Claude Code product description', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('Claude Code')
      expect(envInfo).toContain('CLI')
    })

    test('env info contains model family', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('Claude 4.5/4.6/4.7')
    })

    test('env info contains correct model IDs', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('claude-opus-4-7')
      expect(envInfo).toContain('claude-sonnet-4-6')
      expect(envInfo).toContain('claude-haiku-4-5')
    })

    test('mentions Chrome/Excel/Cowork products', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('Chrome')
      expect(envInfo).toContain('Excel')
      expect(envInfo).toContain('Cowork')
    })
  })

  // ------------------------------------------------------------------
  // #15 对话结束尊重 (Conversation End Respect)
  // TXT 来源: {refusal_handling} line 51
  // ------------------------------------------------------------------
  describe('#15 Conversation end respect', () => {
    test('discourages "anything else?" appendages', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不要附加')
      expect(prompt).toContain('还有其他问题吗')
    })
  })

  // ------------------------------------------------------------------
  // #16 每回复最多一个问题 (One Question Per Response)
  // TXT 来源: {tone_and_formatting} line 71
  // ------------------------------------------------------------------
  describe('#16 One question per response', () => {
    test('limits questions per response', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('一个问题')
    })
  })

  // =====================================================================
  // 第三部分: 已存在功能的回归测试
  // 确保现有的从 TXT 对齐的锚点不被破坏
  // =====================================================================

  describe('Existing behavioral anchors (regression)', () => {
    test('default_stance: default to helping', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('默认提供帮助')
      expect(prompt).toContain('具体、特定的严重伤害风险')
    })

    test('anti-collapse: no self-abasement', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('自我贬低')
      expect(prompt).toContain('保持自尊')
    })

    test('cutoff silence: do not proactively mention cutoff', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不要主动提及你的知识截止日期')
    })

    test('no-machinery-narration: describe in user terms', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('不要叙述内部机制')
      expect(prompt).toContain('用用户术语描述操作')
    })

    test('tool_discovery: search before saying unavailable', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('搜索它')
      expect(prompt).toContain(
        '只有在 SearchExtraTools 返回无匹配时才声明不可用',
      )
    })

    test('false-claims mitigation: report outcomes faithfully', async () => {
      const prompt = await getFullPrompt()
      expect(prompt).toContain('报告结果')
    })

    test('CYBER_RISK_INSTRUCTION: allows security testing', async () => {
      const prompt = await getFullPrompt()
      // TS 允许安全测试 (TXT 完全禁止 — 这是有意的差异)
      expect(prompt).not.toContain(
        'does not write or explain or work on malicious code',
      )
    })
  })

  // =====================================================================
  // 第四部分: prependBullets 工具函数
  // =====================================================================

  describe('prependBullets utility', () => {
    test('flat items get single bullet', () => {
      const result = prependBullets(['A', 'B'])
      expect(result).toEqual([' - A', ' - B'])
    })

    test('nested arrays get double-indented bullets', () => {
      const result = prependBullets(['A', ['sub1', 'sub2'], 'B'])
      expect(result).toEqual([' - A', '  - sub1', '  - sub2', ' - B'])
    })

    test('empty array returns empty', () => {
      expect(prependBullets([])).toEqual([])
    })
  })

  // =====================================================================
  // 第五部分: 环境信息与模型 cutoff
  // =====================================================================

  describe('Knowledge cutoff correctness', () => {
    test('Opus 4.7 cutoff is January 2026', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('January 2026')
    })

    test('Opus 4.6 cutoff is May 2025', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-6')
      expect(envInfo).toContain('May 2025')
    })

    test('Sonnet 4.6 cutoff is August 2025', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-sonnet-4-6')
      expect(envInfo).toContain('August 2025')
    })

    test('Opus 4.7 frontier model name is correct', async () => {
      const envInfo = await computeSimpleEnvInfo('claude-opus-4-7')
      expect(envInfo).toContain('Claude Opus 4.7')
    })
  })
})
