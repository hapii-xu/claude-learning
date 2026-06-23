export const DESCRIPTION =
  '使用存储在用户加密本地 vault（~/.claude/local-vault/）中的密钥发起已认证的 HTTPS 请求。' +
  '你只需指定 vault key 的名称 —— 绝不是密钥值本身。工具框架会把密钥直接注入到请求头中，' +
  '并且该密钥绝不会出现在 tool_result 中、绝不会写入日志、绝不会传给 shell。' +
  '每个 vault key 都需要通过 permissions.allow 获得用户预授权：' +
  "['VaultHttpFetch(key-name)']。整工具级的 allow（不带括号的 'VaultHttpFetch'）" +
  '会在 settings 解析阶段被拒绝。'

export const PROMPT = `VaultHttpFetch —— 使用 vault 中存储的密钥发起已认证的 HTTPS 请求。

适用场景：需要 Bearer token、Basic auth、X-Api-Key 或自定义认证头的 HTTP API 调用。
如 GitHub API、Stripe API、内部服务认证等。

不适用场景：需要密钥的 shell 命令（git push、npm publish、ssh、docker login）。
这些超出本工具范围；用户必须在外部自行处理。

请求 schema：
  url             仅限 https://（HTTP/file/ftp 会被拒绝）
  method          GET（默认）、POST、PUT、PATCH、DELETE
  vault_auth_key  vault key 名称（密钥值由工具自行获取）
  auth_scheme     bearer（默认）、basic、header_x_api_key、custom
  auth_header_name 当 auth_scheme=custom 时使用的 HTTP header
  body            请求体（字符串；按原样发送）
  body_content_type  设置 body 时默认为 application/json
  reason          说明你为什么需要这次请求 —— 会出现在用户的权限提示中

响应：{ status, statusText, responseHeaders（敏感头已脱敏）、
  body（已 scrub 掉所有密钥派生串）、或 error }

权限模型：
  默认：ask（用户提示）。对某个 key 批准一次后会设置一条按 key 的 allow 规则，
  用户可通过提示 UI 持久化保存。整工具级的 allow 被禁止。

始终如实填写 \`reason\`。密钥永远不会出现在你的上下文中；
URL、method、key 名称和 reason 都会出现在 transcript 中。
`
