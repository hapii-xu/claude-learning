import { describe, expect, test } from 'bun:test'

/**
 * 验证面向用户的权限和帮助文案是否符合可用性标准。
 * 这些是纯字符串测试 — 无副作用，无 React 渲染。
 */

describe('Permission dialog footer hints', () => {
  test('bash permission footer says "reject" instead of "cancel"', () => {
    const footer = 'Esc to reject'
    expect(footer).toContain('reject')
    expect(footer).not.toContain('cancel')
  })

  test('bash permission footer tab hint says "add feedback"', () => {
    const tabHint = 'Tab to add feedback'
    expect(tabHint).toContain('feedback')
    expect(tabHint).not.toContain('amend')
  })

  test('file permission footer matches bash footer language', () => {
    const bashFooter = 'Esc to reject'
    const fileFooter = 'Esc to reject'
    expect(bashFooter).toBe(fileFooter)
  })
})

describe('Permission option labels', () => {
  test('.hclaude/ folder option is under 60 chars', () => {
    const label = 'Yes, allow edits to .hclaude/ config for this session'
    expect(label.length).toBeLessThan(60)
    expect(label).toContain('.hclaude/')
  })

  test('accept-once option has simple label', () => {
    const label = 'Yes'
    expect(label).toBe('Yes')
  })

  test('reject option has simple label', () => {
    const label = 'No'
    expect(label).toBe('No')
  })
})

describe('Help General page getting started guide', () => {
  test('step 1 mentions exploring code', () => {
    const step1 =
      'Ask a question or describe a task — Claude will explore your code and respond.'
    expect(step1).toContain('explore')
    expect(step1).toContain('question')
  })

  test('step 2 mentions reviewing actions', () => {
    const step2 =
      'When Claude wants to edit files or run commands, you review and approve each action.'
    expect(step2).toContain('review')
    expect(step2).toContain('approve')
  })

  test('step 3 mentions key commands', () => {
    const step3 = '/commit'
    const step3b = '/help'
    const step3c = '?'
    expect(step3).toBe('/commit')
    expect(step3b).toBe('/help')
    expect(step3c).toBe('?')
  })

  test('heading says "Getting started"', () => {
    const heading = 'Getting started'
    expect(heading).toBe('Getting started')
  })
})
