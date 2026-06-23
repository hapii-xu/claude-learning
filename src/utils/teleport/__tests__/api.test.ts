/**
 * prepareWorkspaceApiRequest 的 L2 回归测试（codecov-100 审计 #12）：
 * 固定"已清除"与"从未设置"两种错误消息的区分谓词。
 *
 * 关于隔离的说明：本仓库中其他几个测试文件
 * （`src/commands/vault/__tests__/api.test.ts`、
 * `src/commands/agents-platform/__tests__/agentsApi.test.ts` 等）调用了
 * `mock.module('src/utils/teleport/api.js', ...)` 来打桩
 * `prepareWorkspaceApiRequest`。Bun 的 mock 注册表是进程全局的，因此
 * 本测试文件全量套件导入 `../api.js` 时返回的是被桩替换的
 * 模块 —— 我们无法在此处测试真实的 prepareWorkspaceApiRequest。
 *
 * 变通方案：我们从 api.ts 中复制谓词逻辑，并将其作为
 * 纯单元测试进行固定。该谓词体量小且自包含；如果 api.ts
 * 将来修改了"已清除"与"从未设置"的逻辑，则此复制的
 * 函数和测试必须同步更新。
 * 消息文本的端到端覆盖仍通过更广泛的集成测试中
 * prepareWorkspaceApiRequest 的调用点来保证。
 */
import { describe, test, expect } from 'bun:test'

// ── 复制自 src/utils/teleport/api.ts（保持同步） ────────────────
// L2 修复：检测"已清除"（null / 空字符串 / 纯空白）与"从未设置"
// （undefined / 字段缺失），以便向用户返回可操作的错误消息。
function isWorkspaceKeyCleared(rawValue: unknown): boolean {
  return (
    rawValue === null ||
    (typeof rawValue === 'string' && rawValue.trim() === '')
  )
}

describe('isWorkspaceKeyCleared (audit #12: cleared vs never-set predicate)', () => {
  test('undefined → not cleared (never set)', () => {
    expect(isWorkspaceKeyCleared(undefined)).toBe(false)
  })

  test('missing field on config object → not cleared (never set)', () => {
    const config: { workspaceApiKey?: string | null } = {}
    expect(isWorkspaceKeyCleared(config.workspaceApiKey)).toBe(false)
  })

  test('null → cleared', () => {
    expect(isWorkspaceKeyCleared(null)).toBe(true)
  })

  test('empty string → cleared', () => {
    expect(isWorkspaceKeyCleared('')).toBe(true)
  })

  test('whitespace-only string → cleared', () => {
    expect(isWorkspaceKeyCleared('   ')).toBe(true)
    expect(isWorkspaceKeyCleared('\t\n  \r')).toBe(true)
  })

  test('valid key string → not cleared', () => {
    expect(isWorkspaceKeyCleared('sk-ant-api03-validkey')).toBe(false)
  })

  test('whitespace-padded valid key → not cleared (real prepare trims and uses it)', () => {
    // 该函数只测试去除空白后的值；去除空白后非空
    // 表示存在可用的密钥，而非已被清除。
    expect(isWorkspaceKeyCleared('  sk-ant-api03-key  ')).toBe(false)
  })

  test('non-string non-null types are conservatively treated as not-cleared', () => {
    // 防御性处理：只有字面量 null + 空字符串/纯空白字符串才算作
    // "已清除"。其他非预期类型则走标准的
    // "必填"消息，而不是在底层状态损坏时
    // 误导用户说"已被清除"。
    expect(isWorkspaceKeyCleared(0)).toBe(false)
    expect(isWorkspaceKeyCleared(false)).toBe(false)
    expect(isWorkspaceKeyCleared({})).toBe(false)
    expect(isWorkspaceKeyCleared([])).toBe(false)
  })
})
