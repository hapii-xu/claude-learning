# 微观：Tool 执行链路时序图（Mermaid）

> 对应源码路径：`src/services/tools/toolOrchestration.ts` → `src/services/tools/toolExecution.ts` → `src/Tool.ts`

```mermaid
sequenceDiagram
    autonumber
    participant Q as query.ts
    participant ORCH as toolOrchestration.ts
    participant PART as partitionToolCalls
    participant TOOL_DEF as Tool.ts
    participant EXEC as toolExecution.ts
    participant HOOKS as toolHooks.ts
    participant PERM as Permission System
    participant SCHEMA as Zod Schema
    participant TOOL as 具体 Tool 实例
    participant RESULT as toolResultStorage.ts
    participant MSGS as utils/messages.ts

    Note over Q: 模型输出 tool_use blocks
    Q->>ORCH: runTools(toolUseMessages, assistantMessages, canUseTool, toolUseContext)

    rect rgb(255, 243, 224)
        Note over ORCH,PART: Phase 1: 分组
        ORCH->>PART: partitionToolCalls(toolUseMessages, ctx)

        loop 每个 toolUse
            PART->>TOOL_DEF: findToolByName(tools, toolUse.name)
            TOOL_DEF-->>PART: Tool 定义
            PART->>PART: tool.isConcurrencySafe(parsedInput.data)
        end

        PART-->>ORCH: Batch[] = [{isConcurrencySafe, blocks}...]
        Note over ORCH: 连续并发安全的工具合并为同一批次
    end

    rect rgb(232, 245, 233)
        Note over ORCH,TOOL: Phase 2: 按批次执行

        loop 每个 Batch
            alt isConcurrencySafe = true
                ORCH->>EXEC: runToolsConcurrently(blocks, canUseTool, ctx)
                Note over EXEC: Promise.all 并发执行
            else isConcurrencySafe = false
                ORCH->>EXEC: runToolsSerially(blocks, canUseTool, ctx)
                Note over EXEC: for...of 逐个等待
            end

            loop 批次内每个 toolUse
                EXEC->>EXEC: runToolUse(toolUse, ...)

                rect rgb(227, 242, 253)
                    Note over EXEC,MSGS: 单次工具执行完整流程
                    
                    EXEC->>TOOL_DEF: findToolByName(allTools, name)
                    Note over TOOL_DEF: 也搜索 MCP 工具 (mcp__server__tool)

                    EXEC->>EXEC: streamedCheckPermissionsAndCallTool()
                    EXEC->>EXEC: checkPermissionsAndCallTool()

                    EXEC->>HOOKS: runPreToolUseHooks(toolUse, ctx)
                    Note over HOOKS: 用户可配置 pre-tool-use hooks
                    HOOKS-->>EXEC: HookDecision (allow/deny/modify)

                    alt Hook 拒绝
                        EXEC->>MSGS: createProgressMessage("blocked by hook")
                    else Hook 允许/通过
                        EXEC->>SCHEMA: tool.inputSchema.parse(input)
                        Note over SCHEMA: Zod 校验输入参数

                        alt 校验失败
                            EXEC->>MSGS: createProgressMessage(formatZodValidationError())
                        else 校验通过
                            EXEC->>PERM: checkPermission(tool, input, ctx)
                            Note over PERM: 权限系统判断 allow/ask/deny

                            alt 需要用户确认
                                PERM-->>EXEC: 等待用户审批
                            end

                            EXEC->>TOOL: tool.call(validatedInput, context)
                            Note over TOOL: 实际执行工具逻辑
                            TOOL-->>EXEC: ToolResult (content, metadata)

                            EXEC->>RESULT: processToolResultBlock(toolResult)
                            Note over RESULT: 处理大结果 → 存储到 toolResultStorage

                            EXEC->>HOOKS: runPostToolUseHooks(toolUse, result, ctx)
                            Note over HOOKS: 用户可配置 post-tool-use hooks

                            opt Hook 失败
                                EXEC->>HOOKS: runPostToolUseFailureHooks()
                            end

                            EXEC->>MSGS: createUserMessage(toolResult)
                        end
                    end
                end

                EXEC-->>ORCH: yield MessageUpdate
            end

            Note over ORCH: 并发批次：收集 contextModifier，批次完按序应用
        end
    end

    ORCH-->>Q: yield 所有 MessageUpdate → 追加到 messages
```

## Tool 接口关键字段

```typescript
interface Tool {
  name: string
  inputSchema: ZodSchema        // 输入参数校验
  isConcurrencySafe: (input) => boolean  // 是否可并发
  call: (input, context) => ToolResult   // 执行函数
  checkPermissions?: (input, ctx) => PermissionResult
  // ...
}
```

## 并发分组规则

| 情况 | 处理 |
|------|------|
| 连续多个 `isConcurrencySafe=true` | 合并为同一并发批次 |
| 中间出现 `isConcurrencySafe=false` | 断点，新开串行批次 |
| MCP 工具 | 默认 `isConcurrencySafe=true` |
