import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

export type AdminRequestType = 'limit_increase' | 'seat_upgrade'

export type AdminRequestStatus = 'pending' | 'approved' | 'dismissed'

export type AdminRequestSeatUpgradeDetails = {
  message?: string | null
  current_seat_tier?: string | null
}

export type AdminRequestCreateParams =
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }

export type AdminRequest = {
  uuid: string
  status: AdminRequestStatus
  requester_uuid?: string | null
  created_at: string
} & (
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }
)

/**
 * 创建一个管理员请求（额度提升或席位升级）。
 *
 * 对于没有账单/管理员权限的 Team/Enterprise 用户，
 * 这会创建一个可由其管理员处理的请求。
 *
 * 如果该用户已存在同类型的 pending 请求，
 * 返回该已有请求而不是创建新请求。
 */
export async function createAdminRequest(
  params: AdminRequestCreateParams,
): Promise<AdminRequest> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests`

  const response = await axios.post<AdminRequest>(url, params, { headers })

  return response.data
}

/**
 * 获取当前用户的指定类型的 pending 管理员请求。
 *
 * 如果存在 pending 请求则返回，否则返回 null。
 */
export async function getMyAdminRequests(
  requestType: AdminRequestType,
  statuses: AdminRequestStatus[],
): Promise<AdminRequest[] | null> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  let url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests/me?request_type=${requestType}`
  for (const status of statuses) {
    url += `&statuses=${status}`
  }

  const response = await axios.get<AdminRequest[] | null>(url, {
    headers,
  })

  return response.data
}

type AdminRequestEligibilityResponse = {
  request_type: AdminRequestType
  is_allowed: boolean
}

/**
 * 检查此 organization 是否允许指定的管理员请求类型。
 */
export async function checkAdminRequestEligibility(
  requestType: AdminRequestType,
): Promise<AdminRequestEligibilityResponse | null> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests/eligibility?request_type=${requestType}`

  const response = await axios.get<AdminRequestEligibilityResponse>(url, {
    headers,
  })

  return response.data
}
