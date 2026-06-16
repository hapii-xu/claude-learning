# 宏观：六层分层架构图（Mermaid）

```mermaid
graph TD
    subgraph L1["① CLI 引导层"]
        CLI["entrypoints/cli.tsx<br/><i>早期分流 · 快路径退出</i>"]
    end

    subgraph L2["② 初始化层"]
        MAIN["main.tsx<br/><i>总控入口 · 能力装配</i>"]
        INIT["entrypoints/init.ts<br/><i>逻辑初始化 · trust 前/后</i>"]
        SETUP["setup.ts<br/><i>运行环境初始化</i>"]
    end

    subgraph L3["③ 控制面 / 命令层"]
        CMD["commands.ts<br/><i>slash 命令 · feature gates</i>"]
    end

    subgraph L4["④ TUI / REPL 层"]
        REPL["screens/REPL.tsx<br/><i>会话工作台</i>"]
        APP["components/App.tsx<br/><i>Provider 根包装</i>"]
        PI["PromptInput<br/><i>输入编排</i>"]
        MSG["Messages<br/><i>消息渲染</i>"]
    end

    subgraph L5["⑤ 执行内核"]
        QE["QueryEngine.ts<br/><i>无 UI 执行引擎</i>"]
        Q["query.ts<br/><i>主循环 · 工具闭环</i>"]
        API["services/api/claude.ts<br/><i>API 调用层</i>"]
    end

    subgraph L6["⑥ 能力层"]
        TOOL["Tool.ts / toolOrchestration<br/><i>工具池 · 调度</i>"]
        MEM["memdir / SessionMemory<br/><i>多层记忆系统</i>"]
        MCP["services/mcp/client.ts<br/><i>MCP 集成</i>"]
        EXT["Plugin / Swarm / Bridge<br/><i>扩展运行时</i>"]
    end

    CLI -->|"import"| MAIN
    MAIN -->|"preAction"| INIT
    MAIN -->|"action"| SETUP
    MAIN -->|"getCommands"| CMD
    MAIN -->|"launchRepl"| REPL
    REPL --> APP
    APP --> PI
    APP --> MSG
    PI -->|"用户输入"| QE
    QE -->|"submitMessage"| Q
    Q -->|"stream"| API
    Q -->|"runTools"| TOOL
    Q -->|"memory 注入"| MEM
    TOOL -->|"MCP 工具"| MCP
    EXT -->|"多 agent"| Q
```

## 层间职责

| 层 | 职责 | 关键特征 |
|----|------|----------|
| ① CLI 引导层 | 早期分流，快路径退出（`--version`、`--dump-system-prompt`） | 不加载 React/Ink/MCP，启动快 |
| ② 初始化层 | 逻辑初始化（`init.ts`）+ 运行环境初始化（`setup.ts`）+ 能力装配（`main.tsx`） | trust 前后分离，安全边界清晰 |
| ③ 控制面 / 命令层 | slash 命令注册、feature gates、内建/外部命令过滤 | 编译期 + 运行期双重开关 |
| ④ TUI / REPL 层 | 终端工作台：消息区 + 输入区 + 弹层 + 快捷键 | Ink/React 渲染，AppState 状态总线 |
| ⑤ 执行内核 | query 主循环：API 调用 → 工具执行 → 结果回流 → 循环 | 可被 SDK/Headless 形态复用 |
| ⑥ 能力层 | 工具池、记忆、MCP、插件、多 agent | 可扩展、可插拔、可独立开关 |
