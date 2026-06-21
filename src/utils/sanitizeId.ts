/**
 * 清理 ID 以用于错误消息。
 *
 * 安全不变量：完整 ID（vault_id、credential_id、agent_id 等）
 * 不得出现在错误消息中，因为它们可能泄露到日志、bug 报告
 * 或面向用户的文本中。仅暴露前 8 个字符。
 *
 * H3：从 4 个 P2 API 客户端文件（vaultsApi、agentsApi、
 * memoryStoresApi、skillsApi）中提取的单一真相源。
 */
export function sanitizeId(id: string): string {
  if (id.length <= 8) return id
  return `${id.slice(0, 8)}…`
}
