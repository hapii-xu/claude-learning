import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import {
  type GlobalConfig,
  getGlobalConfig,
  getRemoteControlAtStartup,
  saveGlobalConfig,
} from 'src/utils/config.js'
import { errorMessage } from 'src/utils/errors.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { logError } from 'src/utils/log.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from 'src/utils/settings/settings.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { CONFIG_TOOL_NAME } from './constants.js'
import { DESCRIPTION, generatePrompt } from './prompt.js'
import {
  getConfig,
  getOptionsForSetting,
  getPath,
  isSupported,
} from './supportedSettings.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    setting: z
      .string()
      .describe(
        '配置项键名（例如："theme"、"model"、"permissions.defaultMode"）',
      ),
    value: z
      .union([z.string(), z.boolean(), z.number()])
      .optional()
      .describe('新值。省略以获取当前值。'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean(),
    operation: z.enum(['get', 'set']).optional(),
    setting: z.string().optional(),
    value: z.unknown().optional(),
    previousValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>

export const ConfigTool = buildTool({
  name: CONFIG_TOOL_NAME,
  searchHint: '获取或设置 Claude Code 配置项（主题、模型等）',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return generatePrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Config'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input: Input) {
    return input.value === undefined
  },
  toAutoClassifierInput(input) {
    return input.value === undefined
      ? input.setting
      : `${input.setting} = ${input.value}`
  },
  async checkPermissions(input: Input) {
    // 自动允许读取配置
    if (input.value === undefined) {
      return { behavior: 'allow' as const, updatedInput: input }
    }
    return {
      behavior: 'ask' as const,
      message: `将 ${input.setting} 设置为 ${jsonStringify(input.value)}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  async call({ setting, value }: Input, context): Promise<{ data: Output }> {
    // 1. 检查该 setting 是否受支持
    // 语音相关 setting 在构建期注册（feature('VOICE_MODE')），但在运行期
    // 还需再做一次门控。当 kill-switch 打开时，把 voiceEnabled 当作未知
    // setting 处理，以免泄露任何语音相关的字符串。
    if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
      const { isVoiceGrowthBookEnabled } = await import(
        'src/voice/voiceModeEnabled.js'
      )
      if (!isVoiceGrowthBookEnabled()) {
        return {
          data: { success: false, error: `未知配置项："${setting}"` },
        }
      }
    }
    if (!isSupported(setting)) {
      return {
        data: { success: false, error: `未知配置项："${setting}"` },
      }
    }

    const config = getConfig(setting)!
    const path = getPath(setting)

    // 2. GET 操作
    if (value === undefined) {
      const currentValue = getValue(config.source, path)
      const displayValue = config.formatOnRead
        ? config.formatOnRead(currentValue)
        : currentValue
      return {
        data: { success: true, operation: 'get', setting, value: displayValue },
      }
    }

    // 3. SET 操作

    // 处理 "default"——取消该 config 键的设置，使其回落到
    // 平台相关的默认值（由 bridge feature 门控决定）。
    if (
      setting === 'remoteControlAtStartup' &&
      typeof value === 'string' &&
      value.toLowerCase().trim() === 'default'
    ) {
      saveGlobalConfig(prev => {
        if (prev.remoteControlAtStartup === undefined) return prev
        const next = { ...prev }
        delete next.remoteControlAtStartup
        return next
      })
      const resolved = getRemoteControlAtStartup()
      // 同步到 AppState，使 useReplBridge 立即响应
      context.setAppState(prev => {
        if (prev.replBridgeEnabled === resolved && !prev.replBridgeOutboundOnly)
          return prev
        return {
          ...prev,
          replBridgeEnabled: resolved,
          replBridgeOutboundOnly: false,
        }
      })
      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          value: resolved,
        },
      }
    }

    let finalValue: unknown = value

    // 强制转换并校验布尔值
    if (config.type === 'boolean') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim()
        if (lower === 'true') finalValue = true
        else if (lower === 'false') finalValue = false
      }
      if (typeof finalValue !== 'boolean') {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: `${setting} 需要 true 或 false。`,
          },
        }
      }
    }

    // 校验可选值
    const options = getOptionsForSetting(setting)
    if (options && !options.includes(String(finalValue))) {
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: `无效值 "${value}"。可选项：${options.join(', ')}`,
        },
      }
    }

    // 异步校验（例如模型 API 检查）
    if (config.validateOnWrite) {
      const result = await config.validateOnWrite(finalValue)
      if (!result.valid) {
        return {
          data: {
            success: false,
            operation: 'set',
            setting,
            error: result.error,
          },
        }
      }
    }

    // 语音模式的预检
    if (
      feature('VOICE_MODE') &&
      setting === 'voiceEnabled' &&
      finalValue === true
    ) {
      const { isVoiceModeEnabled } = await import(
        'src/voice/voiceModeEnabled.js'
      )
      if (!isVoiceModeEnabled()) {
        const { isAnthropicAuthEnabled } = await import('src/utils/auth.js')
        return {
          data: {
            success: false,
            error: !isAnthropicAuthEnabled()
              ? '语音模式需要 Claude.ai 账户，请运行 /login 登录。'
              : '语音模式不可用。',
          },
        }
      }
      const { isVoiceStreamAvailable } = await import(
        'src/services/voiceStreamSTT.js'
      )
      const {
        checkRecordingAvailability,
        checkVoiceDependencies,
        requestMicrophonePermission,
      } = await import('src/services/voice.js')

      const recording = await checkRecordingAvailability()
      if (!recording.available) {
        return {
          data: {
            success: false,
            error:
              recording.reason ??
              '当前环境中语音模式不可用。',
          },
        }
      }
      if (!isVoiceStreamAvailable()) {
        return {
          data: {
            success: false,
            error:
              '语音模式需要 Claude.ai 账户，请运行 /login 登录。',
          },
        }
      }
      const deps = await checkVoiceDependencies()
      if (!deps.available) {
        return {
          data: {
            success: false,
            error:
              '未找到音频录制工具。' +
              (deps.installCommand ? ` 请运行：${deps.installCommand}` : ''),
          },
        }
      }
      if (!(await requestMicrophonePermission())) {
        let guidance: string
        if (process.platform === 'win32') {
          guidance = '\u8bbe\u7f6e \u2192 \u9690\u79c1 \u2192 \u9ea6\u514b\u98ce'
        } else if (process.platform === 'linux') {
          guidance = '\u7cfb\u7edf\u97f3\u9891\u8bbe\u7f6e'
        } else {
          guidance =
            '\u7cfb\u7edf\u8bbe\u7f6e \u2192 \u9690\u79c1\u4e0e\u5b89\u5168 \u2192 \u9ea6\u514b\u98ce'
        }
        return {
          data: {
            success: false,
            error: `\u9ea6\u514b\u98ce\u8bbf\u95ee\u88ab\u62d2\u7edd\u3002\u8bf7\u524d\u5f80 ${guidance} \u542f\u7528\u540e\u91cd\u8bd5\u3002`,
          },
        }
      }
    }

    const previousValue = getValue(config.source, path)

    // 4. 写入存储
    try {
      if (config.source === 'global') {
        const key = path[0]
        if (!key) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: '无效的配置路径',
            },
          }
        }
        saveGlobalConfig(prev => {
          if (prev[key as keyof GlobalConfig] === finalValue) return prev
          return { ...prev, [key]: finalValue }
        })
      } else {
        const update = buildNestedObject(path, finalValue)
        const result = updateSettingsForSource('userSettings', update)
        if (result.error) {
          return {
            data: {
              success: false,
              operation: 'set',
              setting,
              error: result.error.message,
            },
          }
        }
      }

      // 5a. 语音模式需要 notifyChange，以便 applySettingsChange 重新同步
      // AppState.settings（useVoiceEnabled 读取的是 settings.voiceEnabled），
      // 同时重置 settings 缓存以供下次 /voice 读取。
      if (feature('VOICE_MODE') && setting === 'voiceEnabled') {
        const { settingsChangeDetector } = await import(
          'src/utils/settings/changeDetector.js'
        )
        settingsChangeDetector.notifyChange('userSettings')
      }

      // 5b. 如有需要则同步到 AppState，以实现即时的 UI 效果
      if (config.appStateKey) {
        const appKey = config.appStateKey
        context.setAppState(prev => {
          if (prev[appKey] === finalValue) return prev
          return { ...prev, [appKey]: finalValue }
        })
      }

      // 将 remoteControlAtStartup 同步到 AppState，使 bridge 立即响应
      //（该 config 键名与 AppState 字段名不一致，因此通用的 appStateKey
      // 机制无法处理这种情况）。
      if (setting === 'remoteControlAtStartup') {
        const resolved = getRemoteControlAtStartup()
        context.setAppState(prev => {
          if (
            prev.replBridgeEnabled === resolved &&
            !prev.replBridgeOutboundOnly
          )
            return prev
          return {
            ...prev,
            replBridgeEnabled: resolved,
            replBridgeOutboundOnly: false,
          }
        })
      }

      logEvent('tengu_config_tool_changed', {
        setting:
          setting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        value: String(
          finalValue,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      return {
        data: {
          success: true,
          operation: 'set',
          setting,
          previousValue,
          newValue: finalValue,
        },
      }
    } catch (error) {
      logError(error)
      return {
        data: {
          success: false,
          operation: 'set',
          setting,
          error: errorMessage(error),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.success) {
      if (content.operation === 'get') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: `${content.setting} = ${jsonStringify(content.value)}`,
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `已将 ${content.setting} 设置为 ${jsonStringify(content.newValue)}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Error: ${content.error}`,
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

function getValue(source: 'global' | 'settings', path: string[]): unknown {
  if (source === 'global') {
    const config = getGlobalConfig()
    const key = path[0]
    if (!key) return undefined
    return config[key as keyof GlobalConfig]
  }
  const settings = getInitialSettings()
  let current: unknown = settings
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

function buildNestedObject(
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    return {}
  }
  const key = path[0]!
  if (path.length === 1) {
    return { [key]: value }
  }
  return { [key]: buildNestedObject(path.slice(1), value) }
}
