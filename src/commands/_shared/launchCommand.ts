/**
 * launchCommand —— 用于 local-jsx 命令实现的通用工厂。
 *
 * 封装 6 个命令启动文件中重复出现的样板代码：
 *   - 参数解析 + 非法参数处理
 *   - dispatch 错误捕获 + onDone 错误消息
 *   - errorView 渲染
 *   - happy-path View 的 React.createElement 调用
 *
 * 用法（H2 结论 —— 可减少约 50% 样板代码）：
 *
 *   export const callMyCmd: LocalJSXCommandCall = launchCommand<MyParsed, MyViewProps>({
 *     commandName: 'my-cmd',
 *     parseArgs: parseMyArgs,
 *     dispatch: async (parsed, onDone, context) => { ... return viewProps },
 *     View: MyCmdView,
 *     errorView: (msg) => React.createElement(MyCmdView, { mode: 'error', message: msg }),
 *   })
 */

import React from 'react'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { ToolUseContext } from '../../Tool.js'

/** 参数非法时 parseArgs 返回的形状。 */
export interface InvalidParsed {
  action: 'invalid'
  reason: string
}

export interface LaunchCommandOptions<TParsed, TViewProps> {
  /**
   * 出现在错误消息中的命令名（例如 "local-vault"）。
   * dispatch 抛错时会出现在 onDone 文本中。
   */
  commandName: string

  /**
   * 将原始参数字符串解析为带类型的 action 联合类型或 invalid 标记。
   * 当参数非法时必须返回 `{ action: 'invalid'; reason: string }`。
   */
  parseArgs: (rawArgs: string) => TParsed | InvalidParsed

  /**
   * 执行命令操作。
   * - 调用 onDone 传入用户可见的摘要文本。
   * - 返回 View 的 props 用于渲染，或返回 null 不渲染。
   * - 抛出异常以触发错误路径。
   */
  dispatch: (
    parsed: TParsed,
    onDone: LocalJSXCommandOnDone,
    context: ToolUseContext,
  ) => Promise<TViewProps | null>

  /**
   * 使用 dispatch 返回的 props 渲染的 React 组件。
   */
  View: React.FC<TViewProps>

  /**
   * 当 parseArgs 返回 invalid 或 dispatch 抛错时渲染的错误节点。
   * 接收人类可读的错误消息字符串。
   */
  errorView: (message: string) => React.ReactNode

  /**
   * 可选钩子，在 dispatch 抛错后、错误暴露前调用。
   * 适合用于打点 logEvent。
   * 默认：no-op。
   */
  onDispatchError?: (err: unknown) => void
}

/**
 * 返回一个 LocalJSXCommandCall，用统一的错误处理包装传入的
 * parse / dispatch / View 三元组。
 */
export function launchCommand<TParsed, TViewProps>(
  opts: LaunchCommandOptions<TParsed, TViewProps>,
): LocalJSXCommandCall {
  return async (
    onDone: LocalJSXCommandOnDone,
    context: ToolUseContext,
    args: string,
  ): Promise<React.ReactNode> => {
    // ── 解析参数 ────────────────────────────────────────────────────────────
    const parsed = opts.parseArgs(args ?? '')

    if (isInvalid(parsed)) {
      onDone(`Invalid args: ${parsed.reason}`, { display: 'system' })
      return opts.errorView(parsed.reason)
    }

    // ── 执行 dispatch ──────────────────────────────────────────────────────
    try {
      const viewProps = await opts.dispatch(parsed as TParsed, onDone, context)
      if (viewProps === null) return null
      return React.createElement(
        opts.View as React.ComponentType<object>,
        viewProps as object,
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      opts.onDispatchError?.(err)
      onDone(`${opts.commandName} failed: ${msg}`, { display: 'system' })
      return opts.errorView(msg)
    }
  }
}

function isInvalid(parsed: unknown): parsed is InvalidParsed {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'action' in parsed &&
    (parsed as InvalidParsed).action === 'invalid'
  )
}
