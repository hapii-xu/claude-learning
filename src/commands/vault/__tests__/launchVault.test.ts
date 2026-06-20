/**
 * launchVault.tsx 的测试
 *
 * 重要：依据 feedback_mock_dependency_not_subject.md，我们 mock axios（更底层的依赖），
 * 而不是 vaultsApi 模块本身，以避免 Bun mock.module 在进程级缓存上造成污染。
 *
 * 安全：测试会验证 credential 的值绝不会出现在 onDone 消息文本中。
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

// ── Auth / OAuth 相关 mock ──
mock.module('src/utils/auth.js', () => ({
  getClaudeAIOAuthTokens: () => ({ accessToken: 'test-token' }),
}))
mock.module('src/services/oauth/client.js', () => ({
  getOrganizationUUID: async () => 'org-uuid-test',
}))
mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}))
mock.module('src/utils/teleport/api.js', () => ({
  getOAuthHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
  }),
  prepareWorkspaceApiRequest: async () => ({
    apiKey: 'test-workspace-key',
  }),
}))

// ── Axios mock ──
const axiosGetMock = mock(async () => ({}))
const axiosPostMock = mock(async () => ({}))

const axiosIsAxiosError = mock((err: unknown) => {
  return (
    typeof err === 'object' &&
    err !== null &&
    'isAxiosError' in err &&
    (err as { isAxiosError: boolean }).isAxiosError === true
  )
})

const axiosDeleteMock = mock(async () => ({}))

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.get = axiosGetMock
axiosHandle.stubs.post = axiosPostMock
axiosHandle.stubs.delete = axiosDeleteMock
axiosHandle.stubs.isAxiosError = axiosIsAxiosError

// ── 在 mock 完成后再延迟导入被测代码 ──
let callVault: typeof import('../launchVault.js').callVault

beforeAll(async () => {
  axiosHandle.useStubs = true
  const mod = await import('../launchVault.js')
  callVault = mod.callVault
})

afterAll(() => {
  axiosHandle.useStubs = false
})

beforeEach(() => {
  axiosGetMock.mockClear()
  axiosPostMock.mockClear()
})

afterEach(() => {})

// ── list（列出）──
describe('callVault list', () => {
  test('calls listVaults and returns vault count in onDone', async () => {
    const vaults = [{ vault_id: 'v1', name: 'Test Vault' }]
    axiosGetMock.mockResolvedValueOnce({ data: { data: vaults }, status: 200 })

    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    const result = await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'list',
    )
    expect(onDoneMsg).toMatch(/1 vault/)
    expect(result).not.toBeNull()
  })

  test('empty vault list shows friendly message', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      '',
    )
    expect(onDoneMsg).toMatch(/no vaults/i)
  })

  test('API error shows error in onDone', async () => {
    const err = Object.assign(new Error('Unauthorized'), {
      isAxiosError: true,
      response: { status: 401, data: {} },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' && e !== null && 'isAxiosError' in e,
    )
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'list',
    )
    expect(onDoneMsg).toMatch(/failed|error|login|authenticate/i)
  })
})

// ── create（创建）──
describe('callVault create', () => {
  test('creates vault and returns vault_id in onDone', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { vault_id: 'vault_new', name: 'My Vault' },
      status: 201,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'create My Vault',
    )
    expect(onDoneMsg).toMatch(/created/)
    expect(onDoneMsg).toMatch(/vault_new/)
  })

  test('create with no name → invalid args message', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'create',
    )
    expect(onDoneMsg).toMatch(/usage|name/i)
  })
})

// ── get（查询）──
describe('callVault get', () => {
  test('fetches vault and displays detail', async () => {
    axiosGetMock.mockResolvedValueOnce({
      data: { vault_id: 'vault_123', name: 'Work' },
      status: 200,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    const result = await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'get vault_123',
    )
    expect(onDoneMsg).toMatch(/fetched/i)
    expect(result).not.toBeNull()
  })

  test('get with no id → invalid args', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'get',
    )
    expect(onDoneMsg).toMatch(/usage|id/i)
  })
})

// ── archive vault（归档 vault）──
describe('callVault archive', () => {
  test('archives vault and confirms in onDone', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: {
        vault_id: 'vault_arc',
        name: 'Old',
        archived_at: '2026-01-01T00:00:00Z',
      },
      status: 200,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'archive vault_arc',
    )
    expect(onDoneMsg).toMatch(/archived/i)
  })
})

// ── add-credential（添加凭据）──
describe('callVault add-credential', () => {
  test('adds credential and confirms without leaking secret value in onDone', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { credential_id: 'cred_new', vault_id: 'vault_1', kind: 'api_key' },
      status: 201,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'add-credential vault_1 MY_SECRET the-actual-secret-value-xyz',
    )
    // onDone 消息必须确认 credential 已添加
    expect(onDoneMsg).toMatch(/added|created/i)
    // 安全：真实的 secret 值绝不能出现在 onDone 消息中
    expect(onDoneMsg).not.toContain('the-actual-secret-value-xyz')
  })

  test('add-credential missing value → invalid args', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'add-credential vault_1 MY_KEY',
    )
    expect(onDoneMsg).toMatch(/usage|value|non-empty/i)
  })

  test('credential value does not appear in stdout output at all', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: { credential_id: 'cred_secure', vault_id: 'v1', kind: 'api_key' },
      status: 201,
    })
    const messages: string[] = []
    const onDone = (msg: string) => {
      messages.push(msg)
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'add-credential v1 KEY super-secret-do-not-leak',
    )
    // grep 检查：捕获到的消息中都不能包含 secret
    for (const msg of messages) {
      expect(msg).not.toContain('super-secret-do-not-leak')
    }
  })
})

// ── archive-credential（归档凭据）──
describe('callVault archive-credential', () => {
  test('archives credential and confirms in onDone', async () => {
    axiosPostMock.mockResolvedValueOnce({
      data: {
        credential_id: 'cred_arc',
        vault_id: 'vault_1',
        archived_at: '2026-01-01T00:00:00Z',
      },
      status: 200,
    })
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'archive-credential vault_1 cred_arc',
    )
    expect(onDoneMsg).toMatch(/archived/i)
  })

  test('archive-credential missing cred_id → invalid args', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'archive-credential vault_1',
    )
    expect(onDoneMsg).toMatch(/usage|credential_id|cred/i)
  })
})

// ── 无效子命令 ──
describe('callVault invalid subcommand', () => {
  test('unknown subcommand → usage message in onDone', async () => {
    let onDoneMsg = ''
    const onDone = (msg: string) => {
      onDoneMsg = msg
    }
    await callVault(
      onDone as Parameters<typeof callVault>[0],
      {} as Parameters<typeof callVault>[1],
      'delete vault_123',
    )
    expect(onDoneMsg).toMatch(/usage/i)
  })
})
