import { EXECUTE_TOOL_NAME } from './constants.js'

export const DESCRIPTION =
  'ExecuteExtraTool——一个一等公民级核心工具，始终加载且可用。按名称和参数执行任意延迟加载的工具。请在使用 SearchExtraTools 发现某个工具后使用它。它不是远程或外部工具——它在本地以完整权限运行。'

export function getPrompt(): string {
  return `ExecuteExtraTool — always loaded, always available. Runs locally with full permissions — NOT a remote or external tool.

## What it does
Accepts a tool_name and params, looks up the target tool in the registry, and delegates execution to it. The target tool runs with the same permissions as if called directly.

## When to use
ONLY for deferred tools discovered via SearchExtraTools. Core tools (Read, Edit, Write, Bash, Glob, Grep, Agent, WebFetch, WebSearch, Skill) are always in your tool list — call them directly, NOT through ExecuteExtraTool.

## How to call — two-step workflow

Step 1: SearchExtraTools discovers the tool name and schema.
Step 2: This tool executes it.

Example — user asks to schedule a cron job:
  SearchExtraTools({"query": "select:CronCreate"})
  → Response: "Found deferred tool(s): CronCreate"
  ExecuteExtraTool({"tool_name": "CronCreate", "params": {"schedule": "*/5 * * * *", "prompt": "check deploy"}})
  → Response: Cron job created

Example — MCP tool:
  SearchExtraTools({"query": "select:mcp__slack__send_message"})
  → Response: "Found deferred tool(s): mcp__slack__send_message"
  ExecuteExtraTool({"tool_name": "mcp__slack__send_message", "params": {"channel": "C123", "text": "hello"}})

## Inputs
- tool_name: Exact name of the target tool (string, e.g. "CronCreate", "mcp__slack__send_message")
- params: Object with the target tool's parameters. Check the tool's schema from SearchExtraTools discover: response.

## Failure handling
If this tool returns an error, do NOT retry or re-search. Tell the user what failed and suggest alternatives.`
}
