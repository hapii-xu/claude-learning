import { EXECUTE_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'ExecuteExtraTool——一个一等公民级核心工具，始终加载且可用。按名称和参数执行任意延迟加载的工具。请在使用 SearchExtraTools 发现某个工具后使用它。它不是远程或外部工具——它在本地以完整权限运行。'

export function getPrompt(): string {
  return `ExecuteExtraTool — 始终加载，始终可用。在本地以完整权限运行——不是远程或外部工具。

## 功能说明
接受 tool_name 和 params，在 registry 中查找目标工具，并将执行委托给它。目标工具以与直接调用相同的权限运行。

## 何时使用
仅用于通过 SearchExtraTools 发现的 deferred tools。核心工具（Read、Edit、Write、Bash、Glob、Grep、Agent、WebFetch、WebSearch、Skill）始终在你的工具列表中——直接调用它们，不要通过 ExecuteExtraTool。

## 调用方式——两步工作流

Step 1：SearchExtraTools 发现工具名称和 schema。
Step 2：本工具执行它。

示例——用户要求创建 cron job：
  SearchExtraTools({"query": "select:CronCreate"})
  → Response: "Found deferred tool(s): CronCreate"
  ExecuteExtraTool({"tool_name": "CronCreate", "params": {"schedule": "*/5 * * * *", "prompt": "check deploy"}})
  → Response: Cron job created

示例——MCP 工具：
  SearchExtraTools({"query": "select:mcp__slack__send_message"})
  → Response: "Found deferred tool(s): mcp__slack__send_message"
  ExecuteExtraTool({"tool_name": "mcp__slack__send_message", "params": {"channel": "C123", "text": "hello"}})

## 输入参数
- tool_name：目标工具的精确名称（string，例如 "CronCreate"、"mcp__slack__send_message"）
- params：包含目标工具参数的对象。从 SearchExtraTools 的 discover 响应中查看工具的 schema。

## 错误处理
若此工具返回错误，不要重试或重新搜索。告知用户失败原因并建议替代方案。`
}
