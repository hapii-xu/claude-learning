import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * 创建一个带回退的存储：优先使用主存储，
 * 如果失败则回退到备用存储
 */
export function createFallbackStorage(
  primary: SecureStorage,
  secondary: SecureStorage,
): SecureStorage {
  return {
    name: `${primary.name}-with-${secondary.name}-fallback`,
    read(): SecureStorageData {
      const result = primary.read()
      if (result !== null && result !== undefined) {
        return result
      }
      return secondary.read() || {}
    },
    async readAsync(): Promise<SecureStorageData | null> {
      const result = await primary.readAsync()
      if (result !== null && result !== undefined) {
        return result
      }
      return (await secondary.readAsync()) || {}
    },
    update(data: SecureStorageData): { success: boolean; warning?: string } {
      // 捕获更新前的状态
      const primaryDataBefore = primary.read()

      const result = primary.update(data)

      if (result.success) {
        // 首次迁移到主存储时删除备用存储
        // 在宿主机与容器共享 .claude 目录时保留凭据
        // 参见: https://github.com/anthropics/claude-code/issues/1414
        if (primaryDataBefore === null) {
          secondary.delete()
        }
        return result
      }

      const fallbackResult = secondary.update(data)

      if (fallbackResult.success) {
        // 主存储写入失败，但其中可能仍保留着一条*较旧的*有效
        // 条目。read() 只要主存储返回非 null 就优先使用它，因此那条
        // 过期条目会遮蔽我们刚写入备用存储的新数据——例如服务器
        // 已经轮换掉的 refresh token，导致陷入 /login 死循环
        // (#30337)。尽力删除；如果此处也失败，说明用户的密钥串
        // 处于无法从这里修复的异常状态。
        if (primaryDataBefore !== null) {
          primary.delete()
        }
        return {
          success: true,
          warning: fallbackResult.warning,
        }
      }

      return { success: false }
    },
    delete(): boolean {
      const primarySuccess = primary.delete()
      const secondarySuccess = secondary.delete()

      return primarySuccess || secondarySuccess
    },
  }
}
