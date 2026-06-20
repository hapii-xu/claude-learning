import { logForDebugging } from '../utils/debug.js'
import { BridgeFatalError } from './bridgeApi.js'
import type { BridgeApiClient } from './types.js'

/**
 * 仅 ant 使用的故障注入，用于手动测试 bridge 的恢复路径。
 *
 * 针对的真实失败场景（BQ 2026-03-12，7 天窗口）：
 *   poll 404 not_found_error   — 14.7 万 session/周，onEnvironmentLost 门控失效
 *   ws_closed 1002/1006        — 2.2 万 session/周，关闭后僵尸 poll
 *   register 瞬时失败          — 残留：doReconnect 期间的网络抖动
 *
 * 用法：在 Remote Control 已连接的 REPL 中执行 /bridge-kick <subcommand>，
 * 然后 tail debug.log 观察恢复机制的反应。
 *
 * 这里有意使用模块级状态：一个 REPL 进程只对应一个 bridge，/bridge-kick
 * slash command 没有别的办法触达 initBridgeCore 的闭包；teardown 时清空槽位。
 */

/** 下一次匹配的 api 调用时注入的一次性故障。 */
type BridgeFault = {
  method:
    | 'pollForWork'
    | 'registerBridgeEnvironment'
    | 'reconnectSession'
    | 'heartbeatWork'
  /** fatal 错误走 handleErrorStatus → BridgeFatalError。transient 错误以普通
   *  axios reject（5xx / 网络）的形式出现。恢复代码区分二者：fatal →
   *  teardown，transient → 重试/退避。 */
  kind: 'fatal' | 'transient'
  status: number
  errorType?: string
  /** 剩余注入次数。每次消耗减一；归零时移除。 */
  count: number
}

export type BridgeDebugHandle = {
  /** 直接调用 transport 的 permanent-close 处理器。用于测试
   *  ws_closed → reconnectEnvironmentWithSession 的升级路径（#22148）。 */
  fireClose: (code: number) => void
  /** 调用 reconnectEnvironmentWithSession() —— 与 SIGUSR2 等价，但可以
   *  从 slash command 触发。 */
  forceReconnect: () => void
  /** 为接下来的 N 次指定 api 方法调用排队一个故障。 */
  injectFault: (fault: BridgeFault) => void
  /** 中止 at-capacity 睡眠，让注入的 poll 故障立刻命中，而不是
   *  最多延迟 10 分钟才命中。 */
  wakePollLoop: () => void
  /** 返回 env/session ID，方便在 debug.log 里 grep。 */
  describe: () => string
}

let debugHandle: BridgeDebugHandle | null = null
const faultQueue: BridgeFault[] = []

export function registerBridgeDebugHandle(h: BridgeDebugHandle): void {
  debugHandle = h
}

export function clearBridgeDebugHandle(): void {
  debugHandle = null
  faultQueue.length = 0
}

export function getBridgeDebugHandle(): BridgeDebugHandle | null {
  return debugHandle
}

export function injectBridgeFault(fault: BridgeFault): void {
  faultQueue.push(fault)
  logForDebugging(
    `[bridge:debug] Queued fault: ${fault.method} ${fault.kind}/${fault.status}${fault.errorType ? `/${fault.errorType}` : ''} ×${fault.count}`,
  )
}

/**
 * 包装一个 BridgeApiClient，让每次调用都先查故障队列。如果队列里有
 * 匹配的故障，就抛出指定的错误而不是继续向下调用。其它行为委托给
 * 真实的 client。
 *
 * 只在 USER_TYPE === 'ant' 时才会被调用 —— 外部构建零开销。
 */
export function wrapApiForFaultInjection(
  api: BridgeApiClient,
): BridgeApiClient {
  function consume(method: BridgeFault['method']): BridgeFault | null {
    const idx = faultQueue.findIndex(f => f.method === method)
    if (idx === -1) return null
    const fault = faultQueue[idx]!
    fault.count--
    if (fault.count <= 0) faultQueue.splice(idx, 1)
    return fault
  }

  function throwFault(fault: BridgeFault, context: string): never {
    logForDebugging(
      `[bridge:debug] Injecting ${fault.kind} fault into ${context}: status=${fault.status} errorType=${fault.errorType ?? 'none'}`,
    )
    if (fault.kind === 'fatal') {
      throw new BridgeFatalError(
        `[injected] ${context} ${fault.status}`,
        fault.status,
        fault.errorType,
      )
    }
    // Transient：模拟 axios reject（5xx / 网络）。错误对象本身不带 .status
    // —— catch 块就是通过这一点来区分的。
    throw new Error(`[injected transient] ${context} ${fault.status}`)
  }

  return {
    ...api,
    async pollForWork(envId, secret, signal, reclaimMs) {
      const f = consume('pollForWork')
      if (f) throwFault(f, 'Poll')
      return api.pollForWork(envId, secret, signal, reclaimMs)
    },
    async registerBridgeEnvironment(config) {
      const f = consume('registerBridgeEnvironment')
      if (f) throwFault(f, 'Registration')
      return api.registerBridgeEnvironment(config)
    },
    async reconnectSession(envId, sessionId) {
      const f = consume('reconnectSession')
      if (f) throwFault(f, 'ReconnectSession')
      return api.reconnectSession(envId, sessionId)
    },
    async heartbeatWork(envId, workId, token) {
      const f = consume('heartbeatWork')
      if (f) throwFault(f, 'Heartbeat')
      return api.heartbeatWork(envId, workId, token)
    },
  }
}
