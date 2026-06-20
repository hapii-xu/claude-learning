/**
 * vaultsApi.ts 的回归测试
 *
 * 被测的关键不变式：
 *   - archiveVault 使用 POST /v1/vaults/{id}/archive（而非 DELETE）
 *   - archiveCredential 使用 POST /v1/vaults/{id}/credentials/{cid}/archive
 *   - addCredential 使用 POST /v1/vaults/{id}/credentials
 *   - credential 的值绝不出现在 URL 或请求体的元数据中
 *   - 错误消息会对 ID 做脱敏处理（只暴露前 8 个字符）
 *   - 401/403/404/429/5xx 被正确分类
 *   - withRetry 仅重试 5xx，不重试 4xx
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

// ── Workspace API key mock（工作区 API key mock）──
const mockApiKey = 'sk-ant-api03-test-vaults-key'

mock.module('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.anthropic.com' }),
}))

const prepareWorkspaceApiRequestMock = mock(async () => ({
  apiKey: mockApiKey,
}))

mock.module('src/utils/teleport/api.js', () => ({
  prepareWorkspaceApiRequest: prepareWorkspaceApiRequestMock,
}))

// 注意：这里我们不 mock src/services/auth/hostGuard.js。
// 真正的 assertWorkspaceHost() 会用 getOauthConfig()（被 mock 成
// https://api.anthropic.com）返回的 URL 进行调用，该 URL 能通过 host 校验。
// 若 mock hostGuard，会通过 Bun 进程级缓存污染 hostGuard 自己的测试文件。

// ── Axios mock ──────────────────────────────────────────────────────────────
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

// ── 在 mock 完成后再延迟导入被测代码 ──
let listVaults: typeof import('../vaultsApi.js').listVaults
let createVault: typeof import('../vaultsApi.js').createVault
let getVault: typeof import('../vaultsApi.js').getVault
let archiveVault: typeof import('../vaultsApi.js').archiveVault
let listCredentials: typeof import('../vaultsApi.js').listCredentials
let addCredential: typeof import('../vaultsApi.js').addCredential
let archiveCredential: typeof import('../vaultsApi.js').archiveCredential

beforeAll(async () => {
  axiosHandle.useStubs = true
  const mod = await import('../vaultsApi.js')
  listVaults = mod.listVaults
  createVault = mod.createVault
  getVault = mod.getVault
  archiveVault = mod.archiveVault
  listCredentials = mod.listCredentials
  addCredential = mod.addCredential
  archiveCredential = mod.archiveCredential
})

afterAll(() => {
  axiosHandle.useStubs = false
})

beforeEach(() => {
  axiosGetMock.mockClear()
  axiosPostMock.mockClear()
  axiosDeleteMock.mockClear()
  prepareWorkspaceApiRequestMock.mockClear()
  process.env['ANTHROPIC_API_KEY'] = mockApiKey
})

afterEach(() => {
  delete process.env['ANTHROPIC_API_KEY']
})

// ── 安全：credential 的值不得泄漏到 URL 中 ──
describe('addCredential: credential value security', () => {
  test('credential value is never placed in the URL', async () => {
    const cred = {
      credential_id: 'cred_1',
      vault_id: 'vault_abc12345',
      kind: 'api_key',
    }
    axiosPostMock.mockResolvedValueOnce({ data: cred, status: 201 })

    await addCredential('vault_abc12345', 'MY_KEY', 'super-secret-value-xyz')

    const calls = axiosPostMock.mock.calls as unknown as [
      string,
      unknown,
      unknown,
    ][]
    const url = calls[0]?.[0] as string
    // credential 的「值」绝不能出现在 URL 中
    expect(url).not.toContain('super-secret-value-xyz')
    // credential 的「键名」（name）可以出现在 URL 路径里
    expect(url).toContain('vault_abc12345')
  })

  test('addCredential sends credential value in body (not URL)', async () => {
    const cred = {
      credential_id: 'cred_2',
      vault_id: 'vault_xyz',
      kind: 'api_key',
    }
    axiosPostMock.mockResolvedValueOnce({ data: cred, status: 201 })

    await addCredential('vault_xyz', 'API_KEY', 'the-secret-value')

    const calls = axiosPostMock.mock.calls as unknown as [
      string,
      unknown,
      unknown,
    ][]
    const body = calls[0]?.[1] as Record<string, unknown>
    // 请求体应该包含 secret 值（它总要通过某种方式发送）
    expect(body).toHaveProperty('secret')
    expect(body.secret).toBe('the-secret-value')
    // 但 URL 中绝不能包含它
    const url = calls[0]?.[0] as string
    expect(url).not.toContain('the-secret-value')
  })
})

// ── 回归：archiveVault 必须使用 POST 而非 DELETE ──
describe('archiveVault regression: must use POST not DELETE', () => {
  test('archiveVault calls POST /v1/vaults/{id}/archive (not DELETE)', async () => {
    const vault = {
      vault_id: 'vault_arc',
      name: 'Archived Vault',
      archived_at: '2026-01-01T00:00:00Z',
    }
    axiosPostMock.mockResolvedValueOnce({ data: vault, status: 200 })

    await archiveVault('vault_arc')

    expect(axiosPostMock).toHaveBeenCalledTimes(1)
    expect(axiosDeleteMock).not.toHaveBeenCalled()
    const calls = axiosPostMock.mock.calls as unknown as [
      string,
      unknown,
      unknown,
    ][]
    const url = calls[0]?.[0] as string
    expect(url).toContain('vault_arc')
    expect(url).toContain('/archive')
    expect(url).toContain('/v1/vaults/')
  })
})

// ── 回归：archiveCredential 必须使用 POST 而非 DELETE ──
describe('archiveCredential regression: must use POST not DELETE', () => {
  test('archiveCredential calls POST .../credentials/{cid}/archive (not DELETE)', async () => {
    const cred = {
      credential_id: 'cred_arc',
      vault_id: 'vault_1',
      archived_at: '2026-01-01T00:00:00Z',
    }
    axiosPostMock.mockResolvedValueOnce({ data: cred, status: 200 })

    await archiveCredential('vault_1', 'cred_arc')

    expect(axiosPostMock).toHaveBeenCalledTimes(1)
    expect(axiosDeleteMock).not.toHaveBeenCalled()
    const calls = axiosPostMock.mock.calls as unknown as [
      string,
      unknown,
      unknown,
    ][]
    const url = calls[0]?.[0] as string
    expect(url).toContain('vault_1')
    expect(url).toContain('/credentials/')
    expect(url).toContain('cred_arc')
    expect(url).toContain('/archive')
  })
})

// ── listVaults（列出 vault）──
describe('listVaults', () => {
  test('returns vaults on 200', async () => {
    const vaults = [
      {
        vault_id: 'vault_1',
        name: 'My Vault',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    axiosGetMock.mockResolvedValueOnce({
      data: { data: vaults },
      status: 200,
    })

    const result = await listVaults()
    expect(result).toHaveLength(1)
    expect(result[0]!.vault_id).toBe('vault_1')
    expect(axiosGetMock).toHaveBeenCalledTimes(1)
    const calls = axiosGetMock.mock.calls as unknown as [string, unknown][]
    expect(calls[0]?.[0]).toContain('/v1/vaults')
  })

  test('returns empty array on empty response', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    const result = await listVaults()
    expect(result).toHaveLength(0)
  })

  test('throws 401 with friendly message', async () => {
    const err = Object.assign(new Error('Unauthorized'), {
      isAxiosError: true,
      response: { status: 401, data: {} },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    await expect(listVaults()).rejects.toThrow(/login|authenticate/i)
  })

  test('throws 403 with subscription message', async () => {
    const err = Object.assign(new Error('Forbidden'), {
      isAxiosError: true,
      response: { status: 403, data: {} },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    await expect(listVaults()).rejects.toThrow(/subscription|pro|max|team/i)
  })

  test('retries on 5xx and eventually throws', async () => {
    const make5xx = () =>
      Object.assign(new Error('Server Error'), {
        isAxiosError: true,
        response: { status: 500, data: {} },
      })
    axiosGetMock
      .mockRejectedValueOnce(make5xx())
      .mockRejectedValueOnce(make5xx())
      .mockRejectedValueOnce(make5xx())
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    await expect(listVaults()).rejects.toThrow()
    expect(axiosGetMock).toHaveBeenCalledTimes(3)
  }, 15000)

  test('honors Retry-After header on 5xx', async () => {
    const serverErr = Object.assign(new Error('Service Unavailable'), {
      isAxiosError: true,
      response: { status: 503, data: {}, headers: { 'retry-after': '0' } },
    })
    axiosGetMock
      .mockRejectedValueOnce(serverErr)
      .mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    const result = await listVaults()
    expect(result).toHaveLength(0)
    expect(axiosGetMock).toHaveBeenCalledTimes(2)
  })
})

// ── getVault（查询单个 vault）──
describe('getVault', () => {
  test('calls GET /v1/vaults/{id}', async () => {
    const vault = { vault_id: 'vault_get', name: 'Work Vault' }
    axiosGetMock.mockResolvedValueOnce({ data: vault, status: 200 })

    const result = await getVault('vault_get')
    expect(result.vault_id).toBe('vault_get')
    const calls = axiosGetMock.mock.calls as unknown as [string, unknown][]
    expect(calls[0]?.[0]).toContain('vault_get')
    expect(calls[0]?.[0]).toContain('/v1/vaults/')
  })

  test('throws 404 with not found message', async () => {
    const err = Object.assign(new Error('Not Found'), {
      isAxiosError: true,
      response: { status: 404, data: {} },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    await expect(getVault('nonexistent')).rejects.toThrow(/not found/i)
  })

  test('error message only exposes first 8 chars of vault id', async () => {
    const err = Object.assign(new Error('Not Found'), {
      isAxiosError: true,
      response: { status: 404, data: {} },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    // ID 长度超过 8 个字符 —— 完整 ID 不得出现在错误消息中
    const longId = 'vault_verylongidentifier_12345'
    try {
      await getVault(longId)
    } catch (err2: unknown) {
      const msg = err2 instanceof Error ? err2.message : String(err2)
      // 完整 ID 绝不能出现在消息中
      expect(msg).not.toContain(longId)
    }
  })
})

// ── createVault（创建 vault）──
describe('createVault', () => {
  test('sends POST /v1/vaults with name', async () => {
    const vault = { vault_id: 'vault_new', name: 'My New Vault' }
    axiosPostMock.mockResolvedValueOnce({ data: vault, status: 201 })

    const result = await createVault('My New Vault')
    expect(result.vault_id).toBe('vault_new')
    const calls = axiosPostMock.mock.calls as unknown as [
      string,
      unknown,
      unknown,
    ][]
    const url = calls[0]?.[0] as string
    const body = calls[0]?.[1] as Record<string, unknown>
    expect(url).toContain('/v1/vaults')
    expect(url).not.toContain('/v1/agents')
    expect(body.name).toBe('My New Vault')
  })
})

// ── listCredentials（列出凭据）──
describe('listCredentials', () => {
  test('calls GET /v1/vaults/{id}/credentials', async () => {
    const creds = [
      { credential_id: 'cred_1', vault_id: 'vault_1', kind: 'api_key' },
    ]
    axiosGetMock.mockResolvedValueOnce({ data: { data: creds }, status: 200 })

    const result = await listCredentials('vault_1')
    expect(result).toHaveLength(1)
    expect(result[0]!.credential_id).toBe('cred_1')
    const calls = axiosGetMock.mock.calls as unknown as [string, unknown][]
    expect(calls[0]?.[0]).toContain('vault_1')
    expect(calls[0]?.[0]).toContain('/credentials')
  })

  test('response does NOT include secret field (server returns metadata only)', async () => {
    const creds = [
      {
        credential_id: 'cred_safe',
        vault_id: 'vault_1',
        kind: 'api_key',
        // 注意：没有 'secret' 字段 —— 服务器在列表中绝不返回 secret
      },
    ]
    axiosGetMock.mockResolvedValueOnce({ data: { data: creds }, status: 200 })

    const result = await listCredentials('vault_1')
    expect(result[0]).not.toHaveProperty('secret')
  })

  test('throws 404 when vault not found', async () => {
    const err = Object.assign(new Error('Not Found'), {
      isAxiosError: true,
      response: { status: 404, data: {} },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    await expect(listCredentials('nonexistent')).rejects.toThrow(/not found/i)
  })
})

// ── 429 限流 ──
describe('429 rate-limit: not retried (non-5xx)', () => {
  test('throws immediately on 429 without retry', async () => {
    const err = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: { status: 429, data: {}, headers: { 'retry-after': '60' } },
    })
    axiosGetMock.mockRejectedValueOnce(err)
    axiosIsAxiosError.mockImplementation(
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'isAxiosError' in e &&
        (e as { isAxiosError: boolean }).isAxiosError === true,
    )
    await expect(listVaults()).rejects.toThrow()
    expect(axiosGetMock).toHaveBeenCalledTimes(1)
  })
})

// ── 不变式：buildHeaders 必须返回 x-api-key，不返回 Authorization ──
describe('invariant: x-api-key present, no Authorization, no x-organization-uuid', () => {
  test('buildHeaders returns x-api-key header (workspace key)', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    await listVaults()
    const calls = axiosGetMock.mock.calls as unknown as [
      string,
      { headers: Record<string, string> },
    ][]
    const headers = calls[0]?.[1]?.headers ?? {}
    expect(headers['x-api-key']).toBe(mockApiKey)
  })

  test('buildHeaders does NOT include Authorization header', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    await listVaults()
    const calls = axiosGetMock.mock.calls as unknown as [
      string,
      { headers: Record<string, string> },
    ][]
    const headers = calls[0]?.[1]?.headers ?? {}
    expect(headers['Authorization']).toBeUndefined()
  })

  test('buildHeaders does NOT include x-organization-uuid header', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    await listVaults()
    const calls = axiosGetMock.mock.calls as unknown as [
      string,
      { headers: Record<string, string> },
    ][]
    const headers = calls[0]?.[1]?.headers ?? {}
    expect(headers['x-organization-uuid']).toBeUndefined()
  })

  test('uses prepareWorkspaceApiRequest to obtain API key', async () => {
    prepareWorkspaceApiRequestMock.mockClear()
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    await listVaults()
    expect(prepareWorkspaceApiRequestMock).toHaveBeenCalledTimes(1)
  })

  test('request goes to api.anthropic.com (host guard passes for correct host)', async () => {
    axiosGetMock.mockResolvedValueOnce({ data: { data: [] }, status: 200 })
    await listVaults()
    const calls = axiosGetMock.mock.calls as unknown as [string, unknown][]
    expect(calls[0]?.[0]).toContain('api.anthropic.com')
  })
})
