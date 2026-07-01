# queryLoop 分节调试 harness

不启动整个 CLI，直接 **debug 运行** `queryLoop()`（`src/query.ts:540-2457`，约 1900 行的回合执行引擎），
对照 15 个小节逐段观察。**真实 API 调用 + 真实回合循环**版。

> `queryLoop` 是**未导出**的内部函数，唯一入口是 `query()`（`query.ts:359`）。所以本系列的 harness
> **薄封装** query 系列的驱动核心 `runQuery`——一次运行同时穿过 query 与 queryLoop，断点全部打在
> `queryLoop` 内部。共享的 bootstrap / `buildToolUseContext` / generator 驱动见
> [`../../query/_debug/harness.ts`](../../query/_debug/harness.ts)。

## ⚠️ 真实工具副作用

默认 `canUseTool` **自动放行所有工具**且跑真实完整回合——`[9]/[14]/[15]` 等节模型发 `tool_use` 时会
**真实执行工具（含 Bash 命令 / 写文件）**。已用 `maxTurns` + `maxOutputTokensOverride: 128` + 短 prompt
收窄。`[14]tool-execution` 想避免副作用：改 prompt 为只读意图、或传 `tools: []`。

## 目录结构

```
queryLoop/
├── _debug/
│   ├── harness.ts     ← 薄封装：re-export runQuery + runWithToolLoop / runWithBigHistory preset
│   └── README.md      ← 本文件
├── [1]query-wrapper/debug.isolated.ts
├── ...
└── [15]attachments-next-turn/debug.isolated.ts
```

## 怎么跑

### 1) 直接跑

```bash
bun run "docs/summary/[2]core-loop-summary/query-ts/queryLoop/[9]api-call-stream/debug.isolated.ts"
```

终端打印 `[harness]` 逐条 yield + 最终 `terminal.reason`；源码 `[Hapii]` 日志同时输出。

### 2) VS Code 断点调试（推荐）

复用与 queryModel 系列**同一个**通用配置 **「🔬 Debug queryModel 当前分节文件 (.isolated.ts)」**：
在 `src/query.ts` 关心的行（如 540 / 1224 / 2031）打断点 → 打开目标 `[N]<name>/debug.isolated.ts` →
`F5` → 命中单步 → 改参数重跑对比。

### 3) 命令行 / Chrome 调试（备选）

```bash
bun --inspect-wait run "docs/.../query-ts/queryLoop/[12]termination-recovery/debug.isolated.ts"
```

## 控制杆速查（每节改这些，行号 = src/query.ts）

| 文件 | 行号区间 | 驱动 | 关键控制杆 |
|---|---|---|---|
| `[1]query-wrapper` | 359-526 | `runQuery` | trace/收尾/GC（同 query 系列 [6]） |
| `[2]params-state-deps` | 284-336,580-626 | `runQuery` | `paramsOverride.deps` 注入 callModel；`taskBudget` |
| `[3]loop-entry-prefetch` | 628-712 | `runQuery` | `features` 开 skill/tool 预取 |
| `[4]history-trim-budget` | 714-800 | `runWithBigHistory` | 大 toolUseResult 历史看预算释放 |
| `[5]compaction-family` | 802-895 | `runWithBigHistory` | `features:['HISTORY_SNIP']`；snip→micro→collapse |
| `[6]systemprompt-autocompact` | 897-1019 | `runWithBigHistory` | 撑到接近窗口上限触发主动 autocompact |
| `[7]setup-and-model` | 1021-1108 | `runQuery` | `optionsOverride.mainLoopModel`；`fallbackModel` |
| `[8]blocking-predictive` | 1110-1222 | `runWithBigHistory` | 关 auto-compact 撞 `blocking_limit`(1172) |
| `[9]api-call-stream` | 1224-1472（核心） | `runWithToolLoop` | thinking + tool 混合输出逐帧累积 |
| `[10]fallback-errors` | 1473-1597 | `runQuery` | 无效 `mainLoopModel` 触发降级/`model_error`(1596) |
| `[11]post-stream-checks` | 1599-1693 | `runQuery` | 长输出 + Ctrl+C 看 `aborted_streaming`(1683) |
| `[12]termination-recovery` | 1695-1925 | `runWithBigHistory` | 撑爆上下文触发 413 恢复链 |
| `[13]stophooks-completed` | 1927-2029 | `runQuery` | `features:['TOKEN_BUDGET']`+`taskBudget`；stop hook |
| `[14]tool-execution` | 2031-2226 | `runWithToolLoop` | ⚠️ 真实执行工具；prompt 控制调哪个工具 |
| `[15]attachments-next-turn` | 2228-2457 | `runWithToolLoop` | `maxTurns` 看 `next_turn`(2449)/`max_turns`(2431) |

> Terminal（10 种）/ transition（7 种）全表见 [`[0]overview`](../[0]overview/overview.mdx)，对照表读 `terminal.reason` 与续轮原因。

## harness 做了什么

复用 query 系列的 `runQuery`（bootstrap：MACRO / `feature()` mock / `enableConfigs` /
`applySafeConfigEnvironmentVariables`；`buildToolUseContext` 组装最小 ToolUseContext；手动驱动
generator 拿 Terminal）。额外提供两个循环向 preset：

- **`runWithToolLoop`**——全量 tools + 诱导工具调用的 prompt，看「发请求→跑工具→续轮」闭环。
- **`runWithBigHistory`**——注入超长历史撑大 token，触发压缩家族 / 413 恢复家族。

**刻意不 mock**：auth / client / messages / query / queryLoop / 工具执行——全走真实逻辑。

## 注意事项

- **真实计费 + 真实工具副作用**：见顶部警告。压缩/恢复路径会多发 API 请求，token 消耗更高。
- `.isolated.ts` 在 `docs/` 下：不进 typecheck / `bun test`，不影响 `bun run precheck`。
- 首跑兜底：若 standalone 运行报「配置/模块未初始化」，按参照同法在 query 系列 harness 的
  bootstrap 前奏里补对应 `enable*()` 或 env 注入即可。
