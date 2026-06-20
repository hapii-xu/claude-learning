/**
 * `claude mcp xaa` —— 管理 XAA (SEP-990) IdP 连接。
 *
 * 该 IdP 连接是用户级的：配置一次，所有启用 XAA 的 MCP 服务器都复用它。
 * 存放于 settings.xaaIdp（非机密）+ 以 issuer 为键的 keychain 槽位（机密）。
 * 与各服务器的 AS 密钥是独立的信任域。
 */
import type { Command } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import {
  acquireIdpIdToken,
  clearIdpClientSecret,
  clearIdpIdToken,
  getCachedIdpIdToken,
  getIdpClientSecret,
  getXaaIdpSettings,
  issuerKey,
  saveIdpClientSecret,
  saveIdpIdTokenFromJwt,
} from '../../services/mcp/xaaIdpLogin.js'
import { errorMessage } from '../../utils/errors.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export function registerMcpXaaIdpCommand(mcp: Command): void {
  const xaaIdp = mcp
    .command('xaa')
    .description('Manage the XAA (SEP-990) IdP connection')

  xaaIdp
    .command('setup')
    .description(
      'Configure the IdP connection (one-time setup for all XAA-enabled servers)',
    )
    .requiredOption('--issuer <url>', 'IdP issuer URL (OIDC discovery)')
    .requiredOption('--client-id <id>', "Claude Code's client_id at the IdP")
    .option(
      '--client-secret',
      'Read IdP client secret from MCP_XAA_IDP_CLIENT_SECRET env var',
    )
    .option(
      '--callback-port <port>',
      'Fixed loopback callback port (only if IdP does not honor RFC 8252 port-any matching)',
    )
    .action(options => {
      // 在任何写入之前校验全部内容。写入过程中 exit(1) 会留下
      // "settings 已配置但 keychain 缺失"这种令人困惑的状态。
      // updateSettingsForSource 在写入时不会做 schema 校验；一个非 URL 的
      // issuer 会落到磁盘上，然后在下次启动时污染整个 userSettings 源
      // (SettingsSchema .url() 失败 → parseSettingsFile 返回
      // { settings: null }，会丢掉所有内容，而不只是 xaaIdp)。
      let issuerUrl: URL
      try {
        issuerUrl = new URL(options.issuer)
      } catch {
        return cliError(
          `Error: --issuer must be a valid URL (got "${options.issuer}")`,
        )
      }
      // OIDC 发现 + token 交换都打到这个 host。仅对 loopback
      // (conformance 测试夹具的 mock IdP) 允许 http://；其他情况下使用 http://
      // 会在明文信道中泄露 client secret 和 authorization code。
      if (
        issuerUrl.protocol !== 'https:' &&
        !(
          issuerUrl.protocol === 'http:' &&
          (issuerUrl.hostname === 'localhost' ||
            issuerUrl.hostname === '127.0.0.1' ||
            issuerUrl.hostname === '[::1]')
        )
      ) {
        return cliError(
          `Error: --issuer must use https:// (got "${issuerUrl.protocol}//${issuerUrl.host}")`,
        )
      }
      const callbackPort = options.callbackPort
        ? parseInt(options.callbackPort, 10)
        : undefined
      // callbackPort <= 0 在下次启动时会因 Zod 的 .positive() 失败 —— 与上面
      // issuer 校验相同的"污染设置"失败模式。
      if (
        callbackPort !== undefined &&
        (!Number.isInteger(callbackPort) || callbackPort <= 0)
      ) {
        return cliError('Error: --callback-port must be a positive integer')
      }
      const secret = options.clientSecret
        ? process.env.MCP_XAA_IDP_CLIENT_SECRET
        : undefined
      if (options.clientSecret && !secret) {
        return cliError(
          'Error: --client-secret requires MCP_XAA_IDP_CLIENT_SECRET env var',
        )
      }

      // 现就读取旧配置（在 settings 被覆写之前），以便在写入成功后清理过期的
      // keychain 槽位。`clear` 无法在事后做这件事 —— 它读取的是 *当前* 的
      // settings.xaaIdp，而那时已经是新的了。
      const old = getXaaIdpSettings()
      const oldIssuer = old?.issuer
      const oldClientId = old?.clientId

      // callbackPort 必须存在（即使是 undefined）—— mergeWith 进行深合并，
      // 只有显式 `undefined` 才会删除，缺键不会。条件展开会让上次的固定端口
      // 泄漏到新 IdP 的配置中。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: {
          issuer: options.issuer,
          clientId: options.clientId,
          callbackPort,
        },
      })
      if (error) {
        return cliError(`Error writing settings: ${error.message}`)
      }

      // 仅在 settings 写入成功后才清理过期的 keychain 槽位 ——
      // 否则写入失败会让 settings 指向 oldIssuer，但其 secret 已被删除。
      // 通过 issuerKey() 比较：末尾斜杠或 host 大小写差异会归一化到同一个 keychain 槽位。
      if (oldIssuer) {
        if (issuerKey(oldIssuer) !== issuerKey(options.issuer)) {
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        } else if (oldClientId !== options.clientId) {
          // 同一 issuer 槽位但不同的 OAuth 客户端注册 —— 缓存的 id_token 的
          // aud 声明以及存储的 secret 都属于旧 client。`xaa login` 会发送
          // {new clientId, old secret} 并以含糊的 `invalid_client` 失败；
          // 下游 SEP-990 交换也会在 aud 校验时失败。当 clientId 不变时两者都保留：
          // 不带 --client-secret 的 re-setup 意为"微调端口，保留 secret"。
          clearIdpIdToken(oldIssuer)
          clearIdpClientSecret(oldIssuer)
        }
      }

      if (secret) {
        const { success, warning } = saveIdpClientSecret(options.issuer, secret)
        if (!success) {
          return cliError(
            `Error: settings written but keychain save failed${warning ? ` — ${warning}` : ''}. ` +
              `Re-run with --client-secret once keychain is available.`,
          )
        }
      }

      cliOk(`XAA IdP connection configured for ${options.issuer}`)
    })

  xaaIdp
    .command('login')
    .description(
      'Cache an IdP id_token so XAA-enabled MCP servers authenticate ' +
        'silently. Default: run the OIDC browser login. With --id-token: ' +
        'write a pre-obtained JWT directly (used by conformance/e2e tests ' +
        'where the mock IdP does not serve /authorize).',
    )
    .option(
      '--force',
      'Ignore any cached id_token and re-login (useful after IdP-side revocation)',
    )
    // TODO(paulc): 从 stdin 读取 JWT 而非 argv，避免它进入 shell 历史。
    // 对 conformance 没问题（docker exec 直接用 argv，没有 shell 解析器），
    // 但真实用户会希望用 `echo $TOKEN | ... --stdin`。
    .option(
      '--id-token <jwt>',
      'Write this pre-obtained id_token directly to cache, skipping the OIDC browser login',
    )
    .action(async options => {
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliError(
          "Error: no XAA IdP connection. Run 'claude mcp xaa setup' first.",
        )
      }

      // 直接注入路径：跳过缓存检查，跳过 OIDC。写入即是操作本身。
      // issuer 来自 settings（单一权威源），而非单独的 flag —— 少一个会失同步的东西。
      if (options.idToken) {
        const expiresAt = saveIdpIdTokenFromJwt(idp.issuer, options.idToken)
        return cliOk(
          `id_token cached for ${idp.issuer} (expires ${new Date(expiresAt).toISOString()})`,
        )
      }

      if (options.force) {
        clearIdpIdToken(idp.issuer)
      }

      const wasCached = getCachedIdpIdToken(idp.issuer) !== undefined
      if (wasCached) {
        return cliOk(
          `Already logged in to ${idp.issuer} (cached id_token still valid). Use --force to re-login.`,
        )
      }

      process.stdout.write(`Opening browser for IdP login at ${idp.issuer}…\n`)
      try {
        await acquireIdpIdToken({
          idpIssuer: idp.issuer,
          idpClientId: idp.clientId,
          idpClientSecret: getIdpClientSecret(idp.issuer),
          callbackPort: idp.callbackPort,
          onAuthorizationUrl: url => {
            process.stdout.write(
              `If the browser did not open, visit:\n  ${url}\n`,
            )
          },
        })
        cliOk(
          `Logged in. MCP servers with --xaa will now authenticate silently.`,
        )
      } catch (e) {
        cliError(`IdP login failed: ${errorMessage(e)}`)
      }
    })

  xaaIdp
    .command('show')
    .description('Show the current IdP connection config')
    .action(() => {
      const idp = getXaaIdpSettings()
      if (!idp) {
        return cliOk('No XAA IdP connection configured.')
      }
      const hasSecret = getIdpClientSecret(idp.issuer) !== undefined
      const hasIdToken = getCachedIdpIdToken(idp.issuer) !== undefined
      process.stdout.write(`Issuer:        ${idp.issuer}\n`)
      process.stdout.write(`Client ID:     ${idp.clientId}\n`)
      if (idp.callbackPort !== undefined) {
        process.stdout.write(`Callback port: ${idp.callbackPort}\n`)
      }
      process.stdout.write(
        `Client secret: ${hasSecret ? '(stored in keychain)' : '(not set — PKCE-only)'}\n`,
      )
      process.stdout.write(
        `Logged in:     ${hasIdToken ? 'yes (id_token cached)' : "no — run 'claude mcp xaa login'"}\n`,
      )
      cliOk()
    })

  xaaIdp
    .command('clear')
    .description('Clear the IdP connection config and cached id_token')
    .action(() => {
      // 先读 issuer，以便清理正确的 keychain 槽位。
      const idp = getXaaIdpSettings()
      // updateSettingsForSource 使用 mergeWith：设置为 undefined（而不是 delete）
      // 来表示要移除该键。
      const { error } = updateSettingsForSource('userSettings', {
        xaaIdp: undefined,
      })
      if (error) {
        return cliError(`Error writing settings: ${error.message}`)
      }
      // 仅在 settings 写入成功后才清理 keychain —— 否则写入失败会让
      // settings 仍指向该 IdP 但其 secret 已被删除
      // (与 `setup` 中旧 issuer 的清理模式相同)。
      if (idp) {
        clearIdpIdToken(idp.issuer)
        clearIdpClientSecret(idp.issuer)
      }
      cliOk('XAA IdP connection cleared')
    })
}
