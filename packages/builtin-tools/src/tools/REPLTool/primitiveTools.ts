import type { Tool } from 'src/Tool.js'
import { AgentTool } from '../AgentTool/AgentTool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'
import { NotebookEditTool } from '../NotebookEditTool/NotebookEditTool.js'

let _primitiveTools: readonly Tool[] | undefined

/**
 * REPL 模式开启时从模型直接调用中隐藏的原始工具
 * （REPL_ONLY_TOOLS），但仍可在 REPL VM 上下文中访问。
 * 导出以便显示侧代码（collapseReadSearch、渲染器）即使在这些工具
 * 不在过滤后的执行工具列表中时，仍能分类/渲染这些工具的虚拟消息。
 *
 * 惰性 getter——导入链 collapseReadSearch.ts → primitiveTools.ts
 * → FileReadTool.tsx → ... 会循环回工具注册表，因此
 * 顶层 const 会触发 "Cannot access before initialization"。延迟到
 * 调用时执行可避免 TDZ。
 *
 * 直接引用而非通过 getAllBaseTools()，因为后者在
 * hasEmbeddedSearchTools() 为 true 时会排除 Glob/Grep。
 */
export function getReplPrimitiveTools(): readonly Tool[] {
  return (_primitiveTools ??= [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
    NotebookEditTool,
    AgentTool,
  ])
}
