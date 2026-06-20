import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import { fetchEnvironments } from '../../utils/teleport/environments.js'

const CCR_BYOC_BETA_HEADER = 'ccr-byoc-2025-07-29'

/**
 * 包装原始 GitHub token，使其字符串表示被脱敏。
 * `String(token)`、模板字符串、`JSON.stringify(token)` 以及任何
 * 附带的错误消息都会显示 `[REDACTED:gh-token]` 而不是 token 的
 * 实际值。仅在将原始值放入 HTTP body 的那个唯一点调用 `.reveal()`。
 */
export class RedactedGithubToken {
  readonly #value: string
  constructor(raw: string) {
    this.#value = raw
  }
  reveal(): string {
    return this.#value
  }
  toString(): string {
    return '[REDACTED:gh-token]'
  }
  toJSON(): string {
    return '[REDACTED:gh-token]'
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED:gh-token]'
  }
}

export type ImportTokenResult = {
  github_username: string
}

export type ImportTokenError =
  | { kind: 'not_signed_in' }
  | { kind: 'invalid_token' }
  | { kind: 'server'; status: number }
  | { kind: 'network' }

/**
 * 将 GitHub token POST 到 CCR 后端，后者会通过 GitHub 的 /user 端点
 * 校验该 token，并以 Fernet 加密方式存储到 sync_user_tokens 中。
 * 存储后的 token 与 OAuth token 共享相同的读取路径，因此
 * 成功后 claude.ai/code 中的 clone/push 立即可用。
 */
export async function importGithubToken(
  token: RedactedGithubToken,
): Promise<
  | { ok: true; result: ImportTokenResult }
  | { ok: false; error: ImportTokenError }
> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return { ok: false, error: { kind: 'not_signed_in' } }
  }

  const url = `${getOauthConfig().BASE_API_URL}/v1/code/github/import-token`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': CCR_BYOC_BETA_HEADER,
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post<ImportTokenResult>(
      url,
      { token: token.reveal() },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    if (response.status === 200) {
      return { ok: true, result: response.data }
    }
    if (response.status === 400) {
      return { ok: false, error: { kind: 'invalid_token' } }
    }
    if (response.status === 401) {
      return { ok: false, error: { kind: 'not_signed_in' } }
    }
    logForDebugging(`import-token returned ${response.status}`, {
      level: 'error',
    })
    return { ok: false, error: { kind: 'server', status: response.status } }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      // err.config.data 中会包含带有原始 token 的 POST body。
      // 不要将其写入任何日志。仅记录错误码即可。
      logForDebugging(`import-token network error: ${err.code ?? 'unknown'}`, {
        level: 'error',
      })
    }
    return { ok: false, error: { kind: 'network' } }
  }
}

async function hasExistingEnvironment(): Promise<boolean> {
  try {
    const envs = await fetchEnvironments()
    return envs.length > 0
  } catch {
    return false
  }
}

/**
 * 尽力而为的默认环境创建。镜像 web onboarding 的
 * DEFAULT_CLOUD_ENVIRONMENT_REQUEST，使首次使用的用户直接落到
 * composer 而不是 env-setup。先检查是否已存在环境，
 * 这样重复运行 /web-setup 不会堆积重复环境。失败是
 * 非致命的 — token 导入已经成功，web 状态机
 * 下次加载时会回退到 env-setup。
 */
export async function createDefaultEnvironment(): Promise<boolean> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return false
  }

  if (await hasExistingEnvironment()) {
    return true
  }

  // /private/organizations/{org}/ 路径会拒绝 CLI OAuth token（认证依赖
  // 不匹配）。公共路径使用 build_flexible_auth — 与 fetchEnvironments()
  // 使用的路径相同。Org 通过 x-organization-uuid header 传递。
  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers/cloud/create`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post(
      url,
      {
        name: 'Default',
        kind: 'anthropic_cloud',
        description: 'Default - trusted network access',
        config: {
          environment_type: 'anthropic',
          cwd: '/home/user',
          init_script: null,
          environment: {},
          languages: [
            { name: 'python', version: '3.11' },
            { name: 'node', version: '20' },
          ],
          network_config: {
            allowed_hosts: [],
            allow_default_hosts: true,
          },
        },
      },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    return response.status >= 200 && response.status < 300
  } catch {
    return false
  }
}

/** 当用户拥有有效的 Claude OAuth 凭证时返回 true。 */
export async function isSignedIn(): Promise<boolean> {
  try {
    await prepareApiRequest()
    return true
  } catch {
    return false
  }
}

export function getCodeWebUrl(): string {
  return `${getOauthConfig().CLAUDE_AI_ORIGIN}/code`
}
