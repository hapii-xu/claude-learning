import { feature } from 'bun:bundle'

/**
 * 构建时存在性检查：`/skill-learning` slash 命令是否被编译进了本次构建？
 * 用于命令注册表的 `isEnabled`，使该命令只要可构建就出现在菜单中。
 * 运营者通过 `/skill-learning start` 激活子系统，
 * 该命令会设置 `SKILL_LEARNING_ENABLED=1` 并启动 runtime observers
 *（参见 `isSkillLearningEnabled`）。
 */
export function isSkillLearningCompiledIn(): boolean {
  if (feature('SKILL_LEARNING')) return true
  return false
}

/**
 * 运行时激活检查：skill-learning 子系统当前是否在运行中
 *（toolEvent、runtime、session observers 已挂载，正在持久化观察记录到磁盘）？
 * 默认关闭——运营者必须执行 `/skill-learning start`（设置 `SKILL_LEARNING_ENABLED=1`）。
 *
 * 旧版 `FEATURE_SKILL_LEARNING=1` 同样被接受，
 * 用于向后兼容那些在 slash-command UX 上线前就设置了该变量的运营者。
 *
 * 此处有意不执行 build-flag 门控：命令注册表已对命令编译做了 build flag 的把关，
 * 而本函数只会被 build flag 已经放行的代码路径调用。
 * 解耦后测试面更干净（测试只需验证环境变量约定，无需 mock `bun:bundle`）。
 */
export function isSkillLearningEnabled(): boolean {
  if (process.env.SKILL_LEARNING_ENABLED === '1') return true
  if (process.env.FEATURE_SKILL_LEARNING === '1') return true
  return false
}
