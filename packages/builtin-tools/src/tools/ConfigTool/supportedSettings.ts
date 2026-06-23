import { feature } from 'bun:bundle'
import { getRemoteControlAtStartup } from 'src/utils/config.js'
import {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
  TEAMMATE_MODES,
} from 'src/utils/configConstants.js'
import { getModelOptions } from 'src/utils/model/modelOptions.js'
import { validateModel } from 'src/utils/model/validateModel.js'
import { THEME_NAMES, THEME_SETTINGS } from 'src/utils/theme.js'

/** 可以被同步以即时影响 UI 的 AppState 键 */
type SyncableAppStateKey = 'verbose' | 'mainLoopModel' | 'thinkingEnabled'

type SettingConfig = {
  source: 'global' | 'settings'
  type: 'boolean' | 'string'
  description: string
  path?: string[]
  options?: readonly string[]
  getOptions?: () => string[]
  appStateKey?: SyncableAppStateKey
  /** 在写入/设置值时调用的异步校验 */
  validateOnWrite?: (v: unknown) => Promise<{ valid: boolean; error?: string }>
  /** 读取/获取值时用于展示的格式化函数 */
  formatOnRead?: (v: unknown) => unknown
}

export const SUPPORTED_SETTINGS: Record<string, SettingConfig> = {
  theme: {
    source: 'global',
    type: 'string',
    description: 'UI 的颜色主题',
    options: feature('AUTO_THEME') ? THEME_SETTINGS : THEME_NAMES,
  },
  editorMode: {
    source: 'global',
    type: 'string',
    description: '键位绑定模式',
    options: EDITOR_MODES,
  },
  verbose: {
    source: 'global',
    type: 'boolean',
    description: '显示详细的调试输出',
    appStateKey: 'verbose',
  },
  preferredNotifChannel: {
    source: 'global',
    type: 'string',
    description: '首选的通知渠道',
    options: NOTIFICATION_CHANNELS,
  },
  autoCompactEnabled: {
    source: 'global',
    type: 'boolean',
    description: '上下文占满时自动压缩',
  },
  autoMemoryEnabled: {
    source: 'settings',
    type: 'boolean',
    description: '启用自动记忆',
  },
  autoDreamEnabled: {
    source: 'settings',
    type: 'boolean',
    description: '启用后台记忆整合',
  },
  fileCheckpointingEnabled: {
    source: 'global',
    type: 'boolean',
    description: '启用文件检查点，用于代码回溯',
  },
  showTurnDuration: {
    source: 'global',
    type: 'boolean',
    description:
      '在响应后显示轮次耗时消息（例如 "Cooked for 1m 6s"）',
  },
  terminalProgressBarEnabled: {
    source: 'global',
    type: 'boolean',
    description: '在受支持的终端中显示 OSC 9;4 进度指示器',
  },
  todoFeatureEnabled: {
    source: 'global',
    type: 'boolean',
    description: '启用 todo/任务跟踪',
  },
  model: {
    source: 'settings',
    type: 'string',
    description: '覆盖默认模型',
    appStateKey: 'mainLoopModel',
    getOptions: () => {
      try {
        return getModelOptions()
          .filter(o => o.value !== null)
          .map(o => o.value as string)
      } catch {
        return ['sonnet', 'opus', 'haiku']
      }
    },
    validateOnWrite: v => validateModel(String(v)),
    formatOnRead: v => (v === null ? 'default' : v),
  },
  alwaysThinkingEnabled: {
    source: 'settings',
    type: 'boolean',
    description: '启用扩展思考（设为 false 则禁用）',
    appStateKey: 'thinkingEnabled',
  },
  'permissions.defaultMode': {
    source: 'settings',
    type: 'string',
    description: '工具使用的默认权限模式',
    options: feature('TRANSCRIPT_CLASSIFIER')
      ? ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto']
      : ['default', 'plan', 'acceptEdits', 'dontAsk'],
  },
  language: {
    source: 'settings',
    type: 'string',
    description:
      'Claude 回复与语音听写的首选语言（例如 "japanese"、"spanish"）',
  },
  teammateMode: {
    source: 'global',
    type: 'string',
    description:
      '如何拉起 teammates："tmux" 使用传统 tmux，"in-process" 在同进程中运行，"auto" 自动选择',
    options: TEAMMATE_MODES,
  },
  ...(process.env.USER_TYPE === 'ant'
    ? {
        classifierPermissionsEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description:
            '为 Bash(prompt:...) 权限规则启用基于 AI 的分类',
        },
      }
    : {}),
  ...(feature('VOICE_MODE')
    ? {
        voiceEnabled: {
          source: 'settings' as const,
          type: 'boolean' as const,
          description: '启用语音听写（长按说话）',
        },
      }
    : {}),
  ...(feature('BRIDGE_MODE')
    ? {
        remoteControlAtStartup: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            '为所有会话启用 Remote Control（true | false | default）',
          formatOnRead: () => getRemoteControlAtStartup(),
        },
      }
    : {}),
  ...(feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? {
        taskCompleteNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            'Claude 完成任务并空闲时向你的移动设备推送（需要 Remote Control）',
        },
        inputNeededNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            '当有权限提示或问题等待你处理时向移动设备推送（需要 Remote Control）',
        },
        agentPushNotifEnabled: {
          source: 'global' as const,
          type: 'boolean' as const,
          description:
            '允许 Claude 在其认为合适时向你的移动设备推送（需要 Remote Control）',
        },
      }
    : {}),
}

export function isSupported(key: string): boolean {
  return key in SUPPORTED_SETTINGS
}

export function getConfig(key: string): SettingConfig | undefined {
  return SUPPORTED_SETTINGS[key]
}

export function getAllKeys(): string[] {
  return Object.keys(SUPPORTED_SETTINGS)
}

export function getOptionsForSetting(key: string): string[] | undefined {
  const config = SUPPORTED_SETTINGS[key]
  if (!config) return undefined
  if (config.options) return [...config.options]
  if (config.getOptions) return config.getOptions()
  return undefined
}

export function getPath(key: string): string[] {
  const config = SUPPORTED_SETTINGS[key]
  return config?.path ?? key.split('.')
}
