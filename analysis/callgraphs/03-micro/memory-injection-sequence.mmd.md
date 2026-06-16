# 微观：Memory 注入链路时序图（Mermaid）

> 对应源码路径：`src/memdir/memdir.ts` / `src/memdir/findRelevantMemories.ts` / `src/services/SessionMemory/sessionMemory.ts` / `src/tools/AgentTool/agentMemory.ts`

```mermaid
sequenceDiagram
    autonumber
    participant PROMPT as constants/prompts.ts
    participant QE as QueryEngine.ts
    participant MEMDIR as memdir/memdir.ts
    participant PATHS as memdir/paths.ts
    participant TEAM as teamMemPaths.ts
    participant SCAN as memdir/memoryScan.ts
    participant FIND as findRelevantMemories.ts
    participant ATTACH as utils/attachments.ts
    participant SESSMEM as SessionMemory/sessionMemory.ts
    participant AGENTMEM as AgentTool/agentMemory.ts
    participant LOADAGENT as AgentTool/loadAgentsDir.ts
    participant SIDEQ as utils/sideQuery.ts
    participant FS as 文件系统

    rect rgb(255, 243, 224)
        Note over PROMPT,FS: 链路 A：Auto Memory 注入 System Prompt
        PROMPT->>PROMPT: getSystemPrompt()
        Note over PROMPT: systemPromptSection 'memory'
        PROMPT->>MEMDIR: loadMemoryPrompt()
        MEMDIR->>MEMDIR: isAutoMemoryEnabled()
        MEMDIR->>PATHS: getAutoMemPath()
        PATHS->>PATHS: getMemoryBaseDir()
        PATHS->>PATHS: sanitizePath()
        PATHS->>PATHS: findCanonicalGitRoot()
        PATHS-->>MEMDIR: auto memory 路径
        MEMDIR->>FS: ensureMemoryDirExists(path)
        MEMDIR->>MEMDIR: buildMemoryLines(displayName, memoryDir)
        MEMDIR->>FS: 读取 MEMORY.md 入口文件
        MEMDIR->>MEMDIR: truncateEntrypointContent(raw)
        Note over MEMDIR: 硬截断保护: MAX_ENTRYPOINT_LINES=200, MAX_ENTRYPOINT_BYTES=25000

        opt Team Memory 开启 (feature TEAMMEM)
            MEMDIR->>TEAM: isTeamMemoryEnabled()
            TEAM-->>MEMDIR: true
            MEMDIR->>TEAM: getTeamMemPath()
            TEAM-->>MEMDIR: team memory 路径
            MEMDIR->>TEAM: buildCombinedMemoryPrompt()
            TEAM-->>MEMDIR: 合并后的 memory prompt
        end

        MEMDIR-->>PROMPT: memory prompt 文本
        Note over PROMPT: 注入到 system prompt 的 'memory' section
    end

    rect rgb(232, 245, 233)
        Note over ATTACH,FS: 链路 B：Relevant Memory 召回（异步预取）
        ATTACH->>ATTACH: prefetchMemories()  ← query 循环开始时触发
        ATTACH->>FIND: findRelevantMemories(query, memoryDir)
        FIND->>SCAN: scanMemoryFiles(memoryDir)
        SCAN->>FS: 扫描 memories/ 目录下所有 .md 文件
        SCAN-->>FIND: 文件清单 + 内容摘要
        FIND->>SCAN: formatMemoryManifest(scanResult)
        SCAN-->>FIND: manifest 文本
        FIND->>FIND: selectRelevantMemories(manifest, query)
        FIND->>SIDEQ: sideQuery(prompt) ← 用 LLM 筛选相关记忆
        SIDEQ-->>FIND: 相关记忆文件列表
        FIND-->>ATTACH: 召回的记忆内容
        Note over ATTACH: 注入到本轮上下文的附件消息中
    end

    rect rgb(227, 242, 253)
        Note over SESSMEM,FS: 链路 C：Session Memory（会话摘要）
        SESSMEM->>SESSMEM: initSessionMemory()
        Note over SESSMEM: 注册 postSamplingHook: extractSessionMemory
        SESSMEM->>SESSMEM: shouldExtractMemory()
        SESSMEM->>SESSMEM: hasMetInitializationThreshold() / hasMetUpdateThreshold()

        opt 达到阈值
            SESSMEM->>SESSMEM: setupSessionMemoryFile()
            SESSMEM->>SESSMEM: loadSessionMemoryTemplate()
            SESSMEM->>SESSMEM: buildSessionMemoryUpdatePrompt()
            SESSMEM->>SIDEQ: runForkedAgent(prompt)
            Note over SIDEQ: 分叉一个子 agent 做摘要
            SIDEQ-->>SESSMEM: 会话摘要 markdown
            SESSMEM->>FS: 写入 session memory 文件
        end
    end

    rect rgb(243, 229, 245)
        Note over LOADAGENT,FS: 链路 D：Agent Memory（agent 专属记忆）
        LOADAGENT->>LOADAGENT: getAgentDefinitionsWithOverrides()
        LOADAGENT->>AGENTMEM: loadAgentMemoryPrompt(agentDef)
        AGENTMEM->>AGENTMEM: getAgentMemoryDir(agent)
        Note over AGENTMEM: 区分 scope: user / project / local
        AGENTMEM->>MEMDIR: ensureMemoryDirExists(dir)
        AGENTMEM->>MEMDIR: buildMemoryPrompt(displayName, memoryDir)
        MEMDIR->>MEMDIR: buildMemoryLines()
        MEMDIR->>MEMDIR: truncateEntrypointContent()
        MEMDIR-->>AGENTMEM: agent memory prompt
        AGENTMEM-->>LOADAGENT: 注入到 agent 的 system prompt

        opt Agent Memory Snapshot
            LOADAGENT->>LOADAGENT: checkAgentMemorySnapshot()
            Note over LOADAGENT: 检查是否有新版 snapshot
            LOADAGENT->>LOADAGENT: initializeFromSnapshot()
            LOADAGENT->>FS: copySnapshotToLocal()
        end
    end
```

## Memory 四层体系总结

| 层 | 存储位置 | 生命周期 | 注入方式 | 关键文件 |
|----|----------|----------|----------|----------|
| Auto Memory | `~/.claude/memory/` 或项目级 | 长期 | System Prompt section | `memdir.ts` |
| Relevant Memory | 同上 | 按轮召回 | 附件消息 | `findRelevantMemories.ts` |
| Session Memory | 会话目录 | 当前会话 | postSamplingHook | `sessionMemory.ts` |
| Agent Memory | agent 专属目录 | 按 agent scope | Agent System Prompt | `agentMemory.ts` |
| Team Memory | 团队同步目录 | 团队共享 | 合并到 Auto Memory prompt | `teamMemPaths.ts` |
