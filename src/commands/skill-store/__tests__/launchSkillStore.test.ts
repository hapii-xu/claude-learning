/**
 * launchSkillStore.tsx 的测试
 *
 * 遵循 feedback_mock_dependency_not_subject 策略：
 * - 不要 mock skillsApi.ts 本身（会污染 api.test.ts）
 * - 通过 mock axios（底层 HTTP 层）来控制 API 响应
 * - mock fs/promises 以处理 install 相关的文件系统操作
 * - 让真实的 skillsApi 函数运行真实代码路径
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

// ── Analytics mock ──────────────────────────────────────────────────
const realAnalytics = await import('src/services/analytics/index.js')
const logEventMock = mock(() => {})
mock.module('src/services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: logEventMock,
}))

// ── Auth / OAuth mocks ──────────────────────────────────────────────────
const realAuth = await import('src/utils/auth.js')
mock.module('src/utils/auth.js', () => ({
  ...realAuth,
  getClaudeAIOAuthTokens: () => ({ accessToken: 'test-token' }),
}))
mock.module('src/services/oauth/client.js', () => ({
  getOrganizationUUID: async () => 'org-uuid',
}))
mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}))
// 展开真实的 teleport/api，这样未显式 stub 的导出（例如
// prepareWorkspaceApiRequest、axiosGetWithRetry、类型守卫、schemas）
// 对传递性导入方仍然可用。
const realTeleportApi = await import('src/utils/teleport/api.js')
mock.module('src/utils/teleport/api.js', () => ({
  ...realTeleportApi,
  getOAuthHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
  prepareWorkspaceApiRequest: async () => ({
    apiKey: 'test-workspace-key',
  }),
}))

// ── envUtils 配置目录注入 ────────────────────────────────────────────
// 不要 mock envUtils 模块 — 它是进程级的，会泄漏到其他测试的
// getClaudeConfigHomeDir 消费方（见 feedback_mock_dependency_not_subject）。
// 改为通过 process.env 注入 CLAUDE_CONFIG_DIR，并在每个测试前后清理 lodash
// memoize 缓存，这样真实的 getClaudeConfigHomeDir 才能读取到我们设置的值。
const mockConfigDir = '/tmp/test-claude-config'

// ── Axios mock ──────────────────────────────────────────────────────────
const axiosGetMock = mock(async () => ({}))
const axiosPostMock = mock(async () => ({}))
const axiosDeleteMock = mock(async () => ({}))
const axiosIsAxiosError = mock((err: unknown) => {
  return (
    typeof err === 'object' &&
    err !== null &&
    'isAxiosError' in err &&
    (err as { isAxiosError: boolean }).isAxiosError === true
  )
})

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = axiosGetMock
axiosHandle.stubs.post = axiosPostMock
axiosHandle.stubs.delete = axiosDeleteMock
axiosHandle.stubs.isAxiosError = axiosIsAxiosError

// ── fs/promises mock ─────────────────────────────────────────────────────
// Bun 的 mock.module 在进程范围内全局生效，且遵循 last-write-wins。若用
// 仅包含 mkdir + writeFile 的版本替换 node:fs/promises，会破坏同一次
// `bun test` 运行中其他导入 readFile / readdir / unlink / chmod 等的测试
// （尤其是 src/services/localVault/__tests__/store.test.ts）。
//
// 在工厂内部使用 require()（与 SessionMemory/prompts.test 相同的技巧），
// 这样我们获得绕过 mock 注册表的真正真实模块。将两个 stub 通过
// useSkillStoreFsStubs 控制（默认关闭；beforeAll 打开；afterAll 关闭）。
const mkdirMock = mock(async (..._args: unknown[]) => undefined)
const writeFileMock = mock(async (..._args: unknown[]) => undefined)
let useSkillStoreFsStubs = false
mock.module('node:fs/promises', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:fs/promises') as Record<string, unknown>
  return {
    ...real,
    default: real,
    mkdir: (...args: unknown[]) =>
      useSkillStoreFsStubs
        ? mkdirMock(...args)
        : (real.mkdir as (...a: unknown[]) => Promise<unknown>)(...args),
    writeFile: (...args: unknown[]) =>
      useSkillStoreFsStubs
        ? writeFileMock(...args)
        : (real.writeFile as (...a: unknown[]) => Promise<unknown>)(...args),
  }
})

// ── 懒加载 imports ─────────────────────────────────────────────────────
let callSkillStore: typeof import('../launchSkillStore.js').callSkillStore
let getClaudeConfigHomeDir: typeof import('../../../utils/envUtils.js').getClaudeConfigHomeDir
let origConfigDir: string | undefined

beforeAll(async () => {
  axiosHandle.useStubs = true
  const mod = await import('../launchSkillStore.js')
  callSkillStore = mod.callSkillStore
  const envMod = await import('../../../utils/envUtils.js')
  getClaudeConfigHomeDir = envMod.getClaudeConfigHomeDir
  origConfigDir = process.env.CLAUDE_CONFIG_DIR
  useSkillStoreFsStubs = true
})

// 在本套件之后关闭 stub flag，使同一进程中的 localVault/store 及其他依赖 fs 的
// 测试能看到真实的 readFile/readdir 等。
afterAll(() => {
  axiosHandle.useStubs = false
  useSkillStoreFsStubs = false
})

beforeEach(() => {
  axiosGetMock.mockClear()
  axiosPostMock.mockClear()
  axiosDeleteMock.mockClear()
  mkdirMock.mockClear()
  writeFileMock.mockClear()
  logEventMock.mockClear()
  // 注入我们的 mock 配置目录 + 清除 lodash memoize 缓存，这样真实的
  // getClaudeConfigHomeDir 才能读取到刚设置的 env 变量。
  process.env.CLAUDE_CONFIG_DIR = mockConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
})

afterEach(() => {
  // 恢复 env，避免将 mockConfigDir 泄漏到其他测试文件。
  if (origConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = origConfigDir
  }
  getClaudeConfigHomeDir.cache?.clear?.()
})

// ── 辅助函数 ────────────────────────────────────────────────────────────
function makeOnDone() {
  const calls: [string | undefined, unknown][] = []
  const onDone = (msg?: string, opts?: unknown) => calls.push([msg, opts])
  return { onDone, calls }
}

// ── list ──────────────────────────────────────────────────────────────
describe('list action', () => {
  test('calls listSkills and returns element on success', async () => {
    const skills = [
      { skill_id: 'sk_1', name: 'skill-a', owner: 'alice', deprecated: false },
    ]
    axiosGetMock.mockResolvedValueOnce({ data: { data: skills }, status: 200 })
    const { onDone } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'list')
    expect(result).not.toBeNull()
    expect(axiosGetMock).toHaveBeenCalledTimes(1)
  })

  test('empty list returns element', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    const { onDone, calls } = makeOnDone()
    await callSkillStore(onDone, {} as never, 'list')
    expect(calls[0]?.[0]).toContain('No skills')
  })

  test('API error reports failure', async () => {
    axiosGetMock.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401 },
      message: 'Unauthorized',
    })
    const { onDone, calls } = makeOnDone()
    await callSkillStore(onDone, {} as never, 'list')
    expect(calls[0]?.[0]).toContain('Failed')
  })
})

// ── get ───────────────────────────────────────────────────────────────
describe('get action', () => {
  test('fetches and returns skill detail', async () => {
    const skill = {
      skill_id: 'sk_1',
      name: 'my-skill',
      owner: 'user',
      deprecated: false,
    }
    axiosGetMock.mockResolvedValueOnce({ data: skill, status: 200 })
    const { onDone } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'get sk_1')
    expect(result).not.toBeNull()
    expect(axiosGetMock).toHaveBeenCalledTimes(1)
  })

  test('API 404 reports failure', async () => {
    axiosGetMock.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 404 },
      message: 'Not found',
    })
    const { onDone, calls } = makeOnDone()
    await callSkillStore(onDone, {} as never, 'get missing_id')
    expect(calls[0]?.[0]).toContain('Failed')
  })
})

// ── versions ──────────────────────────────────────────────────────────
describe('versions action', () => {
  test('fetches and returns versions', async () => {
    const versions = [
      {
        version: 'v1',
        skill_id: 'sk_1',
        body: '# v1',
        created_at: '2024-01-01',
      },
    ]
    axiosGetMock.mockResolvedValueOnce({
      data: { data: versions },
      status: 200,
    })
    const { onDone } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'versions sk_1')
    expect(result).not.toBeNull()
  })
})

// ── version ───────────────────────────────────────────────────────────
describe('version action', () => {
  test('fetches specific version', async () => {
    const ver = {
      version: 'v2',
      skill_id: 'sk_1',
      body: '# v2',
      created_at: '2024-02-01',
    }
    axiosGetMock.mockResolvedValueOnce({ data: ver, status: 200 })
    const { onDone } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'version sk_1 v2')
    expect(result).not.toBeNull()
    expect(axiosGetMock).toHaveBeenCalledTimes(1)
  })
})

// ── create ────────────────────────────────────────────────────────────
describe('create action', () => {
  test('creates skill and returns result', async () => {
    const skill = {
      skill_id: 'sk_new',
      name: 'new-skill',
      owner: 'user',
      deprecated: false,
    }
    axiosPostMock.mockResolvedValueOnce({ data: skill, status: 201 })
    const { onDone } = makeOnDone()
    const result = await callSkillStore(
      onDone,
      {} as never,
      'create new-skill # Skill Content',
    )
    expect(result).not.toBeNull()
    expect(axiosPostMock).toHaveBeenCalledTimes(1)
  })
})

// ── delete ────────────────────────────────────────────────────────────
describe('delete action', () => {
  test('deletes skill and confirms', async () => {
    axiosDeleteMock.mockResolvedValueOnce({ data: {}, status: 204 })
    const { onDone, calls } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'delete sk_del')
    expect(result).not.toBeNull()
    expect(calls[0]?.[0]).toContain('deleted')
  })
})

// ── install ───────────────────────────────────────────────────────────
describe('install action', () => {
  test('install <id> fetches skill + versions, writes SKILL.md', async () => {
    const skill = {
      skill_id: 'sk_1',
      name: 'my-skill',
      owner: 'user',
      deprecated: false,
    }
    const versions = [
      {
        version: 'v1',
        skill_id: 'sk_1',
        body: '# My Skill Content',
        created_at: '2024-01-01',
      },
    ]
    // 第一次调用：getSkill，第二次调用：getSkillVersions
    axiosGetMock
      .mockResolvedValueOnce({ data: skill, status: 200 })
      .mockResolvedValueOnce({ data: { data: versions }, status: 200 })

    const { onDone, calls } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'install sk_1')
    expect(result).not.toBeNull()
    expect(mkdirMock).toHaveBeenCalledTimes(1)
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const writeCall = writeFileMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ]
    expect(writeCall[0]).toContain('SKILL.md')
    expect(writeCall[0]).toContain('my-skill')
    expect(writeCall[1]).toBe('# My Skill Content')
    expect(calls[0]?.[0]).toContain('installed')
  })

  test('install <id>@<version> fetches specific version and writes SKILL.md', async () => {
    const ver = {
      version: 'v2',
      skill_id: 'sk_1',
      body: '# v2 Content',
      created_at: '2024-02-01',
    }
    axiosGetMock.mockResolvedValueOnce({ data: ver, status: 200 })

    const { onDone, calls } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'install sk_1@v2')
    expect(result).not.toBeNull()
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const writeCall = writeFileMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ]
    expect(writeCall[1]).toBe('# v2 Content')
    expect(calls[0]?.[0]).toContain('installed')
  })

  test('install skill with no versions shows error', async () => {
    const skill = {
      skill_id: 'sk_nover',
      name: 'no-ver-skill',
      owner: 'user',
      deprecated: false,
    }
    axiosGetMock
      .mockResolvedValueOnce({ data: skill, status: 200 })
      .mockResolvedValueOnce({ data: { data: [] }, status: 200 })

    const { onDone, calls } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'install sk_nover')
    expect(result).not.toBeNull()
    expect(calls[0]?.[0]).toContain('no published versions')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  test('install writes to ~/.hclaude/skills/<name>/SKILL.md path', async () => {
    const skill = {
      skill_id: 'sk_path',
      name: 'path-test',
      owner: 'user',
      deprecated: false,
    }
    const versions = [
      {
        version: 'v1',
        skill_id: 'sk_path',
        body: '# Path Test',
        created_at: '2024-01-01',
      },
    ]
    axiosGetMock
      .mockResolvedValueOnce({ data: skill, status: 200 })
      .mockResolvedValueOnce({ data: { data: versions }, status: 200 })

    const { onDone } = makeOnDone()
    await callSkillStore(onDone, {} as never, 'install sk_path')

    const mkdirCall = mkdirMock.mock.calls[0] as unknown as [
      string,
      { recursive: boolean },
    ]
    expect(mkdirCall[0]).toContain('skills')
    expect(mkdirCall[0]).toContain('path-test')

    const writeCall = writeFileMock.mock.calls[0] as unknown as [
      string,
      string,
      string,
    ]
    expect(writeCall[0]).toContain('SKILL.md')
  })
})

// ── 无效参数 ──────────────────────────────────────────────────────────────
describe('invalid args', () => {
  test('invalid subcommand returns null and calls onDone with usage', async () => {
    const { onDone, calls } = makeOnDone()
    const result = await callSkillStore(onDone, {} as never, 'unknowncmd')
    expect(result).toBeNull()
    expect(calls[0]?.[0]).toContain('Usage')
  })
})
