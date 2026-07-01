# queryModelWrappers 分节调试 harness

不启动整个 CLI，直接 **debug 运行** `src/services/api/claude.ts` 的两个**包装层入口**——
`queryModelWithStreaming`（`claude.ts:1022`，流式）和 `queryModelWithoutStreaming`（`claude.ts:963`，非流式）——
并能**自己调整每次调用传入的参数**，对照 5 个小节逐段观察。**真实 API 调用**版，
鉴权复用你机器上 `~/.hclaude/settings.json` 里的配置，不硬编码 key。

> 下游那台 2100 行的传输引擎 `queryModel` 本体，拆在姊妹系列
> [`queryModel/_debug/`](../../queryModel/_debug/README.md)。本系列只调它的外圈包装与周边 helper。

## 目录结构

```
queryModelWrappers/
├── _debug/
│   ├── harness.ts     ← 共享 harness：runStreaming + runNonStreaming + bootstrap
│   └── README.md      ← 本文件
├── [1]streaming-wrapper/debug.isolated.ts
├── [2]nonstreaming-wrapper/debug.isolated.ts
├── [3]vcr-layer/debug.isolated.ts
├── [4]nonstreaming-fallback-engine/debug.isolated.ts
└── [5]helpers/debug.isolated.ts
```

## 怎么跑

### 1) 直接跑（看真实输出，确认链路通）

```bash
bun run "docs/summary/[2]core-loop-summary/services-api/claude-ts/queryModelWrappers/[1]streaming-wrapper/debug.isolated.ts"
```

终端会打印 `[harness]` 前缀的逐条 yield（stream_event / assistant / 错误）与最终汇总。

### 2) VS Code 断点调试（推荐）

复用与 queryModel 系列**同一个**通用配置——`.vscode/launch.json` 里用 `${file}` 指向
「当前打开文件」的 **「🔬 Debug queryModel 当前分节文件 (.isolated.ts)」**，一个配置调试全部分节文件：

1. 在 `src/services/api/claude.ts` / `src/services/vcr.ts` 关心的行打断点（见各文件头注释）。
2. 打开要调试的 `[N]<name>/debug.isolated.ts`（处于当前激活标签）。
3. 按 `F5`，选该配置。命中后单步、改参数重跑、对比变量变化。

### 3) 命令行 / Chrome 调试（备选）

```bash
bun --inspect-wait run "docs/.../queryModelWrappers/[3]vcr-layer/debug.isolated.ts"
```

## 控制杆速查（每节改这些）

| 文件 | 源码行号 | 驱动函数 | 关键控制杆 |
|---|---|---|---|
| `[1]streaming-wrapper` | claude.ts:1022-1054 | `runStreaming` | `prompt` / `messages`，看事件透传 |
| `[2]nonstreaming-wrapper` | claude.ts:963-1020 | `runNonStreaming` | `prompt`；`signal`=已 abort 看 `APIUserAbortError`(1002) |
| `[3]vcr-layer` | vcr.ts:26-383 | `runStreaming` | `env.FORCE_VCR='1'` 打开 VCR；连跑两次看录制→回放 |
| `[4]nonstreaming-fallback-engine` | claude.ts:1079-1196 | `runStreaming` | `options.model`=触发流式失败的模型；`onStreamingFallback` |
| `[5]helpers` | claude.ts:1060-1292 | 直接调 + `runStreaming` | 含大量 media 的 `messages`；带 requestId 的历史；LSP 工具 |

## harness 做了什么（为什么能 standalone 跑）

`_debug/harness.ts` 在 import 被测函数之前完成几件「正常由 CLI init 做」的事（与 queryModel harness 一致）：

1. **注入 `MACRO.*` 全局**（dev/build 时由 `-d`/define 注入，standalone 缺失会抛 `MACRO is not defined`）。
2. **mock `bun:bundle` 的 `feature()`**——没有 `--feature` flag 时默认全 false；用 `setFeatures([...])`/`features` 声明式开关。
3. `enableConfigs()`——放行配置读取（否则 `Config accessed before allowed.`）。
4. `applySafeConfigEnvironmentVariables()`——把 `~/.hclaude/settings.json` 的 `env` 块应用到 `process.env`，**鉴权据此解析**。
5. 默认 `model` 取 `getDefaultSonnetModel()`（尊重你的 provider 映射）。

**刻意不 mock**：auth / client / messages / vcr——走真实逻辑。用 `bun run`（非 `bun test`），
`NODE_ENV` 不为 `test`，VCR（`vcr.ts:27`）默认关闭；`[3]` 用 `env.FORCE_VCR` 显式打开。

## 注意事项

- **真实计费**：每次运行都消耗真实 token。默认已压小（短 prompt + `maxOutputTokensOverride: 128`）。
- 这些文件在 `docs/` 下、且是 `.isolated.ts`：**不被 typecheck 收录、也不被 `bun test` 拾取**，不影响 `bun run precheck`。
- `[3]vcr-layer` 退路：若 `bun run` 下 `FORCE_VCR` 不足以让 `shouldUseVCR()` 返回 true，
  改用 `bun --inspect-wait test "<file>"`，并在 harness 里额外 passthrough-mock
  `src/services/vcr.js`（`withStreamingVCR(msgs,f)=>f()`）。
