import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from './debug.js'
import { hasNodeOption } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * 加载 TLS 连接的 CA 证书。
 *
 * 由于在 HTTPS agent 上设置 `ca` 会替换默认证书存储，
 * 返回时必须始终包含基础 CA（系统或捆绑的 Mozilla）。
 *
 * 不需要自定义 CA 配置时返回 undefined，允许运行时的默认证书处理生效。
 *
 * 行为：
 * - 未设置 NODE_EXTRA_CA_CERTS 和 --use-system-ca/--use-openssl-ca：undefined（运行时默认）
 * - 仅 NODE_EXTRA_CA_CERTS：捆绑的 Mozilla CA + 额外证书文件内容
 * - 仅 --use-system-ca 或 --use-openssl-ca：系统 CA
 * - --use-system-ca + NODE_EXTRA_CA_CERTS：系统 CA + 额外证书文件内容
 *
 * 为性能而记忆。在环境变量更改后调用 clearCACertsCache() 以失效
 *（例如，信任对话框应用 settings.json 之后）。
 *
 * 仅读取 `process.env.NODE_EXTRA_CA_CERTS`。`caCertsConfig.ts` 在 CLI 初始化时
 * 从 settings.json 填充该环境变量；此模块保持无配置，
 * 以便 `proxy.ts`/`mtls.ts` 不会传递性地拉入命令注册表。
 */
export const getCACertificates = memoize((): string[] | undefined => {
  const useSystemCA =
    hasNodeOption('--use-system-ca') || hasNodeOption('--use-openssl-ca')

  const extraCertsPath = process.env.NODE_EXTRA_CA_CERTS

  logForDebugging(
    `CA certs: useSystemCA=${useSystemCA}, extraCertsPath=${extraCertsPath}`,
  )

  // 如果都未设置，返回 undefined（使用运行时默认值，无覆盖）
  if (!useSystemCA && !extraCertsPath) {
    return undefined
  }

  // 延迟加载：Bun 的 node:tls 模块在导入时会急切地物化约 150 个 Mozilla
  // 根证书（约 750KB 堆），即使 tls.rootCertificates 从未被访问。
  // 大多数用户会命中上面的提前返回，因此我们只在实际需要自定义 CA 处理时
  // 才承担此开销。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tls = require('tls') as typeof import('tls')
  /* eslint-enable @typescript-eslint/no-require-imports */

  const certs: string[] = []

  if (useSystemCA) {
    // 加载系统 CA 存储（Bun API）
    const getCACerts = (
      tls as typeof tls & { getCACertificates?: (type: string) => string[] }
    ).getCACertificates
    const systemCAs = getCACerts?.('system')
    if (systemCAs && systemCAs.length > 0) {
      certs.push(...systemCAs)
      logForDebugging(
        `CA certs: Loaded ${certs.length} system CA certificates (--use-system-ca)`,
      )
    } else if (!getCACerts && !extraCertsPath) {
      // 在不支持 getCACertificates 且无额外证书的 Node.js 下，
      // 返回 undefined 让 Node.js 原生处理 --use-system-ca。
      logForDebugging(
        'CA certs: --use-system-ca set but system CA API unavailable, deferring to runtime',
      )
      return undefined
    } else {
      // 系统 CA API 返回空或不可用；回退到捆绑的根证书
      certs.push(...tls.rootCertificates)
      logForDebugging(
        `CA certs: Loaded ${certs.length} bundled root certificates as base (--use-system-ca fallback)`,
      )
    }
  } else {
    // 必须包含捆绑的 Mozilla CA 作为基础，因为 ca 会替换默认值
    certs.push(...tls.rootCertificates)
    logForDebugging(
      `CA certs: Loaded ${certs.length} bundled root certificates as base`,
    )
  }

  // 从文件追加额外证书
  if (extraCertsPath) {
    try {
      const extraCert = getFsImplementation().readFileSync(extraCertsPath, {
        encoding: 'utf8',
      })
      certs.push(extraCert)
      logForDebugging(
        `CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS (${extraCertsPath})`,
      )
    } catch (error) {
      logForDebugging(
        `CA certs: Failed to read NODE_EXTRA_CA_CERTS file (${extraCertsPath}): ${error}`,
        { level: 'error' },
      )
    }
  }

  return certs.length > 0 ? certs : undefined
})

/**
 * 清除 CA 证书缓存。
 * 当影响 CA 证书的环境变量可能已更改时调用
 *（例如 NODE_EXTRA_CA_CERTS、NODE_OPTIONS）。
 */
export function clearCACertsCache(): void {
  getCACertificates.cache.clear?.()
  logForDebugging('Cleared CA certificates cache')
}
