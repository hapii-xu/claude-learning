import { defineConfig, type Plugin } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { getMacroDefines } from './scripts/defines'
import featureFlagsPlugin from './scripts/vite-plugin-feature-flags'
import importMetaRequirePlugin from './scripts/vite-plugin-import-meta-require'

const projectRoot = dirname(fileURLToPath(import.meta.url))

const acknowledgedBuildWarnings = [
  'src/utils/sandbox/sandbox-adapter.ts',
  'packages/builtin-tools/src/tools/ToolSearchTool/prompt.ts',
  'src/utils/claudemd.ts',
  'src/services/SessionMemory/sessionMemoryUtils.ts',
  'src/commands/logout/logout.tsx',
  'src/utils/sessionStorage.ts',
  'src/utils/swarm/backends/registry.ts',
  'src/utils/toolSearch.ts',
  'src/utils/hooks.ts',
  'src/services/skillLearning/sessionObserver.ts',
  'src/utils/settings/changeDetector.ts',
]

function isAcknowledgedBuildWarning(warning: {
  code?: string
  id?: string
  message?: string
}): boolean {
  if (warning.code === 'EVAL' && warning.id?.includes('@protobufjs+inquire')) {
    return true
  }

  return (
    warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT' &&
    acknowledgedBuildWarnings.some(id => warning.message?.includes(id))
  )
}

/**
 * 将 .md 等文件作为原始字符串导入的插件（复刻 Bun 的 text loader 行为）。
 */
function rawAssetPlugin(extensions: string[]): Plugin {
  return {
    name: 'raw-asset',
    enforce: 'pre',
    resolveId(id, importer) {
      if (extensions.some(ext => id.endsWith(ext))) {
        // 解析到实际文件路径
        return this.resolve(id, importer, { skipSelf: true })
      }
      return null
    },
    load(id) {
      if (extensions.some(ext => id.endsWith(ext))) {
        const content = readFileSync(id, 'utf-8')
        return `export default ${JSON.stringify(content)}`
      }
      return null
    },
  }
}

export default defineConfig({
  // CLI 工具 —— 无需浏览器特性
  appType: 'custom',

  // 告知 Vite 这是 Node.js 构建，而非浏览器构建。
  // 防止 Node.js 内置模块（fs、path 等）被外置。
  ssr: {
    target: 'node',
    noExternal: true,
    // 含运行时 require.resolve() 或 WASM 二进制的包无法内联进 bundle ——
    // 它们必须在运行时从 node_modules 解析。doubaoime-asr 使用 opus-encdec，
    // 后者会调用 require.resolve('opus-encdec/dist/libopus-encoder.wasm.js')。
    external: ['doubaoime-asr', 'opus-encdec'],
  },

  build: {
    emptyOutDir: true,
    outDir: 'dist',
    target: 'es2020',
    copyPublicDir: false,
    sourcemap: false,
    minify: true,

    // SSR 构建模式 —— 使用 Rollup，目标为 Node.js
    ssr: true,

    rollupOptions: {
      input: resolve(projectRoot, 'src/entrypoints/cli.tsx'),

      output: {
        format: 'es',
        // 代码分割：Bun/JSC 会全量解析单文件 bundle，17 MB 产物会吃掉
        // ~1 GB RSS（对比 Node/V8 懒解析约 220 MB）。拆分成 chunk 后
        // Bun 可按需加载模块，RSS 降到 ~300 MB。
        entryFileNames: 'cli.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },

      plugins: [
        rawAssetPlugin(['.md', '.txt', '.html', '.css']),
        featureFlagsPlugin(),
        importMetaRequirePlugin(),
      ],

      onwarn(warning, defaultHandler) {
        if (isAcknowledgedBuildWarning(warning)) return
        defaultHandler(warning)
      },
    },

    cssCodeSplit: false,
  },

  // 编译期常量替换（MACRO.* defines）
  define: {
    ...getMacroDefines(),
    // React 生产模式 —— 消除 _debugStack Error 对象
    //（开发构建中约 6,889 个对象 × ~1.7KB = 12MB）
    'process.env.NODE_ENV': JSON.stringify('production'),
  },

  resolve: {
    alias: {
      // src/* 路径别名（镜像 tsconfig 的 paths）
      'src/': resolve(projectRoot, 'src/'),
    },
    // 确保 workspace 包共享这些依赖的同一份实例
    dedupe: ['react', 'react-reconciler', 'react-compiler-runtime'],
    // 将 .js 导入解析到 .ts 文件（Bun 会自动完成）
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
})
