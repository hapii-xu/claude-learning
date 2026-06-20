/**
 * 针对 fix 的测试：修复穷鬼模式的写入问题
 *
 * 修复前，poorMode 是内存中的布尔值，重启时会重置。
 * 修复后，通过 getInitialSettings() 和 updateSettingsForSource()
 * 从 settings.json 读取 / 写入。
 */
import { afterAll, describe, expect, test, beforeEach, mock } from 'bun:test'
import * as settingsModule from '../../../utils/settings/settings.js'

// ── Mock 必须在被测模块导入之前声明 ──────────

let mockSettings: Record<string, unknown> = {}
let lastUpdate: { source: string; patch: Record<string, unknown> } | null = null

mock.module('src/utils/settings/settings.js', () => ({
  loadManagedFileSettings: () => ({ settings: null, errors: [] }),
  getManagedFileSettingsPresence: () => ({
    hasBase: false,
    hasDropIns: false,
  }),
  parseSettingsFile: () => ({ settings: null, errors: [] }),
  getSettingsRootPathForSource: () => '',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => '',
  getInitialSettings: () => mockSettings,
  getSettingsForSource: () => mockSettings,
  getPolicySettingsOrigin: () => null,
  getSettingsWithErrors: () => ({ settings: mockSettings, errors: [] }),
  getSettingsWithSources: () => ({ effective: mockSettings, sources: [] }),
  getSettings_DEPRECATED: () => mockSettings,
  settingsMergeCustomizer: () => undefined,
  getManagedSettingsKeysForLogging: () => [],
  // 保持未使用的导出与真实 settings 模块对齐，这样这个全量 mock 就
  // 不会在 Bun 将其保留存活时影响后续的测试文件。
  hasAutoModeOptIn: () => true,
  hasSkipDangerousModePermissionPrompt: () => false,
  getAutoModeConfig: () => undefined,
  getUseAutoModeDuringPlan: () => true,
  rawSettingsContainsKey: (key: string) => key in mockSettings,
  updateSettingsForSource: (source: string, patch: Record<string, unknown>) => {
    lastUpdate = { source, patch }
    mockSettings = { ...mockSettings, ...patch }
  },
}))

afterAll(() => {
  mock.restore()
  mock.module('src/utils/settings/settings.js', () => settingsModule)
})

// 在 mock 注册之后再导入。查询后缀让此文件拥有自己的模块实例，
// 因此跨文件的 poorMode.js mock 在 Bun 的共享覆盖率运行中
// 无法替换被测对象。
const poorModeModulePath = '../poorMode.js?poorModeTest'
const { isPoorModeActive, setPoorMode } = (await import(
  poorModeModulePath
)) as typeof import('../poorMode.js')

// ── 测试 ────────────────────────────────────────────────────────────────────

describe('isPoorModeActive — reads from settings on first call', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('returns false when settings has no poorMode key', () => {
    mockSettings = {}
    // 通过 setPoorMode 设置内部状态后再检查，强制重新读取
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('returns true when settings.poorMode === true', () => {
    mockSettings = { poorMode: true }
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)
  })
})

describe('setPoorMode — persists to settings', () => {
  beforeEach(() => {
    lastUpdate = null
  })

  test('setPoorMode(true) calls updateSettingsForSource with poorMode: true', () => {
    setPoorMode(true)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    expect(lastUpdate!.patch.poorMode).toBe(true)
  })

  test('setPoorMode(false) calls updateSettingsForSource with poorMode: undefined (removes key)', () => {
    setPoorMode(false)
    expect(lastUpdate).not.toBeNull()
    expect(lastUpdate!.source).toBe('userSettings')
    // false || undefined === undefined —— 应该移除该 key 以保持 settings 干净
    expect(lastUpdate!.patch.poorMode).toBeUndefined()
  })

  test('isPoorModeActive() reflects the value set by setPoorMode()', () => {
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })

  test('toggling multiple times stays consistent', () => {
    setPoorMode(true)
    setPoorMode(true)
    expect(isPoorModeActive()).toBe(true)

    setPoorMode(false)
    setPoorMode(false)
    expect(isPoorModeActive()).toBe(false)
  })
})
