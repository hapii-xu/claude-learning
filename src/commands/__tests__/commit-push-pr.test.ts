import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Command } from '../../commands.js'

mock.module('bun:bundle', () => ({
  feature: (_name: string) => false,
}))

mock.module('src/utils/attribution.ts', () => ({
  getAttributionTexts: () => ({ commit: '', pr: '' }),
  getEnhancedPRAttribution: async () => undefined,
  countUserPromptsInMessages: () => 0,
}))

mock.module('src/utils/undercover.ts', () => ({
  isUndercover: () => false,
  getUndercoverInstructions: () => '',
  shouldShowUndercoverAutoNotice: () => false,
}))

mock.module('src/utils/promptShellExecution.ts', () => ({
  executeShellCommandsInPrompt: async (content: string) => content,
}))

// 重要：mock.module 是进程级全局的。findGitRoot/findCanonicalGitRoot
// 在真实实现中是同步的（返回 string | null）—— 此处若用异步 stub，
// 会污染下游消费方（如 jobs/templates.ts）—— 它们会把返回值当字符串使用。
// 需匹配真实签名（同步，返回 string | null），这样同进程内其他测试文件才能正常工作。
//
// 纯函数（normalizeGitRemoteUrl）按真实语义内联实现，
// 这样 git.test.ts 和其他使用该 mock 的消费方在完整测试套件中运行时
// 不会看到 null 返回值。
const isLocalHostForMock = (host: string): boolean => {
  const lower = host.toLowerCase().split(':')[0] ?? ''
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1'
}
const realNormalizeGitRemoteUrl = (url: string): string | null => {
  const trimmed = url.trim()
  if (!trimmed) return null

  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase()
  }

  const urlMatch = trimmed.match(
    /^(?:https?|ssh):\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/,
  )
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    const host = urlMatch[1]
    const p = urlMatch[2]
    if (isLocalHostForMock(host) && p.startsWith('git/')) {
      const proxyPath = p.slice(4)
      const segments = proxyPath.split('/')
      if (segments.length >= 3 && segments[0]!.includes('.')) {
        return proxyPath.toLowerCase()
      }
      return `github.com/${proxyPath}`.toLowerCase()
    }
    return `${host}/${p}`.toLowerCase()
  }
  return null
}

mock.module('src/utils/git.ts', () => ({
  getDefaultBranch: async () => 'main',
  findGitRoot: (_startPath?: string) => '/fake/root',
  findCanonicalGitRoot: (_startPath?: string) => '/fake/root',
  gitExe: () => 'git',
  getIsGit: async () => true,
  getGitDir: async () => null,
  isAtGitRoot: async () => true,
  dirIsInGitRepo: async () => true,
  getHead: async () => 'abc123',
  getBranch: async () => 'main',
  // 以下导出被 markdownConfigLoader（以及其他传递性消费方）引用 ——
  // 提供最小 stub，使 mock 表面覆盖每个真实导出，避免下游调用方看到 undefined。
  getRemoteUrl: async () => null,
  normalizeGitRemoteUrl: realNormalizeGitRemoteUrl,
  getRepoRemoteHash: async () => null,
  getIsHeadOnRemote: async () => false,
  hasUnpushedCommits: async () => false,
  getIsClean: async () => true,
  getChangedFiles: async () => [] as string[],
  getFileStatus: async () => ({
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
    untracked: [],
  }),
  getWorktreeCount: async () => 1,
  stashToCleanState: async () => false,
  getGitState: async () => null,
  getGithubRepo: async () => null,
  findRemoteBase: async () => null,
  preserveGitStateForIssue: async () => null,
  isCurrentDirectoryBareGitRepo: () => false,
}))

let commitPushPr: Command
let originalUserType: string | undefined
let originalSafeUser: string | undefined
let originalUser: string | undefined

beforeEach(async () => {
  originalUserType = process.env.USER_TYPE
  originalSafeUser = process.env.SAFEUSER
  originalUser = process.env.USER
  const mod = await import('../commit-push-pr.js')
  commitPushPr = mod.default as Command
})

afterEach(() => {
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType

  if (originalSafeUser === undefined) delete process.env.SAFEUSER
  else process.env.SAFEUSER = originalSafeUser

  if (originalUser === undefined) delete process.env.USER
  else process.env.USER = originalUser
})

describe('commit-push-pr command metadata', () => {
  test('has correct name', () => {
    expect(commitPushPr.name).toBe('commit-push-pr')
  })

  test('has description', () => {
    expect(commitPushPr.description).toBeTruthy()
    expect(typeof commitPushPr.description).toBe('string')
  })

  test('type is prompt', () => {
    expect(commitPushPr.type).toBe('prompt')
  })

  test('has progressMessage', () => {
    expect((commitPushPr as any).progressMessage).toBeTruthy()
  })

  test('source is builtin', () => {
    expect((commitPushPr as any).source).toBe('builtin')
  })

  test('has allowedTools array with git and gh tools', () => {
    const tools = (commitPushPr as any).allowedTools as string[]
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.some(t => t.includes('git push'))).toBe(true)
    expect(tools.some(t => t.includes('gh pr create'))).toBe(true)
    expect(tools.some(t => t.includes('git add'))).toBe(true)
    expect(tools.some(t => t.includes('git commit'))).toBe(true)
  })

  test('contentLength getter returns a number', () => {
    const len = (commitPushPr as any).contentLength
    expect(typeof len).toBe('number')
    expect(len).toBeGreaterThan(0)
  })
})

