import { afterEach, describe, expect, test } from 'bun:test'

import type { PromptCommand } from '../../../types/command.js'
import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import { registerUltracodeSkill } from '../ultracode.js'

// Command 是一个联合类型；source/getPromptForCommand 仅存在于 prompt 变体。
// 在确认 type === 'prompt' 后通过类型断言收窄。
function asPrompt(c: { type: string }): PromptCommand {
  return c as unknown as PromptCommand
}

// bundledSkills 是一个进程全局注册表（根据 CLAUDE.md 的 mock/state 规则，
// 模块级单例会在一个 bun 测试进程中跨测试文件泄漏）。
// 每次测试后清理，这样 `ultracode` 就不会泄漏到其他枚举已注册技能
// 的套件中（例如 skill-search prefetch discovery）。
afterEach(() => {
  clearBundledSkills()
})

describe('registerUltracodeSkill', () => {
  test('registers a user-invocable prompt command named ultracode', () => {
    clearBundledSkills()
    registerUltracodeSkill()

    const skills = getBundledSkills()
    const ultracode = skills.find(s => s.name === 'ultracode')
    expect(ultracode).toBeDefined()
    expect(ultracode!.type).toBe('prompt')
    expect(ultracode!.userInvocable).toBe(true)
    expect(ultracode!.whenToUse).toBeTruthy()
    expect(ultracode!.description).toContain('workflow')
    const promptCmd = asPrompt(ultracode!)
    expect(promptCmd.source).toBe('bundled')
  })

  test('getPromptForCommand injects the orchestration playbook with key sections', async () => {
    clearBundledSkills()
    registerUltracodeSkill()

    const ultracode = getBundledSkills().find(s => s.name === 'ultracode')!
    const blocks = await asPrompt(ultracode).getPromptForCommand(
      '',
      {} as never,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')

    const text = (blocks[0] as { type: 'text'; text: string }).text
    // 标题 + 选择加入规则 + harness 注入说明
    expect(text).toContain('Workflow Orchestration Playbook')
    expect(text).toContain('explicitly opted into multi-agent orchestration')
    expect(text).toContain('harness')
    // 编排原语
    expect(text).toContain('Script body hooks')
    expect(text).toContain('parallel')
    expect(text).toContain('pipeline')
    // 确定性 / 脚本执行模型约束（JS 而非 TS；Date.now/Math.random 会抛出）
    expect(text).toContain('plain JavaScript, NOT TypeScript')
    expect(text).toContain('Date.now()')
    // Barrier 与 pipeline 指南、质量模式、恢复、硬限制
    expect(text).toContain('DEFAULT TO pipeline()')
    expect(text).toContain('Quality patterns')
    expect(text).toContain('resumeFromRunId')
    expect(text).toContain('4096')
  })

  test('appends user-provided args to the prompt when given', async () => {
    clearBundledSkills()
    registerUltracodeSkill()

    const ultracode = getBundledSkills().find(s => s.name === 'ultracode')!
    const blocks = await asPrompt(ultracode).getPromptForCommand(
      '迁移 auth 模块',
      {} as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text.endsWith('迁移 auth 模块\n')).toBe(true)
    expect(text).toContain('User input')
  })

  test('is not gated behind USER_TYPE — registers with no env set', () => {
    // 此测试进程中未配置 USER_TYPE 环境变量。如果该技能是
    // ant 限定的（如 stuck.ts），它就不会出现在这里。
    const previousUserType = process.env.USER_TYPE
    delete process.env.USER_TYPE
    clearBundledSkills()
    registerUltracodeSkill()

    const skills = getBundledSkills()
    expect(skills.some(s => s.name === 'ultracode')).toBe(true)

    // 恢复，这样我们永远不会为其他测试文件修改进程环境。
    if (previousUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = previousUserType
  })
})
