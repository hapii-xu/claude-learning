// package.json "browser" 字段的间接层。当 bun 用 --target browser 构建
// browser-sdk.js 时，此文件会被替换为 crypto.browser.ts —— 避免 Bun 为
// `import ... from 'crypto'` 内联约 500KB 的 crypto-browserify polyfill。
// Node/bun 构建原样使用此文件。
//
// 注意：`export { randomUUID } from 'crypto'`（re-export 语法）在
// bun-internal 的字节码编译下会失败 —— 生成的字节码显示了 import
// 但绑定未连接（`ReferenceError: randomUUID is not defined`）。
// 下方的显式 import-then-export 会产生正确的活动绑定。
// 见 PR #20957/#21178 上的 integration-tests-ant-native 失败。
import { randomUUID } from 'crypto'
export { randomUUID }
