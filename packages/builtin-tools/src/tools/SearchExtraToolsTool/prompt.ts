import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { Tool } from 'src/Tool.js'
import { CORE_TOOLS } from 'src/constants/tools.js'
import { logForDebugging } from 'src/utils/debug.js'

export { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'

import { SEARCH_EXTRA_TOOLS_TOOL_NAME } from './constants.js'

const PROMPT_HEAD = `Search for deferred tools by name or keyword. LOW PRIORITY — only use this tool when no core tool can accomplish the task. Core tools (Read, Edit, Write, Bash, Glob, Grep, Agent, WebFetch, WebSearch, Skill) are always available and should be used directly. This tool is for discovering additional capabilities like MCP tools, cron scheduling, worktree management, agent teams (TeamCreate, TeamDelete, SendMessage), etc.

`

// 与 searchExtraTools.ts 中的 isDeferredToolsDeltaEnabled 匹配（不直接导入 —
// searchExtraTools.ts 从此文件导入）。启用时：工具通过 system-reminder
// 附件宣布。禁用时：前置 <available-deferred-tools> 块（预门控行为）。
function getToolLocationHint(): string {
  const deltaEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  return deltaEnabled
    ? 'Deferred tools appear by name in <system-reminder> messages.'
    : 'Deferred tools appear by name in <available-deferred-tools> messages.'
}

const PROMPT_TAIL = ` Returns matching tool names.

## Two-step workflow (MUST follow exactly)

Deferred tools CANNOT be called directly. You MUST use this two-step pattern:

Step 1 — Search: Call this tool (SearchExtraTools) to discover the target tool.
  Input: {"query": "select:CronCreate"}
  Response: "Found 1 deferred tool(s): CronCreate. Use ExecuteExtraTool with {"tool_name": "<name>", "params": {...}} to invoke."

Step 2 — Execute: Call ExecuteExtraTool to run the discovered tool.
  Input: {"tool_name": "CronCreate", "params": {"schedule": "*/5 * * * *", "prompt": "check the deploy"}}
  Response: the actual tool result.

## Example: user asks "schedule a cron to check deploy every 5 minutes"

1. SearchExtraTools({"query": "select:CronCreate"})
   → Response: Found deferred tool CronCreate
2. ExecuteExtraTool({"tool_name": "CronCreate", "params": {"schedule": "*/5 * * * *", "prompt": "check the deploy"}})
   → Response: Cron job created successfully

If you don't know the exact tool name, use keyword search first:
1. SearchExtraTools({"query": "cron schedule"})
   → Response: Found deferred tool(s): CronCreate
2. ExecuteExtraTool({"tool_name": "CronCreate", "params": {...}})

## Query forms
- "select:CronCreate" — exact tool name (fastest, preferred when you know the name from <available-deferred-tools>)
- "select:CronCreate,CronList" — comma-separated multi-select
- "discover:schedule cron job" — returns tool name + description + schema without loading. Use to understand a tool before calling it.
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms

## Failure policy
If ExecuteExtraTool fails, do NOT re-search for the same tool — it will loop. Stop and tell the user what failed.`

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
