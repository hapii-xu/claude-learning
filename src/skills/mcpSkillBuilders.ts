import type {
  createSkillCommand,
  parseSkillFrontmatterFields,
} from './loadSkillsDir.js'

/**
 * MCP 技能发现所需的两个 loadSkillsDir 函数的一次性写入注册表。
 * 此模块是依赖图叶子节点：它仅导入类型，因此 mcpSkills.ts 和
 * loadSkillsDir.ts 都可以依赖它而不形成循环
 * （client.ts → mcpSkills.ts → loadSkillsDir.ts → … → client.ts）。
 *
 * 非字面量动态导入方法（"await import(variable)"）在 Bun 打包的
 * 二进制文件中会在运行时失败——说明符会针对 chunk 的
 * /$bunfs/root/… 路径解析，而非原始源树，产生 "Cannot find
 * module './loadSkillsDir.js'"。字面量动态导入在 bunfs 中有效，
 * 但 dependency-cruiser 会跟踪它，并且由于 loadSkillsDir 传递性
 * 地几乎触及所有内容，单个新边在 diff 检查中会扇出成许多新的
 * 循环违规。
 *
 * 注册发生在 loadSkillsDir.ts 模块初始化时，该模块在启动时通过
 * commands.ts 的静态导入被急切求值——远早于任何 MCP 服务器连接。
 */

export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) {
    throw new Error(
      'MCP skill builders not registered — loadSkillsDir.ts has not been evaluated yet',
    )
  }
  return builders
}
