/**
 * 内置插件初始化
 *
 * 初始化随 CLI 一起提供的内置插件，它们会出现在 /plugin UI
 * 中供用户启用/禁用。
 *
 * 并非所有捆绑功能都应该是内置插件——仅对用户应该能够
 * 显式启用/禁用的功能使用此机制。对于具有复杂设置或
 * 自动启用逻辑的功能（例如 claude-in-chrome），请使用
 * src/skills/bundled/ 代替。
 *
 * 添加新的内置插件的步骤：
 * 1. 从 '../builtinPlugins.js' 导入 registerBuiltinPlugin
 * 2. 在此处使用插件定义调用 registerBuiltinPlugin()
 */

import { registerWeixinBuiltinPlugin } from './weixin.js'

/**
 * 初始化内置插件。在 CLI 启动时调用。
 */
export function initBuiltinPlugins(): void {
  registerWeixinBuiltinPlugin()
}
