/**
 * Anthropic 官方插件市场的常量。
 *
 * 官方市场托管在 GitHub 上，提供由 Anthropic 开发的第一方插件。
 * 本文件定义了安装和识别该市场所需的常量。
 */

import type { MarketplaceSource } from './schemas.js'

/**
 * 官方 Anthropic 插件市场的源配置。
 * 在启动时自动安装市场时使用。
 */
export const OFFICIAL_MARKETPLACE_SOURCE = {
  source: 'github',
  repo: 'anthropics/claude-plugins-official',
} as const satisfies MarketplaceSource

/**
 * 官方市场的显示名称。
 * 这是市场在 known_marketplaces.json 文件中注册时使用的名称。
 */
export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'
