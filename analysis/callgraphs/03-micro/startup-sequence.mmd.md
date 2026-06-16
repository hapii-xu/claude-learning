# 微观：启动链路时序图（Mermaid）

> 对应源码路径：`src/entrypoints/cli.tsx` → `src/main.tsx` → `src/entrypoints/init.ts` → `src/setup.ts` → `src/replLauncher.tsx`

```mermaid
sequenceDiagram
    autonumber
    participant CLI as cli.tsx
    participant MAIN as main.tsx
    participant INIT as init.ts
    participant SETUP as setup.ts
    participant CMDS as commands.ts
    participant MCP as mcp/client.ts
    participant SKILLS as skills/bundled
    participant PLUGINS as plugins/bundled
    participant AGENTS as AgentTool/agentMemory
    participant GROWTH as GrowthBook
    participant TELE as Telemetry
    participant REPL as replLauncher.tsx
    participant APP as App.tsx
    participant REPLSCREEN as REPL.tsx

    Note over CLI: 进程启动
    CLI->>CLI: profileCheckpoint("cli:start")
    CLI->>CLI: 解析 CLI 参数 (parseArgs)

    alt 快路径命中
        CLI-->>CLI: --version / --dump-system-prompt / remote-control / daemon
        CLI->>CLI: process.exit(0)
    else 默认路径
        CLI->>MAIN: import('./main.tsx').then(m => m.main(argv))
    end

    MAIN->>MAIN: initializeWarningHandler()
    MAIN->>MAIN: startCapturingEarlyInput()
    MAIN->>MAIN: initializeEntrypoint()
    MAIN->>MAIN: eagerLoadSettings()

    rect rgb(232, 245, 233)
        Note over MAIN,INIT: main.tsx::run — preAction hook (trust 前)
        MAIN->>INIT: init(argv)
        INIT->>INIT: applySafeConfigEnvironmentVariables()
        INIT->>INIT: applyExtraCACertsFromConfig()
        INIT->>INIT: configureGlobalMTLS()
        INIT->>INIT: configureGlobalAgents()
        INIT->>INIT: preconnectAnthropicApi()
        INIT->>INIT: initJetBrainsDetection()
        INIT->>INIT: detectCurrentRepository()
        INIT->>INIT: setupGracefulShutdown()
        INIT->>INIT: ensureScratchpadDir()
        INIT-->>MAIN: init 完成
    end

    rect rgb(227, 242, 253)
        Note over MAIN,TELE: main.tsx::run — action handler
        MAIN->>SETUP: setup(argv, permissionContext)
        SETUP->>SETUP: switchSession()
        SETUP->>SETUP: setCwd(resolvedWorkingDir)
        SETUP->>SETUP: captureHooksConfigSnapshot()
        SETUP->>SETUP: initializeFileChangedWatcher()
        SETUP->>SETUP: createWorktreeForSession()
        SETUP->>SETUP: initSessionMemory()
        SETUP->>SETUP: prefetchApiKeyFromApiKeyHelperIfSafe()
        SETUP-->>MAIN: setup 完成

        MAIN->>CMDS: getCommands(options)
        CMDS-->>MAIN: Command[]

        MAIN->>MCP: getMcpToolsCommandsAndResources()
        MCP-->>MAIN: { tools, commands, resources }

        MAIN->>SKILLS: initBundledSkills()
        MAIN->>PLUGINS: initBuiltinPlugins()
        MAIN->>AGENTS: getAgentDefinitionsWithOverrides()

        MAIN->>GROWTH: initializeGrowthBook()
        MAIN->>TELE: initializeTelemetryAfterTrust()
        Note over TELE: trust 后才启动 telemetry sink

        MAIN->>MAIN: showSetupScreens()
        MAIN->>MAIN: settingsChangeDetector.start()
    end

    rect rgb(243, 229, 245)
        Note over MAIN,REPLSCREEN: 进入 REPL
        MAIN->>REPL: launchRepl(root, appProps, replProps, renderAndRun)
        REPL->>APP: 动态 import App 组件
        REPL->>REPLSCREEN: 动态 import REPL 组件
        REPL->>REPLSCREEN: Ink 渲染循环启动

        Note over REPLSCREEN: 用户可见交互式工作台
        REPLSCREEN->>REPLSCREEN: 渲染 Messages + PromptInput
        REPLSCREEN->>REPLSCREEN: 注册全局快捷键
    end
```

## 关键设计点

| 阶段 | 设计意图 |
|------|----------|
| cli.tsx 快路径 | 简单命令不加载 React/Ink，启动速度快 |
| init.ts trust 前 | 只应用安全 env vars，防配置攻击 |
| setup.ts | 环境准备：CWD、hooks、memory、worktree |
| main.tsx 能力装配 | 集中装配 tools/mcp/skills/plugins/agents |
| initializeTelemetryAfterTrust | trust 建立后才启动 telemetry |
| launchRepl 动态加载 | App/REPL 组件延迟到最后一刻才 import |
