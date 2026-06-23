import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { Tool } from 'src/Tool.js'
import { CORE_TOOLS } from 'src/constants/tools.js'
import { logForDebugging } from 'src/utils/debug.js'

export { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'

import { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `通过名称或关键词搜索延迟工具。低优先级 —— 仅在核心工具无法完成任务时使用此工具。核心工具（Read、Edit、Write、Bash、Glob、Grep、Agent、WebFetch、WebSearch、Skill）始终可用，应直接调用。此工具用于发现额外功能，如 MCP 工具、cron 调度、worktree 管理、agent 团队（TeamCreate、TeamDelete、SendMessage）等。

`

// 与 searchExtraTools.ts 中的 isDeferredToolsDeltaEnabled 匹配（不直接导入 —
// searchExtraTools.ts 从此文件导入）。启用时：工具通过 system-reminder
// 附件宣布。禁用时：前置 <available-deferred-tools> 块（预门控行为）。
function getToolLocationHint(): string {
  const deltaEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? '延迟工具以名称出现在 <system-reminder> 消息中。'
    : '延迟工具以名称出现在 <available-deferred-tools> 消息中。'
}

const PROMPT_TAIL = ` 返回匹配的工具名称。

## 两步工作流（必须严格遵守）

延迟工具无法直接调用。必须使用如下两步模式：

第一步 —— 搜索：调用此工具（SearchExtraTools）发现目标工具。
  输入：{"query": "select:CronCreate"}
  响应："找到 1 个延迟工具：CronCreate。请使用 ExecuteExtraTool，格式为 {"tool_name": "<name>", "params": {...}} 来调用。"

第二步 —— 执行：调用 ExecuteExtraTool 运行已发现的工具。
  输入：{"tool_name": "CronCreate", "params": {"schedule": "*/5 * * * *", "prompt": "check the deploy"}}
  响应：实际工具结果。

## 示例：用户要求"每 5 分钟调度一个 cron 检查部署"

1. SearchExtraTools({"query": "select:CronCreate"})
   → 响应：找到延迟工具 CronCreate
2. ExecuteExtraTool({"tool_name": "CronCreate", "params": {"schedule": "*/5 * * * *", "prompt": "check the deploy"}})
   → 响应：Cron 任务创建成功

如果不知道确切工具名，先使用关键词搜索：
1. SearchExtraTools({"query": "cron schedule"})
   → 响应：找到延迟工具：CronCreate
2. ExecuteExtraTool({"tool_name": "CronCreate", "params": {...}})

## 查询格式
- "select:CronCreate" —— 精确工具名（最快，推荐在从 <available-deferred-tools> 中知道名称时使用）
- "select:CronCreate,CronList" —— 逗号分隔多选
- "discover:schedule cron job" —— 返回工具名 + 描述 + schema，不触发加载。用于在调用前了解工具。
- "notebook jupyter" —— 关键词搜索，最多返回 max_results 个最佳匹配
- "+slack send" —— 要求名称中包含 "slack"，按剩余术语排序

## 失败策略
如果 ExecuteExtraTool 失败，不要重新搜索同一工具 —— 这会导致循环。停止并告知用户失败原因。`

/**
 * 检查工具是否应被延迟（需要 SearchExtraTools 来加载）。
 * 如果工具不在 CORE_TOOLS 中且没有 alwaysLoad: true，则被视为延迟。
 * 核心工具始终加载 — 从不会被延迟。
 * 所有其他工具（非核心内置 + 所有 MCP 工具）都是延迟的，
 * 必须通过 SearchExtraToolsTool / ExecuteExtraTool 发现。
 */
export function isDeferredTool(tool: Tool): boolean {
  // 通过 _meta['anthropic/alwaysLoad'] 显式退出
  if (tool.alwaysLoad === true) return false

  // 核心工具始终加载 — 从不会被延迟
  if (CORE_TOOLS.has(tool.name)) return false

  // 其他所有工具（非核心内置 + 所有 MCP 工具）都是延迟的
  return true
}

/**
 * 为 <available-deferred-tools> 用户消息格式化一行延迟工具。
 * 不渲染搜索提示（tool.searchHint）— A/B 测试
 * （exp_xenhnnmn0smrx4，3 月 21 日停止）显示没有收益。
 */
export function formatDeferredToolLine(tool: Tool): string {
  return tool.name
}

export function getPrompt(): string {
  logForDebugging('[延迟工具] getPrompt 生成 SearchExtraTools 系统提示', {
    level: 'info',
  })
  return PROMPT_HEAD + getToolLocationHint() + PROMPT_TAIL
}
