/**
 * CCR upstreamproxy — 容器端接线。
 *
 * 当在配置了 upstreamproxy 的 CCR 会话容器中运行时，
 * 此模块：
 *   1. 从 /run/ccr/session_token 读取会话令牌
 *   2. 设置 prctl(PR_SET_DUMPABLE, 0) 以阻止同 UID 的 ptrace 堆内存攻击
 *   3. 下载 upstreamproxy CA 证书并将其与系统证书包合并，
 *      使 curl/gh/python 信任该 MITM 代理
 *   4. 启动本地 CONNECT→WebSocket 中继（见 relay.ts）
 *   5. 删除令牌文件（令牌仅保留在堆内存中；文件在代理循环
 *      能看到之前就已消失，但需在中继确认启动后才删除，
 *      以便 supervisor 重启时可以重试）
 *   6. 为所有代理子进程暴露 HTTPS_PROXY / SSL_CERT_FILE 环境变量
 *
 * 每一步都是"失败即开放"的：任何错误只会记录警告并禁用代理。
 * 损坏的代理设置绝不能破坏一个本来正常的会话。
 *
 * 设计文档：api-go/ccr/docs/plans/CCR_AUTH_DESIGN.md § "Week-1 pilot scope".
 */

import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { startUpstreamProxyRelay } from './relay.js'

export const SESSION_TOKEN_PATH = '/run/ccr/session_token'
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

// 代理不得拦截的主机列表。涵盖环回地址、RFC1918 私有地址段、IMDS
// 地址范围，以及 CCR 容器已直接访问的包注册表和 GitHub。
// 与 airlock/scripts/sandbox-shell-ccr.sh 保持一致。
const NO_PROXY_LIST = [
  'localhost',
  '127.0.0.1',
  '::1',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // Anthropic API：不会有上游路由匹配，且 MITM 会破坏
  // 非 Bun 运行时（Python httpx/certifi 不信任伪造的 CA）。
  // 三种形式是因为不同运行时的 NO_PROXY 解析方式不同：
  //   *.anthropic.com  — Bun、curl、Go（通配符匹配）
  //   .anthropic.com   — Python urllib/httpx（后缀匹配，去除前导点）
  //   anthropic.com    — 根域后备
  'anthropic.com',
  '.anthropic.com',
  '*.anthropic.com',
  'github.com',
  'api.github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'proxy.golang.org',
].join(',')

type UpstreamProxyState = {
  enabled: boolean
  port?: number
  caBundlePath?: string
}

let state: UpstreamProxyState = { enabled: false }

/**
 * 初始化 upstreamproxy。从 init.ts 调用一次。
 * 当功能关闭或令牌文件不存在时安全调用 — 返回 {enabled: false}。
 *
 * 可覆盖的路径用于测试；生产环境使用默认值。
 */
export async function initUpstreamProxy(opts?: {
  tokenPath?: string
  systemCaPath?: string
  caBundlePath?: string
  ccrBaseUrl?: string
}): Promise<UpstreamProxyState> {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    return state
  }
  // CCR 在服务端（GrowthBook 已预热）评估 ccr_upstream_proxy_enabled，
  // 并通过 StartupContext.EnvironmentVariables 注入此环境变量。
  // 每个 CCR 会话都是全新的容器，没有 GB 缓存，因此客户端
  // GB 检查始终返回默认值（false）。
  if (!isEnvTruthy(process.env.CCR_UPSTREAM_PROXY_ENABLED)) {
    return state
  }

  const sessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  if (!sessionId) {
    logForDebugging(
      '[upstreamproxy] CLAUDE_CODE_REMOTE_SESSION_ID unset; proxy disabled',
      { level: 'warn' },
    )
    return state
  }

  const tokenPath = opts?.tokenPath ?? SESSION_TOKEN_PATH
  const token = await readToken(tokenPath)
  if (!token) {
    logForDebugging('[upstreamproxy] no session token file; proxy disabled')
    return state
  }

  setNonDumpable()

  // CCR 通过 StartupContext（sessionExecutor.ts /
  // sessionHandler.ts）注入 ANTHROPIC_BASE_URL。此处的 getOauthConfig()
  // 是错误的：它依赖 USER_TYPE + USE_{LOCAL,STAGING}_OAUTH，而容器
  // 都不设置这些变量，所以始终返回生产 URL，导致 CA 获取 404。
  const baseUrl =
    opts?.ccrBaseUrl ??
    process.env.ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  const caBundlePath =
    opts?.caBundlePath ?? join(homedir(), '.ccr', 'ca-bundle.crt')

  const caOk = await downloadCaBundle(
    baseUrl,
    opts?.systemCaPath ?? SYSTEM_CA_BUNDLE,
    caBundlePath,
  )
  if (!caOk) return state

  try {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/v1/code/upstreamproxy/ws'
    const relay = await startUpstreamProxyRelay({ wsUrl, sessionId, token })
    registerCleanup(async () => relay.stop())
    state = { enabled: true, port: relay.port, caBundlePath }
    logForDebugging(`[upstreamproxy] enabled on 127.0.0.1:${relay.port}`)
    // 仅在监听器启动后才删除：如果 CA 下载或 listen()
    // 失败，supervisor 重启时仍可从磁盘上的令牌重试。
    await unlink(tokenPath).catch(() => {
      logForDebugging('[upstreamproxy] token file unlink failed', {
        level: 'warn',
      })
    })
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] relay start failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
  }

  return state
}

