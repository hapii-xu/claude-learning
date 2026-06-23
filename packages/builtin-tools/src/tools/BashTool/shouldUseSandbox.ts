import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { splitCommand_DEPRECATED } from 'src/utils/bash/commands.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import {
  BINARY_HIJACK_VARS,
  bashPermissionRule,
  matchWildcardPattern,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
} from './bashPermissions.js'

type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}

// 注意：excludedCommands 是面向用户的便利特性，并非安全边界。
// 能够绕过 excludedCommands 并不属于安全漏洞——真正的安全控制是
// 沙箱权限系统（会向用户弹出批准提示）。
function containsExcludedCommand(command: string): boolean {
  // 检查动态配置中禁用的命令与子串（仅限 ant 用户）
  if (process.env.USER_TYPE === 'ant') {
    const disabledCommands = getFeatureValue_CACHED_MAY_BE_STALE<{
      commands: string[]
      substrings: string[]
    }>('tengu_sandbox_disabled_commands', { commands: [], substrings: [] })

    // 检查命令是否包含任意被禁用的子串
    for (const substring of disabledCommands.substrings) {
      if (command.includes(substring)) {
        return true
      }
    }

    // 检查命令是否以任意被禁用的命令开头
    try {
      const commandParts = splitCommand_DEPRECATED(command)
      for (const part of commandParts) {
        const baseCommand = part.trim().split(' ')[0]
        if (baseCommand && disabledCommands.commands.includes(baseCommand)) {
          return true
        }
      }
    } catch {
      // 若无法解析该命令（例如 bash 语法格式错误），
      // 则视为未排除，以便交由其他校验检查处理，
      // 这样可避免渲染 tool use 消息时崩溃
    }
  }

  // 检查 settings 中用户配置的排除命令
  const settings = getSettings_DEPRECATED()
  const userExcludedCommands = settings.sandbox?.excludedCommands ?? []

  if (userExcludedCommands.length === 0) {
    return false
  }

  // 将复合命令（例如 "docker ps && curl evil.com"）拆分为单条
  // 子命令，并逐条与排除模式匹配。这样可避免复合命令仅因其第一条
  // 子命令命中排除模式而整体逃出沙箱。
  let subcommands: string[]
  try {
    subcommands = splitCommand_DEPRECATED(command)
  } catch {
    subcommands = [command]
  }

  for (const subcommand of subcommands) {
    const trimmed = subcommand.trim()
    // 同时尝试剥离环境变量前缀和包装命令后再匹配，
    // 这样 `FOO=bar bazel ...` 与 `timeout 30 bazel ...` 也能命中 `bazel:*`。
    // 这并非安全边界（见上方 NOTE）；上方的 &&-split 已经能让
    // `export FOO=bar && bazel ...` 匹配。保留 BINARY_HIJACK_VARS 作为启发式判断。
    //
    // 我们迭代地同时应用两种剥离操作，直到不再产生新候选为止（不动点），
    // 与 filterRulesByContentsMatchingInput 的做法一致。
    // 这可以处理 `timeout 300 FOO=bar bazel run` 这种交错模式，
    // 而单次组合剥离无法处理。
    const candidates = [trimmed]
    const seen = new Set(candidates)
    let startIdx = 0
    while (startIdx < candidates.length) {
      const endIdx = candidates.length
      for (let i = startIdx; i < endIdx; i++) {
        const cmd = candidates[i]!
        const envStripped = stripAllLeadingEnvVars(cmd, BINARY_HIJACK_VARS)
        if (!seen.has(envStripped)) {
          candidates.push(envStripped)
          seen.add(envStripped)
        }
        const wrapperStripped = stripSafeWrappers(cmd)
        if (!seen.has(wrapperStripped)) {
          candidates.push(wrapperStripped)
          seen.add(wrapperStripped)
        }
      }
      startIdx = endIdx
    }

    for (const pattern of userExcludedCommands) {
      const rule = bashPermissionRule(pattern)
      for (const cand of candidates) {
        switch (rule.type) {
          case 'prefix':
            if (cand === rule.prefix || cand.startsWith(rule.prefix + ' ')) {
              return true
            }
            break
          case 'exact':
            if (cand === rule.command) {
              return true
            }
            break
          case 'wildcard':
            if (matchWildcardPattern(rule.pattern, cand)) {
              return true
            }
            break
        }
      }
    }
  }

  return false
}

export function shouldUseSandbox(input: Partial<SandboxInput>): boolean {
  if (!SandboxManager.isSandboxingEnabled()) {
    return false
  }

  // 若显式禁用沙箱且策略允许非沙箱命令，则不放入沙箱
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  if (!input.command) {
    return false
  }

  // 若命令包含用户配置的排除命令，则不放入沙箱
  if (containsExcludedCommand(input.command)) {
    return false
  }

  return true
}
