import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_WITH_REFRESH } from 'src/services/analytics/growthbook.js'
import { DEFAULT_CRON_JITTER_CONFIG } from 'src/utils/cronTasks.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'

const KAIROS_CRON_REFRESH_MS = 5 * 60 * 1000

export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * cron 调度系统的统一开关。将构建期的 `feature('AGENT_TRIGGERS')` 标志
 * （死代码消除）与运行期的 `tengu_kairos_cron` GrowthBook 开关结合，
 * 刷新窗口为 5 分钟。
 *
 * AGENT_TRIGGERS 可独立于 KAIROS 发布 —— cron 模块图
 * （cronScheduler/cronTasks/cronTasksLock/cron.ts + 三个工具 + /loop skill）
 * 对 src/assistant/ 零引用，也没有任何 feature('KAIROS') 调用。
 * REPL.tsx 中对 kairosEnabled 的读取是安全的：
 * kairosEnabled 无条件存在于 AppStateStore 中、默认为 false，因此当
 * KAIROS 关闭时调度器只会拿到 assistantMode: false。
 *
 * 从 Tool.isEnabled()（懒加载，post-init）以及 useEffect / 命令式 setup 中
 * 调用，从不在模块作用域调用 —— 因此磁盘缓存有机会先填充好。
 *
 * 默认值为 `true` —— /loop 已 GA（在 changelog 中公布）。GrowthBook 对
 * Bedrock/Vertex/Foundry 以及设置了 DISABLE_TELEMETRY /
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 的用户禁用；如果默认值是 `false`，
 * 会破坏这些用户的 /loop（GH #31759）。GB 开关现在纯粹用作全集群级别的
 * kill switch —— 翻到 `false` 会让已在运行的调度器在下次 isKilled 轮询时停止，
 * 而不仅仅是阻止新的调度器。
 *
 * `CLAUDE_CODE_DISABLE_CRON` 是本地覆盖项，优先级高于 GB。
 */
export function isKairosCronEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON)
}

/**
 * 针对磁盘持久化（durable）cron 任务的 kill 开关。作用范围比
 * {@link isKairosCronEnabled} 更窄 —— 关闭它只会在 call() 调用处强制
 * `durable: false`，不影响仅会话级（内存中、已 GA）的 cron。
 *
 * 默认值为 `true`，这样 Bedrock/Vertex/Foundry 以及 DISABLE_TELEMETRY
 * 用户能获得 durable cron。不会读取 CLAUDE_CODE_DISABLE_CRON
 * （那是通过 isKairosCronEnabled 杀掉整个调度器的开关）。
 */
export function isDurableCronEnabled(): boolean {
  return getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_kairos_cron_durable',
    true,
    KAIROS_CRON_REFRESH_MS,
  )
}

export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

export function buildCronCreateDescription(durableEnabled: boolean): string {
  return durableEnabled
    ? '安排一个 prompt 在未来某个时间运行 —— 可以是按 cron 周期性运行，也可以在指定时间运行一次。传入 durable: true 可持久化到 .claude/scheduled_tasks.json；否则仅本次会话有效。'
    : '安排一个 prompt 在本次 Claude 会话内的未来某个时间运行 —— 可以是按 cron 周期性运行，也可以在指定时间运行一次。'
}

export function buildCronCreatePrompt(durableEnabled: boolean): string {
  const durabilitySection = durableEnabled
    ? `## 持久化

默认情况下（durable: false），任务只在当前 Claude 会话中存在 —— 不写入磁盘，Claude 退出后任务消失。传入 durable: true 可将任务写入 .claude/scheduled_tasks.json，使其在重启后依然存在。仅在用户明确要求任务持久化时（"每天都这样做"、"永久设置"）才使用 durable: true。大多数"5 分钟后提醒我"/"1 小时后回来"的请求应保持仅会话有效。`
    : `## 仅会话有效

任务只在当前 Claude 会话中存在 —— 不写入磁盘，Claude 退出后任务消失。`

  const durableRuntimeNote = durableEnabled
    ? '持久化任务写入 .claude/scheduled_tasks.json，在会话重启后继续存在 —— 下次启动时自动恢复。REPL 关闭期间错过的一次性持久任务会被提示补偿执行。仅会话任务随进程消亡。'
    : ''

  return `将一个 prompt 安排在未来某个时间加入队列执行。适用于周期性调度和一次性提醒。

使用用户本地时区的标准 5 字段 cron：分钟 小时 月份中的天 月份 星期几。"0 9 * * *" 表示本地时间 9:00 —— 无需时区转换。

## 一次性任务（recurring: false）

适用于"在 X 时提醒我"或"在<时间>做 Y"类请求 —— 触发一次后自动删除。
将分钟/小时/月份中的天/月份固定为具体值：
  "今天下午 2:30 提醒我检查部署" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "明天早上运行冒烟测试" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## 周期性任务（recurring: true，默认值）

适用于"每 N 分钟"/"每小时"/"工作日上午 9 点"类请求：
  "*/5 * * * *"（每 5 分钟），"0 * * * *"（每小时），"0 9 * * 1-5"（工作日本地时间 9:00）

## 在任务允许时避免使用 :00 和 :30 分钟

每个要求"9 点"的用户都会得到 \`0 9\`，每个要求"每小时"的用户都会得到 \`0 *\` —— 这意味着来自全球各地的请求同时打到 API。当用户的要求是大概时间时，选一个不是 0 或 30 的分钟：
  "每天早上大约 9 点" → "57 8 * * *" 或 "3 9 * * *"（不要用 "0 9 * * *"）
  "每小时" → "7 * * * *"（不要用 "0 * * * *"）
  "大概一小时后提醒我..." → 选你落到的那一分钟，不要取整

只有在用户明确说出那个时间并且显然是认真的时候才使用 0 或 30 分钟（"9:00 整"、"半点"、与会议协调）。不确定时，提前或推迟几分钟 —— 用户不会注意到，但整个集群会。

${durabilitySection}

## 运行时行为

任务只在 REPL 空闲时触发（不在查询进行中）。${durableRuntimeNote}调度器会在你选定的时间上添加小幅确定性抖动：周期性任务最多延迟周期的 10%（最多 15 分钟）；落在 :00 或 :30 的一次性任务最多提前 90 秒触发。选择非整点分钟仍是更大的调节杠杆。

周期性任务在 ${DEFAULT_MAX_AGE_DAYS} 天后自动过期 —— 触发最后一次后被删除。这限制了会话生命周期。安排周期性任务时请告知用户 ${DEFAULT_MAX_AGE_DAYS} 天的限制。

返回一个可传给 ${CRON_DELETE_TOOL_NAME} 的任务 ID。`
}

export const CRON_DELETE_DESCRIPTION = '按 ID 取消一个已安排的 cron 任务'
export function buildCronDeletePrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from .claude/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).`
    : `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from the in-memory session store.`
}

export const CRON_LIST_DESCRIPTION = '列出已安排的 cron 任务'
export function buildCronListPrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable (.claude/scheduled_tasks.json) and session-only.`
    : `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME} in this session.`
}
