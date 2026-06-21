import { useCallback, useEffect } from 'react'
import type { Command } from '../commands.js'
import {
  clearCommandMemoizationCaches,
  clearCommandsCache,
  getCommands,
} from '../commands.js'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { logError } from '../utils/log.js'
import { skillChangeDetector } from '../utils/skills/skillChangeDetector.js'

/**
 * 通过两个触发器保持命令列表新鲜：
 *
 * 1. Skill 文件变更（watcher）—— 完整缓存清除 + 磁盘重新扫描，因为
 *    skill 内容在磁盘上已变更。
 * 2. GrowthBook init/refresh —— 仅清除 memo，因为仅 `isEnabled()`
 *    谓词可能已变更。处理像 /btw 这样的命令，其 gate
 *    读取一个在 flag 重命名后第一次会话时磁盘缓存中还没有的
 *    flag：getCommands() 在 GB init 之前运行（main.tsx:2855 vs
 *    showSetupScreens 在 :3106），所以 memoized 列表用
 *    默认值烘焙。一旦 init 填充 remoteEvalFeatureValues，重新过滤。
 */
export function useSkillsChange(
  cwd: string | undefined,
  onCommandsChange: (commands: Command[]) => void,
): void {
  const handleChange = useCallback(async () => {
    if (!cwd) return
    try {
      // 清除所有命令缓存以确保全新加载
      clearCommandsCache()
      const commands = await getCommands(cwd)
      onCommandsChange(commands)
    } catch (error) {
      // 重载期间的错误非致命 —— 记录日志并继续
      if (error instanceof Error) {
        logError(error)
      }
    }
  }, [cwd, onCommandsChange])

  useEffect(() => skillChangeDetector.subscribe(handleChange), [handleChange])

  const handleGrowthBookRefresh = useCallback(async () => {
    if (!cwd) return
    try {
      clearCommandMemoizationCaches()
      const commands = await getCommands(cwd)
      onCommandsChange(commands)
    } catch (error) {
      if (error instanceof Error) {
        logError(error)
      }
    }
  }, [cwd, onCommandsChange])

  useEffect(
    () => onGrowthBookRefresh(handleGrowthBookRefresh),
    [handleGrowthBookRefresh],
  )
}
