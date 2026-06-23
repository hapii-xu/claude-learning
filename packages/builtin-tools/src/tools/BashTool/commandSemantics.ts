/**
 * 命令语义配置，用于在不同上下文中解释退出码。
 *
 * 许多命令用退出码传达除成功/失败之外的信息。
 * 例如，grep 在未找到匹配项时返回 1，这并非错误情况。
 */

import { splitCommand_DEPRECATED } from 'src/utils/bash/commands.js'

export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => {
  isError: boolean
  message?: string
}

/**
 * 默认语义：仅将退出码 0 视为成功，其余均视为错误
 */
const DEFAULT_SEMANTIC: CommandSemantic = (exitCode, _stdout, _stderr) => ({
  isError: exitCode !== 0,
  message:
    exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/**
 * 命令专属语义
 */
const COMMAND_SEMANTICS: Map<string, CommandSemantic> = new Map([
  // grep：0=找到匹配项，1=未找到匹配项，2+=错误
  [
    'grep',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // ripgrep 语义与 grep 相同
  [
    'rg',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'No matches found' : undefined,
    }),
  ],

  // find：0=成功，1=部分成功（部分目录不可访问），2+=错误
  [
    'find',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message:
        exitCode === 1 ? 'Some directories were inaccessible' : undefined,
    }),
  ],

  // diff：0=无差异，1=发现差异，2+=错误
  [
    'diff',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Files differ' : undefined,
    }),
  ],

  // test/[：0=条件为真，1=条件为假，2+=错误
  [
    'test',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // [ 是 test 的别名
  [
    '[',
    (exitCode, _stdout, _stderr) => ({
      isError: exitCode >= 2,
      message: exitCode === 1 ? 'Condition is false' : undefined,
    }),
  ],

  // wc、head、tail、cat 等：这些通常只在真正出错时才失败
  // 因此使用默认语义
])

/**
 * 获取命令的语义解释
 */
function getCommandSemantic(command: string): CommandSemantic {
  // 提取基础命令（第一个单词，处理管道）
  const baseCommand = heuristicallyExtractBaseCommand(command)
  const semantic = COMMAND_SEMANTICS.get(baseCommand)
  return semantic !== undefined ? semantic : DEFAULT_SEMANTIC
}

/**
 * 从单条命令字符串中提取命令名（第一个单词）。
 */
function extractBaseCommand(command: string): string {
  return command.trim().split(/\s+/)[0] || ''
}

/**
 * 从复杂命令行中提取主命令；
 * 可能完全猜错——不要依赖它做安全判断
 */
function heuristicallyExtractBaseCommand(command: string): string {
  const segments = splitCommand_DEPRECATED(command)

  // 取最后一条命令，因为决定退出码的是它
  const lastCommand = segments[segments.length - 1] || command

  return extractBaseCommand(lastCommand)
}

/**
 * 根据语义规则解释命令结果
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): {
  isError: boolean
  message?: string
} {
  const semantic = getCommandSemantic(command)
  const result = semantic(exitCode, stdout, stderr)

  return {
    isError: result.isError,
    message: result.message,
  }
}
