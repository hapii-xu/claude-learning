/**
 * /coordinator —— 切换 coordinator（多 worker 编排）模式。
 *
 * 开启后，CLI 成为编排者，通过 Agent({ subagent_type: "worker" }) 把任务分发给 worker agent。
 * coordinator 只能使用 Agent、SendMessage 和 TaskStop。
 */
import { feature } from 'bun:bundle'
import type { ToolUseContext } from '../Tool.js'
import type {
  Command,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types/command.js'

const coordinator = {
  type: 'local-jsx',
  name: 'coordinator',
  description: 'Toggle coordinator (multi-worker) mode',
  isEnabled: () => {
    if (feature('COORDINATOR_MODE')) {
      return true
    }
    return false
  },
  immediate: true,
  load: () =>
    Promise.resolve({
      async call(
        onDone: LocalJSXCommandOnDone,
        _context: ToolUseContext & LocalJSXCommandContext,
      ): Promise<React.ReactNode> {
        const mod =
          require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')

        if (mod.isCoordinatorMode()) {
          // 关闭：清除环境变量
          delete process.env.CLAUDE_CODE_COORDINATOR_MODE
          onDone('Coordinator mode disabled — back to normal mode', {
            display: 'system',
            metaMessages: [
              '<system-reminder>\nCoordinator mode is now disabled. You have access to all standard tools again. Work directly instead of dispatching to workers.\n</system-reminder>',
            ],
          })
        } else {
          // 开启：设置环境变量
          process.env.CLAUDE_CODE_COORDINATOR_MODE = '1'
          onDone(
            'Coordinator mode enabled — use Agent(subagent_type: "worker") to dispatch tasks',
            {
              display: 'system',
              metaMessages: [
                '<system-reminder>\nCoordinator mode is now enabled. You are an orchestrator. Use Agent({ subagent_type: "worker" }) to spawn workers, SendMessage to continue them, TaskStop to stop them. Do not use other tools directly.\n</system-reminder>',
              ],
            },
          )
        }
        return null
      },
    }),
} satisfies Command

export default coordinator
