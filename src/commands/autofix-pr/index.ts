import { feature } from 'bun:bundle'
import type { Command } from '../../types/command.js'

// 来自 bun:bundle 的 `feature()` 只能直接出现在 if 语句
// 或三元条件的条件位置（Bun macro 限制）。用具名函数 +
// `return feature(...)` 函数体是满足此约束、同时保持 Command 对象可读性
// 的最干净写法。
function isAutofixPrEnabled(): boolean {
  return feature('AUTOFIX_PR') ? true : false
}

const autofixPr: Command = {
  type: 'local-jsx',
  name: 'autofix-pr',
  description: 'Auto-fix CI failures on a pull request',
  // hint 中避免使用 `<x>` —— REPL 的 markdown 渲染器会把尖括号包裹的
  // token 当作 HTML 标签吞掉。使用大写占位符才能原样保留。
  argumentHint: 'PR_NUMBER | stop | OWNER/REPO#N',
  isEnabled: isAutofixPrEnabled,
  isHidden: false,
  bridgeSafe: true,
  getBridgeInvocationError: (args: string) => {
    const trimmed = args.trim()
    if (!trimmed) return 'PR number required, e.g. /autofix-pr 386'
    if (trimmed === 'stop' || trimmed === 'off') return undefined
    if (/^[1-9]\d{0,9}$/.test(trimmed)) return undefined
    if (/^[\w.-]+\/[\w.-]+#[1-9]\d{0,9}$/.test(trimmed)) return undefined
    return 'Invalid args. Use /autofix-pr <pr-number> | stop | <owner>/<repo>#<n>'
  },
  load: async () => {
    const m = await import('./launchAutofixPr.js')
    return { call: m.callAutofixPr }
  },
}

export default autofixPr
