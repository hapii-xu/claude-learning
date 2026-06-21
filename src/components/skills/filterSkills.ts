/**
 * skills 选择器的输入即过滤逻辑。
 *
 * 不变式：空或仅空白的查询总是原样返回所有 skills。
 * 匹配是大小写不敏感的；查询中每个空白分隔的词
 * 必须出现在 skill 名称或描述中。
 */

export type SkillItem = {
  name: string
  description: string
}

/**
 * 按 `query` 过滤 `skills`。返回新数组；从不修改输入。
 *
 * - 空/空白查询 → 返回所有 skills。
 * - 查询中的每个词必须（大小写不敏感地）出现在 skill 名称
 *   或描述中（每词 AND 语义，名称/描述之间 OR）。
 */
export function filterSkills<T extends SkillItem>(
  skills: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    return skills.slice()
  }

  const words = trimmed.toLowerCase().split(/\s+/)

  return skills.filter(skill => {
    const haystack = `${skill.name} ${skill.description}`.toLowerCase()
    return words.every(word => haystack.includes(word))
  })
}
