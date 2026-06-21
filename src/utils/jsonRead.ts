/**
 * 叶子 stripBOM — 从 json.ts 中抽离以打破 settings → json → log →
 * types/logs → … → settings 的循环依赖。json.ts 为 memoized+logging 的
 * safeParseJSON 导入此模块；无法导入 json.ts 的叶子调用方
 * 使用内联的 stripBOM + jsonParse（syncCacheState 就是这样做的）。
 *
 * UTF-8 BOM (U+FEFF)：PowerShell 5.x 默认写出 UTF-8 with BOM
 * (Out-File, Set-Content)。我们无法控制用户环境，因此在读取时剥离。
 * 若不做此处理，JSON.parse 会因 "Unexpected token" 失败。
 */

const UTF8_BOM = '\uFEFF'

export function stripBOM(content: string): string {
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content
}
