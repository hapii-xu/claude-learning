// MCP 数据的 Unicode 清理
// 提取自 src/utils/sanitization.ts

/**
 * 递归清理 MCP 服务器响应中的 Unicode 字符。
 * 移除或替换可能导致显示或解析问题的 Unicode 字符。
 */
export function recursivelySanitizeUnicode<T>(data: T): T {
  if (typeof data === 'string') {
    // 移除控制字符，保留 \t, \n, \r
    // 替换空字节和其他 C0 控制字符
    return (
      data
        // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character sanitization
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\uFFFD/g, '') // 替换字符
        .normalize('NFC') as unknown as T
    )
  }

  if (Array.isArray(data)) {
    return data.map(item => recursivelySanitizeUnicode(item)) as unknown as T
  }

  if (data !== null && typeof data === 'object') {
    const result = {} as Record<string, unknown>
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      result[key] = recursivelySanitizeUnicode(value)
    }
    return result as T
  }

  return data
}
