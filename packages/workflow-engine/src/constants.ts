// 引擎级常量。无运行时依赖。

/**
 * Workflow 工具名称。PascalCase 与系统其他工具保持一致（Agent/Bash/CronCreate…），
 * 否则大小写敏感的 toolMatchesName 会在模型自然选择 select:Workflow 时失败。
 */
export const WORKFLOW_TOOL_NAME = 'Workflow'

/** 用户命名 workflow 文件的目录（相对于项目根目录）。 */
export const WORKFLOW_DIR_NAME = '.hclaude/workflows'

/** workflow 运行的持久化目录（journal + 运行记录）。 */
export const WORKFLOW_RUNS_DIR = '.hclaude/workflow-runs'

/** 命名 workflow 支持的脚本扩展名（按优先级排序）。 */
export const WORKFLOW_SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs'] as const

/**
 * 并发：每次 workflow 运行的默认信号量许可数。
 * 历史：之前使用 min(CAP, cpuCores - 2)；改为固定默认值 3——避免在多核机器上一次扇出十几个 agent。
 * 单次运行可通过 Workflow 工具的 maxConcurrency 输入覆盖（仍受 CAP 限制）。
 */
export const DEFAULT_MAX_CONCURRENCY = 3

/** 用户指定 maxConcurrency 的绝对上限（防滥用）。 */
export const MAX_CONCURRENCY_CAP = 16

/** 单次 workflow 生命周期内 agent() 调用总上限。 */
export const MAX_TOTAL_AGENTS = 1000

/** 单次 parallel()/pipeline() 调用的条目上限。 */
export const MAX_ITEMS_PER_CALL = 4096
