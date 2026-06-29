# queryModel 分节调试 harness

不启动整个 CLI，直接 **debug 运行** `src/services/api/claude.ts` 里的 `queryModel`（claude.ts:1303），
并能**自己调整每次调用传入的参数**，对照 16 个小节逐段观察行为。**真实 API 调用**版——
鉴权复用你机器上 `~/.hclaude/settings.json` 里的配置（DashScope/Qwen），不硬编码 key。

## 目录结构

```
queryModel/
├── _debug/
│   ├── harness.ts     ← 共享 harness：装参数 + 最小 mock + 消费生成器
│   └── README.md      ← 本文件
├── [1]off-switch/debug.isolated.ts
├── [2]previous-request-id/debug.isolated.ts
├── ...
└── [16]finally-and-teardown/debug.isolated.ts
```

每个 `[N]<name>/debug.isolated.ts` 是一段**顶层 await 脚本**，针对该小节调好参数，
文件头注释写明：**行号范围、控制杆（改哪些参数）、建议断点、该看什么**。

## 怎么跑

### 1) 直接跑（看真实输出，确认链路通）

```bash
bun run "docs/summary/[2]core-loop-summary/services-api/claude-ts/queryModel/[10]params-from-context/debug.isolated.ts"
```

终端会打印 `[harness]` 前缀的逐条 yield（stream_event / assistant / 错误）与最终汇总。

### 2) VS Code 断点调试（核心用法，推荐）

**不需要给每个文件单独写配置**——`.vscode/launch.json` 里已加了一个用 `${file}`
指向「当前打开文件」的通用配置，一个配置调试全部 16 个分节文件。

步骤：

1. 在 `src/services/api/claude.ts` 里你关心的行号左侧点一下打断点（见各文件头注释）。
2. 打开要调试的 `[N]<name>/debug.isolated.ts`（让它处于当前激活的编辑器标签）。
3. 按 `F5`，调试配置选 **「🔬 Debug queryModel 当前分节文件 (.isolated.ts)」**。
4. 命中断点，单步观察。改完该文件里的参数再 `F5` 重跑，对比变量变化——这就是「自己调参观察」的闭环。

> 该配置等价于 `bun run <当前文件>`：`request: launch` 而非 test，所以 `NODE_ENV` 不为
> `test`、VCR 自动关闭，`queryModel` 每次真实执行。依赖项目已装的 Bun VS Code 扩展（`type: "bun"`）。

### 3) 命令行 / Chrome 调试（备选）

```bash
bun --inspect-wait run "docs/.../queryModel/[13]stream-events/debug.isolated.ts"
```

`--inspect-wait` 等调试器接入后才执行；打开 `chrome://inspect` →
Configure 加上 `localhost:6499` → 点 inspect。

## 控制杆速查（每节改这些）

| 文件 | claude.ts 行号 | 关键控制杆 |
|---|---|---|
| `[1]off-switch` | 1324-1342 | `options.model`=Opus；`tengu-off-switch` 动态配置 |
| `[2]previous-request-id` | 1347-1354 | `messages` 含带 requestId 的历史 assistant；Bedrock env |
| `[3]betas-and-advisor` | 1356-1406 | `options.advisorModel`、`querySource`、feature `ADVISOR` |
| `[4]search-tools` | 1408-1561 | `tools`、`mcpTools`、`hasPendingMcpServers`、搜索工具 feature |
| `[5]cache-and-tool-schemas` | 1480-1563 | `enablePromptCaching`、`skipCacheWrite`、`mcpTools` |
| `[6]message-normalization` | 1565-1672 | `messages` 形态（string/blocks/media/tool_result） |
| `[7]provider-routing` | 1621-1662 | env `CLAUDE_CODE_USE_OPENAI/GEMINI/GROK` |
| `[8]system-prompt-and-cache-break` | 1674-1762 | `isNonInteractiveSession`、`hasAppendSystemPrompt`、`system` |
| `[9]beta-latching` | 1781-1871 | `fastMode`；连调两次看锁存 |
| `[10]params-from-context` | 1906-2135 | `thinkingConfig`、`temperatureOverride`、`effortValue`、`taskBudget` |
| `[11]send-request` | 2137-2233 | `fallbackModel`、`maxOutputTokensOverride` |
| `[12]stream-watchdog` | 2245-2305 | env `API_TIMEOUT_MS`；长输出 prompt |
| `[13]stream-events` | 2307-2775 | thinking+text+tool 混合输出，逐帧累积（核心） |
| `[14]post-stream-validation` | 2776-2882 | usage / 配额头 / 空响应判定 |
| `[15]error-fallback` | 2883-3290 | `options.model`=无效模型，触发降级 catch |
| `[16]finally-and-teardown` | 3291-3402 | 资源释放 / 成本累计 / 成功日志 |

## harness 做了什么（为什么能 standalone 跑）

`_debug/harness.ts` 在 import 被测函数之前完成几件「正常由 CLI init 做」的事：

1. **注入 `MACRO.*` 全局**（dev/build 时由 `-d`/define 注入，standalone 缺失会抛 `MACRO is not defined`）。
2. **mock `bun:bundle` 的 `feature()`**——没有 `--feature` flag 时默认全 false；用 `setFeatures([...])`/`options.features` 声明式开关。
3. `enableConfigs()`——放行配置读取（否则 config.ts:1426 抛 `Config accessed before allowed.`）。
4. `applySafeConfigEnvironmentVariables()`——把 `~/.hclaude/settings.json` 的 `env` 块
   （`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / 模型映射）应用到 `process.env`，**鉴权据此解析**。
5. 默认 `model` 取 `getDefaultSonnetModel()`（尊重你的 provider 映射，如 `qwen3.6-plus`）。

**刻意不 mock**：auth / client / messages / vcr——让它们走真实逻辑。
用 `bun run`（非 `bun test`）执行，`NODE_ENV` 不为 `test`，VCR（vcr.ts:27）自动关闭，
`queryModel` 每次真实执行而非录/放跳过。

## 注意事项

- **真实计费**：每次运行都消耗真实 token。默认已压小（短 prompt + `maxOutputTokensOverride`），
  调试时尽量保持小输出。
- 这些文件在 `docs/` 下、且是 `.isolated.ts`：**不被 `bun run typecheck` 收录、也不被 `bun test` 拾取**，
  不影响 `bun run precheck`。
- 若某分节需要点亮 feature，用文件里的 `features: [...]` 或顶部 `setFeatures([...])`。
- 退路：若哪天 `bun run` 下 `mock.module` 不可用，改用 `bun --inspect-wait test "<file>"`，
  并在 harness 里额外 passthrough-mock `src/services/vcr.js`（`withStreamingVCR(msgs,f)=>f()`）。
