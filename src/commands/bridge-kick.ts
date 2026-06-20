import { getBridgeDebugHandle } from '../bridge/bridgeDebug.js'
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'

/**
 * 仅 Ant 使用：注入 bridge 故障状态，用于手动测试恢复路径。
 *
 *   /bridge-kick close 1002            — 触发 code 为 1002 的 ws_closed
 *   /bridge-kick close 1006            — 触发 code 为 1006 的 ws_closed
 *   /bridge-kick poll 404              — 下一次 poll 抛出 404/not_found_error
 *   /bridge-kick poll 404 <type>       — 下一次 poll 抛出带 error_type 的 404
 *   /bridge-kick poll 401              — 下一次 poll 抛出 401（鉴权）
 *   /bridge-kick poll transient        — 下一次 poll 抛出 axios 风格的拒绝
 *   /bridge-kick register fail         — 下一次 register（在 doReconnect 内）瞬时失败
 *   /bridge-kick register fail 3       — 接下来 3 次 register 瞬时失败
 *   /bridge-kick register fatal        — 下一次 register 返回 403（终止性）
 *   /bridge-kick reconnect-session fail — POST /bridge/reconnect 失败（→ 策略 2）
 *   /bridge-kick heartbeat 401         — 下一次 heartbeat 返回 401（JWT 过期）
 *   /bridge-kick reconnect             — 直接调用 doReconnect（= SIGUSR2）
 *   /bridge-kick status                — 打印当前 bridge 状态
 *
 * 工作流：连接 Remote Control，运行一个子命令，`tail -f debug.log`
 * 观察 [bridge:repl] / [bridge:debug] 日志行以查看恢复反应。
 *
 * 组合序列 —— BQ 数据中的故障模式是链式的，而不是单一事件。
 * 先排队故障，再触发：
 *
 *   # #22148 残留：ws_closed → register 瞬时抖动 → teardown？
 *   /bridge-kick register fail 2
 *   /bridge-kick close 1002
 *   → 预期：doReconnect 尝试 register，失败，返回 false → teardown
 *     （演示了需要修复的重试缺口）
 *
 *   # 死亡闸门：poll 404/not_found_error → onEnvironmentLost 是否触发？
 *   /bridge-kick poll 404
 *   → 预期：tengu_bridge_repl_fatal_error（闸门已死 —— 14.7 万/周）
 *     修复后：tengu_bridge_repl_env_lost → doReconnect
 */

const USAGE = `/bridge-kick <subcommand>
  close <code>              fire ws_closed with the given code (e.g. 1002)
  poll <status> [type]      next poll throws BridgeFatalError(status, type)
  poll transient            next poll throws axios-style rejection (5xx/net)
  register fail [N]         next N registers transient-fail (default 1)
  register fatal            next register 403s (terminal)
  reconnect-session fail    next POST /bridge/reconnect fails
  heartbeat <status>        next heartbeat throws BridgeFatalError(status)
  reconnect                 call reconnectEnvironmentWithSession directly
  status                    print bridge state`

const call: LocalCommandCall = async args => {
  const h = getBridgeDebugHandle()
  if (!h) {
    return {
      type: 'text',
      value:
        'No bridge debug handle registered. Remote Control must be connected (USER_TYPE=ant).',
    }
  }

  const [sub, a, b] = args.trim().split(/\s+/)

  switch (sub) {
    case 'close': {
      const code = Number(a)
      if (!Number.isFinite(code)) {
        return { type: 'text', value: `close: need a numeric code\n${USAGE}` }
      }
      h.fireClose(code)
      return {
        type: 'text',
        value: `Fired transport close(${code}). Watch debug.log for [bridge:repl] recovery.`,
      }
    }

    case 'poll': {
      if (a === 'transient') {
        h.injectFault({
          method: 'pollForWork',
          kind: 'transient',
          status: 503,
          count: 1,
        })
        h.wakePollLoop()
        return {
          type: 'text',
          value:
            'Next poll will throw a transient (axios rejection). Poll loop woken.',
        }
      }
      const status = Number(a)
      if (!Number.isFinite(status)) {
        return {
          type: 'text',
          value: `poll: need 'transient' or a status code\n${USAGE}`,
        }
      }
      // 默认使用服务器对 404 实际返回的值（经 BQ 验证），
      // 以便 `/bridge-kick poll 404` 能复现真实的 14.7 万/周状态。
      const errorType =
        b ?? (status === 404 ? 'not_found_error' : 'authentication_error')
      h.injectFault({
        method: 'pollForWork',
        kind: 'fatal',
        status,
        errorType,
        count: 1,
      })
      h.wakePollLoop()
      return {
        type: 'text',
        value: `Next poll will throw BridgeFatalError(${status}, ${errorType}). Poll loop woken.`,
      }
    }

    case 'register': {
      if (a === 'fatal') {
        h.injectFault({
          method: 'registerBridgeEnvironment',
          kind: 'fatal',
          status: 403,
          errorType: 'permission_error',
          count: 1,
        })
        return {
          type: 'text',
          value:
            'Next registerBridgeEnvironment will 403. Trigger with close/reconnect.',
        }
      }
      const n = Number(b) || 1
      h.injectFault({
        method: 'registerBridgeEnvironment',
        kind: 'transient',
        status: 503,
        count: n,
      })
      return {
        type: 'text',
        value: `Next ${n} registerBridgeEnvironment call(s) will transient-fail. Trigger with close/reconnect.`,
      }
    }

    case 'reconnect-session': {
      h.injectFault({
        method: 'reconnectSession',
        kind: 'fatal',
        status: 404,
        errorType: 'not_found_error',
        count: 2,
      })
      return {
        type: 'text',
        value:
          'Next 2 POST /bridge/reconnect calls will 404. doReconnect Strategy 1 falls through to Strategy 2.',
      }
    }

    case 'heartbeat': {
      const status = Number(a) || 401
      h.injectFault({
        method: 'heartbeatWork',
        kind: 'fatal',
        status,
        errorType: status === 401 ? 'authentication_error' : 'not_found_error',
        count: 1,
      })
      return {
        type: 'text',
        value: `Next heartbeat will ${status}. Watch for onHeartbeatFatal → work-state teardown.`,
      }
    }

    case 'reconnect': {
      h.forceReconnect()
      return {
        type: 'text',
        value: 'Called reconnectEnvironmentWithSession(). Watch debug.log.',
      }
    }

    case 'status': {
      return { type: 'text', value: h.describe() }
    }

    default:
      return { type: 'text', value: USAGE }
  }
}

const bridgeKick = {
  type: 'local',
  name: 'bridge-kick',
  description: 'Inject bridge failure states for manual recovery testing',
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default bridgeKick
