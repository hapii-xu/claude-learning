/**
 * 独立 agent 工具，用于具有自定义名称/颜色的会话
 *
 * 这些帮助器提供对不属于 swarm 团队的会话的独立 agent 上下文
 *（名称和颜色）的访问。当会话是 swarm 的一部分时，
 * 这些函数返回 undefined 以让 swarm 上下文优先。
 */

import type { AppState } from '../state/AppState.js'
import { getTeamName } from './teammate.js'

/**
 * 如果已设置且不是 swarm 团队成员，则返回独立 agent 名称。
 * 使用 getTeamName() 以与 isTeammate() 的 swarm 检测保持一致。
 */
export function getStandaloneAgentName(appState: AppState): string | undefined {
  // 如果在团队（swarm）中，则不返回独立名称
  if (getTeamName()) {
    return undefined
  }
  return appState.standaloneAgentContext?.name
}
