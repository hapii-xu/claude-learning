import axios from 'axios'
import z from 'zod/v4'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

/**
 * /v1/ultrareview/preflight 响应的 Zod schema。
 * 基于二进制提取出的 schema：vq.object({action: vq.enum([...]), billing_note: ...})
 */
const UltrareviewPreflightSchema = z.object({
  action: z.enum(['proceed', 'confirm', 'blocked']),
  billing_note: z.string().nullable().optional(),
})

export type UltrareviewPreflightResponse = z.infer<
  typeof UltrareviewPreflightSchema
>

export type UltrareviewPreflightArgs = {
  repo: string
  pr_number?: number
  pr_url?: string
  confirm?: boolean
}

/**
 * POST /v1/ultrareview/preflight —— 启动前的服务端闸门。
 *
 * 返回 preflight 结果（proceed / confirm / blocked），任何失败（网络错误、
 * 鉴权错误、schema 不匹配）时返回 null。调用方必须把 null 当作
 * "回退到直接启动"处理，以保留既有行为。
 *
 * 当用户已在账单对话框中确认（或 CLI 上传入了 --confirm）时，`confirm`
 * 应设置为 true，这会跳过服务端的 confirm 提示并直接返回 proceed/blocked。
 */
export async function fetchUltrareviewPreflight(
  args: UltrareviewPreflightArgs,
): Promise<UltrareviewPreflightResponse | null> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()

    const body: Record<string, unknown> = {
      repo: args.repo,
    }
    if (args.pr_number !== undefined) {
      body.pr_number = args.pr_number
    }
    if (args.pr_url !== undefined) {
      body.pr_url = args.pr_url
    }
    if (args.confirm !== undefined) {
      body.confirm = args.confirm
    }

    const response = await axios.post(
      `${getOauthConfig().BASE_API_URL}/v1/ultrareview/preflight`,
      body,
      {
        headers: {
          ...getOAuthHeaders(accessToken),
          'x-organization-uuid': orgUUID,
        },
        timeout: 10000,
      },
    )

    const parsed = UltrareviewPreflightSchema.safeParse(response.data)
    if (!parsed.success) {
      logForDebugging(
        `fetchUltrareviewPreflight: schema mismatch — ${parsed.error.message}`,
      )
      return null
    }
    return parsed.data
  } catch (error) {
    logForDebugging(`fetchUltrareviewPreflight failed: ${error}`)
    return null
  }
}