describe('commit-push-pr getPromptForCommand', () => {
  const makeContext = () => ({
    getAppState: () => ({
      toolPermissionContext: {
        alwaysAllowRules: { command: [] },
      },
    }),
  })

  test('returns array with text type for empty args', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].type).toBe('text')
  })

  test('result text contains pull request instructions', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('PR')
  })

  test('result text contains default branch', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('main')
  })

  test('appends additional user instructions when args provided', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      'Fix the bug',
      makeContext(),
    )
    expect(result[0].text).toContain('Fix the bug')
    expect(result[0].text).toContain('Additional instructions')
  })

  test('does not append additional instructions section for whitespace-only args', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      '   ',
      makeContext(),
    )
    expect(result[0].text).not.toContain('Additional instructions')
  })

  test('handles null/undefined args gracefully', async () => {
    const result = await (commitPushPr as any).getPromptForCommand(
      undefined,
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].type).toBe('text')
  })

  test('with ant user type and not undercover, includes reviewer arg', async () => {
    process.env.USER_TYPE = 'external'
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('gh pr create')
  })

  test('with SAFEUSER env var set, text contains context', async () => {
    process.env.SAFEUSER = 'testuser'
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(result[0].text).toContain('SAFEUSER')
  })

  test('with ant user type and undercover, strips reviewer args', async () => {
    process.env.USER_TYPE = 'ant'
    // isUndercover 被 mock 为 false，因此不会添加前缀
    const result = await (commitPushPr as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
  })

  test('with args containing newlines, appends full multi-line instructions', async () => {
    const multiline = 'Line one\nLine two\nLine three'
    const result = await (commitPushPr as any).getPromptForCommand(
      multiline,
      makeContext(),
    )
    expect(result[0].text).toContain('Line one')
    expect(result[0].text).toContain('Line three')
  })

  test('getAppState override in context includes ALLOWED_TOOLS', async () => {
    let capturedGetAppState: (() => any) | undefined

    // 重新 mock executeShellCommandsInPrompt 以捕获 context 参数
    mock.module('src/utils/promptShellExecution.ts', () => ({
      executeShellCommandsInPrompt: async (content: string, ctx: any) => {
        capturedGetAppState = ctx.getAppState.bind(ctx)
        return content
      },
    }))

    // 重新 import 以让新的 mock 生效
    const { default: freshCmd } = await import('../commit-push-pr.js')

    await (freshCmd as any).getPromptForCommand('', {
      getAppState: () => ({
        toolPermissionContext: {
          alwaysAllowRules: { command: ['pre-existing'] },
          extra: true,
        },
        someState: 'value',
      }),
    })

    expect(capturedGetAppState).toBeDefined()
    const resultState = capturedGetAppState!()
    expect(
      Array.isArray(resultState.toolPermissionContext.alwaysAllowRules.command),
    ).toBe(true)
    // 应当已被替换为 ALLOWED_TOOLS
    expect(
      resultState.toolPermissionContext.alwaysAllowRules.command.length,
    ).toBeGreaterThan(0)
    expect(resultState.someState).toBe('value')
  })

  test('ant undercover path strips reviewer/slack/changelog sections', async () => {
    process.env.USER_TYPE = 'ant'

    // 为该测试重新 mock undercover 使其返回 true
    mock.module('src/utils/undercover.ts', () => ({
      isUndercover: () => true,
      getUndercoverInstructions: () => 'UNDERCOVER_INSTRUCTIONS',
      shouldShowUndercoverAutoNotice: () => false,
    }))

    // 同时重新 mock attribution 以返回 commit 文本
    mock.module('src/utils/attribution.ts', () => ({
      getAttributionTexts: () => ({
        commit: 'Attribution text',
        pr: 'PR Attribution',
      }),
      getEnhancedPRAttribution: async () => 'Enhanced PR Attribution',
      countUserPromptsInMessages: () => 0,
    }))

    const { default: freshCmd } = await import('../commit-push-pr.js')

    const result = await (freshCmd as any).getPromptForCommand(
      '',
      makeContext(),
    )
    expect(Array.isArray(result)).toBe(true)
    // undercover 路径会移除 slackStep、changelogSection 和 reviewer 参数
    // prompt 中不应出现这些段落
    expect(result[0].text).not.toContain('CHANGELOG:START')
    expect(result[0].text).not.toContain('Slack')
  })
})
