import { normalizeLanguageForSTT } from '../../hooks/useVoice.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isVoiceAvailable } from '../../voice/voiceModeEnabled.js'

const LANG_HINT_MAX_SHOWS = 2

export const call: LocalCommandCall = async args => {
  // 在允许进入语音模式前，先检查 kill-switch
  if (!isVoiceAvailable()) {
    return {
      type: 'text' as const,
      value: 'Voice mode is not available.',
    }
  }

  const currentSettings = getInitialSettings()
  const isCurrentlyEnabled = currentSettings.voiceEnabled === true
  const providerArg = args?.trim().toLowerCase()

  // 已启用时传入 provider 参数 —— 仅切换后端
  if (isCurrentlyEnabled && providerArg === 'doubao') {
    const result = updateSettingsForSource('userSettings', {
      voiceProvider: 'doubao',
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
    return {
      type: 'text' as const,
      value: `Voice mode switched to Doubao ASR. Hold ${key} to record.`,
    }
  }

  // 已启用时传入 provider 参数 —— 切换到 anthropic
  if (isCurrentlyEnabled && providerArg === 'anthropic') {
    const result = updateSettingsForSource('userSettings', {
      voiceProvider: 'anthropic',
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
    return {
      type: 'text' as const,
      value: `Voice mode switched to Anthropic STT. Hold ${key} to record.`,
    }
  }

  // 关闭 —— 无需任何检查
  if (isCurrentlyEnabled) {
    const result = updateSettingsForSource('userSettings', {
      voiceEnabled: false,
    })
    if (result.error) {
      return {
        type: 'text' as const,
        value:
          'Failed to update settings. Check your settings file for syntax errors.',
      }
    }
    settingsChangeDetector.notifyChange('userSettings')
    logEvent('tengu_voice_toggled', { enabled: false })
    return {
      type: 'text' as const,
      value: 'Voice mode disabled.',
    }
  }

  // 开启 —— 根据参数或默认值确定 provider
  const provider = providerArg === 'doubao' ? 'doubao' : 'anthropic'

  // 执行预检
  const { isVoiceStreamAvailable } = await import(
    '../../services/voiceStreamSTT.js'
  )
  const { checkRecordingAvailability } = await import('../../services/voice.js')

  // 检查录音可用性（麦克风访问）
  const recording = await checkRecordingAvailability()
  if (!recording.available) {
    return {
      type: 'text' as const,
      value:
        recording.reason ?? 'Voice mode is not available in this environment.',
    }
  }

  // 检查 API key（仅 Anthropic 后端需要 —— Doubao 使用自己的凭据）
  if (provider !== 'doubao' && !isVoiceStreamAvailable()) {
    return {
      type: 'text' as const,
      value:
        'Voice mode requires a Claude.ai account. Please run /login to sign in.',
    }
  }

  // 检查录音工具
  const { checkVoiceDependencies, requestMicrophonePermission } = await import(
    '../../services/voice.js'
  )
  const deps = await checkVoiceDependencies()
  if (!deps.available) {
    const hint = deps.installCommand
      ? `\nInstall audio recording tools? Run: ${deps.installCommand}`
      : '\nInstall SoX manually for audio recording.'
    return {
      type: 'text' as const,
      value: `No audio recording tool found.${hint}`,
    }
  }

  // 提前探测麦克风权限，让操作系统的权限弹窗现在就出现，
  // 而不是等用户第一次按住说话键时才弹出。
  if (!(await requestMicrophonePermission())) {
    let guidance: string
    if (process.platform === 'win32') {
      guidance = 'Settings \u2192 Privacy \u2192 Microphone'
    } else if (process.platform === 'linux') {
      guidance = "your system's audio settings"
    } else {
      guidance = 'System Settings \u2192 Privacy & Security \u2192 Microphone'
    }
    return {
      type: 'text' as const,
      value: `Microphone access is denied. To enable it, go to ${guidance}, then run /voice again.`,
    }
  }

  // 所有检查都通过 —— 启用语音并指定 provider
  const result = updateSettingsForSource('userSettings', {
    voiceEnabled: true,
    ...(provider === 'doubao' ? { voiceProvider: 'doubao' } : {}),
  })
  if (result.error) {
    return {
      type: 'text' as const,
      value:
        'Failed to update settings. Check your settings file for syntax errors.',
    }
  }
  settingsChangeDetector.notifyChange('userSettings')
  logEvent('tengu_voice_toggled', { enabled: true })
  const key = getShortcutDisplay('voice:pushToTalk', 'Chat', 'Space')
  let langNote = ''
  const providerLabel = provider === 'doubao' ? 'Doubao ASR' : 'Anthropic'
  // Doubao 后端原生支持所有语言 —— 跳过语言提示
  if (provider !== 'doubao') {
    const stt = normalizeLanguageForSTT(currentSettings.language)
    const cfg = getGlobalConfig()
    const langChanged = cfg.voiceLangHintLastLanguage !== stt.code
    const priorCount = langChanged ? 0 : (cfg.voiceLangHintShownCount ?? 0)
    const showHint = !stt.fellBackFrom && priorCount < LANG_HINT_MAX_SHOWS
    if (stt.fellBackFrom) {
      langNote = ` Note: "${stt.fellBackFrom}" is not a supported dictation language; using English. Change it via /config.`
    } else if (showHint) {
      langNote = ` Dictation language: ${stt.code} (/config to change).`
    }
    if (langChanged || showHint) {
      saveGlobalConfig(prev => ({
        ...prev,
        voiceLangHintShownCount: priorCount + (showHint ? 1 : 0),
        voiceLangHintLastLanguage: stt.code,
      }))
    }
  }
  return {
    type: 'text' as const,
    value: `Voice mode enabled (${providerLabel}). Hold ${key} to record.${langNote}`,
  }
}
