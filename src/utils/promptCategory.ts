import type { QuerySource } from 'src/constants/querySource.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  OUTPUT_STYLE_CONFIG,
} from '../constants/outputStyles.js'
import { getSettings_DEPRECATED } from './settings/settings.js'

/**
 * 确定 agent 使用的 prompt 类别。
 * 用于分析以跟踪不同的 agent 模式。
 *
 * @param agentType - agent 的类型/名称
 * @param isBuiltInAgent - 是否为内置 agent 或自定义
 * @returns agent prompt 类别字符串
 */
export function getQuerySourceForAgent(
  agentType: string | undefined,
  isBuiltInAgent: boolean,
): QuerySource {
  if (isBuiltInAgent) {
    // TODO: 避免此强转
    return agentType
      ? (`agent:builtin:${agentType}` as QuerySource)
      : 'agent:default'
  } else {
    return 'agent:custom'
  }
}

/**
 * 根据输出样式设置确定 prompt 类别。
 * 用于分析以跟踪不同输出样式的使用情况。
 *
 * @returns prompt 类别字符串，默认时返回 undefined
 */
export function getQuerySourceForREPL(): QuerySource {
  const settings = getSettings_DEPRECATED()
  const style = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  if (style === DEFAULT_OUTPUT_STYLE_NAME) {
    return 'repl_main_thread'
  }

  // OUTPUT_STYLE_CONFIG 中的所有样式均为内置
  const isBuiltIn = style in OUTPUT_STYLE_CONFIG
  return isBuiltIn
    ? (`repl_main_thread:outputStyle:${style}` as QuerySource)
    : 'repl_main_thread:outputStyle:custom'
}
