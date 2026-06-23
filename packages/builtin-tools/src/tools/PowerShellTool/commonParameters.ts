/**
 * PowerShell 通用参数（通过 [CmdletBinding()] 在所有 cmdlet 上可用）。
 * 来源：about_CommonParameters（PowerShell 文档）+ Get-Command 输出。
 *
 * 由 pathValidation.ts（合并到每个 cmdlet 的已知参数集合）和
 * readOnlyValidation.ts（合并到 safeFlags 检查）共享。拆分出来是为了
 * 打破这两个文件之间原本会形成的导入循环。
 *
 * 以小写形式存储并带前导横杠 — 调用方将输入 `.toLowerCase()`。
 */

export const COMMON_SWITCHES = ['-verbose', '-debug']

export const COMMON_VALUE_PARAMS = [
  '-erroraction',
  '-warningaction',
  '-informationaction',
  '-progressaction',
  '-errorvariable',
  '-warningvariable',
  '-informationvariable',
  '-outvariable',
  '-outbuffer',
  '-pipelinevariable',
]

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([
  ...COMMON_SWITCHES,
  ...COMMON_VALUE_PARAMS,
])
