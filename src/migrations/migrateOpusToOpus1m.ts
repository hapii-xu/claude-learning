import { logEvent } from '../services/analytics/index.js'
import { isOpus1mMergeEnabled } from '../utils/model/model.js'

/**
 * 迁移已禁用：手动移除 [1m] 后缀的用户不应自动重新添加。
 * 该迁移过于激进，未尊重用户选择。
 */
export function migrateOpusToOpus1m(): void {
  // 空操作 - 尊重用户手动选择的模型
  if (!isOpus1mMergeEnabled()) {
    return
  }
  logEvent('tengu_opus_to_opus1m_migration', { skipped: true })
}
