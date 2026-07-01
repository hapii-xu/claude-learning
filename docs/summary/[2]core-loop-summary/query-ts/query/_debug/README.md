# query() 分节调试 harness

不启动整个 CLI，直接 **debug 运行** `src/query.ts` 的公开入口 `query()`（`query.ts:359`），
并能**自己调整每次调用传入的参数**，对照 7 个小节逐段观察。**真实 API 调用 + 真实回合循环**版。

> `query()` 经 `yield*` 委托内部的 `queryLoop()`（`query.ts:540`），所以**一次运行同时穿过
> query 与 queryLoop 两者**。姊妹系列 [`queryLoop/_debug/`](../../queryLoop/_debug/README.md) 复用本 harness。

## ⚠️ 真实工具副作用

默认 `canUseTool` **自动放行所有工具**，且跑真实完整回合——模型发 `tool_use` 时会
**真实执行工具（含 Bash 命令 / 写文件）**。已用 `maxTurns: 3` + `maxOutputTokensOverride: 128`
+ 短 prompt 收窄。调试时保持小输入；想禁工具传 `tools: []`。

## 目录结构

```
query/
├── _debug/
│   ├── harness.ts     ← 共享 harness：buildToolUseContext + 手动驱动 generator 拿 Terminal
│   └── README.md      ← 本文件
├── [1]module-helpers/debug.isolated.ts
├── [2]params-and-state/debug.isolated.ts
├── [3]trace-ownership/debug.isolated.ts
├── [4]loop-invocation/debug.isolated.ts
├── [5]autonomy-finalize/debug.isolated.ts
├── [6]trace-teardown-gc/debug.isolated.ts
└── [7]completion-signal/debug.isolated.ts
```

## 怎么跑

### 1) 直接跑

```bash
bun run "docs/summary/[2]core-loop-summary/query-ts/query/[7]completion-signal/debug.isolated.ts"
```

终端打印 `[harness]` 逐条 yield（stream_event / assistant / tool_result）+ 最终 `terminal.reason`。
源码里大量 `[Hapii]` 日志会同时输出，配合断点逐段学习。

### 2) VS Code 断点调试（推荐）

复用与 queryModel 系列**同一个**通用配置 **「🔬 Debug queryModel 当前分节文件 (.isolated.ts)」**
（`.vscode/launch.json` 里用 `${file}` 指向当前打开文件）：在 `src/query.ts` 关心的行打断点 →
打开目标 `[N]<name>/debug.isolated.ts` → `F5` → 命中单步 → 改参数重跑对比。

### 3) 命令行 / Chrome 调试（备选）

```bash
bun --inspect-wait run "docs/.../query-ts/query/[4]loop-invocation/debug.isolated.ts"
```

## 控制杆速查（每节改这些）

| 文件 | query.ts 行号 | 建议断点 | 关键控制杆 |
|---|---|---|---|
| `[1]module-helpers` | 214-282 | 214 / getAutonomyTurnOutcome | `maxTurns`、`maxOutputTokensOverride` |
| `[2]params-and-state` | 284-335 | 359 / 540 | 全 `QueryParams` 字段；`paramsOverride` |
| `[3]trace-ownership` | 359-407 | 379 / 384 / 401 | `features` 开 langfuse；`toolUseContextOverride.langfuseTrace` |
| `[4]loop-invocation` | 408-432 | 416 / 428 | `optionsOverride.mainLoopModel`=无效模型触发 throw |
| `[5]autonomy-finalize` | 433-456 | 433 / enqueue | `features` autonomy；带 autonomy 命令的 `messages` |
| `[6]trace-teardown-gc` | 457-508 | 457 / flushLangfuse / clearMarks | `features` 开 langfuse 看三连清理 |
| `[7]completion-signal` | 510-526 | 510 / 526 | 正常完成 vs throw vs `closeAfterYields`(.return()) |

## harness 做了什么（为什么能 standalone 跑）

bootstrap 前奏与 queryModel/queryModelWrappers harness 一致（MACRO 注入 / `feature()` mock /
`enableConfigs()` / `applySafeConfigEnvironmentVariables()` / 默认 sonnet 模型）。额外两件事：

1. **`buildToolUseContext()`**——组装最小可用的 `ToolUseContext`（`src/Tool.ts:160`）：
   `options`（tools 取 `getTools(空权限上下文)`）、`abortController`、`readFileState`（`FileStateCache`）、
   可变 `getAppState/setAppState`（从 `getDefaultAppState()` 起步）、其余 setter no-op。
2. **手动驱动 generator** 而非 `for await`——因为 `query()` 的精华是 finally 善后 + **返回的
   `Terminal`**，`for await` 拿不到 return 值。harness 用 `gen.next()` 循环、`r.done` 时取 `r.value`。

**刻意不 mock**：auth / client / messages / query / queryLoop / 工具执行——全走真实逻辑。

## 注意事项

- **真实计费 + 真实工具副作用**：见顶部警告。默认已压小。
- `.isolated.ts` 在 `docs/` 下：不进 typecheck / `bun test`，不影响 `bun run precheck`。
- 首跑兜底：若 standalone 运行报「配置/模块未初始化」，按参照同法在 harness 的 bootstrap
  前奏里补对应 `enable*()` 或 env 注入即可。