/**
 * 获取要合并到每个代理子进程的环境变量。代理禁用时返回空对象。
 * 从 subprocessEnv() 调用，使 Bash/MCP/LSP/hooks 都继承相同的配置。
 */
export function getUpstreamProxyEnv(): Record<string, string> {
  if (!state.enabled || !state.port || !state.caBundlePath) {
    // 子 CLI 进程无法重新初始化中继（令牌文件已被父进程删除），
    // 但父进程的中继仍在运行，可通过 127.0.0.1:<port> 访问。
    // 如果从父进程继承了代理变量（HTTPS_PROXY + SSL_CERT_FILE 均已设置），
    // 则透传这些变量，使我们的子进程也通过父进程的中继路由。
    if (process.env.HTTPS_PROXY && process.env.SSL_CERT_FILE) {
      const inherited: Record<string, string> = {}
      for (const key of [
        'HTTPS_PROXY',
        'https_proxy',
        'NO_PROXY',
        'no_proxy',
        'SSL_CERT_FILE',
        'NODE_EXTRA_CA_CERTS',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
      ]) {
        if (process.env[key]) inherited[key] = process.env[key]
      }
      return inherited
    }
    return {}
  }
  const proxyUrl = `http://127.0.0.1:${state.port}`
  // 仅 HTTPS：中继只处理 CONNECT，其他不处理。纯 HTTP 没有
  // 需要注入的凭据，通过中继路由只会导致 405 错误。
  return {
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: NO_PROXY_LIST,
    no_proxy: NO_PROXY_LIST,
    SSL_CERT_FILE: state.caBundlePath,
    NODE_EXTRA_CA_CERTS: state.caBundlePath,
    REQUESTS_CA_BUNDLE: state.caBundlePath,
    CURL_CA_BUNDLE: state.caBundlePath,
  }
}

/** 仅测试用：在测试用例之间重置模块状态。 */
export function resetUpstreamProxyForTests(): void {
  state = { enabled: false }
}

async function readToken(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.trim() || null
  } catch (err) {
    if (isENOENT(err)) return null
    logForDebugging(
      `[upstreamproxy] token read failed: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * 通过 libc FFI 调用 prctl(PR_SET_DUMPABLE, 0)。阻止同 UID 的 ptrace
 * 攻击本进程，防止被提示注入的 `gdb -p $PPID` 从堆内存中窃取令牌。
 * 仅限 Linux；其他平台静默跳过。
 */
function setNonDumpable(): void {
  if (process.platform !== 'linux' || typeof Bun === 'undefined') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const lib = ffi.dlopen('libc.so.6', {
      prctl: {
        args: ['int', 'u64', 'u64', 'u64', 'u64'],
        returns: 'int',
      },
    } as const)
    const PR_SET_DUMPABLE = 4
    const rc = lib.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n)
    if (rc !== 0) {
      logForDebugging(
        '[upstreamproxy] prctl(PR_SET_DUMPABLE,0) returned nonzero',
        {
          level: 'warn',
        },
      )
    }
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] prctl unavailable: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

async function downloadCaBundle(
  baseUrl: string,
  systemCaPath: string,
  outPath: string,
): Promise<boolean> {
  try {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const resp = await fetch(`${baseUrl}/v1/code/upstreamproxy/ca-cert`, {
      // Bun 的 fetch 没有默认超时 — 挂起的端点会无限期阻塞 CLI
      // 启动。对于小型 PEM 文件，5 秒已足够宽裕。
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) {
      logForDebugging(
        `[upstreamproxy] ca-cert fetch ${resp.status}; proxy disabled`,
        { level: 'warn' },
      )
      return false
    }
    const ccrCa = await resp.text()
    const systemCa = await readFile(systemCaPath, 'utf8').catch(() => '')
    await mkdir(join(outPath, '..'), { recursive: true })
    await writeFile(outPath, systemCa + '\n' + ccrCa, 'utf8')
    return true
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] ca-cert download failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
    return false
  }
}
