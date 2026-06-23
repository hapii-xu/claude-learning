#!/usr/bin/env bun
/**
 * Dev 入口 —— 启动 cli.tsx 并通过 Bun 的 -d flag 注入 MACRO.* defines
 *（bunfig.toml 的 [define] 在运行时不会传播到动态导入的模块）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMacroDefines, DEFAULT_BUILD_FEATURES } from './defines.ts'

// 根据当前脚本位置推算项目根目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '..')
const cliPath = join(projectRoot, 'src/entrypoints/cli.tsx')

const defines = {
  ...getMacroDefines(),
  // React 生产模式 —— 防止长会话期间累积 6,889+ 个 _debugStack Error
  // 对象（12MB）。dev 模式使用 development 模式
  'process.env.NODE_ENV': JSON.stringify('production'),
}

const defineArgs = Object.entries(defines).flatMap(([k, v]) => [
  '-d',
  `${k}:${v}`,
])

// Bun --feature flag：在运行时启用 feature() 门控。
// 使用 defines.ts 中共享的 DEFAULT_BUILD_FEATURES 列表。

// 任何匹配 FEATURE_<NAME>=1 的环境变量也会启用对应的 feature。
// 例如：FEATURE_PROACTIVE=1 bun run dev
const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith('FEATURE_'))
  .map(([k]) => k.replace('FEATURE_', ''))

const allFeatures = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]
const featureArgs = allFeatures.flatMap(name => ['--feature', name])

// 若设置了 BUN_INSPECT，则向子进程传递 --inspect-wait
const inspectArgs = process.env.BUN_INSPECT
  ? ['--inspect-wait=' + process.env.BUN_INSPECT]
  : []

const result = Bun.spawnSync(
  [
    'bun',
    ...inspectArgs,
    'run',
    ...defineArgs,
    ...featureArgs,
    cliPath,
    ...process.argv.slice(2),
  ],
  {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: process.env.CC_CWD ?? projectRoot,
  },
)

process.exit(result.exitCode ?? 0)
