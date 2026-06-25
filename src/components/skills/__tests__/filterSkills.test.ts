import { describe, expect, test } from 'bun:test'
import { filterSkills } from '../filterSkills.js'
import type { SkillItem } from '../filterSkills.js'

function makeSkill(name: string, description = ''): SkillItem {
  return { name, description }
}

describe('filterSkills', () => {
  const skills: SkillItem[] = [
    makeSkill('tdd-guide', 'Test-driven development guide'),
    makeSkill('code-reviewer', 'Review code quality and patterns'),
    makeSkill('security-reviewer', 'Security vulnerability analysis'),
    makeSkill('refactor-cleaner', 'Dead code cleanup and refactoring'),
    makeSkill('planner', 'Implementation planning for complex features'),
    makeSkill('architect', 'System design and architecture decisions'),
  ]

  test('空查询返回所有 skills', () => {
    const result = filterSkills(skills, '')
    expect(result).toEqual(skills)
  })

  test('部分名称匹配返回对应的 skills', () => {
    const result = filterSkills(skills, 'review')
    const names = result.map(s => s.name)
    expect(names).toContain('code-reviewer')
    expect(names).toContain('security-reviewer')
    expect(names).not.toContain('planner')
  })

  test('无匹配返回空数组', () => {
    const result = filterSkills(skills, 'zzznomatch')
    expect(result).toHaveLength(0)
  })

  test('大小写不敏感匹配', () => {
    const result = filterSkills(skills, 'TDD')
    expect(result.map(s => s.name)).toContain('tdd-guide')
  })

  test('当名称不匹配时匹配描述', () => {
    const result = filterSkills(skills, 'dead code')
    expect(result.map(s => s.name)).toContain('refactor-cleaner')
  })

  test('多词查询匹配包含任一词的 skills', () => {
    // "code review" 应同时匹配 code-reviewer（名称）和 tdd-guide（描述含 "Test" 但不含 code review）
    const result = filterSkills(skills, 'code review')
    const names = result.map(s => s.name)
    // code-reviewer 同时匹配 "code" 和 "review"
    expect(names).toContain('code-reviewer')
  })

  test('清空查询（重置为空）再次返回所有 skills', () => {
    // 先过滤
    const filtered = filterSkills(skills, 'security')
    expect(filtered).toHaveLength(1)
    // 再清空
    const all = filterSkills(skills, '')
    expect(all).toHaveLength(skills.length)
  })

  test('仅空白的查询返回所有 skills', () => {
    const result = filterSkills(skills, '   ')
    expect(result).toEqual(skills)
  })
})
