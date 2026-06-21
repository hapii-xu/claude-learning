// highlight.js 的类型定义包含 `/// <reference lib="dom" />`。SSETransport、
// mcp/client、ssh、dumpPrompts 使用 DOM 类型（TextDecodeOptions、RequestInfo），
// 仅因为下方的 hljs import 引入了 lib.dom 才能通过类型检查。
// tsconfig 仅有 lib: ["ESNext"] —— 此 ref 保留了原有状态。
/// <reference lib="dom" />

import { extname } from 'path'
// 静态导入 —— 动态 import('highlight.js') 在 Bun --compile 模式下失败
// 因为模块解析指向内部的 bunfs 二进制路径。
import hljs from 'highlight.js'

export type CliHighlight = {
  highlight: typeof import('cli-highlight').highlight
  supportsLanguage: typeof import('cli-highlight').supportsLanguage
}

// 一个由 Fallback.tsx、markdown.ts、events.ts、getLanguageName 共享的 promise。
let cliHighlightPromise: Promise<CliHighlight | null> | undefined

let loadedGetLanguage:
  | ((name: string) => { name?: string } | undefined)
  | undefined

async function loadCliHighlight(): Promise<CliHighlight | null> {
  try {
    const cliHighlight = await import('cli-highlight')
    // highlight.js CJS 互操作：`export =` 在 ESM 下包装为 .default
    const hljsMod = hljs as {
      getLanguage?: typeof loadedGetLanguage
      default?: typeof hljs
    }
    loadedGetLanguage = hljsMod.getLanguage ?? hljsMod.default?.getLanguage
    return {
      highlight: cliHighlight.highlight,
      supportsLanguage: cliHighlight.supportsLanguage,
    }
  } catch {
    return null
  }
}

export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  cliHighlightPromise ??= loadCliHighlight()
  return cliHighlightPromise
}

/**
 * 例如 "foo/bar.ts" → "TypeScript"。等待共享的 cli-highlight 加载，
 * 然后读取 highlight.js 的语言注册表。所有调用方仅用于遥测
 *（OTel 计数器属性、权限对话框一元事件）—— 都不会阻塞于此，
 * 它们 fire-and-forget 或消费者已处理 Promise<string>。
 */
export async function getLanguageName(file_path: string): Promise<string> {
  await getCliHighlightPromise()
  const ext = extname(file_path).slice(1)
  if (!ext) return 'unknown'
  return loadedGetLanguage?.(ext)?.name ?? 'unknown'
}
