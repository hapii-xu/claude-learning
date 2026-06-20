import type { Command } from '../../types/command.js'

// `/onboarding` 支持的子命令。
// - (无参数) | full       — 重新运行完整的首次启动流程
// - theme                  — 重新选择终端主题
// - trust                  — 重新确认工作区信任对话框
// - model                  — 打开模型选择器（委托给 /model）
// - mcp                    — 显示 MCP 服务器配置指引
// - status                 — 打印当前 onboarding 状态
//
// `/onboarding` 在官方 v2.1.123 中存在（字符串 + 遥测确认：
// `tengu_onboarding_step`、`hasCompletedOnboarding`、`lastOnboardingVersion`）。
// 我们暴露面向用户的入口，订阅者可以重新运行任意步骤。
const onboarding: Command = {
  type: 'local-jsx',
  name: 'onboarding',
  description: 'Re-run the first-run setup (theme, trust, model, MCP)',
  argumentHint: '[full|theme|trust|model|mcp|status]',
  isEnabled: () => true,
  isHidden: false,
  bridgeSafe: false,
  getBridgeInvocationError: () =>
    'onboarding requires the local interactive UI and is not bridge-safe',
  load: async () => {
    const m = await import('./launchOnboarding.js')
    return { call: m.callOnboarding }
  },
}

export default onboarding
