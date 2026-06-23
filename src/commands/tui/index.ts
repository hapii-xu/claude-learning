import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { Command, LocalCommandResult } from '../../types/command.js'

/**
 * TUI 模式标记文件的路径。
 *
 * 当此文件存在时，表示用户已启用无闪烁 TUI 模式
 * （通过 CLAUDE_CODE_NO_FLICKER=1 进入备用屏幕缓冲）。该标记与会话无关：
 * 它在多次重启之间持久存在，因此用户只需运行一次 `/tui on` 即可。
 *
 * Shell profile 集成：将以下内容添加到 ~/.bashrc / ~/.zshrc，
 * 即可在标记存在时自动启用 TUI 模式：
 *
 *   [ -f "$HOME/.hclaude/.tui-mode" ] && export CLAUDE_CODE_NO_FLICKER=1
 *
 * 注意：运行时设置 CLAUDE_CODE_NO_FLICKER 无法追溯进入备用屏幕缓冲 ——
 * Ink 渲染树已经挂载完毕。该改动要到「下一次会话启动」时才会生效。
 */
export function getTuiMarkerPath(): string {
  return join(getClaudeConfigHomeDir(), '.tui-mode')
}

/**
 * 当 TUI 模式标记文件存在时返回 true，表示用户已启用无闪烁的备用屏幕渲染。
 */
export function isTuiModeEnabled(): boolean {
  return existsSync(getTuiMarkerPath())
}

const USAGE_TEXT = [
  'Usage: /tui [subcommand]',
  '',
  '  (no args)   Toggle flicker-free TUI mode (alternate screen buffer)',
  '  on          Enable TUI mode',
  '  off         Disable TUI mode',
  '  status      Show current TUI mode state',
  '',
  'TUI mode uses the ANSI alternate screen buffer (\\x1b[?1049h) so the',
  'Claude Code UI occupies a clean full-screen area with no scroll-back',
  'flicker.  The setting is stored in ~/.hclaude/.tui-mode and takes effect',
  'on the next session start.',
  '',
  'Shell-profile integration (auto-enable on every start):',
  '  [ -f "$HOME/.hclaude/.tui-mode" ] && export CLAUDE_CODE_NO_FLICKER=1',
  '',
  'Environment override:',
  '  CLAUDE_CODE_NO_FLICKER=1   force on (overrides marker)',
  '  CLAUDE_CODE_NO_FLICKER=0   force off (overrides marker)',
].join('\n')

function enableTui(): LocalCommandResult {
  const markerPath = getTuiMarkerPath()
  mkdirSync(getClaudeConfigHomeDir(), { recursive: true })
  writeFileSync(markerPath, new Date().toISOString(), 'utf8')
  return {
    type: 'text',
    value: [
      '## TUI mode enabled',
      '',
      `Marker written: \`${markerPath}\``,
      '',
      'Flicker-free alternate-screen rendering will be active on the next',
      'session start.  Add this to your shell profile to make it permanent:',
      '',
      '  [ -f "$HOME/.hclaude/.tui-mode" ] && export CLAUDE_CODE_NO_FLICKER=1',
      '',
      'To disable: `/tui off`',
    ].join('\n'),
  }
}

function disableTui(): LocalCommandResult {
  const markerPath = getTuiMarkerPath()
  if (!existsSync(markerPath)) {
    return {
      type: 'text',
      value: 'TUI mode was not active.',
    }
  }
  unlinkSync(markerPath)
  return {
    type: 'text',
    value: [
      '## TUI mode disabled',
      '',
      `Marker removed: \`${markerPath}\``,
      '',
      'Standard (non-alternate-screen) rendering will be used on the next',
      'session start.',
      '',
      'To re-enable: `/tui on`',
    ].join('\n'),
  }
}

export async function callTui(args: string): Promise<LocalCommandResult> {
  const sub = args.trim().toLowerCase()

  // ── 状态查询 ──────────────────────────────────────────────────────────
  if (sub === 'status') {
    const enabled = isTuiModeEnabled()
    const markerPath = getTuiMarkerPath()
    const envVal = process.env.CLAUDE_CODE_NO_FLICKER
    let envLine: string
    if (envVal === '1' || envVal === 'true') {
      envLine = 'CLAUDE_CODE_NO_FLICKER=1 (forced on via env var)'
    } else if (envVal === '0' || envVal === 'false') {
      envLine = 'CLAUDE_CODE_NO_FLICKER=0 (forced off via env var)'
    } else {
      envLine = 'CLAUDE_CODE_NO_FLICKER not set'
    }
    return {
      type: 'text',
      value: [
        '## TUI Mode Status',
        '',
        `  Marker file:  ${enabled ? 'present' : 'absent'} (\`${markerPath}\`)`,
        `  Mode:         ${enabled ? 'enabled' : 'disabled'}`,
        `  Env var:      ${envLine}`,
        '',
        'Note: changes take effect on the next session start.',
      ].join('\n'),
    }
  }

  // ── on（启用）──
  if (sub === 'on') {
    return enableTui()
  }

  // ── off（禁用）──
  if (sub === 'off') {
    return disableTui()
  }

  // ── toggle（历史默认行为）──
  if (sub === '' || sub === 'toggle') {
    return isTuiModeEnabled() ? disableTui() : enableTui()
  }

  // ── 未知子命令 ──
  return {
    type: 'text',
    value: [`Unknown subcommand: "${sub}"`, '', USAGE_TEXT].join('\n'),
  }
}

const tuiCommand: Command = {
  type: 'local-jsx',
  name: 'tui',
  description:
    'Manage flicker-free TUI mode. Open actions or run: status, on, off, toggle',
  isHidden: false,
  isEnabled: () => !getIsNonInteractiveSession(),
  argumentHint: '[status|on|off|toggle]',
  bridgeSafe: true,
  getBridgeInvocationError: args =>
    args.trim()
      ? undefined
      : 'Use /tui status/on/off/toggle over Remote Control.',
  load: () => import('./panel.js'),
}

export const tuiNonInteractive: Command = {
  type: 'local',
  name: 'tui',
  description:
    'Toggle flicker-free TUI mode (alternate screen buffer). Subcommands: on, off, status',
  isHidden: false,
  isEnabled: () => getIsNonInteractiveSession(),
  supportsNonInteractive: true,
  bridgeSafe: true,
  load: async () => ({
    call: callTui,
  }),
}

export default tuiCommand
