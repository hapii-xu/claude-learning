# 微观：Query 执行循环时序图（Mermaid）

> 对应源码路径：`src/QueryEngine.ts` → `src/query.ts` → `src/services/api/claude.ts` → `src/services/tools/toolOrchestration.ts`

```mermaid
sequenceDiagram
    autonumber
    participant USER as 用户 / REPL
    participant QE as QueryEngine.ts
    participant Q as query.ts
    participant ATTACH as utils/attachments.ts
    participant MSGS as utils/messages.ts
    participant API as services/api/claude.ts
    participant ORCH as toolOrchestration.ts
    participant EXEC as toolExecution.ts
    participant TOOL as Tool.ts
    participant HOOKS as utils/hooks.ts
    participant COMPACT as compact.ts
    participant STORE as sessionStorage.ts

    Note over USER: 用户输入提交
    USER->>QE: submitMessage(userInput)
    QE->>QE: fetchSystemPromptParts()
    QE->>QE: processUserInput()

    rect rgb(255, 235, 238)
        Note over QE,Q: 进入 query 主循环
        QE->>Q: query(userMessages, systemPrompt, toolUseContext, deps)
    end

    loop 主循环（直到无 tool_use）

        rect rgb(255, 249, 235)
            Note over Q,ATTACH: Step 1: 组装上下文
            Q->>ATTACH: startRelevantMemoryPrefetch()
            Note over ATTACH: 异步预取相关 memory
            Q->>ATTACH: getAttachmentMessages()
            ATTACH-->>Q: 附件消息（memory/文件等）
            Q->>ATTACH: filterDuplicateMemoryAttachments()
            Q->>MSGS: normalizeMessagesForAPI(messages)
            MSGS-->>Q: 规范化消息列表
            Q->>Q: createBudgetTracker()
            Q->>Q: checkTokenBudget()
        end

        rect rgb(232, 245, 233)
            Note over Q,API: Step 2: 调用 Claude API
            Q->>API: deps.callModel(apiMessages, systemPrompt)
            Note over API: queryModelWithStreaming()
            API-->>Q: AsyncGenerator<StreamEvent>
            Note over Q: 流式接收模型响应
            Q->>Q: 累积 assistant message
            Q->>API: updateUsage() / accumulateUsage()
        end

        rect rgb(227, 242, 253)
            Note over Q,TOOL: Step 3: 提取并执行工具
            Q->>Q: extractToolUseBlocks(messages)

            alt 有 tool_use blocks
                Q->>ORCH: runTools(toolUseMessages, assistantMessages, canUseTool, ctx)
                ORCH->>ORCH: partitionToolCalls()
                Note over ORCH: 分为并发批次 + 串行批次

                loop 每个批次
                    alt 并发安全批次
                        ORCH->>EXEC: runToolsConcurrently(blocks, ...)
                    else 串行批次
                        ORCH->>EXEC: runToolsSerially(blocks, ...)
                    end
                    EXEC->>EXEC: runToolUse()
                    EXEC->>TOOL: findToolByName(name)
                    EXEC->>EXEC: checkPermissionsAndCallTool()
                    EXEC->>TOOL: tool.call(input)
                    TOOL-->>EXEC: ToolResult
                    EXEC-->>ORCH: MessageUpdate
                    ORCH-->>Q: yield update（实时回传 UI）
                end

                Q->>Q: messages = [...messages, ...toolResults]
            else 无 tool_use blocks
                Note over Q: 模型纯文本回复 → 跳出循环
            end
        end

        rect rgb(243, 229, 245)
            Note over Q,COMPACT: Step 4: 后处理
            Q->>HOOKS: executePostSamplingHooks(messages, ctx)
            Q->>Q: shouldCompact(messages)?
            opt 需要 compact
                Q->>COMPACT: autoCompactIfNeeded() / microcompactMessages()
                COMPACT-->>Q: 压缩后的 messages
            end
        end

    end

    rect rgb(236, 239, 241)
        Note over QE,STORE: Step 5: 结果回流
        Q-->>QE: AsyncGenerator 结束
        QE->>STORE: recordTranscript()
        QE->>STORE: flushSessionStorage()
        QE->>QE: getTotalCost() / getModelUsage()
        QE-->>USER: 最终响应
    end
```

## 循环终止条件

| 条件 | 说明 |
|------|------|
| 模型不输出 tool_use | 纯文本回复，自然结束 |
| Token 预算耗尽 | `checkTokenBudget()` 触发 |
| 用户中断 | `createUserInterruptionMessage()` |
| API 错误 | `createAssistantAPIErrorMessage()` |
| 最大轮次 | 循环保护上限 |
