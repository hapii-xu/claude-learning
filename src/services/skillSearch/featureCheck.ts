import { feature } from 'bun:bundle'

/**
 * 构建时存在性检查：`/skill-search` 斜杠命令是否编译进此构建？
 * 由命令注册表的 `isEnabled` 使用，使命令在可构建时
 * 出现在菜单中。操作员通过 `/skill-search start` 激活
 * 子系统本身，这会翻转
 * `SKILL_SEARCH_ENABLED=1` 并开启运行时热路径（见
 * `isSkillSearchEnabled`）。
 */
export function isSkillSearchCompiledIn(): boolean {
  if (feature('EXPERIMENTAL_SKILL_SEARCH')) return true
  return false
}

/**
 * 运行时激活检查：skill-search 子系统当前是否在工作
 *（intentNormalize Haiku 调用、预取热路径、遥测）？默认关闭
 * —— 操作员必须运行 `/skill-search start`（设置
 * `SKILL_SEARCH_ENABLED=1`）。见 docs/agent/sur-skill-overflow-bugs.md §5。
 *
 * 这里有意不执行构建标志门控：命令
 * 注册表已经对命令编译进行了构建标志门控，此
 * 函数只能从构建标志已经放行的代码路径到达。解耦保持测试表面干净
 *（测试在不需 mock `bun:bundle` 的情况下验证环境变量契约）。
 */
export function isSkillSearchEnabled(): boolean {
  return process.env.SKILL_SEARCH_ENABLED === '1'
}
